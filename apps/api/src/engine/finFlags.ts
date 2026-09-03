import { finFlags, orders, refunds, type Db } from "@auction/db";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { getFinSettings } from "./finSettings.js";

/**
 * Единая очередь «Требует внимания» (fin-architecture, раздел 0.2): любое
 * расхождение любого потока — одна таблица, один экран в админке. dedupeKey
 * не даёт кронам плодить один и тот же флаг при каждом проходе.
 */

type Tx = Pick<Db, "select" | "insert" | "update">;

export type FinFlagType =
  | "bank_mismatch"
  | "refund_pending"
  | "partner_mismatch"
  | "clearing_overdue"
  | "carrier_mismatch"
  | "dual_approval_wait"
  | "eu_threshold";

export async function raiseFlag(
  tx: Tx,
  flag: {
    type: FinFlagType;
    title: string;
    details?: Record<string, unknown>;
    amountCents?: number | null;
    refType?: string | null;
    refId?: string | null;
    department?: string | null;
    dedupeKey?: string | null;
  },
): Promise<void> {
  await tx
    .insert(finFlags)
    .values({
      type: flag.type,
      title: flag.title,
      details: flag.details ?? {},
      amountCents: flag.amountCents ?? null,
      refType: flag.refType ?? null,
      refId: flag.refId ?? null,
      department: flag.department ?? null,
      dedupeKey: flag.dedupeKey ?? null,
    })
    .onConflictDoNothing();
}

export async function resolveFlag(
  ctx: AppContext,
  id: string,
  args: { note: string; actor: string },
): Promise<boolean> {
  const [row] = await ctx.db
    .update(finFlags)
    .set({ status: "resolved", resolutionNote: args.note, resolvedBy: args.actor, resolvedAt: ctx.now() })
    .where(and(eq(finFlags.id, id), eq(finFlags.status, "open")))
    .returning({ id: finFlags.id });
  return Boolean(row);
}

/**
 * Clearing-контроль (раздел 4): деньги, ушедшие «в пути» к провайдеру дольше
 * его окна (Klix 2 дня, Inbank 4 — правится в настройках) и всё ещё не
 * закрытые встречной записью выплаты, поднимают флаг по каждому заказу.
 */
export async function runClearingOverdue(ctx: AppContext): Promise<number> {
  const s = await getFinSettings(ctx);
  const windows: Array<{ account: string; days: number }> = [
    { account: "clearing_klix", days: s.clearing_klix_days },
    { account: "clearing_inbank", days: s.clearing_inbank_days },
  ];
  let raised = 0;
  for (const w of windows) {
    const cutoff = new Date(ctx.now().getTime() - w.days * 86_400_000);
    const res = await ctx.db.execute(sql`
      SELECT order_ref, SUM(amount_cents)::int AS pending, MAX(event_at) AS last_at
      FROM ledger_entries
      WHERE account = ${w.account} AND order_ref IS NOT NULL
      GROUP BY order_ref
      HAVING SUM(amount_cents) > 0 AND MAX(event_at) < ${cutoff}
      LIMIT 200
    `);
    const rows = (res as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? (res as unknown as Array<Record<string, unknown>>);
    for (const r of rows) {
      const orderRef = String(r.order_ref);
      const pending = Number(r.pending);
      await raiseFlag(ctx.db, {
        type: "clearing_overdue",
        title: `Nauda ceļā pārāk ilgi — ${orderRef}`,
        details: { account: w.account, windowDays: w.days, lastAt: String(r.last_at) },
        amountCents: pending,
        refType: "order",
        refId: orderRef,
        dedupeKey: `clearing:${w.account}:${orderRef}`,
      });
      raised++;
    }
  }
  return raised;
}

/**
 * SLA ручных возвратов (раздел 5.2): запрошенный возврат висит без выплаты
 * дольше N дней (3 по умолчанию) — флаг на каждый.
 */
export async function runRefundSla(ctx: AppContext): Promise<number> {
  const s = await getFinSettings(ctx);
  const cutoff = new Date(ctx.now().getTime() - s.refund_sla_days * 86_400_000);
  const overdue = await ctx.db
    .select({ refund: refunds, orderRef: orders.ref })
    .from(refunds)
    .innerJoin(orders, eq(refunds.orderId, orders.id))
    .where(and(inArray(refunds.status, ["requested", "awaiting_manual"]), lt(refunds.createdAt, cutoff)))
    .limit(200);
  for (const r of overdue) {
    await raiseFlag(ctx.db, {
      type: "refund_pending",
      title: `Atmaksa gaida izmaksu ilgāk par ${s.refund_sla_days} d. — ${r.orderRef}`,
      details: { requestedAt: r.refund.createdAt.toISOString(), method: r.refund.method, reason: r.refund.reason },
      amountCents: r.refund.amountCents,
      refType: "refund",
      refId: r.refund.id,
      dedupeKey: `refund_sla:${r.refund.id}`,
    });
  }
  return overdue.length;
}

/**
 * Порог дистанционных продаж EE+LT €10 000/год (раздел 8.2): считаем
 * календарный год по оплаченным заказам эстонского и литовского рынков;
 * при 80% (настройка) — предупреждение, при 100% — отдельный флаг.
 */
export async function runEuThreshold(ctx: AppContext): Promise<void> {
  const s = await getFinSettings(ctx);
  if (s.eu_threshold_cents <= 0) return;
  const year = ctx.now().getUTCFullYear();
  const from = new Date(Date.UTC(year, 0, 1));
  const res = await ctx.db.execute(sql`
    SELECT COALESCE(SUM(total_cents), 0)::bigint AS total
    FROM orders
    WHERE market_code IN ('EE','LT') AND status IN ('paid','refunded') AND paid_at >= ${from}
  `);
  const rows = (res as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? (res as unknown as Array<Record<string, unknown>>);
  const total = Number(rows[0]?.total ?? 0);
  const alertAt = Math.floor((s.eu_threshold_cents * s.eu_alert_bp) / 10_000);
  if (total >= s.eu_threshold_cents) {
    await raiseFlag(ctx.db, {
      type: "eu_threshold",
      title: `EE+LT slieksnis €${(s.eu_threshold_cents / 100).toFixed(0)} PĀRSNIEGTS — vajadzīgs OSS/PVN lēmums`,
      details: { year, totalCents: total, thresholdCents: s.eu_threshold_cents },
      amountCents: total,
      dedupeKey: `eu:${year}:limit`,
    });
  } else if (total >= alertAt) {
    await raiseFlag(ctx.db, {
      type: "eu_threshold",
      title: `EE+LT pārdošana sasniegusi ${Math.floor((total / s.eu_threshold_cents) * 100)}% no €10k sliekšņa`,
      details: { year, totalCents: total, thresholdCents: s.eu_threshold_cents, alertBp: s.eu_alert_bp },
      amountCents: total,
      dedupeKey: `eu:${year}:alert`,
    });
  }
}

/** Часовой пакет финансовых кронов — вызывается из тика планировщика. */
export async function runFinCrons(ctx: AppContext): Promise<void> {
  await runClearingOverdue(ctx).catch((err) => console.error("clearing overdue cron failed", err));
  await runRefundSla(ctx).catch((err) => console.error("refund SLA cron failed", err));
  await runEuThreshold(ctx).catch((err) => console.error("eu threshold cron failed", err));
}
