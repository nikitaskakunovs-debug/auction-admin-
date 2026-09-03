import { consignments, exportBatches, items, ledgerEntries, listings, orders, supplierInvoices, type Db } from "@auction/db";
import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import type { AppContext } from "../context.js";

/**
 * Журнал проводок (fin-architecture, раздел 11) — мост «платформа →
 * бухгалтерия». Каждая денежная операция раскладывается на компонентные
 * строки по схеме счетов; бухгалтер получает их батчами (CSV / XML в духе
 * текущего Jumis-импорта, позже — формат Horizon, когда придёт спецификация).
 *
 * Строки аналитические, по одной на компонент, знак «+» увеличивает счёт в
 * его природе (выручка/актив/обязательство). Никакой двойной записи здесь не
 * навязывается — реальную разноску делает бухгалтерия из этих компонентов.
 */

export const FIN_ACCOUNTS = {
  revenue_hammer: "Ieņēmumi — āmura cena",
  revenue_premium: "Ieņēmumi — pircēja piemaksa",
  revenue_shipping: "Ieņēmumi — piegāde",
  vat_payable: "PVN maksājams",
  expense_shipping_subsidy: "Izdevumi — piegādes subsīdija",
  expense_carrier_fees: "Izdevumi — pārvadātāju tarifi",
  clearing_klix: "Clearing — Klix ceļā",
  clearing_inbank: "Clearing — Inbank ceļā",
  expense_klix_fees: "Izdevumi — Klix komisijas",
  liability_refunds_pending: "Saistības — neizmaksātās atmaksas",
  liability_customer_credit: "Saistības — klientu avansi",
  asset_carrier_claims: "Aktīvi — prasības pret pārvadātājiem",
  expense_goodwill: "Izdevumi — goodwill kompensācijas",
  liability_loyalty_points: "Saistības — lojalitātes punkti",
  revenue_loyalty_breakage: "Ieņēmumi — nodegušie punkti",
  expense_partner_commission: "Izdevumi — partneru komisijas",
  expense_advertising: "Izdevumi — reklāma",
  expense_operating: "Izdevumi — saimnieciskie",
  rounding_differences: "Noapaļošanas starpības",
  asset_inventory: "Aktīvi — krājumi",
  expense_cogs: "Izdevumi — pārdoto preču pašizmaksa",
  expense_inventory_writeoff: "Izdevumi — krājumu norakstīšana",
  asset_fixed: "Aktīvi — pamatlīdzekļi",
  expense_depreciation: "Izdevumi — nolietojums",
} as const;

export type FinAccount = keyof typeof FIN_ACCOUNTS;

type Tx = Pick<Db, "select" | "insert" | "update">;

export interface LedgerLine {
  account: FinAccount;
  amountCents: number;
  legalEntity?: string;
  department?: string | null;
  paymentMethod?: string | null;
  orderRef?: string | null;
  refType?: string | null;
  refId?: string | null;
  memo?: string;
}

/** Провести набор строк одной операции; нулевые суммы отбрасываются. */
export async function postLedger(tx: Tx, lines: LedgerLine[], eventAt: Date): Promise<void> {
  const rows = lines
    .filter((l) => l.amountCents !== 0)
    .map((l) => ({
      account: l.account,
      amountCents: l.amountCents,
      legalEntity: l.legalEntity ?? "LV",
      department: l.department ?? null,
      paymentMethod: l.paymentMethod ?? null,
      orderRef: l.orderRef ?? null,
      refType: l.refType ?? null,
      refId: l.refId ?? null,
      memo: l.memo ?? "",
      eventAt,
    }));
  if (rows.length) await tx.insert(ledgerEntries).values(rows);
}

/**
 * Платёжный метод для clearing-логики: онлайн-провайдеры держат деньги «в
 * пути» (раздел 4 — clearing-счета), касса и POS-терминал — нет.
 */
