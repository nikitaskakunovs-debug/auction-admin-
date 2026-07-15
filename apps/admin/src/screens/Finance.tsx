import { useEffect, useState } from "react";
import { api, type Invoice, type VatReport } from "../api.js";
import type { Nav } from "../App.js";
import { formatDate, formatEur } from "../format.js";
import { isBnpl, methodLabel, providerLabel } from "../paymentLabels.js";
import { AT } from "../theme.js";
import { ABadge, ABtn, ACard, AEmpty, AField, AIcon, AInput, APills, ATable, ATd, ATr, useToast } from "../ui.js";

const TABS = [
  { id: "payments", label: "Payments" },
  { id: "invoices", label: "Invoices" },
  { id: "vat", label: "VAT report" },
];

function monthStart(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function FinanceScreen({ nav: _nav }: { nav: Nav }) {
  const [tab, setTab] = useState("payments");
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <h1 style={{ fontFamily: AT.body, fontSize: 20, fontWeight: 700, color: AT.ink }}>Finance</h1>
      <div style={{ display: "flex", gap: 2, borderBottom: `1px solid ${AT.rule}` }}>
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            all: "unset", cursor: "pointer", padding: "9px 14px", fontFamily: AT.body,
            fontSize: 13, fontWeight: 600, color: tab === t.id ? AT.ink : AT.inkSoft,
            borderBottom: `2px solid ${tab === t.id ? AT.accent : "transparent"}`, marginBottom: -1,
          }}>{t.label}</button>
        ))}
      </div>
      {tab === "payments" ? <PaymentsTab /> : tab === "invoices" ? <InvoicesTab /> : <VatTab />}
    </div>
  );
}

interface PaymentRow {
  id: string;
  provider: string;
  channel: string;
  providerId: string | null;
  status: string;
  providerStatus: string | null;
  method: string | null;
  raw: Record<string, unknown> | null;
  amountCents: number;
  createdAt: string;
  orderRef: string;
  orderStatus: string;
  customerAlias: string;
  itemTitle: string;
}

const PAYMENT_TONE: Record<string, "ok" | "warn" | "danger" | "neutral"> = {
  paid: "ok",
  created: "warn",
  failed: "danger",
  expired: "neutral",
};

const STATUS_PILLS = [
  { id: "all", label: "All" },
  { id: "paid", label: "Paid" },
  { id: "created", label: "In flight" },
  { id: "failed", label: "Failed" },
  { id: "expired", label: "Expired" },
];
const PROVIDER_PILLS = [
  { id: "all", label: "All providers" },
  { id: "klix", label: "Klix" },
  { id: "inbank", label: "Inbank" },
];

/**
 * Every online payment attempt across all orders in one place: provider,
 * exact method (card / banklink / BNPL — with terms in the details), where
 * it was started (web or email link), and its current state.
 */
