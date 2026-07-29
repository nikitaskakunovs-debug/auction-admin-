import { useEffect, useRef, useState } from "react";
import { api, type Invoice, type VatReport } from "../api.js";
import type { Nav } from "../App.js";
import { exportCSV, exportPDFPrint, exportXLS } from "../exporters.js";
import { formatDate, formatEur } from "../format.js";
import { isBnpl, methodLabel, providerLabel } from "../paymentLabels.js";
import {
  dateInputStyle, ExportMenu, makeFilterTools, SearchBox, useDebounced, useSavedViews,
  useStoredFilters, ViewsBar,
} from "../powerkit.js";
import { AT } from "../theme.js";
import { ABadge, ABtn, ACard, AEmpty, AField, AIcon, AInput, APills, AStat, ATable, ATd, ATr, useToast } from "../ui.js";

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

interface PaymentFilters {
  status: string;
  provider: string;
  from: string;
  to: string;
  q: string;
}
const PAY_DEFAULTS: PaymentFilters = { status: "all", provider: "all", from: "", to: "", q: "" };
const payTools = makeFilterTools(PAY_DEFAULTS);
const PAY_PAGE = 50;
const PAY_EXPORT_PAGE = 200;

interface PaymentsResponse {
  payments: PaymentRow[];
  total: number;
  summary: { todayCents: number; weekCents: number; pendingCount: number };
}

function payQuery(f: PaymentFilters, limit: number, offset: number): string {
  const p = new URLSearchParams();
  if (f.status !== "all") p.set("status", f.status);
  if (f.provider !== "all") p.set("provider", f.provider);
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.q.trim().length >= 2) p.set("q", f.q.trim());
  p.set("limit", String(limit));
  p.set("offset", String(offset));
  return p.toString();
}

const PAY_EXPORT_HEADERS = ["When", "Order", "Customer", "Provider", "Method", "Via", "Status", "Amount €"];
const payExportRow = (p: PaymentRow): string[] => [
  p.createdAt.slice(0, 16).replace("T", " "),
  p.orderRef,
  p.customerAlias,
  providerLabel(p.provider),
  methodLabel(p.method),
  p.channel === "email" ? "Email link" : "Web",
  p.status,
  (p.amountCents / 100).toFixed(2),
];

/**
 * Every online payment attempt across all orders in one place: provider,
 * exact method (card / banklink / BNPL — with terms in the details), where
 * it was started (web or email link), and its current state.
 */