export function paymentMethodOf(provider: string | undefined): {
  method: string;
  clearing: Extract<FinAccount, "clearing_klix" | "clearing_inbank"> | null;
} {
  const p = (provider ?? "").toLowerCase();
  if (p.includes("klix")) return { method: "klix", clearing: "clearing_klix" };
  if (p.includes("inbank")) return { method: "inbank", clearing: "clearing_inbank" };
  if (p.includes("skaidra") || p === "cash") return { method: "cash", clearing: null };
  if (p.includes("termin")) return { method: "card_pos", clearing: null };
  return { method: p || "manual", clearing: null };
}

type Order = typeof orders.$inferSelect;

/**
 * Проводки оплаченного заказа — вызывается ИЗ транзакции settleOrderPaid,
 * единственного места, где оплата подтверждена. Компоненты: выручка (молоток /
 * премия / доставка), PVN, движение баллов, аванс, clearing и COGS. Остаток от
 * сверки компонентов с итогом уходит в rounding_differences, чтобы экспорт
 * всегда сходился с заказом цент в цент.
 */
export async function postSalePaid(
  tx: Tx,
  args: {
    order: Order;
    itemCostCents: number | null;
    earnedPointsCents: number;
    provider?: string | undefined;
  },
  eventAt: Date,
): Promise<void> {
  const { order } = args;
  const { method, clearing } = paymentMethodOf(args.provider);
  const base = { orderRef: order.ref, refType: "order", refId: order.id, paymentMethod: method };
  const lines: LedgerLine[] = [];
  const netHammer = order.hammerCents;
  lines.push({ ...base, account: "revenue_hammer", amountCents: netHammer, memo: "Āmura cena" });
  lines.push({ ...base, account: "revenue_premium", amountCents: order.premiumCents + order.handlingCents, memo: "Pircēja piemaksa + apstrāde" });
  lines.push({ ...base, account: "revenue_shipping", amountCents: order.shippingCents + order.insuranceCents, memo: "Piegāde + apdrošināšana" });
  lines.push({ ...base, account: "vat_payable", amountCents: order.vatCents, memo: `PVN ${order.vatRateBp / 100}%` });
  // Сверка: компоненты выше должны дать итог заказа; остаток — в округления.
  const componentSum =
    netHammer + order.premiumCents + order.handlingCents + order.shippingCents + order.insuranceCents + order.vatCents;
  const residual = order.totalCents - componentSum;
  if (residual !== 0) {
    lines.push({ ...base, account: "rounding_differences", amountCents: residual, memo: "Komponentu starpība pret kopsummu" });
  }
  // Баллы: списанные в оплату уменьшают обязательство, новые — увеличивают.
  if (order.pointsAppliedCents > 0) {
    lines.push({ ...base, account: "liability_loyalty_points", amountCents: -order.pointsAppliedCents, memo: "Punkti izmantoti apmaksā" });
  }
  if (args.earnedPointsCents > 0) {
    lines.push({ ...base, account: "liability_loyalty_points", amountCents: args.earnedPointsCents, memo: "Punkti nopelnīti" });
  }
  // Аванс: часть итога закрыта клиентским кредитом — обязательство падает.
  if (order.creditAppliedCents > 0) {
    lines.push({ ...base, account: "liability_customer_credit", amountCents: -order.creditAppliedCents, memo: "Avanss ieskaitīts" });
  }
  // Деньги «в пути» у онлайн-провайдера до выплаты на банku (раздел 4).
  const cashReceived = order.totalCents - order.pointsAppliedCents - order.creditAppliedCents;
  if (clearing && cashReceived > 0) {
    lines.push({ ...base, account: clearing, amountCents: cashReceived, memo: "Saņemts caur provaideru — ceļā" });
  }
  // COGS: себестоимость проданного, если она известна (W6 costCents).
  if (args.itemCostCents != null && args.itemCostCents > 0) {
    lines.push({ ...base, account: "expense_cogs", amountCents: args.itemCostCents, memo: "Pārdotās preces pašizmaksa" });
    lines.push({ ...base, account: "asset_inventory", amountCents: -args.itemCostCents, memo: "Krājumu samazinājums" });
  }
  await postLedger(tx, lines, eventAt);
}

