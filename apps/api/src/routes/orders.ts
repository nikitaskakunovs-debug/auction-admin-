import { customers, invoices, items, markets, orders, payments, refunds } from "@auction/db";
import { assertItemTransition, computeNoShowSettlement, type ItemStatus } from "@auction/domain";
import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import type { AppContext } from "../context.js";
import { recordFee } from "../engine/fees.js";
import { enqueueNotification } from "../engine/notifications.js";
import { settleOrderPaid } from "../engine/settlement.js";
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
    const [invoice] = await ctx.db
      .select({ id: invoices.id, number: invoices.number, issuedAt: invoices.issuedAt })
      .from(invoices)
      .where(eq(invoices.orderId, id));
    const paymentRows = await ctx.db.select().from(payments).where(eq(payments.orderId, id)).orderBy(desc(payments.createdAt));
    return { order: row.order, item: row.item, refunds: refundRows, invoice: invoice ?? null, payments: paymentRows };
  });

  app.post("/api/orders/:id/mark-paid", guard("orders.mark_paid"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = await settleOrderPaid(ctx, id, actor(req), { via: "manual" });
    if (result.outcome === "not_found") return reply.code(404).send({ error: "not_found" });
    if (result.outcome === "not_awaiting") return reply.code(409).send({ error: "order_not_awaiting_payment" });
    return { ok: true };
  });

  const refundSchema = z.object({
    amountCents: z.number().int().positive(),
    reason: z.string().min(3),
    /**
     * When the order was paid through Klix, also return the money via the
     * provider (the default). Untick to record-only — e.g. the money was
     * already sent back manually in the Klix portal, or refunded in cash.
     */
    viaProvider: z.boolean().default(true),
  });
  app.post("/api/orders/:id/refund", guard("orders.refund"), async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = refundSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: "amount + reason required" });

    // Pre-flight the ledger rules BEFORE any provider call: money must never
    // leave Klix for a refund our own bookkeeping would then reject.
    {
      const [order] = await ctx.db.select().from(orders).where(eq(orders.id, id));
      if (!order) return reply.code(404).send({ error: "not_found" });
      if (order.status !== "paid" && order.status !== "refunded") return reply.code(409).send({ error: "order_not_paid" });
      const [sumRow] = await ctx.db
        .select({ refunded: sql<string>`coalesce(sum(${refunds.amountCents}), 0)` })
        .from(refunds)
        .where(eq(refunds.orderId, id));
      if (Number(sumRow!.refunded) + body.data.amountCents > order.totalCents) {
        return reply.code(422).send({ error: "refund_exceeds_total" });
      }
    }

    // If this order was collected through Klix, the money moves back through
    // Klix too — and only what the provider confirms gets recorded. The
    // provider call happens before the ledger write: a rejected refund
    // (already refunded in the portal, amount over the remainder, expired)
    // must not leave a phantom refund row.
    let providerMeta: Record<string, unknown> = {};
    if (body.data.viaProvider) {
      const [klixPayment] = await ctx.db
        .select()
        .from(payments)
        .where(and(eq(payments.orderId, id), eq(payments.status, "paid")))
        .orderBy(desc(payments.createdAt))
        .limit(1);
      if (klixPayment?.providerId) {
        if (!ctx.klix) return reply.code(503).send({ error: "payments_unavailable", detail: "KLIX_MODE is off — refund in the Klix portal, then record with viaProvider=false" });
        try {
          const purchase = await ctx.klix.refundPurchase(klixPayment.providerId, body.data.amountCents);
          await ctx.db
            .update(payments)
            .set({ providerStatus: purchase.status, updatedAt: ctx.now() })
            .where(eq(payments.id, klixPayment.id));
          providerMeta = { via: "klix", purchaseId: klixPayment.providerId };
        } catch (err) {
          req.log?.error({ err, orderId: id }, "klix refund failed");
          return reply.code(502).send({ error: "klix_refund_failed", detail: err instanceof Error ? err.message : "provider error" });
        }
      }
    }

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
        ...providerMeta,
      });
      return order;
    });
    if (result === null) return reply.code(404).send({ error: "not_found" });
    if (result === "not_refundable") return reply.code(409).send({ error: "order_not_paid" });
    if (result === "over_max") return reply.code(422).send({ error: "refund_exceeds_total" });
    return { ok: true };
  });

  const cancelSchema = z.object({
    reason: z.string().min(3),
    strike: z.boolean().default(true),
    /** Record the 5% restock fee as an outstanding claim (blocks bidding). */
    restockFee: z.boolean().default(true),
  });
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
      const [market] = await tx.select().from(markets).where(eq(markets.code, order.marketCode));
      const feeCents = body.data.restockFee
        ? computeNoShowSettlement(order.totalCents, market?.restockFeeBp ?? 500).feeCents
        : 0;
      await tx
        .update(orders)
        .set({ status: "cancelled", cancelledAt: ctx.now(), cancelReason: "unpaid", restockFeeCents: feeCents || null })
        .where(eq(orders.id, id));
      await tx.update(items).set({ status: "unpaid_cancelled", updatedAt: ctx.now() }).where(eq(items.id, item!.id));
      if (body.data.strike) {
        await tx
          .update(customers)
          .set({ strikes: sql`${customers.strikes} + 1` })
          .where(eq(customers.id, order.customerId));
      }
      if (feeCents > 0) {
        await recordFee(tx, {
          customerId: order.customerId,
          orderId: order.id,
          orderRef: order.ref,
          type: "unpaid_restock",
          amountCents: feeCents,
          status: "outstanding",
          note: body.data.reason,
          now: ctx.now(),
        });
        await enqueueNotification(tx, {
          customerId: order.customerId,
          type: "unpaid_cancelled",
          template: { alias: "", lotTitle: "", orderRef: order.ref, feeCents },
          dedupeKey: `unpaid_cancelled:${order.id}`,
        });
      }
      await writeAudit(tx, actor(req), "order", "cancelled_unpaid", order.ref, {
        reason: body.data.reason,
        strike: body.data.strike,
        feeCents,
      });
      return order;
    });
    if (result === null) return reply.code(404).send({ error: "not_found" });
    if (result === "not_awaiting") return reply.code(409).send({ error: "order_not_awaiting_payment" });
    return { ok: true };
  });
}
