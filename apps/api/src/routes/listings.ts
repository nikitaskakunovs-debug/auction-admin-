import { auctions, items, listings, warehouseLocations } from "@auction/db";
import { assertItemTransition, type ItemStatus } from "@auction/domain";
import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import type { AppContext } from "../context.js";
import { requirePermission, type PermissionService } from "../auth/rbac.js";
import { recordPriceDrop } from "../engine/buyNowNudges.js";

const actor = (req: { admin?: { sub: string; name: string } }) => ({
  id: req.admin?.sub ?? null,
  label: req.admin?.name ?? "Unknown",
});

const PRICING_FIELDS = ["startPriceCents", "reserveCents", "priceCents"] as const;

const listingBody = z.object({
  itemId: z.string().uuid(),
  type: z.enum(["auction", "fixed"]),
  title: z.string().min(1),
  description: z.string().default(""),
  marketCode: z.string().length(2),
  startPriceCents: z.number().int().positive().nullable().optional(),
  reserveCents: z.number().int().positive().nullable().optional(),
  priceCents: z.number().int().positive().nullable().optional(),
  quantity: z.number().int().positive().default(1),
  antiSnipeSec: z.number().int().min(0).nullable().optional(),
});

export function registerListingRoutes(app: FastifyInstance, ctx: AppContext, perms: PermissionService): void {
  const guard = (p: Parameters<typeof requirePermission>[1]) => ({ preHandler: requirePermission(perms, p) });

  app.get("/api/listings", guard("listings.view"), async (req) => {
    const q = req.query as {
      status?: string; type?: string; q?: string; market?: string;
      from?: string; to?: string; sort?: string; limit?: string; offset?: string;
    };
    // Status apart from the rest — pill counts ignore the status choice (A3).
    const statusConds = q.status ? [eq(listings.status, q.status)] : [];
    const otherConds = [];
    if (q.type) otherConds.push(eq(listings.type, q.type));
    if (q.q) otherConds.push(or(ilike(listings.title, `%${q.q}%`), ilike(items.sku, `%${q.q}%`)));
    if (q.market) otherConds.push(eq(listings.marketCode, q.market.toUpperCase()));
    const dayStart = (d: string) => new Date(`${d}T00:00:00.000Z`);
    if (q.from) otherConds.push(sql`${listings.createdAt} >= ${dayStart(q.from)}`);
    if (q.to) otherConds.push(sql`${listings.createdAt} < ${new Date(dayStart(q.to).getTime() + 86_400_000)}`);

    const conditions = [...statusConds, ...otherConds];
    const where = conditions.length ? and(...conditions) : undefined;
    const limit = Math.min(Math.max(Number(q.limit) || 500, 1), 500);
    const offset = Math.max(Number(q.offset) || 0, 0);
    const order = q.sort === "oldest" ? listings.createdAt : q.sort === "title" ? listings.title : desc(listings.createdAt);

    const rows = await ctx.db
      .select({ listing: listings, itemSku: items.sku, itemStatus: items.status })
      .from(listings)
      .innerJoin(items, eq(listings.itemId, items.id))
      .where(where)
      .orderBy(order)
      .limit(limit)
      .offset(offset);
    const [totalRow] = await ctx.db
      .select({ n: sql<string>`count(*)` })
      .from(listings)
      .innerJoin(items, eq(listings.itemId, items.id))
      .where(where);
    const countRows = await ctx.db
      .select({ status: listings.status, n: sql<string>`count(*)` })
      .from(listings)
      .innerJoin(items, eq(listings.itemId, items.id))
      .where(otherConds.length ? and(...otherConds) : undefined)
      .groupBy(listings.status);
    return {
      listings: rows.map((r) => ({ ...r.listing, itemSku: r.itemSku, itemStatus: r.itemStatus })),
      total: Number(totalRow!.n),
      counts: Object.fromEntries(countRows.map((r) => [r.status, Number(r.n)])),
    };
  });

  app.get("/api/listings/:id", guard("listings.view"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await ctx.db
      .select({ listing: listings, item: items })
      .from(listings)
      .innerJoin(items, eq(listings.itemId, items.id))
      .where(eq(listings.id, id));
    if (!row) return reply.code(404).send({ error: "not_found" });
    const history = await ctx.db
      .select()
      .from(auctions)
      .where(eq(auctions.listingId, id))
      .orderBy(desc(auctions.createdAt));
    return {
      listing: row.listing,
      item: row.item,
      auctions: history.map(({ leaderMaxCents: _h, leaderSeq: _s, ...a }) => a),
    };
  });

  app.post("/api/listings", guard("listings.create"), async (req, reply) => {
    const body = listingBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    if (body.data.type === "auction" && !body.data.startPriceCents) {
      return reply.code(400).send({ error: "auction_needs_start_price" });
    }
    if (body.data.type === "fixed" && !body.data.priceCents) {
      return reply.code(400).send({ error: "fixed_needs_price" });
    }
    // Setting pricing at creation requires the commercial permission.
    if (!(await perms.has(req.admin!.role, "listings.set_pricing")) && (body.data.reserveCents ?? null) !== null) {
      return reply.code(403).send({ error: "forbidden", permission: "listings.set_pricing" });
    }
    const [item] = await ctx.db.select().from(items).where(eq(items.id, body.data.itemId));
    if (!item) return reply.code(404).send({ error: "item_not_found" });
    const [row] = await ctx.db
      .insert(listings)
      .values({
        ...body.data,
        startPriceCents: body.data.startPriceCents ?? null,
        reserveCents: body.data.reserveCents ?? null,
        priceCents: body.data.priceCents ?? null,
        antiSnipeSec: body.data.antiSnipeSec ?? null,
        createdBy: req.admin!.sub,
      })
      .returning();
    await writeAudit(ctx.db, actor(req), "listing", "created", row!.title);
    return { listing: row };
  });

  app.patch("/api/listings/:id", guard("listings.edit"), async (req, reply) => {
    const body = listingBody.partial().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const touchesPricing = PRICING_FIELDS.some((f) => f in (req.body as Record<string, unknown>));
    if (touchesPricing && !(await perms.has(req.admin!.role, "listings.set_pricing"))) {
      return reply.code(403).send({ error: "forbidden", permission: "listings.set_pricing" });
    }
    const { id } = req.params as { id: string };
    const result = await ctx.db.transaction(async (tx) => {
      const [listing] = await tx.select().from(listings).where(eq(listings.id, id)).for("update");
      if (!listing) return null;
      // Pricing of a listing with an open auction is immutable.
      if (touchesPricing) {
        const open = await tx
          .select({ id: auctions.id })
          .from(auctions)
          .where(and(eq(auctions.listingId, id), inArray(auctions.status, ["scheduled", "live"])));
        if (open.length > 0) return "auction_open" as const;
      }
      const { itemId: _noMove, type: _noType, ...patch } = body.data;
      const [row] = await tx
        .update(listings)
        .set({ ...patch, updatedAt: ctx.now() })
        .where(eq(listings.id, id))
        .returning();
      // Цену снизили — повод написать тем, у кого лот в отслеживаемых. Само
      // письмо уходит не сейчас, а после паузы: см. recordPriceDrop.
      if (
        listing.priceCents !== null &&
        row!.priceCents !== null &&
        row!.priceCents < listing.priceCents
      ) {
        await recordPriceDrop(ctx, tx, {
          listingId: id,
          oldPriceCents: listing.priceCents,
          newPriceCents: row!.priceCents,
        });
      }
      await writeAudit(tx, actor(req), "listing", "updated", row!.title, { fields: Object.keys(body.data) });
      return row!;
    });
    if (result === null) return reply.code(404).send({ error: "not_found" });
    if (result === "auction_open") return reply.code(409).send({ error: "pricing_locked_while_auction_open" });
    return { listing: result };
  });

  /** Publish transaction body — shared by the single and A3 bulk endpoints. */
  async function publishOne(
    id: string,
    who: { id: string | null; label: string },
  ): Promise<typeof listings.$inferSelect | null | "quarantined" | "grade_pending" | "item_busy"> {
    return await ctx.db.transaction(async (tx) => {
      const [listing] = await tx.select().from(listings).where(eq(listings.id, id)).for("update");
      if (!listing) return null;
      const [item] = await tx.select().from(items).where(eq(items.id, listing.itemId)).for("update");
      // Quarantined stock (pulled for damage/rephoto/regrade) cannot go live.
      if (item!.locationId) {
        const [loc] = await tx.select({ zone: warehouseLocations.zone }).from(warehouseLocations).where(eq(warehouseLocations.id, item!.locationId));
        if (loc?.zone === "QUARANTINE") return "quarantined" as const;
      }
      // A grade awaiting listing-manager review cannot go live either (W2).
      if (item!.gradeStatus === "pending_review") return "grade_pending" as const;
      if (item!.status === "draft") {
        assertItemTransition("draft", "listed");
        await tx.update(items).set({ status: "listed", updatedAt: ctx.now() }).where(eq(items.id, item!.id));
      } else if (item!.status !== "listed") {
        return "item_busy" as const;
      }
      const [row] = await tx
        .update(listings)
        .set({ status: "published", updatedAt: ctx.now() })
        .where(eq(listings.id, id))
        .returning();
      await writeAudit(tx, who, "listing", "published", listing.title);
      return row!;
    });
  }

  /** Publish: item draft→listed; auction listings also need POST /api/auctions to schedule a run. */
  app.post("/api/listings/:id/publish", guard("listings.publish"), async (req, reply) => {
    const result = await publishOne((req.params as { id: string }).id, actor(req));
    if (result === null) return reply.code(404).send({ error: "not_found" });
    if (result === "quarantined") return reply.code(409).send({ error: "item_quarantined" });
    if (result === "grade_pending") return reply.code(409).send({ error: "grade_pending_review" });
    if (result === "item_busy") return reply.code(409).send({ error: "item_not_publishable" });
    return { listing: result };
  });

  // ── A3 bulk actions ────────────────────────────────────────────────────────

  const bulkPublishBody = z.object({
    ids: z.array(z.string().uuid()).min(1).max(100),
    /** Optional auction run for auction-type listings, like the quick-create flow. */
    schedule: z.object({ startsAt: z.coerce.date(), endsAt: z.coerce.date() }).optional(),
  });
  app.post("/api/listings/bulk/publish", guard("listings.publish"), async (req, reply) => {
    const body = bulkPublishBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const { ids, schedule } = body.data;
    if (schedule && schedule.endsAt.getTime() <= schedule.startsAt.getTime()) {
      return reply.code(400).send({ error: "ends_before_start" });
    }
    let published = 0;
    let scheduled = 0;
    const failed: Array<{ id: string; error: string }> = [];
    for (const id of ids) {
      const result = await publishOne(id, actor(req));
      if (result === null || typeof result === "string") {
        failed.push({ id, error: result === null ? "not_found" : result });
        continue;
      }
      published++;
      if (schedule && result.type === "auction") {
        // Same rules as POST /api/auctions: one open run per listing.
        const created = await ctx.db.transaction(async (tx) => {
          const open = await tx
            .select({ id: auctions.id })
            .from(auctions)
            .where(and(eq(auctions.listingId, id), inArray(auctions.status, ["scheduled", "live"])));
          if (open.length > 0) return false;
          const [a] = await tx
            .insert(auctions)
            .values({ listingId: id, status: "scheduled", startsAt: schedule.startsAt, endsAt: schedule.endsAt })
            .returning({ id: auctions.id });
          await writeAudit(tx, actor(req), "auction", "scheduled", result.title, {
            auctionId: a!.id,
            startsAt: schedule.startsAt.toISOString(),
            endsAt: schedule.endsAt.toISOString(),
            bulk: true,
          });
          return true;
        });
        if (created) scheduled++;
      }
    }
    return { published, scheduled, failed };
  });

  const bulkArchiveBody = z.object({ ids: z.array(z.string().uuid()).min(1).max(100) });
  app.post("/api/listings/bulk/archive", guard("listings.edit"), async (req, reply) => {
    const body = bulkArchiveBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    // Only drafts archive in bulk — a published listing may have live bidding
    // and keeps its existing one-at-a-time paths.
    const rows = await ctx.db
      .update(listings)
      .set({ status: "archived", updatedAt: ctx.now() })
      .where(and(inArray(listings.id, body.data.ids), eq(listings.status, "draft")))
      .returning({ id: listings.id, title: listings.title });
    for (const r of rows) await writeAudit(ctx.db, actor(req), "listing", "archived", r.title, { bulk: true });
    return { archived: rows.length, skipped: body.data.ids.length - rows.length };
  });
}