/** Заявка на возврат: сумма повисает обязательством до «выплачено» (5.2). */
export async function postRefundRequested(
  tx: Tx,
  args: { refundId: string; orderRef: string; amountCents: number; method: string },
  eventAt: Date,
): Promise<void> {
  await postLedger(
    tx,
    [{
      account: "liability_refunds_pending",
      amountCents: args.amountCents,
      orderRef: args.orderRef,
      refType: "refund",
      refId: args.refundId,
      paymentMethod: args.method,
      memo: "Atmaksa pieprasīta — gaida izmaksu",
    }],
    eventAt,
  );
}

/**
 * Возврат ВЫПЛАЧЕН — только теперь сторнируется выручка (решение из
 * архитектуры: сторно не раньше реального движения денег). Частичный возврат
 * снимает выручку и PVN пропорционально доле суммы в итоге заказа.
 */
export async function postRefundPaid(
  tx: Tx,
  args: {
    refund: { id: string; amountCents: number; method: string };
    order: Order;
    /** true — заявка ранее повесила liability_refunds_pending, снимаем её. */
    pendingHeld: boolean;
  },
  eventAt: Date,
): Promise<void> {
  const { refund, order } = args;
  const base = { orderRef: order.ref, refType: "refund", refId: refund.id, paymentMethod: refund.method };
  const share = order.totalCents > 0 ? refund.amountCents / order.totalCents : 0;
  const hammerBack = Math.round(order.hammerCents * share);
  const premiumBack = Math.round((order.premiumCents + order.handlingCents) * share);
  const shippingBack = Math.round((order.shippingCents + order.insuranceCents) * share);
  const vatBack = Math.round(order.vatCents * share);
  const residual = refund.amountCents - (hammerBack + premiumBack + shippingBack + vatBack);
  await postLedger(
    tx,
    [
      ...(args.pendingHeld
        ? [{ ...base, account: "liability_refunds_pending" as const, amountCents: -refund.amountCents, memo: "Atmaksa izmaksāta" }]
        : []),
      { ...base, account: "revenue_hammer", amountCents: -hammerBack, memo: "Storno — āmura cena" },
      { ...base, account: "revenue_premium", amountCents: -premiumBack, memo: "Storno — piemaksa" },
      { ...base, account: "revenue_shipping", amountCents: -shippingBack, memo: "Storno — piegāde" },
      { ...base, account: "vat_payable", amountCents: -vatBack, memo: "Storno — PVN" },
      { ...base, account: "rounding_differences", amountCents: -residual, memo: "Storno — noapaļojums" },
    ],
    eventAt,
  );
}

/**
 * Ручные проводки — goodwill-компенсация клиенту и претензия к перевозчику
 * (разделы 5.4 и 6). Отдаём узкий выбор счетов, а не весь план — ошибиться
 * из админки должно быть трудно.
 */
export async function postManual(
  tx: Tx,
  args: {
    kind: "goodwill" | "carrier_claim" | "carrier_claim_settled" | "writeoff";
    amountCents: number;
    orderRef?: string | null;
    memo: string;
    actor: string;
    department?: string | null;
  },
  eventAt: Date,
): Promise<void> {
  const common = { orderRef: args.orderRef ?? null, refType: "manual", refId: null, department: args.department ?? null };
  const memo = `${args.memo} (${args.actor})`;
  const lines: LedgerLine[] =
    args.kind === "goodwill"
      ? [{ ...common, account: "expense_goodwill", amountCents: args.amountCents, memo }]
      : args.kind === "carrier_claim"
        ? [{ ...common, account: "asset_carrier_claims", amountCents: args.amountCents, memo }]
        : args.kind === "carrier_claim_settled"
          ? [{ ...common, account: "asset_carrier_claims", amountCents: -args.amountCents, memo }]
          : [
              { ...common, account: "expense_inventory_writeoff", amountCents: args.amountCents, memo },
              { ...common, account: "asset_inventory", amountCents: -args.amountCents, memo },
            ];
  await postLedger(tx, lines, eventAt);
}