function PaymentsTab() {
  const toast = useToast();
  const [rows, setRows] = useState<PaymentRow[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<PaymentsResponse["summary"] | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [filters, setFilters] = useState<PaymentFilters>(() => payTools.loadStored("paymentsFilters.v1"));
  const [qInput, setQInput] = useState(filters.q);
  const seq = useRef(0);

  useDebounced(qInput, (v) => setFilters((f) => (f.q === v ? f : { ...f, q: v })));
  useStoredFilters("paymentsFilters.v1", filters);
  const sv = useSavedViews({
    screen: "payments",
    filters,
    defaults: PAY_DEFAULTS,
    normalize: payTools.normalize,
    same: payTools.same,
    apply: (f) => {
      setQInput(f.q);
      setFilters(f);
    },
  });

  useEffect(() => {
    const s = ++seq.current;
    void api.get<PaymentsResponse>(`/api/payments?${payQuery(filters, PAY_PAGE, 0)}`).then((r) => {
      if (seq.current !== s) return;
      setRows(r.payments);
      setTotal(r.total);
      setSummary(r.summary);
    }).catch(() => undefined);
  }, [filters]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const r = await api.get<PaymentsResponse>(`/api/payments?${payQuery(filters, PAY_PAGE, rows.length)}`);
      setRows((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        return [...prev, ...r.payments.filter((p) => !seen.has(p.id))];
      });
      setTotal(r.total);
    } finally {
      setLoadingMore(false);
    }
  };

  const runExport = async (fmt: "csv" | "xls" | "pdf") => {
    try {
      const out: PaymentRow[] = [];
      for (;;) {
        const r = await api.get<PaymentsResponse>(`/api/payments?${payQuery(filters, PAY_EXPORT_PAGE, out.length)}`);
        out.push(...r.payments);
        if (r.payments.length === 0 || out.length >= r.total) break;
      }
      if (out.length === 0) return toast("Nothing to export", "warn");
      const body = out.map(payExportRow);
      if (fmt === "csv") exportCSV("payments", PAY_EXPORT_HEADERS, body);
      else if (fmt === "xls") exportXLS("payments", PAY_EXPORT_HEADERS, body, "Payments");
      else exportPDFPrint("Payments export", PAY_EXPORT_HEADERS, body);
      toast(`Exported ${out.length} payments`, "ok");
    } catch {
      toast("Export failed", "danger");
    }
  };

  const set = (patch: Partial<PaymentFilters>) => setFilters((f) => ({ ...f, ...patch }));

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <ViewsBar {...sv.ViewsBarProps} />
      {summary && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <AStat label="Collected today" value={formatEur(summary.todayCents)} tone={summary.todayCents > 0 ? "ok" : undefined} />
          <AStat label="Last 7 days" value={formatEur(summary.weekCents)} />
          <AStat label="Checkouts in flight" value={summary.pendingCount} tone={summary.pendingCount > 0 ? "warn" : undefined} />
        </div>
      )}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <APills options={STATUS_PILLS} value={filters.status} onChange={(v) => set({ status: v })} />
        <APills options={PROVIDER_PILLS} value={filters.provider} onChange={(v) => set({ provider: v })} />
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <SearchBox value={qInput} onChange={setQInput} placeholder="Search order ref or bidder…" />
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft }}>
          <input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => set({ from: e.target.value })} style={dateInputStyle} />
          –
          <input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => set({ to: e.target.value })} style={dateInputStyle} />
        </label>
        <div style={{ marginLeft: "auto" }}>
          <ExportMenu count={total} scope="filtered" noun="payments" onPick={(fmt) => void runExport(fmt)} />
        </div>
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
        {rows.length > 0 && rows.length < total && (
          <div style={{ padding: 12, display: "flex", justifyContent: "center", borderTop: `1px solid ${AT.ruleSoft}` }}>
            <ABtn kind="ghost" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
              {loadingMore ? "Loading…" : `Load more (${rows.length} of ${total})`}
            </ABtn>
          </div>
        )}
      </ACard>
    </div>
  );
}

function openInvoice(id: string): void {
  window.open(`/api/invoices/${id}/html?token=${encodeURIComponent(api.token ?? "")}`, "_blank");
}

const INV_EXPORT_HEADERS = ["Invoice no.", "Order", "Buyer", "Market", "Issued", "Net €", "VAT €", "Total €", "Reverse charge"];
const invExportRow = (inv: Invoice): string[] => [
  inv.number,
  inv.orderRef ?? "",
  inv.data.buyer.company ?? inv.data.buyer.alias,
  inv.data.marketCode,
  inv.issuedAt.slice(0, 10),
  ((inv.data.totalCents - inv.data.vatCents) / 100).toFixed(2),
  (inv.data.vatCents / 100).toFixed(2),
  (inv.data.totalCents / 100).toFixed(2),
  inv.data.reverseCharge ? "Yes" : "No",
];

