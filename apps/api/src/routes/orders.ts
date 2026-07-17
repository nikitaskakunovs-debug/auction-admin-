import { customers, invoices, items, markets, orders, payments, refunds, shipments } from "@auction/db";
import { assertItemTransition, computeNoShowSettlement, type ItemStatus } from "@auction/domain";
import { and, asc, desc, eq, gte, isNull, lte, or, sql, type SQL } from "drizzle-orm";
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

  /**
   * Filtered + paginated orders list for the power screen. Every filter is
   * server-side so the list scales past the browser: status, market,
   * fulfilment, free-text (ref/alias/email, accent-folded), amount band,
   * date range, sort. Returns per-status counts (computed under the same
   * filters, minus status) for the pill row, plus the latest paid payment's
   * provider/method for the Payment column.
   */
  app.get("/api/orders", guard("orders.view"), async (req) => {
    const q = req.query as {
      status?: string; market?: string; fulfilment?: string; q?: string;
      min?: string; max?: string; from?: string; to?: string; sort?: string;
      limit?: string; offset?: string;
    };
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
    const offset = Math.max(Number(q.offset) || 0, 0);

    const base: SQL[] = [];
    if (q.market) base.push(eq(orders.marketCode, q.market.toUpperCase()) as SQL);
    if (q.fulfilment) base.push(eq(orders.fulfilment, q.fulfilment) as SQL);
    if (q.min && Number(q.min) > 0) base.push(gte(orders.totalCents, Number(q.min)) as SQL);
    if (q.max && Number(q.max) > 0) base.push(lte(orders.totalCents, Number(q.max)) as SQL);
    if (q.from && !Number.isNaN(Date.parse(q.from))) base.push(gte(orders.createdAt, new Date(q.from)) as SQL);
    if (q.to && !Number.isNaN(Date.parse(q.to))) {
      const to = new Date(q.to);
      to.setUTCHours(23, 59, 59, 999);
      base.push(lte(orders.createdAt, to) as SQL);
    }
    if (q.q && q.q.trim().length >= 2) {
      const fold = "translate(lower(%s), 'āčēģīķļņšūž', 'acegiklnsuz')";
      let needle = q.q.trim().toLowerCase();
      const FROM = "āčēģīķļņšūž";
      const TO = "acegiklnsuz";
      for (let i = 0; i < FROM.length; i++) needle = needle.replaceAll(FROM[i]!, TO[i]!);
      const like = `%${needle}%`;
      void fold; // documented pattern; inlined below per-column
      base.push(
        or(
          sql`translate(lower(${orders.ref}), 'āčēģīķļņšūž', 'acegiklnsuz') like ${like}`,
          sql`translate(lower(${orders.customerAlias}), 'āčēģīķļņšūž', 'acegiklnsuz') like ${like}`,
          sql`translate(lower(${orders.customerEmail}), 'āčēģīķļņšūž', 'acegiklnsuz') like ${like}`,
        ) as SQL,
      );
    }

    const withStatus = q.status ? [...base, eq(orders.status, q.status) as SQL] : base;
    const whereAll = base.length ? and(...base) : undefined;
    const whereList = withStatus.length ? and(...withStatus) : undefined;

    const sort =
      q.sort === "oldest" ? asc(orders.createdAt) :
      q.sort === "amount_desc" ? desc(orders.totalCents) :
      q.sort === "amount_asc" ? asc(orders.totalCents) : desc(orders.createdAt);

    const [rows, statusCounts] = await Promise.all([
      ctx.db
        .select({ order: orders, itemSku: items.sku, itemStatus: items.status, itemTitle: items.title })
        .from(orders)
        .innerJoin(items, eq(orders.itemId, items.id))
        .where(whereList)
        .orderBy(sort)
        .limit(limit)
        .offset(offset),
      ctx.db
        .select({ status: orders.status, count: sql<number>`count(*)::int` })
        .from(orders)
        .where(whereAll)
        .groupBy(orders.status),
    ]);

    // Latest paid payment per listed order → "Klix · pay_later" style label.
    const ids = rows.map((r) => r.order.id);
    const payRows = ids.length
      ? await ctx.db
          .select({ orderId: payments.orderId, provider: payments.provider, method: payments.method, createdAt: payments.createdAt })
          .from(payments)
          .where(and(sql`${payments.orderId} in ${ids}`, eq(payments.status, "paid")))
      : [];
    const payBy = new Map<string, { provider: string; method: string | null }>();
    for (const p of payRows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
      payBy.set(p.orderId, { provider: p.provider, method: p.method });
    }

    let all = 0;
    const counts: Record<string, number> = {};
    for (const c of statusCounts) {
      counts[c.status] = c.count;
      all += c.count;
    }
    counts.all = all;
    const total = q.status ? (counts[q.status] ?? 0) : counts.all;

    return {
      orders: rows.map((r) => ({
        ...r.order,
        itemSku: r.itemSku,
        itemStatus: r.itemStatus,
        itemTitle: r.itemTitle,
        paidVia: payBy.get(r.order.id) ?? null,
      })),
      total,
      counts,
    };
  });

  /**
   * All online payment attempts across orders — the admin "Payments" view.
   * One row per checkout attempt with provider, method (BNPL vs banklink vs
   * card), channel, status, and the order it belongs to.
   */
  app.get("/api/payments", guard("orders.view"), async (req) => {
    const q = req.query as { status?: string; provider?: string };
    const conds = [];
    if (q.status) conds.push(eq(payments.status, q.status));
    if (q.provider) conds.push(eq(payments.provider, q.provider));
    const rows = await ctx.db
      .select({
        payment: payments,
        orderRef: orders.ref,
        orderStatus: orders.status,
        customerAlias: orders.customerAlias,
        itemTitle: items.title,
      })
      .from(payments)
      .innerJoin(orders, eq(payments.orderId, orders.id))
      .innerJoin(items, eq(orders.itemId, items.id))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(payments.createdAt))
      .limit(500);
    return {
      payments: rows.map((r) => ({
        ...r.payment,
        orderRef: r.orderRef,
        orderStatus: r.orderStatus,
        customerAlias: r.customerAlias,
        itemTitle: r.itemTitle,
      })),
    };
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
      .where(and(eq(invoices.orderId, id), isNull(invoices.voidedAt)));
    const paymentRows = await ctx.db.select().from(payments).where(eq(payments.orderId, id)).orderBy(desc(payments.createdAt));
    const shipmentRows = await ctx.db.select().from(shipments).where(eq(shipments.orderId, id)).orderBy(desc(shipments.createdAt));
    return { order: row.order, item: row.item, refunds: refundRows, invoice: invoice ?? null, payments: paymentRows, shipments: shipmentRows };
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

    // If this order was collected online, the money moves back through the
    // provider too — and only what the provider confirms gets recorded. The
    // provider call happens before the ledger write: a rejected refund
    // (already refunded in the portal, amount over the remainder, expired)
    // must not leave a phantom refund row. Klix exposes a refund API;
    // Inbank credit contracts are terminated/credited in their partner
    // portal, so Inbank-paid orders must be refunded there first and then
    // recorded here with viaProvider=false — never silently skipped.
    let providerMeta: Record<string, unknown> = {};
    if (body.data.viaProvider) {
      const [paidPayment] = await ctx.db
        .select()
        .from(payments)
        .where(and(eq(payments.orderId, id), eq(payments.status, "paid")))
        .orderBy(desc(payments.createdAt))
        .limit(1);
      if (paidPayment?.provider === "inbank") {
        return reply.code(409).send({
          error: "provider_refund_unsupported",
          detail: "Paid via Inbank — credit the contract in the Inbank partner portal, then record with viaProvider=false",
        });
      }
      if (paidPayment?.providerId) {
        if (!ctx.klix) return reply.code(503).send({ error: "payments_unavailable", detail: "KLIX_MODE is off — refund in the Klix portal, then record with viaProvider=false" });
        try {
          const purchase = await ctx.klix.refundPurchase(paidPayment.providerId, body.data.amountCents);
          await ctx.db
            .update(payments)
            .set({ providerStatus: purchase.status, updatedAt: ctx.now() })
            .where(eq(payments.id, paidPayment.id));
          providerMeta = { via: "klix", purchaseId: paidPayment.providerId };
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