/**
 * Одобренный счёт поставщика становится проводкой: привязан к поставке —
 * это приход запасов (палета), реклама — расход рекламы, остальное — прочие
 * хозяйственные расходы по категории.
 */
export async function postSupplierInvoiceApproved(
  tx: Tx,
  invoice: typeof supplierInvoices.$inferSelect,
  eventAt: Date,
): Promise<void> {
  const account: FinAccount = invoice.consignmentId
    ? "asset_inventory"
    : (invoice.category ?? "").toLowerCase().includes("rekl") || (invoice.category ?? "").toLowerCase().includes("advert")
      ? "expense_advertising"
      : "expense_operating";
  await postLedger(
    tx,
    [{
      account,
      amountCents: invoice.amountCents,
      legalEntity: invoice.legalEntity,
      department: invoice.department,
      refType: "supplier_invoice",
      refId: invoice.id,
      memo: `Piegādātāja rēķins ${invoice.number}`,
    }],
    eventAt,
  );
}

/**
 * Распределитель себестоимости палеты (раздел 3, решение владельца):
 * пул = одобренные счета поставки + extraCostCents; вес каждой единицы —
 * её оценка (стартовая/фиксированная цена листинга), fallback — поровну.
 * Пишет costCents только пустым позициям; уже оценённые вручную не трогает.
 */
export async function allocateConsignmentCost(
  tx: Tx,
  consignmentId: string,
  now: Date,
): Promise<{ allocated: number; poolCents: number } | { error: "no_pool" | "no_items" }> {
  const [con] = await tx.select().from(consignments).where(eq(consignments.id, consignmentId));
  if (!con) return { error: "no_items" };
  const invoices = await tx
    .select({ amountCents: supplierInvoices.amountCents, approvalStatus: supplierInvoices.approvalStatus })
    .from(supplierInvoices)
    .where(eq(supplierInvoices.consignmentId, consignmentId));
  const poolCents =
    invoices
      .filter((i) => i.approvalStatus === "approved" || i.approvalStatus === "auto")
      .reduce((s, i) => s + i.amountCents, 0) + (con.extraCostCents ?? 0);
  if (poolCents <= 0) return { error: "no_pool" };
  const units = await tx
    .select({ id: items.id, costCents: items.costCents })
    .from(items)
    .where(eq(items.consignmentId, consignmentId));
  const blank = units.filter((u) => u.costCents == null);
  if (!blank.length) return { error: "no_items" };
  // Оценка единицы: цена её листинга (старт аукциона или фикс-цена).
  const ls = await tx
    .select({ itemId: listings.itemId, startPriceCents: listings.startPriceCents, priceCents: listings.priceCents })
    .from(listings)
    .where(inArray(listings.itemId, blank.map((u) => u.id)));
  const estimate = new Map<string, number>();
  for (const l of ls) {
    const v = l.priceCents ?? l.startPriceCents ?? 0;
    if (v > 0) estimate.set(l.itemId, Math.max(estimate.get(l.itemId) ?? 0, v));
  }
  const weights = blank.map((u) => estimate.get(u.id) ?? 0);
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  // Fallback поровну: оценок нет вовсе — либо у всех, либо метод не применим.
  const perUnit = totalWeight > 0 ? null : Math.floor(poolCents / blank.length);
  let assigned = 0;
  for (let i = 0; i < blank.length; i++) {
    const isLast = i === blank.length - 1;
    const cost = isLast
      ? poolCents - assigned // последний забирает остаток — сумма сходится до цента
      : perUnit != null
        ? perUnit
        : Math.floor((poolCents * weights[i]!) / totalWeight);
    assigned += cost;
    await tx.update(items).set({ costCents: cost, updatedAt: now }).where(eq(items.id, blank[i]!.id));
  }
  return { allocated: blank.length, poolCents };
}

// ── Экспорт батчей (CSV + XML в духе текущего Jumis-импорта) ────────────────

type Entry = typeof ledgerEntries.$inferSelect;

const CSV_HEADER = "date;account;account_name;amount_eur;legal_entity;department;payment_method;order_ref;ref_type;memo";

