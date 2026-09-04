import { consignments, items, suppliers, supplierInvoices, supplierPayments } from "@auction/db";
import { and, eq, sql } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { getFinSettings } from "./finSettings.js";
import { enqueueSupplierNotification } from "./notifications.js";

/**
 * Переписка с поставщиком (письма S3…S10): всё, что раньше жило в WhatsApp —
 * акт приёмки, расхождение, статус счёта, платёж, месячная сводка и судьба
 * непроданного остатка. Отправка идёт через общую очередь уведомлений, так
 * что письма поставщикам видны в «Paziņojumi» и правятся там же.
 */

const DAY_MS = 86_400_000;

/** Рабочие дни: срок ответа на расхождение не должен падать на выходные. */
function addWorkingDays(from: Date, days: number): Date {
  const d = new Date(from.getTime());
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return d;
}

const rowsOf = <T>(res: unknown): T[] =>
  ((res as { rows?: T[] }).rows ?? (res as T[])) satisfies T[];

/**
 * Приёмка закрыта (S3 / S4). Заявленное берём из поставки, принятое —
 * фактическое число заведённых единиц. Если приняли меньше заявленного,
 * это расхождение: письмо другое и требует ответа в срок.
 */
export async function notifyIntakeClosed(ctx: AppContext, consignmentId: string): Promise<void> {
  const [con] = await ctx.db.select().from(consignments).where(eq(consignments.id, consignmentId));
  if (!con?.supplierId) return;
  const [counted] = await ctx.db
    .select({ n: sql<string>`count(*)` })
    .from(items)
    .where(eq(items.consignmentId, consignmentId));
  const accepted = Number(counted?.n ?? 0);
  const declared = con.expectedCount > 0 ? con.expectedCount : accepted;
  const rejected = Math.max(0, declared - accepted);
  const s = await getFinSettings(ctx);

  if (rejected > 0) {
    const replyBy = addWorkingDays(ctx.now(), s.supplier_discrepancy_days);
    // Тот же вопрос ждёт поставщика в кабинете — письмо только зовёт туда.
    await ctx.db
      .update(consignments)
      .set({
        discrepancyStatus: "open",
        discrepancyNote: `${rejected} vienības no pieteiktajām nav pieņemtas`,
        discrepancyDueAt: replyBy,
      })
      .where(eq(consignments.id, consignmentId));
    await enqueueSupplierNotification(ctx, ctx.db, {
      supplierId: con.supplierId,
      type: "sup_discrepancy",
      template: {
        alias: "", lotTitle: "",
        consignmentRef: con.ref,
        declaredCount: declared,
        acceptedCount: accepted,
        rejectedCount: rejected,
        discrepancyNote: `${rejected} vienības no pieteiktajām nav pieņemtas`,
        replyByDate: replyBy,
      },
      dedupeKey: `sup_discrepancy:${consignmentId}`,
    });
    return;
  }
  await enqueueSupplierNotification(ctx, ctx.db, {
    supplierId: con.supplierId,
    type: "sup_intake_done",
    template: {
      alias: "", lotTitle: "",
      consignmentRef: con.ref,
      declaredCount: declared,
      acceptedCount: accepted,
      rejectedCount: 0,
    },
    dedupeKey: `sup_intake_done:${consignmentId}`,
  });
}

/** Счёт согласован (S5) или отклонён (S6) — вызывается из approval-слоя. */
export async function notifyInvoiceDecision(
  ctx: AppContext,
  invoiceId: string,
  decision: "accepted" | "rejected",
): Promise<void> {
  const [inv] = await ctx.db.select().from(supplierInvoices).where(eq(supplierInvoices.id, invoiceId));
  if (!inv) return;
  await enqueueSupplierNotification(ctx, ctx.db, {
    supplierId: inv.supplierId,
    type: decision === "accepted" ? "sup_invoice_accepted" : "sup_invoice_rejected",
    template: {
      alias: "", lotTitle: "",
      invoiceNumber: inv.number,
      amountCents: inv.amountCents,
      dueDate: inv.dueDate,
      ...(decision === "rejected" ? { rejectReason: inv.rejectedReason ?? "" } : {}),
    },
    dedupeKey: `sup_invoice_${decision}:${invoiceId}`,
  });
}

/** Платёж отправлен (S7) — из записи оплаты счёта. */
export async function notifyPaymentSent(ctx: AppContext, paymentId: string): Promise<void> {
  const [row] = await ctx.db
    .select({ payment: supplierPayments, invoice: supplierInvoices })
    .from(supplierPayments)
    .innerJoin(supplierInvoices, eq(supplierPayments.invoiceId, supplierInvoices.id))
    .where(eq(supplierPayments.id, paymentId));
  if (!row) return;
  await enqueueSupplierNotification(ctx, ctx.db, {
    supplierId: row.invoice.supplierId,
    type: "sup_payment_sent",
    template: {
      alias: "", lotTitle: "",
      amountCents: row.payment.amountCents,
      paidAt: row.payment.paidAt,
      paymentRef: row.payment.note.trim() || row.invoice.number,
      invoiceNumbers: [row.invoice.number],
    },
    dedupeKey: `sup_payment_sent:${paymentId}`,
  });
}

