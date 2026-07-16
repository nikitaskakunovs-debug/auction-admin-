import { createHash, randomBytes } from "node:crypto";
import {
  auctions,
  bids,
  customerFees,
  customerRefreshTokens,
  customers,
  hashPassword,
  items,
  listings,
  orders,
  shipments,
  verifyPassword,
} from "@auction/db";
import { and, asc, desc, eq, gt, ilike, inArray, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { signAccessToken } from "../auth/jwt.js";
import {
  createResetToken,
  findValidResetToken,
  markResetTokenUsed,
  resetEmail,
  resetRequestAllowed,
} from "../auth/passwordReset.js";
import type { AppContext } from "../context.js";
import { placeBid } from "../engine/bids.js";
import { buyNow } from "../engine/purchase.js";

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
    conditionNotes: item.conditionNotes,
    category: item.category,
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

  // ── Forgot password (emailed single-use link) ─────────────────────────────
  app.post("/api/public/auth/forgot-password", async (req, reply) => {
    const body = z.object({ email: z.string().email() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const email = body.data.email.toLowerCase();
    // Flat "ok" whether or not the account exists; lookup + email happen
    // after the response so timing can't reveal existence either.
    void (async () => {
      if (!(await resetRequestAllowed(ctx.redis, email))) return;
      const [customer] = await ctx.db.select().from(customers).where(eq(customers.email, email));
      if (!customer || customer.erasedAt !== null || !customer.passwordHash) return;
      const token = await createResetToken(ctx, { customerId: customer.id });
      const link = `${ctx.config.storefrontBaseUrl}/reset-password?token=${token}`;
      const msg = resetEmail(link, Math.round(ctx.config.passwordResetTtlSec / 60));
      await ctx.email.send({ to: customer.email, subject: msg.subject, text: msg.text });
    })().catch((err) => req.log.error({ err }, "customer forgot-password processing failed"));
    return reply.send({ ok: true });
  });

  app.post("/api/public/auth/reset-password", async (req, reply) => {
    const body = z.object({ token: z.string().min(20), newPassword: z.string().min(8) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const found = await findValidResetToken(ctx, body.data.token);
    if (!found || !found.customerId) return reply.code(401).send({ error: "invalid_or_expired_token" });
    const [customer] = await ctx.db.select().from(customers).where(eq(customers.id, found.customerId));
    if (!customer || customer.erasedAt !== null) return reply.code(401).send({ error: "invalid_or_expired_token" });
    await ctx.db
      .update(customers)
      .set({ passwordHash: await hashPassword(body.data.newPassword) })
      .where(eq(customers.id, customer.id));
    await markResetTokenUsed(ctx, found.rowId);
    // Credential change ends every live session on every device.
    await ctx.db
      .update(customerRefreshTokens)
      .set({ revokedAt: ctx.now() })
      .where(and(eq(customerRefreshTokens.customerId, customer.id), isNull(customerRefreshTokens.revokedAt)));
    return { ok: true };
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

  /** Catalog paging: ?q= title search, ?category= code, ?limit/?offset. */
  const pageParams = (q: { limit?: string; offset?: string }) => ({
    limit: Math.min(Math.max(Number(q.limit) || 48, 1), 100),
    offset: Math.max(Number(q.offset) || 0, 0),
  });

  app.get("/api/public/auctions", async (req) => {
    const q = req.query as { status?: string; market?: string; q?: string; category?: string; limit?: string; offset?: string };
    const statuses = q.status === "scheduled" ? ["scheduled"] : q.status === "ended" ? ["ended_won", "ended_reserve_not_met", "ended_no_bids"] : ["live", "scheduled"];
    const conditions = [inArray(auctions.status, statuses), eq(listings.status, "published")];
    if (q.market) conditions.push(eq(listings.marketCode, q.market.toUpperCase()));
    if (q.category) conditions.push(eq(items.category, q.category));
    if (q.q && q.q.trim().length >= 2) conditions.push(ilike(listings.title, `%${q.q.trim()}%`));
    const { limit, offset } = pageParams(q);
    const rows = await ctx.db
      .select({ auction: auctions, listing: listings, item: items, leaderAlias: customers.alias })
      .from(auctions)
      .innerJoin(listings, eq(auctions.listingId, listings.id))
      .innerJoin(items, eq(listings.itemId, items.id))
      .leftJoin(customers, eq(auctions.leaderCustomerId, customers.id))
      .where(and(...conditions))
      .orderBy(asc(auctions.endsAt))
      .limit(limit + 1)
      .offset(offset);
    return { auctions: rows.slice(0, limit).map(publicAuction), hasMore: rows.length > limit };
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
      // What the current price actually costs the winner (hammer + buyer
      // premium + VAT) — drives the Pay Later monthly-payment calculator.
      estimatedTotalCents: await estimatedTotal(row),
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

  /** Full cost of the current price: hammer + buyer premium + VAT. */
  async function estimatedTotal(row: { auction: typeof auctions.$inferSelect; listing: typeof listings.$inferSelect }) {
    const { computeInvoice } = await import("@auction/domain");
    const { markets } = await import("@auction/db");
    const hammer = row.auction.currentPriceCents ?? row.listing.startPriceCents ?? 0;
    const [market] = await ctx.db.select().from(markets).where(eq(markets.code, row.listing.marketCode));
    return computeInvoice({ hammerCents: hammer, buyerPremiumBp: market!.buyerPremiumBp, vatRateBp: market!.vatRateBp }).totalCents;
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
    // Latest shipment per order — the bidder's tracking line.
    const orderIds = rows.map((r) => r.order.id);
    const shipmentRows = orderIds.length
      ? await ctx.db
          .select({
            orderId: shipments.orderId,
            barcode: shipments.barcode,
            status: shipments.status,
            createdAt: shipments.createdAt,
          })
          .from(shipments)
          .where(inArray(shipments.orderId, orderIds))
          .orderBy(desc(shipments.createdAt))
      : [];
    const shipmentByOrder = new Map<string, (typeof shipmentRows)[number]>();
    for (const s of shipmentRows) if (!shipmentByOrder.has(s.orderId)) shipmentByOrder.set(s.orderId, s);
    return {
      orders: rows.map((r) => {
        const shipment = shipmentByOrder.get(r.order.id) ?? null;
        return {
          ref: r.order.ref,
          itemTitle: r.itemTitle,
          itemSku: r.itemSku,
          hammerCents: r.order.hammerCents,
          premiumCents: r.order.premiumCents,
          vatCents: r.order.vatCents,
          shippingCents: r.order.shippingCents,
          handlingCents: r.order.handlingCents,
          totalCents: r.order.totalCents,
          status: r.order.status,
          paymentDeadlineAt: r.order.paymentDeadlineAt,
          createdAt: r.order.createdAt,
          fulfilment: r.order.fulfilment,
          shippingTo: r.order.shippingTo,
          shipment: shipment ? { barcode: shipment.barcode, status: shipment.status } : null,
        };
      }),
    };
  });

  // Outstanding restock fees — the reason an account is paused. Shown on the
  // account page with the amount and the order each claim came from.
  app.get("/api/public/me/fees", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const rows = await ctx.db
      .select({
        orderRef: customerFees.orderRef,
        type: customerFees.type,
        amountCents: customerFees.amountCents,
        createdAt: customerFees.createdAt,
      })
      .from(customerFees)
      .where(and(eq(customerFees.customerId, bidderId), eq(customerFees.status, "outstanding")))
      .orderBy(desc(customerFees.createdAt));
    return {
      fees: rows,
      outstandingCents: rows.reduce((sum, f) => sum + f.amountCents, 0),
    };
  });

  // Pickup pass: the bidder's own paid, uncollected orders with the 6-digit
  // collection code + deadline (rendered as a QR on the account page).
  app.get("/api/public/me/pickup", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const rows = await ctx.db
      .select({ order: orders, itemTitle: items.title, itemStatus: items.status })
      .from(orders)
      .innerJoin(items, eq(orders.itemId, items.id))
      .where(and(eq(orders.customerId, bidderId), eq(orders.status, "paid")))
      .orderBy(desc(orders.paidAt))
      .limit(50);
    return {
      pickup: rows
        .filter((r) => r.itemStatus === "paid" || r.itemStatus === "picking")
        .map((r) => ({
          ref: r.order.ref,
          itemTitle: r.itemTitle,
          pickupCode: r.order.pickupCode,
          pickupDeadlineAt: r.order.pickupDeadlineAt,
          collecting: r.itemStatus === "picking",
        })),
    };
  });

  // ── Fixed-price "buy it now" ───────────────────────────────────────────────

  function publicListing(row: {
    listing: typeof listings.$inferSelect;
    item: typeof items.$inferSelect;
  }) {
    const { listing, item } = row;
    return {
      id: listing.id,
      title: listing.title,
      description: listing.description,
      sku: item.sku,
      condition: item.condition,
      conditionNotes: item.conditionNotes,
      category: item.category,
      photos: item.photos,
      marketCode: listing.marketCode,
      priceCents: listing.priceCents,
      quantity: listing.quantity,
    };
  }

  app.get("/api/public/listings", async (req) => {
    const q = req.query as { market?: string; q?: string; category?: string; limit?: string; offset?: string };
    const conds = [
      eq(listings.type, "fixed"),
      eq(listings.status, "published"),
      gt(listings.quantity, 0),
      eq(items.status, "listed"),
    ];
    if (q.market) conds.push(eq(listings.marketCode, q.market.toUpperCase()));
    if (q.category) conds.push(eq(items.category, q.category));
    if (q.q && q.q.trim().length >= 2) conds.push(ilike(listings.title, `%${q.q.trim()}%`));
    const { limit, offset } = pageParams(q);
    const rows = await ctx.db
      .select({ listing: listings, item: items })
      .from(listings)
      .innerJoin(items, eq(listings.itemId, items.id))
      .where(and(...conds))
      .orderBy(desc(listings.createdAt))
      .limit(limit + 1)
      .offset(offset);
    return { listings: rows.slice(0, limit).map(publicListing), hasMore: rows.length > limit };
  });

  app.get("/api/public/listings/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await ctx.db
      .select({ listing: listings, item: items })
      .from(listings)
      .innerJoin(items, eq(listings.itemId, items.id))
      .where(eq(listings.id, id));
    // Serve published (buyable) and archived (sold) fixed listings so a shared
    // link shows "sold out" rather than 404; drafts stay hidden.
    if (!row || row.listing.type !== "fixed" || row.listing.status === "draft") {
      return reply.code(404).send({ error: "not_found" });
    }
    const soldOut = row.listing.status !== "published" || row.item.status !== "listed";
    // Checkout total for fixed-price buys: price + VAT (no buyer premium,
    // mirroring engine/purchase.ts). Drives the Pay Later calculator.
    const { computeInvoice } = await import("@auction/domain");
    const { markets } = await import("@auction/db");
    const [market] = await ctx.db.select().from(markets).where(eq(markets.code, row.listing.marketCode));
    const estimatedTotalCents = computeInvoice({
      hammerCents: row.listing.priceCents ?? 0,
      buyerPremiumBp: 0,
      vatRateBp: market!.vatRateBp,
    }).totalCents;
    return { listing: { ...publicListing(row), soldOut, estimatedTotalCents } };
  });

  app.post("/api/public/listings/:id/buy", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const { id } = req.params as { id: string };
    const result = await buyNow(ctx, { listingId: id, customerId: bidderId });
    if (!result.ok) {
      const status = result.code === "LISTING_NOT_FOUND" ? 404 : result.code === "NOT_AVAILABLE" ? 409 : 422;
      return reply.code(status).send(result);
    }
    return result;
  });
}