function PaymentsTab() {
  const [rows, setRows] = useState<PaymentRow[]>([]);
  const [status, setStatus] = useState("all");
  const [provider, setProvider] = useState("all");

  useEffect(() => {
    const params = new URLSearchParams();
    if (status !== "all") params.set("status", status);
    if (provider !== "all") params.set("provider", provider);
    const qs = params.toString();
    void api
      .get<{ payments: PaymentRow[] }>(`/api/payments${qs ? `?${qs}` : ""}`)
      .then((r) => setRows(r.payments))
      .catch(() => undefined);
  }, [status, provider]);

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <APills options={STATUS_PILLS} value={status} onChange={setStatus} />
        <APills options={PROVIDER_PILLS} value={provider} onChange={setProvider} />
      </div>
      <ACard pad={false}>
        {rows.length === 0 ? (
          <AEmpty text="No online payment attempts match — they appear here the moment a customer opens a checkout." />
        ) : (
          <ATable head={["When", "Order", "Customer", "Provider", "Method", "Via", "Status", "Amount", ""]}>
            {rows.map((p) => (
              <ATr key={p.id}>
                <ATd>{formatDate(p.createdAt)}</ATd>
                <ATd mono>
                  <strong>{p.orderRef}</strong>
                  <div style={{ fontSize: 10.5, color: AT.inkSoft, fontFamily: AT.body }}>{p.itemTitle}</div>
                </ATd>
                <ATd>{p.customerAlias}</ATd>
                <ATd><span style={{ fontWeight: 600, fontSize: 12 }}>{providerLabel(p.provider)}</span></ATd>
                <ATd>
                  <span style={{ fontSize: 12 }}>{methodLabel(p.method)}</span>
                  {isBnpl(p.method) && <span style={{ marginLeft: 6 }}><ABadge tone="accent">BNPL</ABadge></span>}
                </ATd>
                <ATd><span style={{ fontSize: 12, color: AT.inkSoft }}>{p.channel === "email" ? "Email link" : "Web"}</span></ATd>
                <ATd>
                  <ABadge tone={PAYMENT_TONE[p.status] ?? "neutral"}>{p.status}</ABadge>
                  {p.providerStatus && p.providerStatus !== p.status && (
                    <div style={{ fontSize: 10, color: AT.inkSoft, marginTop: 2 }}>{p.providerStatus}</div>
                  )}
                </ATd>
                <ATd mono right><strong>{formatEur(p.amountCents)}</strong></ATd>
                <ATd>
                  <details>
                    <summary style={{ cursor: "pointer", fontSize: 11, color: AT.inkSoft }}>details</summary>
                    <div style={{ fontFamily: AT.mono, fontSize: 10.5, color: AT.inkSoft, marginTop: 4 }}>
                      <div>provider ref: {p.providerId ?? "—"}</div>
                      {p.raw && (
                        <pre style={{ margin: "4px 0 0", whiteSpace: "pre-wrap", maxWidth: 380, maxHeight: 220, overflow: "auto", background: "#F6F6F4", borderRadius: 6, padding: 6 }}>
                          {JSON.stringify(p.raw, null, 1)}
                        </pre>
                      )}
                    </div>
                  </details>
                </ATd>
              </ATr>
            ))}
          </ATable>
        )}
      </ACard>
    </div>
  );
}

function openInvoice(id: string): void {
  window.open(`/api/invoices/${id}/html?token=${encodeURIComponent(api.token ?? "")}`, "_blank");
}

function InvoicesTab() {
  const [rows, setRows] = useState<Invoice[]>([]);
  useEffect(() => {
    void api.get<{ invoices: Invoice[] }>("/api/invoices").then((r) => setRows(r.invoices)).catch(() => undefined);
  }, []);

  return (
    <ACard pad={false}>
      {rows.length === 0 ? (
        <AEmpty text="No invoices issued yet — they are created automatically when an auction closes with a winner." />
      ) : (
        <ATable head={["Invoice no.", "Order", "Buyer", "Market", "Issued", "VAT", "Total", ""]}>
          {rows.map((inv) => (
            <ATr key={inv.id} onClick={() => openInvoice(inv.id)}>
              <ATd mono><strong>{inv.number}</strong></ATd>
              <ATd mono>{inv.orderRef}</ATd>
              <ATd>
                <div style={{ fontWeight: 600 }}>{inv.data.buyer.company ?? inv.data.buyer.alias}</div>
                <div style={{ fontSize: 10.5, color: AT.inkSoft }}>{inv.data.buyer.email}</div>
              </ATd>
              <ATd>{inv.data.marketCode}</ATd>
              <ATd>{formatDate(inv.issuedAt)}</ATd>
              <ATd mono right>
                {inv.data.reverseCharge ? <ABadge tone="accent">RC 0%</ABadge> : formatEur(inv.data.vatCents)}
              </ATd>
              <ATd mono right><strong>{formatEur(inv.data.totalCents)}</strong></ATd>
              <ATd right>
                <ABtn size="sm" kind="ghost" onClick={() => openInvoice(inv.id)}>
                  <AIcon name="download" size={13} /> Open
                </ABtn>
              </ATd>
            </ATr>
          ))}
        </ATable>
      )}
    </ACard>
  );
}

