import { customers, items, orders, stockMovements, warehouseLocations } from "@auction/db";
import { locationLabel, PICK_LINE_STATUSES } from "@auction/domain";
import { and, desc, eq, ilike, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { writeAudit, type Actor } from "../audit.js";
import type { AppContext } from "../context.js";
import {
  buildBoardPayload,
  cancelTicket,
  checkInByCode,
  checkInCustomer,
  claimTicket,
  completeTicket,
  markDelivering,
  setLineStatus,
  ticketQueue,
} from "../engine/pickup.js";
import { requirePermission, type PermissionService } from "../auth/rbac.js";

const actor = (req: { admin?: { sub: string; name: string } }): Actor => ({
  id: req.admin?.sub ?? null,
  label: req.admin?.name ?? "Unknown",
});

export function registerPickupRoutes(app: FastifyInstance, ctx: AppContext, perms: PermissionService): void {
  const guard = (p: Parameters<typeof requirePermission>[1]) => ({ preHandler: requirePermission(perms, p) });

  // ── Admin: pickup desk ────────────────────────────────────────────────────

  app.get("/api/pickup/queue", guard("pickup.view"), async () => {
    return { tickets: await ticketQueue(ctx) };
  });

  // Front-desk check-in: by customer id, or by searching a paid order ref /
  // pickup code / customer email (the same box handles all three).
  const deskCheckin = z.object({ customerId: z.string().uuid().optional(), query: z.string().min(2).optional() });
  app.post("/api/pickup/checkin", guard("pickup.operate"), async (req, reply) => {
    const body = deskCheckin.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });

    let customerId = body.data.customerId ?? null;
    if (!customerId && body.data.query) {
      const q = body.data.query.trim();
      const [byOrder] = await ctx.db
        .select({ customerId: orders.customerId })
        .from(orders)
        .where(and(eq(orders.status, "paid"), or(eq(orders.ref, q), eq(orders.pickupCode, q))))
        .limit(1);
      if (byOrder) customerId = byOrder.customerId;
      if (!customerId) {
        const [byEmail] = await ctx.db
          .select({ id: customers.id })
          .from(customers)
          .where(ilike(customers.email, q))
          .limit(1);
        if (byEmail) customerId = byEmail.id;
      }
    }
    if (!customerId) return reply.code(404).send({ error: "customer_not_found" });

    const result = await checkInCustomer(ctx, customerId, "desk", actor(req));
    if (!result.ok) return reply.code(409).send({ error: result.error });
    return result;
  });

  app.post("/api/pickup/tickets/:id/claim", guard("pickup.operate"), async (req, reply) => {
    const result = await claimTicket(ctx, (req.params as { id: string }).id, actor(req));
    if (!result.ok) return reply.code(409).send({ error: result.error });
    return result;
  });

  const lineBody = z.object({ status: z.enum(PICK_LINE_STATUSES.filter((s) => s !== "pending") as [string, ...string[]]) });
  app.post("/api/pickup/tickets/:id/lines/:lineId", guard("pickup.operate"), async (req, reply) => {
    const body = lineBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const { id, lineId } = req.params as { id: string; lineId: string };
    const result = await setLineStatus(ctx, id, lineId, body.data.status as "picked" | "missing" | "damaged", actor(req));
    if (!result.ok) return reply.code(409).send({ error: result.error });
    return result;
  });

  app.post("/api/pickup/tickets/:id/delivering", guard("pickup.operate"), async (req, reply) => {
    const result = await markDelivering(ctx, (req.params as { id: string }).id, actor(req));
    if (!result.ok) return reply.code(409).send({ error: result.error });
    return result;
  });

  const completeBody = z.object({ pickupCode: z.string().regex(/^\d{6}$/) });
  app.post("/api/pickup/tickets/:id/complete", guard("pickup.operate"), async (req, reply) => {
    const body = completeBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: "6-digit pickupCode required" });
    const result = await completeTicket(ctx, (req.params as { id: string }).id, body.data.pickupCode, actor(req));
    if (!result.ok) {
      return reply.code(result.error === "invalid_pickup_code" ? 403 : 409).send({ error: result.error });
    }
    return result;
  });

  const cancelBody = z.object({ reason: z.string().min(3) });
  app.post("/api/pickup/tickets/:id/cancel", guard("pickup.operate"), async (req, reply) => {
    const body = cancelBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: "reason required" });
    const result = await cancelTicket(ctx, (req.params as { id: string }).id, body.data.reason, actor(req));
    if (!result.ok) return reply.code(409).send({ error: result.error });
    return result;
  });

  // ── Admin: warehouse ERP (locations + movements) ──────────────────────────

  app.get("/api/warehouse/locations", guard("items.view"), async () => {
    const rows = await ctx.db.select().from(warehouseLocations).orderBy(warehouseLocations.label);
    return { locations: rows };
  });

  const locationBody = z.object({
    zone: z.string().min(1).max(16).transform((s) => s.toUpperCase()),
    aisle: z.string().max(16).default(""),
    rack: z.string().max(16).default(""),
    shelf: z.string().max(16).default(""),
    notes: z.string().max(500).default(""),
  });
  app.post("/api/warehouse/locations", guard("warehouse.manage"), async (req, reply) => {
    const body = locationBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const label = locationLabel(body.data);
    const [row] = await ctx.db
      .insert(warehouseLocations)
      .values({ ...body.data, label })
      .onConflictDoNothing()
      .returning();
    if (!row) return reply.code(409).send({ error: "label_exists", label });
    await writeAudit(ctx.db, actor(req), "item", "location_created", label);
    return { location: row };
  });

  app.patch("/api/warehouse/locations/:id", guard("warehouse.manage"), async (req, reply) => {
    const body = z.object({ active: z.boolean().optional(), notes: z.string().max(500).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const [row] = await ctx.db
      .update(warehouseLocations)
      .set(body.data)
      .where(eq(warehouseLocations.id, (req.params as { id: string }).id))
      .returning();
    if (!row) return reply.code(404).send({ error: "not_found" });
    await writeAudit(ctx.db, actor(req), "item", "location_updated", row.label, body.data);
    return { location: row };
  });

  // Putaway / move an item into a bin — the only way locations change, so the
  // movement ledger stays complete.
  const putawayBody = z.object({ locationId: z.string().uuid().nullable(), reason: z.string().max(200).default("") });
  app.post("/api/items/:id/putaway", guard("warehouse.manage"), async (req, reply) => {
    const body = putawayBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const { id } = req.params as { id: string };
    const result = await ctx.db.transaction(async (tx) => {
      const [item] = await tx.select().from(items).where(eq(items.id, id)).for("update");
      if (!item) return null;
      if (body.data.locationId) {
        const [loc] = await tx.select().from(warehouseLocations).where(eq(warehouseLocations.id, body.data.locationId));
        if (!loc || !loc.active) return "bad_location" as const;
      }
      const type = item.locationId === null ? "putaway" : body.data.locationId === null ? "adjust" : "move";
      await tx.insert(stockMovements).values({
        itemId: id,
        type,
        fromLocationId: item.locationId,
        toLocationId: body.data.locationId,
        actorId: req.admin!.sub,
        actorLabel: req.admin!.name,
        reason: body.data.reason,
      });
      await tx.update(items).set({ locationId: body.data.locationId, updatedAt: ctx.now() }).where(eq(items.id, id));
      return item;
    });
    if (result === null) return reply.code(404).send({ error: "not_found" });
    if (result === "bad_location") return reply.code(422).send({ error: "unknown_or_inactive_location" });
    return { ok: true };
  });

  app.get("/api/items/:id/movements", guard("items.view"), async (req) => {
    const { id } = req.params as { id: string };
    const from = warehouseLocations;
    const rows = await ctx.db
      .select({ movement: stockMovements, toLabel: from.label })
      .from(stockMovements)
      .leftJoin(from, eq(stockMovements.toLocationId, from.id))
      .where(eq(stockMovements.itemId, id))
      .orderBy(desc(stockMovements.createdAt))
      .limit(200);
    return { movements: rows.map((r) => ({ ...r.movement, toLabel: r.toLabel })) };
  });

  // ── Public: kiosk check-in + waiting-room boards ──────────────────────────

  // The 6-digit pickup code is the credential; a strict per-route rate limit
  // keeps brute force far below the 1-in-a-million guess odds.
  const kioskBody = z.object({ code: z.string().regex(/^\d{6}$/) });
  app.post(
    "/api/public/pickup/checkin",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const body = kioskBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: "6-digit code required" });
      const result = await checkInByCode(ctx, body.data.code, "kiosk");
      if (!result.ok) {
        return reply.code(result.error === "code_not_found" ? 404 : 409).send({ error: result.error });
      }
      return { ticketNumber: result.number, lineCount: result.lineCount, alreadyCheckedIn: result.alreadyCheckedIn };
    },
  );

  // PII-free by construction: ticket numbers, progress, zone counts only.
  app.get("/api/public/pickup/board", async () => buildBoardPayload(ctx));
}
