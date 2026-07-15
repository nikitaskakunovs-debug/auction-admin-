import { counters, customers, invoices, items, markets, orders } from "@auction/db";
import { formatEur } from "@auction/domain";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@auction/db";

/**
 * Invoice issuing. Numbers are sequential per series — one series per
 * market legal entity per year (e.g. LV-2026-00042) — allocated from the
 * counters table under a row lock, so numbering has no gaps or duplicates
 * even under concurrent closes. The invoice row snapshots everything the
 * document needs; later edits to customers/markets never rewrite history.
 */

export interface InvoiceData {
  orderRef: string;
  marketCode: string;
  seller: { legalName: string; country: string };
  buyer: {
    alias: string;
    email: string;
    name: string | null;
    company: string | null;
    vatNo: string | null;
    country: string | null;
  };
  item: { sku: string; title: string };
  hammerCents: number;
  premiumCents: number;
  netCents: number;
  vatCents: number;
  vatRateBp: number;
  shippingCents: number;
  /** Packing/handling for carrier orders — like shipping, never premium'd. */
  handlingCents: number;
  totalCents: number;
  reverseCharge: boolean;
}

type Tx = Pick<Db, "select" | "insert" | "update">;

/** Issue an invoice for an order inside the caller's transaction. Returns
 * null when the order already has one (unless reissuing). */