interface PeriodStats {
  supplierId: string;
  received: number;
  sold: number;
  grossCents: number;
  paidCents: number;
}

/** Цифры прошлого месяца по каждому поставщику — одним проходом по базе. */
async function periodStats(ctx: AppContext, from: Date, to: Date): Promise<Map<string, PeriodStats>> {
  const stats = new Map<string, PeriodStats>();
  const bump = (id: string): PeriodStats => {
    const cur = stats.get(id) ?? { supplierId: id, received: 0, sold: 0, grossCents: 0, paidCents: 0 };
    stats.set(id, cur);
    return cur;
  };

  const received = rowsOf<{ supplier_id: string; n: string }>(
    await ctx.db.execute(sql`
      SELECT c.supplier_id, count(*)::text AS n
      FROM items i JOIN consignments c ON c.id = i.consignment_id
      WHERE c.supplier_id IS NOT NULL AND i.created_at >= ${from} AND i.created_at < ${to}
      GROUP BY c.supplier_id
    `),
  );
  for (const r of received) bump(r.supplier_id).received = Number(r.n);

  const sold = rowsOf<{ supplier_id: string; n: string; gross: string }>(
    await ctx.db.execute(sql`
      SELECT c.supplier_id, count(*)::text AS n, COALESCE(SUM(o.total_cents), 0)::text AS gross
      FROM orders o
      JOIN items i ON i.id = o.item_id
      JOIN consignments c ON c.id = i.consignment_id
      WHERE c.supplier_id IS NOT NULL AND o.status = 'paid'
        AND o.paid_at >= ${from} AND o.paid_at < ${to}
      GROUP BY c.supplier_id
    `),
  );
  for (const r of sold) {
    const cur = bump(r.supplier_id);
    cur.sold = Number(r.n);
    cur.grossCents = Number(r.gross);
  }

  const paid = rowsOf<{ supplier_id: string; total: string }>(
    await ctx.db.execute(sql`
      SELECT si.supplier_id, COALESCE(SUM(sp.amount_cents), 0)::text AS total
      FROM supplier_payments sp JOIN supplier_invoices si ON si.id = sp.invoice_id
      WHERE sp.paid_at >= ${from} AND sp.paid_at < ${to}
      GROUP BY si.supplier_id
    `),
  );
  for (const r of paid) bump(r.supplier_id).paidCents = Number(r.total);

  return stats;
}

/** Что именно продалось за период — строки для комиссионного отчёта. */
async function soldLotsOf(ctx: AppContext, supplierId: string, from: Date, to: Date) {
  return rowsOf<{ title: string; price: string }>(
    await ctx.db.execute(sql`
      SELECT i.title, o.total_cents::text AS price
      FROM orders o
      JOIN items i ON i.id = o.item_id
      JOIN consignments c ON c.id = i.consignment_id
      WHERE c.supplier_id = ${supplierId} AND o.status = 'paid'
        AND o.paid_at >= ${from} AND o.paid_at < ${to}
      ORDER BY o.total_cents DESC
      LIMIT 20
    `),
  ).map((r) => ({ title: r.title, priceCents: Number(r.price) }));
}

const MONTHS_LV = [
  "janvāris", "februāris", "marts", "aprīlis", "maijs", "jūnijs",
  "jūlijs", "augusts", "septembris", "oktobris", "novembris", "decembris",
];

/**
 * Месячный пакет поставщику (S8 + S9): сводка всем, а комиссионным — ещё и
 * отчёт о продажах с расчётом выплаты (он заменяет их счёт). Раз в месяц,
 * в день из настроек.
 */
