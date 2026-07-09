import { createHash, randomBytes } from "node:crypto";
import {
  auctions,
  bids,
  customerRefreshTokens,
  customers,
  hashPassword,
  items,
  listings,
  orders,
  verifyPassword,
} from "@auction/db";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { signAccessToken } from "../auth/jwt.js";
import type { AppContext } from "../context.js";
import { placeBid } from "../engine/bids.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Public storefront API. HYGIENE RULES (design doc): responses NEVER contain
 * reserve amounts (only reserveMet), proxy maxima, customer emails, or any
 * admin-only field. Bidders authenticate with kind="bidder" tokens that the
 * admin routes reject by construction.
 */

/** Public-safe auction card/detail shape. */
function publicAuction(row: {
  auction: typeof auctions.$inferSelect;
  listing: typeof listings.$inferSelect;
  item: typeof items.$inferSelect;
  leaderAlias: string | null;
}) {
  const { auction, listing, item } = row;
  return {
    id: auction.id,
    title: listing.title,
    description: listing.description,
    sku: item.sku,
    condition: item.condition,
    photos: item.photos,
    marketCode: listing.marketCode,
    status: auction.status,
    startsAt: auction.startsAt,
    endsAt: auction.endsAt,
    startPriceCents: listing.startPriceCents,
    currentPriceCents: auction.currentPriceCents,
    bidCount: auction.bidCount,
    leaderAlias: row.leaderAlias,
    hasReserve: listing.reserveCents !== null,
    reserveMet: listing.reserveCents === null ? true : auction.reserveMet,
  };
}

