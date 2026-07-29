import { adminUsers, items, pickupTickets, stockMovements, warehouseLocations, workerStatus } from "@auction/db";
import { assertTicketTransition, dayKey, type Permission, type TicketStatus } from "@auction/domain";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { writeAudit, type Actor } from "../audit.js";
import type { AppContext } from "../context.js";
import { publishBoard } from "../engine/pickup.js";
import { requirePermission, type PermissionService } from "../auth/rbac.js";

const actor = (req: { admin?: { sub: string; name: string } }): Actor => ({
  id: req.admin?.sub ?? null,
  label: req.admin?.name ?? "Unknown",
});

/** Worker shift statuses shown on the admin live board. */
const WORKER_STATUSES = ["working", "coffee", "lunch", "done"] as const;

/** Quarantine bin — auto-created on first pull-to-quarantine. */
const QUARANTINE_ZONE = "QUARANTINE";
const QUARANTINE_LABEL = "QUAR-01";

/**
 * Phase W1 warehouse operations: worker presence, pickup-ticket handoff
 * (pass / accept / decline), and pull-from-shelf with optional quarantine.
 */
export function registerWarehouseOpsRoutes(app: FastifyInstance, ctx: AppContext, perms: PermissionService): void {
  const guard = (p: Parameters<typeof requirePermission>[1]) => ({ preHandler: requirePermission(perms, p) });

  // Multi-permission guard (any-of) — same manual pattern as /api/search.
  const requireAny =
    (...permissions: Permission[]) =>
    async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      if (!req.admin) {
        await reply.code(401).send({ error: "unauthenticated" });
        return;
      }
      const have = await perms.permissionsFor(req.admin.role);
      if (!permissions.some((p) => have.has(p))) {
        await reply.code(403).send({ error: "forbidden", permission: permissions.join("|") });
        return;
      }
    };
  const statusGuard = { preHandler: requireAny("warehouse.manage", "pickup.operate") };

  // ── Worker status (one row per admin per day, updated in place) ────────────

  const statusBody = z.object({ status: z.enum(WORKER_STATUSES) });
  app.post("/api/warehouse/status", statusGuard, async (req, reply) => {
    const body = statusBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const today = dayKey(ctx.now());
    const [row] = await ctx.db
      .insert(workerStatus)
      .values({ userId: req.admin!.sub, dayKey: today, status: body.data.status, sinceAt: ctx.now() })
      .onConflictDoUpdate({
        target: [workerStatus.userId, workerStatus.dayKey],
        set: { status: body.data.status, sinceAt: ctx.now() },
      })
      .returning();
    await writeAudit(ctx.db, actor(req), "pickup", "worker_status", body.data.status);
    return { status: row };
  });

  app.get("/api/warehouse/status/today", statusGuard, async () => {
    const today = dayKey(ctx.now());
    const rows = await ctx.db
      .select({ userId: workerStatus.userId, name: adminUsers.name, status: workerStatus.status, sinceAt: workerStatus.sinceAt })
      .from(workerStatus)
      .innerJoin(adminUsers, eq(workerStatus.userId, adminUsers.id))
      .where(eq(workerStatus.dayKey, today))
      .orderBy(adminUsers.name);
    // The ticket each worker is currently picking (today, at most one each).
    const picking = await ctx.db
      .select({ claimedById: pickupTickets.claimedById, number: pickupTickets.number })
      .from(pickupTickets)
      .where(and(eq(pickupTickets.dayKey, today), eq(pickupTickets.status, "picking")));
    const ticketByWorker = new Map(picking.filter((p) => p.claimedById !== null).map((p) => [p.claimedById!, p.number]));
    return {
      workers: rows.map((r) => ({
        userId: r.userId,
        name: r.name,
        status: r.status,
        sinceAt: r.sinceAt.toISOString(),
        currentTicketNumber: ticketByWorker.get(r.userId) ?? null,
      })),
    };
  });

  // ── Ticket handoff: pass to queue / pass to colleague → accept | decline ───

  const passBody = z.object({
    toUserId: z.string().uuid().nullable().optional(),
    reason: z.string().min(2).max(60),
  });
  app.post("/api/pickup/tickets/:id/pass", guard("pickup.operate"), async (req, reply) => {
    const body = passBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const { id } = req.params as { id: string };
    const toUserId = body.data.toUserId ?? null;

    const result = await ctx.db.transaction(async (tx) => {
      const [ticket] = await tx.select().from(pickupTickets).where(eq(pickupTickets.id, id)).for("update");
      if (!ticket) return "not_found" as const;
      if (ticket.status !== "picking") return "not_picking" as const;
      // Only the current claimer may hand the ticket off (no broader
      // pickup-manage permission exists on this surface).
      if (ticket.claimedById !== req.admin!.sub) return "not_claimer" as const;

      if (toUserId === null) {
        // Back to the queue: any colleague can claim it; picked lines and the
        // original pickingStartedAt survive.
        assertTicketTransition(ticket.status as TicketStatus, "waiting");
        await tx
          .update(pickupTickets)
          .set({ status: "waiting", claimedById: null, passToId: null, passReason: null, passAt: null })
          .where(eq(pickupTickets.id, id));
        await writeAudit(tx, actor(req), "pickup", "ticket_passed_to_queue", `#${ticket.number}`, {
          ticketId: id,
          reason: body.data.reason,
        });
        return "queued" as const;
      }

      const [target] = await tx.select().from(adminUsers).where(eq(adminUsers.id, toUserId));
      if (!target || !target.active) return "bad_target" as const;
      // Direct offer: the ticket stays picking with the current claimer until
      // the colleague accepts.
      await tx
        .update(pickupTickets)
        .set({ passToId: toUserId, passReason: body.data.reason, passAt: ctx.now() })
        .where(eq(pickupTickets.id, id));
      await writeAudit(tx, actor(req), "pickup", "ticket_pass_offered", `#${ticket.number}`, {
        ticketId: id,
        to: toUserId,
        reason: body.data.reason,
      });
      return "offered" as const;
    });

    if (result === "not_found") return reply.code(404).send({ error: "not_found" });
    if (result === "not_picking") return reply.code(409).send({ error: "ticket_not_picking" });
    if (result === "not_claimer") return reply.code(403).send({ error: "not_claimer" });
    if (result === "bad_target") return reply.code(422).send({ error: "unknown_or_inactive_admin" });
    if (result === "queued") await publishBoard(ctx); // board shows waiting again
    return { ok: true, passed: result };
  });

  app.post("/api/pickup/tickets/:id/accept", guard("pickup.operate"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = await ctx.db.transaction(async (tx) => {
      const [ticket] = await tx.select().from(pickupTickets).where(eq(pickupTickets.id, id)).for("update");
      if (!ticket) return "not_found" as const;
      if (ticket.passToId !== req.admin!.sub) return "not_pass_target" as const;
      // Take over mid-pick: lines already picked carry over untouched.
      await tx
        .update(pickupTickets)
        .set({ claimedById: req.admin!.sub, passToId: null, passReason: null, passAt: null })
        .where(eq(pickupTickets.id, id));
      await writeAudit(tx, actor(req), "pickup", "ticket_pass_accepted", `#${ticket.number}`, {
        ticketId: id,
        from: ticket.claimedById,
      });
      return "ok" as const;
    });
    if (result === "not_found") return reply.code(404).send({ error: "not_found" });
    if (result === "not_pass_target") return reply.code(403).send({ error: "not_pass_target" });
    return { ok: true };
  });

  app.post("/api/pickup/tickets/:id/decline", guard("pickup.operate"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = await ctx.db.transaction(async (tx) => {
      const [ticket] = await tx.select().from(pickupTickets).where(eq(pickupTickets.id, id)).for("update");
      if (!ticket) return "not_found" as const;
      if (ticket.passToId !== req.admin!.sub) return "not_pass_target" as const;
      await tx
        .update(pickupTickets)
        .set({ passToId: null, passReason: null, passAt: null })
        .where(eq(pickupTickets.id, id));
      await writeAudit(tx, actor(req), "pickup", "ticket_pass_declined", `#${ticket.number}`, {
        ticketId: id,
        reason: ticket.passReason,
      });
      return "ok" as const;
    });
    if (result === "not_found") return reply.code(404).send({ error: "not_found" });
    if (result === "not_pass_target") return reply.code(403).send({ error: "not_pass_target" });
    return { ok: true };
  });

  // ── Pull from shelf (+ optional quarantine) ────────────────────────────────

  const pullBody = z.object({
    reason: z.enum(["damaged", "rephoto", "regrade", "recount", "other"]),
    note: z.string().max(200).optional(),
    toQuarantine: z.boolean().default(false),
  });
  app.post("/api/items/:id/pull", guard("warehouse.manage"), async (req, reply) => {
    const body = pullBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const { id } = req.params as { id: string };

    const result = await ctx.db.transaction(async (tx) => {
      const [item] = await tx.select().from(items).where(eq(items.id, id)).for("update");
      if (!item) return null;

      let toLocationId: string | null = null;
      if (body.data.toQuarantine) {
        // Find-or-create the quarantine bin (single fixed label).
        let [quar] = await tx.select().from(warehouseLocations).where(eq(warehouseLocations.label, QUARANTINE_LABEL));
        if (!quar) {
          const [created] = await tx
            .insert(warehouseLocations)
            .values({ zone: QUARANTINE_ZONE, label: QUARANTINE_LABEL, aisle: "", rack: "", shelf: "", notes: "Quarantine bin (auto-created)" })
            .onConflictDoNothing()
            .returning();
          quar = created ?? (await tx.select().from(warehouseLocations).where(eq(warehouseLocations.label, QUARANTINE_LABEL)))[0];
        }
        toLocationId = quar!.id;
      }

      await tx.insert(stockMovements).values({
        itemId: id,
        type: "adjust",
        fromLocationId: item.locationId,
        toLocationId,
        actorId: req.admin!.sub,
        actorLabel: req.admin!.name,
        reason: `pull:${body.data.reason}` + (body.data.note ? ` — ${body.data.note}` : ""),
      });
      await tx.update(items).set({ locationId: toLocationId, updatedAt: ctx.now() }).where(eq(items.id, id));
      await writeAudit(tx, actor(req), "item", "pulled", item.sku, {
        reason: body.data.reason,
        quarantine: body.data.toQuarantine,
      });
      return { locationId: toLocationId };
    });
    if (result === null) return reply.code(404).send({ error: "not_found" });
    return { ok: true, locationId: result.locationId };
  });
}
