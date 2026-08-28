import { customers, invoices, items, markets, orders, payments, refunds, shipments } from "@auction/db";
import { assertItemTransition, computeNoShowSettlement, type ItemStatus } from "@auction/domain";
import { and, asc, desc, eq, gte, ilike, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { slackOrderCancelled } from "../engine/slackNotify.js";
import { refundOrder } from "../engine/refund.js";
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
      /** Отбор по рекламе: source|medium|campaign и модель касания. Так из
       *  отчёта «Reklāmas atdeve» можно провалиться в сами заказы кампании. */
      attrSource?: string; attrMedium?: string; attrCampaign?: string; attrModel?: string;
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

    // Отбор по кампании. Пустая строка — осмысленное значение: так отбирается
    // «прямой заход / без меток», иначе эта самая крупная строка отчёта была
    // бы единственной, в которую нельзя провалиться.
    if (q.attrSource !== undefined || q.attrMedium !== undefined || q.attrCampaign !== undefined) {
      const col = q.attrModel === "first" ? orders.attribution : orders.attributionLast;
      const at = (key: string, value: string) => sql`coalesce(${col}->>${key}, '') = ${value}`;
      if (q.attrSource !== undefined) base.push(at("source", q.attrSource) as SQL);
      if (q.attrMedium !== undefined) base.push(at("medium", q.attrMedium) as SQL);
      if (q.attrCampaign !== undefined) base.push(at("campaign", q.attrCampaign) as SQL);
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
    const q = req.query as {
      status?: string; provider?: string; q?: string; from?: string; to?: string;
      min?: string; max?: string; limit?: string; offset?: string;
    };
    const conds = [];
    if (q.status) conds.push(eq(payments.status, q.status));
    if (q.provider) conds.push(eq(payments.provider, q.provider));
    if (q.q) conds.push(or(ilike(orders.ref, `%${q.q}%`), ilike(orders.customerAlias, `%${q.q}%`)));
    const dayStart = (d: string) => new Date(`${d}T00:00:00.000Z`);
    if (q.from) conds.push(sql`${payments.createdAt} >= ${dayStart(q.from)}`);
    if (q.to) conds.push(sql`${payments.createdAt} < ${new Date(dayStart(q.to).getTime() + 86_400_000)}`);
    if (q.min) conds.push(sql`${payments.amountCents} >= ${Number(q.min)}`);
    if (q.max) conds.push(sql`${payments.amountCents} <= ${Number(q.max)}`);
    const where = conds.length ? and(...conds) : undefined;
    const limit = Math.min(Math.max(Number(q.limit) || 500, 1), 500);
    const offset = Math.max(Number(q.offset) || 0, 0);

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
      .where(where)
      .orderBy(desc(payments.createdAt))
      .limit(limit)
      .offset(offset);
    const [totalRow] = await ctx.db
      .select({ n: sql<string>`count(*)` })
      .from(payments)
      .innerJoin(orders, eq(payments.orderId, orders.id))
      .where(where);
    // A3 tiles — unfiltered by design: today's money is today's money.
    const now = ctx.now();
    const todayStart = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
    const weekStart = new Date(now.getTime() - 7 * 86_400_000);
    const [summary] = await ctx.db
      .select({
        todayCents: sql<string>`coalesce(sum(${payments.amountCents}) filter (where ${payments.status} = 'paid' and ${payments.updatedAt} >= ${todayStart}), 0)`,
        weekCents: sql<string>`coalesce(sum(${payments.amountCents}) filter (where ${payments.status} = 'paid' and ${payments.updatedAt} >= ${weekStart}), 0)`,
        pendingCount: sql<string>`count(*) filter (where ${payments.status} = 'created')`,
      })
      .from(payments);
    return {
      payments: rows.map((r) => ({
        ...r.payment,
        orderRef: r.orderRef,
        orderStatus: r.orderStatus,
        customerAlias: r.customerAlias,
        itemTitle: r.itemTitle,
      })),
      total: Number(totalRow!.n),
      summary: {
        todayCents: Number(summary!.todayCents),
        weekCents: Number(summary!.weekCents),
        pendingCount: Number(summary!.pendingCount),
      },
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
    /* Кто покупатель — рядом с заказом, а не «сходите поищите в клиентах».
     * Здесь же его первое касание: если у заказа снимок пустой (старый заказ,
     * созданный до атрибуции), карточка всё равно скажет, откуда человек. */
    const [buyer] = await ctx.db
      .select({
        id: customers.id,
        alias: customers.alias,
        email: customers.email,
        blocked: customers.blocked,
        strikes: customers.strikes,
        createdAt: customers.createdAt,
        attribution: customers.attribution,
        attributionLast: customers.attributionLast,
        lastLoginMethod: customers.lastLoginMethod,
        ordersCount: sql<string>`(select count(*) from orders o2 where o2.customer_id = customers.id)`,
      })
      .from(customers)
      .where(eq(customers.id, row.order.customerId));
    return {
      order: row.order,
      item: row.item,
      refunds: refundRows,
      invoice: invoice ?? null,
      payments: paymentRows,
      shipments: shipmentRows,
      buyer: buyer ? { ...buyer, ordersCount: Number(buyer.ordersCount) } : null,
    };
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
    // The rules live in the engine because R2's counter returns refund through
    // exactly the same path — provider quirks included.
    const result = await refundOrder(ctx, id, { ...body.data, actor: actor(req) });
    if (!result.ok) {
      if (result.error === "klix_refund_failed") req.log?.error({ orderId: id }, "klix refund failed");
      return reply.code(result.code).send(result.detail ? { error: result.error, detail: result.detail } : { error: result.error });
    }
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
        await enqueueNotification(ctx, tx, {
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
      return { ...order, slackFeeCents: feeCents };
    });
    if (result === null) return reply.code(404).send({ error: "not_found" });
    if (result === "not_awaiting") return reply.code(409).send({ error: "order_not_awaiting_payment" });
    slackOrderCancelled(ctx, { orderRef: result.ref, reason: "unpaid", feeCents: result.slackFeeCents ?? 0, orderId: id });
    return { ok: true };
  });
}