export function registerPublicRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ── Bidder auth ───────────────────────────────────────────────────────────

  async function issueTokens(customer: { id: string; email: string; alias: string }) {
    const accessToken = signAccessToken(
      { sub: customer.id, kind: "bidder", email: customer.email, name: customer.alias, role: "bidder" },
      ctx.config.jwtSecret,
      ctx.config.accessTokenTtlSec,
      ctx.now().getTime(),
    );
    const refreshToken = randomBytes(48).toString("base64url");
    await ctx.db.insert(customerRefreshTokens).values({
      customerId: customer.id,
      tokenHash: sha256(refreshToken),
      expiresAt: new Date(ctx.now().getTime() + ctx.config.refreshTokenTtlSec * 1000),
    });
    return {
      accessToken,
      refreshToken,
      bidder: { id: customer.id, email: customer.email, alias: customer.alias },
    };
  }

  const registerSchema = z.object({
    email: z.string().email(),
    alias: z
      .string()
      .min(3)
      .max(24)
      .regex(/^[a-zA-Z0-9_.-]+$/, "alias may contain letters, digits, _ . -"),
    password: z.string().min(8),
    name: z.string().max(120).optional(),
    country: z.enum(["LV", "EE", "LT"]).optional(),
  });

  app.post("/api/public/auth/register", async (req, reply) => {
    const body = registerSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const [row] = await ctx.db
      .insert(customers)
      .values({
        email: body.data.email.toLowerCase(),
        alias: body.data.alias,
        name: body.data.name ?? null,
        country: body.data.country ?? null,
        marketCode: body.data.country ?? null,
        passwordHash: await hashPassword(body.data.password),
      })
      .onConflictDoNothing()
      .returning({ id: customers.id, email: customers.email, alias: customers.alias });
    if (!row) return reply.code(409).send({ error: "email_exists" });
    return issueTokens(row);
  });

  app.post("/api/public/auth/login", async (req, reply) => {
    const body = z.object({ email: z.string().email(), password: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const [customer] = await ctx.db
      .select()
      .from(customers)
      .where(eq(customers.email, body.data.email.toLowerCase()));
    if (
      !customer ||
      customer.erasedAt !== null ||
      !customer.passwordHash ||
      !(await verifyPassword(body.data.password, customer.passwordHash))
    ) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    return issueTokens(customer);
  });

  app.post("/api/public/auth/refresh", async (req, reply) => {
    const body = z.object({ refreshToken: z.string().min(10) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const [row] = await ctx.db
      .select()
      .from(customerRefreshTokens)
      .where(and(eq(customerRefreshTokens.tokenHash, sha256(body.data.refreshToken)), isNull(customerRefreshTokens.revokedAt)));
    if (!row || row.expiresAt.getTime() <= ctx.now().getTime()) {
      return reply.code(401).send({ error: "invalid_refresh_token" });
    }
    const [customer] = await ctx.db.select().from(customers).where(eq(customers.id, row.customerId));
    if (!customer || customer.erasedAt !== null) return reply.code(401).send({ error: "invalid_refresh_token" });
    await ctx.db.update(customerRefreshTokens).set({ revokedAt: ctx.now() }).where(eq(customerRefreshTokens.id, row.id));
    return issueTokens(customer);
  });

  const requireBidder = (req: FastifyRequest, reply: FastifyReply): string | null => {
    if (!req.bidder) {
      void reply.code(401).send({ error: "unauthenticated" });
      return null;
    }
    return req.bidder.sub;
  };

  app.get("/api/public/auth/me", async (req, reply) => {
    const id = requireBidder(req, reply);
    if (!id) return;
    const [c] = await ctx.db.select().from(customers).where(eq(customers.id, id));
    if (!c || c.erasedAt !== null) return reply.code(401).send({ error: "unauthenticated" });
    return { bidder: { id: c.id, email: c.email, alias: c.alias, country: c.country, blocked: c.blocked, strikes: c.strikes } };
  });

  // ── Browse ────────────────────────────────────────────────────────────────

  app.get("/api/public/auctions", async (req) => {
    const q = req.query as { status?: string; market?: string };
    const statuses = q.status === "scheduled" ? ["scheduled"] : q.status === "ended" ? ["ended_won", "ended_reserve_not_met", "ended_no_bids"] : ["live", "scheduled"];
    const conditions = [inArray(auctions.status, statuses), eq(listings.status, "published")];
    if (q.market) conditions.push(eq(listings.marketCode, q.market.toUpperCase()));
    const rows = await ctx.db
      .select({ auction: auctions, listing: listings, item: items, leaderAlias: customers.alias })
      .from(auctions)
      .innerJoin(listings, eq(auctions.listingId, listings.id))
      .innerJoin(items, eq(listings.itemId, items.id))
      .leftJoin(customers, eq(auctions.leaderCustomerId, customers.id))
      .where(and(...conditions))
      .orderBy(asc(auctions.endsAt))
      .limit(200);
    return { auctions: rows.map(publicAuction) };
  });

  app.get("/api/public/auctions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await ctx.db
      .select({ auction: auctions, listing: listings, item: items, leaderAlias: customers.alias })
      .from(auctions)
      .innerJoin(listings, eq(auctions.listingId, listings.id))
      .innerJoin(items, eq(listings.itemId, items.id))
      .leftJoin(customers, eq(auctions.leaderCustomerId, customers.id))
      .where(eq(auctions.id, id));
    if (!row) return reply.code(404).send({ error: "not_found" });

    // Public ledger: alias + visible amount only. No maxima, no ids.
    const ledger = await ctx.db
      .select({
        alias: customers.alias,
        amountCents: bids.amountCents,
        auto: bids.auto,
        outbid: bids.outbid,
        seq: bids.seq,
        createdAt: bids.createdAt,
        customerId: bids.customerId,
        voidedAt: bids.voidedAt,
      })
      .from(bids)
      .innerJoin(customers, eq(bids.customerId, customers.id))
      .where(and(eq(bids.auctionId, id), isNull(bids.voidedAt)))
      .orderBy(desc(bids.seq))
      .limit(100);

    const me = req.bidder?.sub ?? null;
    return {
      auction: publicAuction(row),
      minNextBidCents: await minNext(row),
      bids: ledger.map((b) => ({
        alias: b.alias,
        amountCents: b.amountCents,
        auto: b.auto,
        outbid: b.outbid,
        seq: b.seq,
        createdAt: b.createdAt,
        isYou: me !== null && b.customerId === me,
      })),
    };
  });

  async function minNext(row: { auction: typeof auctions.$inferSelect; listing: typeof listings.$inferSelect }) {
    const { incrementAt } = await import("@auction/domain");
    const { markets } = await import("@auction/db");
    if (row.auction.currentPriceCents === null) return row.listing.startPriceCents ?? 0;
    const [market] = await ctx.db.select().from(markets).where(eq(markets.code, row.listing.marketCode));
    return row.auction.currentPriceCents + incrementAt(row.auction.currentPriceCents, market!.incrementTable);
  }

  // ── The real bid path ─────────────────────────────────────────────────────

  const bidSchema = z.object({ maxCents: z.number().int().positive() });
  app.post("/api/public/auctions/:id/bids", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const body = bidSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const { id } = req.params as { id: string };
    const result = await placeBid(ctx, { auctionId: id, customerId: bidderId, maxCents: body.data.maxCents });
    if (!result.ok) return reply.code(422).send(result);
    return {
      ok: true,
      currentPriceCents: result.currentPriceCents,
      youLead: result.leaderCustomerId === bidderId,
      leaderAlias: result.leaderAlias,
      bidCount: result.bidCount,
      endsAt: result.endsAt,
      extended: result.extended,
      reserveMet: result.reserveMet,
    };
  });

  // ── My activity ───────────────────────────────────────────────────────────

  app.get("/api/public/me/bids", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const rows = await ctx.db
      .selectDistinctOn([bids.auctionId], {
        auctionId: bids.auctionId,
        myLastBidAt: bids.createdAt,
      })
      .from(bids)
      .where(eq(bids.customerId, bidderId))
      .orderBy(bids.auctionId, desc(bids.seq));
    if (rows.length === 0) return { bids: [] };
    const auctionRows = await ctx.db
      .select({ auction: auctions, listing: listings, item: items, leaderAlias: customers.alias })
      .from(auctions)
      .innerJoin(listings, eq(auctions.listingId, listings.id))
      .innerJoin(items, eq(listings.itemId, items.id))
      .leftJoin(customers, eq(auctions.leaderCustomerId, customers.id))
      .where(inArray(auctions.id, rows.map((r) => r.auctionId)));
    return {
      bids: auctionRows.map((r) => ({
        ...publicAuction(r),
        youLead: r.auction.leaderCustomerId === bidderId,
      })),
    };
  });

  app.get("/api/public/me/orders", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const rows = await ctx.db
      .select({ order: orders, itemTitle: items.title, itemSku: items.sku })
      .from(orders)
      .innerJoin(items, eq(orders.itemId, items.id))
      .where(eq(orders.customerId, bidderId))
      .orderBy(desc(orders.createdAt))
      .limit(100);
    return {
      orders: rows.map((r) => ({
        ref: r.order.ref,
        itemTitle: r.itemTitle,
        itemSku: r.itemSku,
        hammerCents: r.order.hammerCents,
        premiumCents: r.order.premiumCents,
        vatCents: r.order.vatCents,
        totalCents: r.order.totalCents,
        status: r.order.status,
        paymentDeadlineAt: r.order.paymentDeadlineAt,
        createdAt: r.order.createdAt,
      })),
    };
  });
}
