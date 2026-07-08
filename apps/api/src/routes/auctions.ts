import { auctions, bids, customers, items, listings } from "@auction/db";
import { assertAuctionTransition, assertItemTransition, type AuctionStatus, type ItemStatus } from "@auction/domain";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { publishAuctionEvent, type AppContext } from "../context.js";
import { placeBid, voidBid } from "../engine/bids.js";
import { requirePermission, type PermissionService } from "../auth/rbac.js";

const actor = (req: { admin?: { sub: string; name: string } }) => ({
  id: req.admin?.sub ?? null,
  label: req.admin?.name ?? "Unknown",
});

/** Public/admin-safe auction serialization: the proxy max NEVER leaves. */
function auctionDto(a: typeof auctions.$inferSelect, extra: Record<string, unknown> = {}) {
  const { leaderMaxCents: _hidden, leaderSeq: _seq, ...safe } = a;
  return { ...safe, ...extra };
}

export function registerAuctionRoutes(app: FastifyInstance, ctx: AppContext, perms: PermissionService): void {
  const guard = (p: Parameters<typeof requirePermission>[1]) => ({ preHandler: requirePermission(perms, p) });

  app.get("/api/auctions", guard("auctions.view"), async (req) => {
    const q = req.query as { status?: string };
    const rows = await ctx.db
      .select({
        auction: auctions,
        listingTitle: listings.title,
        listingType: listings.type,
        reserveCents: listings.reserveCents,
        startPriceCents: listings.startPriceCents,
        itemSku: items.sku,
        leaderAlias: customers.alias,
      })
      .from(auctions)
      .innerJoin(listings, eq(auctions.listingId, listings.id))
      .innerJoin(items, eq(listings.itemId, items.id))
      .leftJoin(customers, eq(auctions.leaderCustomerId, customers.id))
      .where(q.status ? eq(auctions.status, q.status) : undefined)
      .orderBy(desc(auctions.endsAt))
      .limit(500);
    return {
      auctions: rows.map((r) =>
        auctionDto(r.auction, {
          listingTitle: r.listingTitle,
          listingType: r.listingType,
          reserveCents: r.reserveCents,
          startPriceCents: r.startPriceCents,
          itemSku: r.itemSku,
          leaderAlias: r.leaderAlias,
        }),
      ),
    };
  });

  app.get("/api/auctions/:id", guard("auctions.view"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await ctx.db
      .select({
        auction: auctions,
        listing: listings,
        item: items,
        leaderAlias: customers.alias,
      })
      .from(auctions)
      .innerJoin(listings, eq(auctions.listingId, listings.id))
      .innerJoin(items, eq(listings.itemId, items.id))
      .leftJoin(customers, eq(auctions.leaderCustomerId, customers.id))
      .where(eq(auctions.id, id));
    if (!row) return reply.code(404).send({ error: "not_found" });

    const ledger = await ctx.db
      .select({
        id: bids.id,
        amountCents: bids.amountCents,
        auto: bids.auto,
        outbid: bids.outbid,
        seq: bids.seq,
        voidedAt: bids.voidedAt,
        voidReason: bids.voidReason,
        createdAt: bids.createdAt,
        customerId: bids.customerId,
        alias: customers.alias,
      })
      .from(bids)
      .innerJoin(customers, eq(bids.customerId, customers.id))
      .where(eq(bids.auctionId, id))
      .orderBy(desc(bids.seq));

    return {
      auction: auctionDto(row.auction, { leaderAlias: row.leaderAlias }),
      listing: row.listing, // admin detail: reserve visible here, max still hidden
      item: row.item,
      bids: ledger,
    };
  });

  const createSchema = z.object({
    listingId: z.string().uuid(),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
  });
  app.post("/api/auctions", guard("listings.publish"), async (req, reply) => {
    const body = createSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    if (body.data.endsAt.getTime() <= body.data.startsAt.getTime()) {
      return reply.code(400).send({ error: "ends_before_start" });
    }
    const created = await ctx.db.transaction(async (tx) => {
      const [listing] = await tx.select().from(listings).where(eq(listings.id, body.data.listingId)).for("update");
      if (!listing || listing.type !== "auction") return null;
      const open = await tx
        .select({ id: auctions.id })
        .from(auctions)
        .where(and(eq(auctions.listingId, listing.id), inArray(auctions.status, ["scheduled", "live"])));
      if (open.length > 0) return "conflict" as const;
      const [item] = await tx.select().from(items).where(eq(items.id, listing.itemId)).for("update");
      if (!item || item.status !== "listed") return "item_not_listed" as const;
      const [a] = await tx
        .insert(auctions)
        .values({ listingId: listing.id, status: "scheduled", startsAt: body.data.startsAt, endsAt: body.data.endsAt })
        .returning();
      await writeAudit(tx, actor(req), "auction", "scheduled", listing.title, {
        auctionId: a!.id,
        startsAt: body.data.startsAt.toISOString(),
        endsAt: body.data.endsAt.toISOString(),
      });
      return a!;
    });
    if (created === null) return reply.code(404).send({ error: "listing_not_found_or_not_auction" });
    if (created === "conflict") return reply.code(409).send({ error: "auction_already_open_for_listing" });
    if (created === "item_not_listed") return reply.code(409).send({ error: "item_not_in_listed_state" });
    return { auction: auctionDto(created) };
  });

  const extendSchema = z.object({ minutes: z.number().int().min(1).max(7 * 24 * 60), reason: z.string().min(3) });
  app.post("/api/auctions/:id/extend", guard("auctions.extend"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = extendSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const updated = await ctx.db.transaction(async (tx) => {
      const [a] = await tx.select().from(auctions).where(eq(auctions.id, id)).for("update");
      if (!a || (a.status !== "live" && a.status !== "scheduled")) return null;
      const endsAt = new Date(a.endsAt.getTime() + body.data.minutes * 60_000);
      await tx.update(auctions).set({ endsAt }).where(eq(auctions.id, id));
      await writeAudit(tx, actor(req), "auction", "extended_manually", id, {
        minutes: body.data.minutes,
        reason: body.data.reason,
      });
      return endsAt;
    });
    if (!updated) return reply.code(409).send({ error: "not_extendable" });
    await publishAuctionEvent(ctx, {
      type: "extended",
      auctionId: id,
      at: ctx.now().toISOString(),
      data: { endsAt: updated.toISOString(), manual: true },
    });
    return { ok: true, endsAt: updated.toISOString() };
  });

  const cancelSchema = z.object({ reason: z.string().min(3) });
  app.post("/api/auctions/:id/cancel", guard("auctions.cancel"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = cancelSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: "reason required" });
    const ok = await ctx.db.transaction(async (tx) => {
      const [a] = await tx.select().from(auctions).where(eq(auctions.id, id)).for("update");
      if (!a) return false;
      assertAuctionTransition(a.status as AuctionStatus, "cancelled");
      const [listing] = await tx.select().from(listings).where(eq(listings.id, a.listingId));
      const [item] = await tx.select().from(items).where(eq(items.id, listing!.itemId));
      await tx.update(auctions).set({ status: "cancelled", closedAt: ctx.now() }).where(eq(auctions.id, id));
      if (item!.status === "live") {
        assertItemTransition("live", "listed");
        await tx.update(items).set({ status: "listed", updatedAt: ctx.now() }).where(eq(items.id, item!.id));
      }
      await writeAudit(tx, actor(req), "auction", "cancelled", listing!.title, { auctionId: id, reason: body.data.reason });
      return true;
    });
    if (!ok) return reply.code(404).send({ error: "not_found" });
    await publishAuctionEvent(ctx, {
      type: "cancelled",
      auctionId: id,
      at: ctx.now().toISOString(),
      data: { reason: body.data.reason },
    });
    return { ok: true };
  });

  const relistSchema = z.object({ startsAt: z.coerce.date(), endsAt: z.coerce.date() });
  app.post("/api/auctions/:id/relist", guard("auctions.relist"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = relistSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const created = await ctx.db.transaction(async (tx) => {
      const [a] = await tx.select().from(auctions).where(eq(auctions.id, id)).for("update");
      if (!a || !["ended_reserve_not_met", "ended_no_bids", "cancelled"].includes(a.status)) return null;
      const [listing] = await tx.select().from(listings).where(eq(listings.id, a.listingId)).for("update");
      const [item] = await tx.select().from(items).where(eq(items.id, listing!.itemId)).for("update");
      if (item!.status === "unsold" || item!.status === "unpaid_cancelled") {
        assertItemTransition(item!.status as ItemStatus, "listed");
        await tx.update(items).set({ status: "listed", updatedAt: ctx.now() }).where(eq(items.id, item!.id));
      } else if (item!.status !== "listed") {
        return "item_not_relistable" as const;
      }
      const [next] = await tx
        .insert(auctions)
        .values({ listingId: listing!.id, status: "scheduled", startsAt: body.data.startsAt, endsAt: body.data.endsAt })
        .returning();
      await writeAudit(tx, actor(req), "auction", "relisted", listing!.title, {
        fromAuctionId: id,
        toAuctionId: next!.id,
      });
      return next!;
    });
    if (created === null) return reply.code(409).send({ error: "not_relistable" });
    if (created === "item_not_relistable") return reply.code(409).send({ error: "item_not_relistable" });
    return { auction: auctionDto(created) };
  });

  // Dev/staging bid simulation — the public bidder API is a later phase.
  const bidSchema = z.object({ customerId: z.string().uuid(), maxCents: z.number().int().positive() });
  app.post("/api/auctions/:id/bids", async (req, reply) => {
    if (!ctx.config.allowBidSimulation) return reply.code(403).send({ error: "bid_simulation_disabled" });
    if (!req.admin) return reply.code(401).send({ error: "unauthenticated" });
    const { id } = req.params as { id: string };
    const body = bidSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const result = await placeBid(ctx, { auctionId: id, customerId: body.data.customerId, maxCents: body.data.maxCents });
    if (!result.ok) return reply.code(422).send(result);
    return result;
  });

  const voidSchema = z.object({ reason: z.string().min(3) });
  app.post("/api/auctions/:id/bids/:bidId/void", guard("auctions.void_bid"), async (req, reply) => {
    const { id, bidId } = req.params as { id: string; bidId: string };
    const body = voidSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: "reason required" });
    const result = await voidBid(ctx, { auctionId: id, bidId, reason: body.data.reason });
    if (!result.ok) return reply.code(409).send(result);
    await writeAudit(ctx.db, actor(req), "auction", "bid_voided", id, { bidId, reason: body.data.reason });
    return result;
  });
}