function csvCell(v: string): string {
  return /[;"\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
}

export function buildExportCsv(entries: Entry[]): string {
  const lines = entries.map((e) =>
    [
      e.eventAt.toISOString().slice(0, 10),
      e.account,
      FIN_ACCOUNTS[e.account as FinAccount] ?? e.account,
      (e.amountCents / 100).toFixed(2),
      e.legalEntity,
      e.department ?? "",
      e.paymentMethod ?? "",
      e.orderRef ?? "",
      e.refType ?? "",
      e.memo,
    ].map(csvCell).join(";"),
  );
  return [CSV_HEADER, ...lines].join("\r\n") + "\r\n";
}

function xmlEsc(v: string): string {
  return v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/**
 * XML по образцу текущего импорта владельца (tjResponse → Insert-операции).
 * Когда придёт спецификация Horizon — добавится второй форматтер, структура
 * строк уже готова.
 */
export function buildExportXml(entries: Entry[], batch: { id: string; fromAt: Date; toAt: Date }): string {
  const rows = entries
    .map(
      (e) => `    <tjRequest Name="LedgerEntry" Operation="Insert">
      <EntryDate>${e.eventAt.toISOString().slice(0, 10)}</EntryDate>
      <Account>${xmlEsc(e.account)}</Account>
      <AccountName>${xmlEsc(FIN_ACCOUNTS[e.account as FinAccount] ?? e.account)}</AccountName>
      <Amount>${(e.amountCents / 100).toFixed(2)}</Amount>
      <Currency>EUR</Currency>
      <LegalEntity>${xmlEsc(e.legalEntity)}</LegalEntity>
      <Department>${xmlEsc(e.department ?? "")}</Department>
      <PaymentMethod>${xmlEsc(e.paymentMethod ?? "")}</PaymentMethod>
      <DocNumber>${xmlEsc(e.orderRef ?? "")}</DocNumber>
      <RefType>${xmlEsc(e.refType ?? "")}</RefType>
      <Memo>${xmlEsc(e.memo)}</Memo>
    </tjRequest>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<tjExport BatchId="${batch.id}" From="${batch.fromAt.toISOString().slice(0, 10)}" To="${batch.toAt.toISOString().slice(0, 10)}">
${rows}
</tjExport>
`;
}

/**
 * Собрать батч экспорта: все ещё не выгруженные строки периода помечаются
 * батчем и отдаются файлом. Повторный вызов того же периода не задваивает —
 * берутся только строки без exportBatchId.
 */
export async function createExportBatch(
  ctx: AppContext,
  args: { fromAt: Date; toAt: Date; format: "csv" | "xml"; actor: string },
): Promise<{ batchId: string; entryCount: number; content: string; filename: string } | { error: "empty" }> {
  return await ctx.db.transaction(async (tx) => {
    const entries = await tx
      .select()
      .from(ledgerEntries)
      .where(and(isNull(ledgerEntries.exportBatchId), gte(ledgerEntries.eventAt, args.fromAt), lte(ledgerEntries.eventAt, args.toAt)))
      .orderBy(ledgerEntries.eventAt, ledgerEntries.createdAt);
    if (!entries.length) return { error: "empty" as const };
    const [batch] = await tx
      .insert(exportBatches)
      .values({ format: args.format, fromAt: args.fromAt, toAt: args.toAt, entryCount: entries.length, createdBy: args.actor })
      .returning();
    await tx
      .update(ledgerEntries)
      .set({ exportBatchId: batch!.id })
      .where(inArray(ledgerEntries.id, entries.map((e) => e.id)));
    const stamp = args.toAt.toISOString().slice(0, 10);
    return args.format === "csv"
      ? { batchId: batch!.id, entryCount: entries.length, content: buildExportCsv(entries), filename: `izsoli-ledger-${stamp}.csv` }
      : { batchId: batch!.id, entryCount: entries.length, content: buildExportXml(entries, { id: batch!.id, fromAt: args.fromAt, toAt: args.toAt }), filename: `izsoli-ledger-${stamp}.xml` };
  });
}
