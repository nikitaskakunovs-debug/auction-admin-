import { customers, items, orders, refunds } from "@auction/db";
import { assertItemTransition, type ItemStatus } from "@auction/domain";
import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import type { AppContext } from "../context.js";
import { requirePermission, type PermissionService } from "../auth/rbac.js";

const actor = (req: { admin?: { sub: string; name: string } }) => ({
  id: req.admin?.sub ?? null,
  label: req.admin?.name ?? "Unknown",
});

export function registerOrderRoutes(app: FastifyInstance, ctx: AppContext, perms: PermissionService): void {
  const guard = (p: Parameters<typeof requirePermission>[1]) => ({ preHandler: requirePermission(perms, p) });

  app.get("/api/orders", guard("orders.view"), async (req) => {
    const q = req.query as { status?: string };
    const rows = await ctx.db
      .select({ order: orders, itemSku: items.sku, itemStatus: items.status })
      .from(orders)
      .innerJoin(items, eq(orders.itemId, items.id))
      .where(q.status ? eq(orders.status, q.status) : undefined)
      .orderBy(desc(orders.createdAt))
      .limit(500);
    return { orders: rows.map((r) => ({ ...r.order, itemSku: r.itemSku, itemStatus: r.itemStatus })) };
  });

  app.get("/api/orders/:id", guard("orders.view"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await ctx.db
      .select({ order: orders, item: items })
      .from(orders)
      .innerJoin(items, eq(orders.itemId, items.id))
      .where(eq(orders.id, id));
    if (!row) return reply.code(404).send({ error: "not_found" });
    const refundRows = await ctx.db.select().from(refunds).where(eq(refunds.orderId, id)).orderBy(desc(refunds.createdAt));
    return { order: row.order, item: row.item, refunds: refundRows };
  });

  app.post("/api/orders/:id/mark-paid", guard("orders.mark_paid"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = await ctx.db.transaction(async (tx) => {
      const [order] = await tx.select().from(orders).where(eq(orders.id, id)).for("update");
      if (!order) return null;
      if (order.status !== "awaiting_payment") return "not_awaiting" as const;
      const [item] = await tx.select().from(items).where(eq(items.id, order.itemId)).for("update");
      assertItemTransition(item!.status as ItemStatus, "paid");
      await tx.update(orders).set({ status: "paid", paidAt: ctx.now() }).where(eq(orders.id, id));
      await tx.update(items).set({ status: "paid", updatedAt: ctx.now() }).where(eq(items.id, item!.id));
      await writeAudit(tx, actor(req), "order", "marked_paid", order.ref, { totalCents: order.totalCents });
      return order;
    });
    if (result === null) return reply.code(404).send({ error: "not_found" });
    if (result === "not_awaiting") return reply.code(409).send({ error: "order_not_awaiting_payment" });
    return { ok: true };
  });

  const refundSchema = z.object({ amountCents: z.number().int().positive(), reason: z.string().min(3) });
  app.post("/api/orders/:id/refund", guard("orders.refund"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = refundSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: "amount + reason required" });
    const result = await ctx.db.transaction(async (tx) => {
      const [order] = await tx.select().from(orders).where(eq(orders.id, id)).for("update");
      if (!order) return null;
      if (order.status !== "paid" && order.status !== "refunded") return "not_refundable" as const;
      const [sumRow] = await tx
        .select({ refunded: sql<string>`coalesce(sum(${refunds.amountCents}), 0)` })
        .from(refunds)
        .where(eq(refunds.orderId, id));
      const already = Number(sumRow!.refunded);
      if (already + body.data.amountCents > order.totalCents) return "over_max" as const;
      await tx.insert(refunds).values({
        orderId: id,
        amountCents: body.data.amountCents,
        reason: body.data.reason,
        actorId: req.admin!.sub,
      });
      if (already + body.data.amountCents === order.totalCents) {
        await tx.update(orders).set({ status: "refunded" }).where(eq(orders.id, id));
      }
      await writeAudit(tx, actor(req), "order", "refunded", order.ref, {
        amountCents: body.data.amountCents,
        reason: body.data.reason,
      });
      return order;
    });
    if (result === null) return reply.code(404).send({ error: "not_found" });
    if (result === "not_refundable") return reply.code(409).send({ error: "order_not_paid" });
    if (result === "over_max") return reply.code(422).send({ error: "refund_exceeds_total" });
    return { ok: true };
  });

  const cancelSchema = z.object({ reason: z.string().min(3), strike: z.boolean().default(true) });
  app.post("/api/orders/:id/cancel-unpaid", guard("orders.cancel_unpaid"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = cancelSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: "reason required" });
    const result = await ctx.db.transaction(async (tx) => {
      const [order] = await tx.select().from(orders).where(eq(orders.id, id)).for("update");
      if (!order) return null;
      if (order.status !== "awaiting_payment") return "not_awaiting" as const;
      const [item] = await tx.select().from(items).where(eq(items.id, order.itemId)).for("update");
      assertItemTransition(item!.status as ItemStatus, "unpaid_cancelled");
      await tx.update(orders).set({ status: "cancelled", cancelledAt: ctx.now() }).where(eq(orders.id, id));
      await tx.update(items).set({ status: "unpaid_cancelled", updatedAt: ctx.now() }).where(eq(items.id, item!.id));
      if (body.data.strike) {
        await tx
          .update(customers)
          .set({ strikes: sql`${customers.strikes} + 1` })
          .where(eq(customers.id, order.customerId));
      }
      await writeAudit(tx, actor(req), "order", "cancelled_unpaid", order.ref, {
        reason: body.data.reason,
        strike: body.data.strike,
      });
      return order;
    });
    if (result === null) return reply.code(404).send({ error: "not_found" });
    if (result === "not_awaiting") return reply.code(409).send({ error: "order_not_awaiting_payment" });
    return { ok: true };
  });
}