export async function runSupplierMonthly(ctx: AppContext): Promise<{ sent: number }> {
  const s = await getFinSettings(ctx);
  if (s.supplier_report_day <= 0) return { sent: 0 };
  const now = ctx.now();
  if (now.getUTCDate() !== s.supplier_report_day) return { sent: 0 };

  // Прошлый календарный месяц целиком.
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const period = `${from.getUTCFullYear()}. gada ${MONTHS_LV[from.getUTCMonth()]}`;
  const stamp = from.toISOString().slice(0, 7);

  const stats = await periodStats(ctx, from, to);
  const all = await ctx.db
    .select({ id: suppliers.id, model: suppliers.model, commissionBp: suppliers.commissionBp })
    .from(suppliers)
    .where(eq(suppliers.active, true));

  let sent = 0;
  for (const sup of all) {
    const st = stats.get(sup.id);
    // Пустой месяц не тревожим: письмо «ноль и ноль» никому не нужно.
    if (!st || (st.received === 0 && st.sold === 0 && st.paidCents === 0)) continue;
    const sellThrough = st.received > 0 ? Math.round((st.sold / st.received) * 100) : 0;

    await enqueueSupplierNotification(ctx, ctx.db, {
      supplierId: sup.id,
      type: "sup_monthly_report",
      template: {
        alias: "", lotTitle: "",
        periodLabel: period,
        receivedCount: st.received,
        soldCount: st.sold,
        soldGrossCents: st.grossCents,
        sellThroughPercent: sellThrough,
        payoutCents: st.paidCents,
      },
      dedupeKey: `sup_monthly:${sup.id}:${stamp}`,
    }).catch(() => undefined);
    sent++;

    // Комиссия: отчёт-расчёт вместо счёта поставщика (self-billing).
    if (sup.model === "commission" && st.grossCents > 0) {
      const commissionCents = Math.round((st.grossCents * sup.commissionBp) / 10_000);
      await enqueueSupplierNotification(ctx, ctx.db, {
        supplierId: sup.id,
        type: "sup_sales_report",
        template: {
          alias: "", lotTitle: "",
          periodLabel: period,
          soldGrossCents: st.grossCents,
          commissionCents,
          commissionPercent: Math.round(sup.commissionBp / 100),
          payoutCents: st.grossCents - commissionCents,
          soldLots: await soldLotsOf(ctx, sup.id, from, to),
        },
        dedupeKey: `sup_sales:${sup.id}:${stamp}`,
      }).catch(() => undefined);
      sent++;
    }
  }
  return { sent };
}

/**
 * Непроданный остаток (S10): единицы, которые лежат дольше срока и всё ещё
 * не проданы. Письмо уходит раз в месяц на поставщика, а не на каждую вещь.
 */
export async function runSupplierUnsold(ctx: AppContext): Promise<{ sent: number }> {
  const s = await getFinSettings(ctx);
  if (s.supplier_unsold_days <= 0) return { sent: 0 };
  const cutoff = new Date(ctx.now().getTime() - s.supplier_unsold_days * DAY_MS);
  const rows = rowsOf<{ supplier_id: string; n: string }>(
    await ctx.db.execute(sql`
      SELECT c.supplier_id, count(*)::text AS n
      FROM items i JOIN consignments c ON c.id = i.consignment_id
      WHERE c.supplier_id IS NOT NULL
        AND i.created_at < ${cutoff}
        AND i.status IN ('draft', 'listed', 'unsold')
      GROUP BY c.supplier_id
    `),
  );
  const stamp = ctx.now().toISOString().slice(0, 7);
  let sent = 0;
  for (const r of rows) {
    const count = Number(r.n);
    if (count <= 0) continue;
    await enqueueSupplierNotification(ctx, ctx.db, {
      supplierId: r.supplier_id,
      type: "sup_unsold",
      template: {
        alias: "", lotTitle: "",
        unsoldCount: count,
        waitingDays: s.supplier_unsold_days,
        decideByDate: addWorkingDays(ctx.now(), s.supplier_discrepancy_days * 2),
      },
      dedupeKey: `sup_unsold:${r.supplier_id}:${stamp}`,
    }).catch(() => undefined);
    sent++;
  }
  return { sent };
}

/** Приглашение в кабинет (S1) — отправляется из админки. */
export async function sendSupplierInvite(
  ctx: AppContext,
  args: { supplierId: string; inviteUrl: string; days: number },
): Promise<void> {
  await enqueueSupplierNotification(ctx, ctx.db, {
    supplierId: args.supplierId,
    type: "sup_invite",
    template: { alias: "", lotTitle: "", inviteUrl: args.inviteUrl, inviteDays: args.days },
  });
}

/** Welcome после первого входа в кабинет (S2). */
export async function sendSupplierWelcome(ctx: AppContext, supplierId: string): Promise<void> {
  const [sup] = await ctx.db
    .select({ model: suppliers.model, commissionBp: suppliers.commissionBp, terms: suppliers.paymentTermsDays })
    .from(suppliers)
    .where(and(eq(suppliers.id, supplierId), eq(suppliers.active, true)));
  if (!sup) return;
  await enqueueSupplierNotification(ctx, ctx.db, {
    supplierId,
    type: "sup_welcome",
    template: {
      alias: "", lotTitle: "",
      commissionPercent: sup.model === "commission" ? Math.round(sup.commissionBp / 100) : 0,
      inviteDays: sup.terms,
    },
    dedupeKey: `sup_welcome:${supplierId}`,
  });
}

/**
 * Молчание в срок — согласие (правило из письма S4): просроченные вопросы по
 * приёмке закрываются автоматически, чтобы акты не висели вечно.
 */
export async function closeExpiredDiscrepancies(ctx: AppContext): Promise<{ closed: number }> {
  const rows = await ctx.db
    .update(consignments)
    .set({ discrepancyStatus: "accepted", discrepancyRepliedAt: ctx.now(), discrepancyReply: "" })
    .where(and(eq(consignments.discrepancyStatus, "open"), sql`${consignments.discrepancyDueAt} < ${ctx.now()}`))
    .returning({ id: consignments.id });
  return { closed: rows.length };
}