export async function issueInvoice(
  tx: Tx,
  orderId: string,
  now: Date,
  opts: { reissue?: boolean } = {},
): Promise<{ id: string; number: string } | null> {
  const [existing] = await tx
    .select({ id: invoices.id, voidedAt: invoices.voidedAt })
    .from(invoices)
    .where(and(eq(invoices.orderId, orderId), isNull(invoices.voidedAt)));
  if (existing) {
    if (!opts.reissue) return null;
    // Correction flow (e.g. shipping added to an unpaid order): the old
    // number stays in the sequence, marked voided; the replacement gets the
    // next number. Never done after money moved.
    await tx.update(invoices).set({ voidedAt: now }).where(eq(invoices.id, existing.id));
  }

  const [order] = await tx.select().from(orders).where(eq(orders.id, orderId));
  if (!order) throw new Error("order not found");
  const [market] = await tx.select().from(markets).where(eq(markets.code, order.marketCode));
  const [item] = await tx.select().from(items).where(eq(items.id, order.itemId));
  const [buyer] = await tx.select().from(customers).where(eq(customers.id, order.customerId));

  const series = `${order.marketCode}-${now.getUTCFullYear()}`;
  const counterKey = `invoice:${series}`;
  // Upsert-and-increment under row lock.
  const [counter] = await tx
    .insert(counters)
    .values({ key: counterKey, value: 1 })
    .onConflictDoUpdate({ target: counters.key, set: { value: sql`${counters.value} + 1` } })
    .returning({ value: counters.value });
  const number = `${series}-${String(counter!.value).padStart(5, "0")}`;

  const data: InvoiceData = {
    orderRef: order.ref,
    marketCode: order.marketCode,
    seller: { legalName: market?.legalName || "Skakunov’s SIA", country: order.marketCode },
    buyer: {
      alias: order.customerAlias,
      email: order.customerEmail,
      name: buyer?.name ?? null,
      company: buyer?.company ?? null,
      vatNo: buyer?.vatNo ?? null,
      country: buyer?.country ?? null,
    },
    item: { sku: item?.sku ?? "—", title: item?.title ?? "—" },
    hammerCents: order.hammerCents,
    premiumCents: order.premiumCents,
    netCents: order.hammerCents + order.premiumCents,
    vatCents: order.vatCents,
    vatRateBp: order.vatRateBp,
    shippingCents: order.shippingCents,
    handlingCents: order.handlingCents,
    totalCents: order.totalCents,
    reverseCharge: order.reverseCharge,
  };

  const [row] = await tx
    .insert(invoices)
    .values({ orderId, number, series, data, issuedAt: now })
    .returning({ id: invoices.id, number: invoices.number });
  return row!;
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Printable invoice document (layout ported from the Shhh InvoiceScreen,
 * upgraded with the hammer/premium split and per-line VAT the design doc
 * requires). Self-contained HTML — print to PDF from the browser. */
export function renderInvoiceHtml(number: string, issuedAt: Date, d: InvoiceData): string {
  const vatPct = (d.vatRateBp / 100).toFixed(1).replace(/\.0$/, "");
  const line = (label: string, value: string, bold = false) => `
    <tr${bold ? ' style="font-weight:700"' : ""}>
      <td style="padding:6px 0">${label}</td>
      <td style="padding:6px 0;text-align:right;font-family:ui-monospace,monospace">${value}</td>
    </tr>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Invoice ${esc(number)}</title>
<style>
  body { font-family: system-ui, sans-serif; color: #0A0A0A; margin: 0; background: #fff; }
  .page { max-width: 720px; margin: 0 auto; padding: 48px 40px; }
  h1 { font-size: 22px; margin: 0; letter-spacing: -0.02em; }
  .muted { color: #6B6B68; font-size: 12px; }
  .grid { display: flex; justify-content: space-between; gap: 24px; margin: 28px 0; }
  .block h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em; color: #6B6B68; margin: 0 0 6px; }
  .block div { font-size: 13px; line-height: 1.55; }
  table.lines { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  table.lines td { border-bottom: 1px solid rgba(10,10,10,0.08); }
  .total td { border-top: 2px solid #0A0A0A; border-bottom: none !important; font-size: 15px; }
  .note { margin-top: 22px; font-size: 12px; color: #6B6B68; line-height: 1.6; }
  @media print { .page { padding: 24px; } }
</style></head><body><div class="page">
  <div style="display:flex;justify-content:space-between;align-items:flex-start">
    <div>
      <h1>Invoice ${esc(number)}</h1>
      <div class="muted">Order ${esc(d.orderRef)} · issued ${issuedAt.toISOString().slice(0, 10)}</div>
    </div>
    <div style="text-align:right">
      <div style="font-weight:700">${esc(d.seller.legalName)}</div>
      <div class="muted">${esc(d.seller.country)}</div>
    </div>
  </div>
  <div class="grid">
    <div class="block"><h3>Billed to</h3><div>
      ${esc(d.buyer.company ?? d.buyer.name ?? d.buyer.alias)}<br>
      ${esc(d.buyer.email)}${d.buyer.country ? `<br>${esc(d.buyer.country)}` : ""}
      ${d.buyer.vatNo ? `<br>VAT ${esc(d.buyer.vatNo)}` : ""}
    </div></div>
    <div class="block" style="text-align:right"><h3>Lot</h3><div>
      ${esc(d.item.title)}<br><span class="muted">${esc(d.item.sku)}</span>
    </div></div>
  </div>
  <table class="lines">
    ${line(`Hammer price — ${esc(d.item.title)}`, formatEur(d.hammerCents))}
    ${line("Buyer's premium (10%)", formatEur(d.premiumCents))}
    ${line("Net amount", formatEur(d.netCents))}
    ${line(d.reverseCharge ? "VAT (reverse charge, 0%)" : `VAT (${vatPct}%)`, formatEur(d.vatCents))}
    ${d.shippingCents > 0 ? line("Shipping (Omniva)", formatEur(d.shippingCents)) : ""}
    ${(d.handlingCents ?? 0) > 0 ? line("Packing & handling", formatEur(d.handlingCents)) : ""}
    <tr class="total" style="font-weight:700">
      <td style="padding:9px 0 0">Total due</td>
      <td style="padding:9px 0 0;text-align:right;font-family:ui-monospace,monospace">${formatEur(d.totalCents)}</td>
    </tr>
  </table>
  ${d.reverseCharge ? `<div class="note">Reverse charge — VAT to be accounted for by the recipient (Art. 196, Council Directive 2006/112/EC). Buyer VAT no. ${esc(d.buyer.vatNo ?? "")}.</div>` : ""}
  <div class="note">Payment reference: ${esc(d.orderRef)} · Currency: EUR</div>
</div></body></html>`;
}