function InvoicesTab() {
  const toast = useToast();
  const [rows, setRows] = useState<Invoice[]>([]);
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const seq = useRef(0);

  useDebounced(qInput, setQ);

  const query = (limit: number, offset: number) => {
    const p = new URLSearchParams();
    if (q.trim().length >= 2) p.set("q", q.trim());
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    p.set("limit", String(limit));
    p.set("offset", String(offset));
    return p.toString();
  };

  useEffect(() => {
    const s = ++seq.current;
    void api.get<{ invoices: Invoice[]; total: number }>(`/api/invoices?${query(PAY_PAGE, 0)}`).then((r) => {
      if (seq.current !== s) return;
      setRows(r.invoices);
      setTotal(r.total);
    }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, from, to]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const r = await api.get<{ invoices: Invoice[]; total: number }>(`/api/invoices?${query(PAY_PAGE, rows.length)}`);
      setRows((prev) => {
        const seen = new Set(prev.map((i) => i.id));
        return [...prev, ...r.invoices.filter((i) => !seen.has(i.id))];
      });
      setTotal(r.total);
    } finally {
      setLoadingMore(false);
    }
  };

  const runExport = async (fmt: "csv" | "xls" | "pdf") => {
    try {
      const out: Invoice[] = [];
      for (;;) {
        const r = await api.get<{ invoices: Invoice[]; total: number }>(`/api/invoices?${query(PAY_EXPORT_PAGE, out.length)}`);
        out.push(...r.invoices);
        if (r.invoices.length === 0 || out.length >= r.total) break;
      }
      if (out.length === 0) return toast("Nothing to export", "warn");
      const body = out.map(invExportRow);
      if (fmt === "csv") exportCSV("invoices", INV_EXPORT_HEADERS, body);
      else if (fmt === "xls") exportXLS("invoices", INV_EXPORT_HEADERS, body, "Invoices");
      else exportPDFPrint("Invoices export", INV_EXPORT_HEADERS, body);
      toast(`Exported ${out.length} invoices`, "ok");
    } catch {
      toast("Export failed", "danger");
    }
  };

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <SearchBox value={qInput} onChange={setQInput} placeholder="Search invoice no., order, buyer…" />
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft }}>
          <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} style={dateInputStyle} />
          –
          <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} style={dateInputStyle} />
        </label>
        <div style={{ marginLeft: "auto" }}>
          <ExportMenu count={total} scope="filtered" noun="invoices" onPick={(fmt) => void runExport(fmt)} />
        </div>
      </div>
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
      {rows.length > 0 && rows.length < total && (
        <div style={{ padding: 12, display: "flex", justifyContent: "center", borderTop: `1px solid ${AT.ruleSoft}` }}>
          <ABtn kind="ghost" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? "Loading…" : `Load more (${rows.length} of ${total})`}
          </ABtn>
        </div>
      )}
    </ACard>
    </div>
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

  // A3: shared exporters — the accountant gets Excel and PDF too.
  const VAT_HEADERS = ["Market", "Invoices", "Net €", "VAT due €", "Gross €", "Reverse-charge net €", "RC invoices"];
  const vatRows = (): string[][] =>
    (report?.markets ?? []).map((m) => [
      m.marketCode,
      String(m.invoiceCount),
      (m.netCents / 100).toFixed(2),
      (m.vatCents / 100).toFixed(2),
      (m.grossCents / 100).toFixed(2),
      (m.reverseChargeNetCents / 100).toFixed(2),
      String(m.reverseChargeCount),
    ]);
  const runVatExport = (fmt: "csv" | "xls" | "pdf") => {
    const body = vatRows();
    if (body.length === 0) return;
    const name = `vat-report-${from}-to-${to}`;
    if (fmt === "csv") exportCSV(name, VAT_HEADERS, body);
    else if (fmt === "xls") exportXLS(name, VAT_HEADERS, body, "VAT");
    else exportPDFPrint(`VAT report ${from} – ${to}`, VAT_HEADERS, body);
  };

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
        <AField label="From"><AInput type="date" value={from} onChange={setFrom} /></AField>
        <AField label="To (inclusive)"><AInput type="date" value={to} onChange={setTo} /></AField>
        <ABtn onClick={run}>Run report</ABtn>
        {report && report.markets.length > 0 && (
          <ExportMenu count={report.markets.length} scope="filtered" noun="markets" onPick={runVatExport} />
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