function VatTab() {
  const toast = useToast();
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [report, setReport] = useState<VatReport | null>(null);

  const run = () => {
    // `to` is exclusive in the API; include the chosen end day.
    const toExclusive = new Date(new Date(to).getTime() + 86_400_000).toISOString().slice(0, 10);
    void api
      .get<VatReport>(`/api/reports/vat?from=${from}&to=${toExclusive}`)
      .then(setReport)
      .catch(() => toast("Failed to load the report", "danger"));
  };
  useEffect(run, []);

  const totals = report?.markets.reduce(
    (a, m) => ({
      invoiceCount: a.invoiceCount + m.invoiceCount,
      netCents: a.netCents + m.netCents,
      vatCents: a.vatCents + m.vatCents,
      grossCents: a.grossCents + m.grossCents,
      reverseChargeNetCents: a.reverseChargeNetCents + m.reverseChargeNetCents,
    }),
    { invoiceCount: 0, netCents: 0, vatCents: 0, grossCents: 0, reverseChargeNetCents: 0 },
  );

  const exportCsv = () => {
    if (!report) return;
    const header = "market,invoices,net_eur,vat_eur,gross_eur,reverse_charge_net_eur,reverse_charge_invoices";
    const lines = report.markets.map((m) =>
      [m.marketCode, m.invoiceCount, (m.netCents / 100).toFixed(2), (m.vatCents / 100).toFixed(2), (m.grossCents / 100).toFixed(2), (m.reverseChargeNetCents / 100).toFixed(2), m.reverseChargeCount].join(","),
    );
    const blob = new Blob([[header, ...lines].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `vat-report-${from}-to-${to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
        <AField label="From"><AInput type="date" value={from} onChange={setFrom} /></AField>
        <AField label="To (inclusive)"><AInput type="date" value={to} onChange={setTo} /></AField>
        <ABtn onClick={run}>Run report</ABtn>
        {report && report.markets.length > 0 && (
          <ABtn kind="ghost" onClick={exportCsv}><AIcon name="download" size={14} /> Export CSV</ABtn>
        )}
        <span style={{ fontFamily: AT.body, fontSize: 11.5, color: AT.inkSoft, marginLeft: "auto" }}>
          Basis: invoices issued in period · confirm treatment with your accountant
        </span>
      </div>

      <ACard pad={false}>
        {!report || report.markets.length === 0 ? (
          <AEmpty text="No invoices in this period." />
        ) : (
          <ATable head={["Market", "Invoices", "Net", "VAT due", "Gross", "Reverse-charge net", "RC invoices"]}>
            {report.markets.map((m) => (
              <ATr key={m.marketCode}>
                <ATd><strong>{m.marketCode}</strong></ATd>
                <ATd right>{m.invoiceCount}</ATd>
                <ATd mono right>{formatEur(m.netCents)}</ATd>
                <ATd mono right><strong>{formatEur(m.vatCents)}</strong></ATd>
                <ATd mono right>{formatEur(m.grossCents)}</ATd>
                <ATd mono right>{formatEur(m.reverseChargeNetCents)}</ATd>
                <ATd right>{m.reverseChargeCount}</ATd>
              </ATr>
            ))}
            {totals && (
              <ATr>
                <ATd><strong>Total</strong></ATd>
                <ATd right><strong>{totals.invoiceCount}</strong></ATd>
                <ATd mono right><strong>{formatEur(totals.netCents)}</strong></ATd>
                <ATd mono right><strong>{formatEur(totals.vatCents)}</strong></ATd>
                <ATd mono right><strong>{formatEur(totals.grossCents)}</strong></ATd>
                <ATd mono right><strong>{formatEur(totals.reverseChargeNetCents)}</strong></ATd>
                <ATd right>{""}</ATd>
              </ATr>
            )}
          </ATable>
        )}
      </ACard>
    </div>
  );
}
