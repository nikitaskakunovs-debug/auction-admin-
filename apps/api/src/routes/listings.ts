import { auctions, items, listings } from "@auction/db";
import { assertItemTransition, type ItemStatus } from "@auction/domain";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import type { AppContext } from "../context.js";
import { requirePermission, type PermissionService } from "../auth/rbac.js";

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
    const q = req.query as { status?: string; type?: string };
    const conditions = [];
    if (q.status) conditions.push(eq(listings.status, q.status));
    if (q.type) conditions.push(eq(listings.type, q.type));
    const rows = await ctx.db
      .select({ listing: listings, itemSku: items.sku, itemStatus: items.status })
      .from(listings)
      .innerJoin(items, eq(listings.itemId, items.id))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(listings.createdAt))
      .limit(500);
    return { listings: rows.map((r) => ({ ...r.listing, itemSku: r.itemSku, itemStatus: r.itemStatus })) };
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
      await writeAudit(tx, actor(req), "listing", "updated", row!.title, { fields: Object.keys(body.data) });
      return row!;
    });
    if (result === null) return reply.code(404).send({ error: "not_found" });
    if (result === "auction_open") return reply.code(409).send({ error: "pricing_locked_while_auction_open" });
    return { listing: result };
  });

  /** Publish: item draft→listed; auction listings also need POST /api/auctions to schedule a run. */
  app.post("/api/listings/:id/publish", guard("listings.publish"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = await ctx.db.transaction(async (tx) => {
      const [listing] = await tx.select().from(listings).where(eq(listings.id, id)).for("update");
      if (!listing) return null;
      const [item] = await tx.select().from(items).where(eq(items.id, listing.itemId)).for("update");
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
      await writeAudit(tx, actor(req), "listing", "published", listing.title);
      return row!;
    });
    if (result === null) return reply.code(404).send({ error: "not_found" });
    if (result === "item_busy") return reply.code(409).send({ error: "item_not_publishable" });
    return { listing: result };
  });
}
