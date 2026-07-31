import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Invoice, type VatReport } from "../api.js";
import type { Nav } from "../App.js";
import { useAuth } from "../auth.js";
import { exportCSV, exportPDFPrint, exportXLS } from "../exporters.js";
import { formatDate, formatDay, formatEur } from "../format.js";
import { useT, type TKey } from "../i18n.js";
import { isBnpl, methodLabel, providerLabel } from "../paymentLabels.js";
import {
  dateInputStyle, ExportMenu, makeFilterTools, SearchBox, useDebounced, useSavedViews,
  useStoredFilters, ViewsBar,
} from "../powerkit.js";
import { AT, type Tone } from "../theme.js";
import {
  ABadge, ABtn, ACard, ADrawer, AEmpty, AField, AIcon, AInput, APills, ASelect, AStat,
  ATable, ATd, ATr, useConfirm, useToast,
} from "../ui.js";

/**
 * Each tab answers to its own permission and the screen opens for anyone who
 * holds at least one of them (see SCREENS in App.tsx). Finance holds
 * invoices.view; Sales Manager holds only finance.view and lands on Profit.
 */
const TABS: { id: string; label: TKey; permission: string }[] = [
  { id: "payments", label: "fin.tab.payments", permission: "orders.view" },
  { id: "invoices", label: "fin.tab.invoices", permission: "invoices.view" },
  { id: "vat", label: "fin.tab.vat", permission: "invoices.view" },
  // W6: profit & stock value — purchase costs are private to finance.view.
  { id: "profit", label: "fin.pf.tab", permission: "finance.view" },
  // R1: what we owe suppliers — money going out, same permission as the money
  // coming in on Profit.
  { id: "payables", label: "fin.pay.tab", permission: "finance.view" },
];

function monthStart(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function FinanceScreen({ nav: _nav }: { nav: Nav }) {
  const { t } = useT();
  const { can } = useAuth();
  const tabs = TABS.filter((tb) => can(tb.permission));
  // Start on the first tab this role may actually open — a finance.view-only
  // user would otherwise land on a Payments tab the API refuses to serve.
  const [tab, setTab] = useState(() => tabs[0]?.id ?? "profit");
  const active = tabs.some((tb) => tb.id === tab) ? tab : tabs[0]?.id ?? null;
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <h1 style={{ fontFamily: AT.body, fontSize: 20, fontWeight: 700, color: AT.ink }}>{t("fin.title")}</h1>
      <div style={{ display: "flex", gap: 2, borderBottom: `1px solid ${AT.rule}` }}>
        {tabs.map((tb) => (
          <button key={tb.id} onClick={() => setTab(tb.id)} style={{
            all: "unset", cursor: "pointer", padding: "9px 14px", fontFamily: AT.body,
            fontSize: 13, fontWeight: 600, color: active === tb.id ? AT.ink : AT.inkSoft,
            borderBottom: `2px solid ${active === tb.id ? AT.accent : "transparent"}`, marginBottom: -1,
          }}>{t(tb.label)}</button>
        ))}
      </div>
      {active === "payments" ? <PaymentsTab />
        : active === "invoices" ? <InvoicesTab />
          : active === "vat" ? <VatTab />
            : active === "profit" ? <ProfitTab />
              : active === "payables" ? <PayablesTab />
                : <AEmpty text={t("fin.noTabs")} />}
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

/** Payment status words — raw server values, translated when known. */
const PAY_STATUS_KEY: Record<string, TKey> = {
  paid: "fin.pst.paid",
  created: "fin.pst.created",
  failed: "fin.pst.failed",
  expired: "fin.pst.expired",
};

const STATUS_PILLS: { id: string; label: TKey }[] = [
  { id: "all", label: "c.all" },
  { id: "paid", label: "fin.ps.paid" },
  { id: "created", label: "fin.ps.created" },
  { id: "failed", label: "fin.ps.failed" },
  { id: "expired", label: "fin.ps.expired" },
];
// Provider names (Klix, Inbank) are brands — never translated.
const PROVIDER_PILLS = [
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

/**
 * Every online payment attempt across all orders in one place: provider,
 * exact method (card / banklink / BNPL — with terms in the details), where
 * it was started (web or email link), and its current state.
 */
function PaymentsTab() {
  const { t } = useT();
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

  const payStatusWord = (s: string): string => {
    const k = PAY_STATUS_KEY[s];
    return k ? t(k) : s;
  };

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

  const payExportHeaders = [
    t("fin.th.when"), t("fin.th.order"), t("fin.th.customer"), t("fin.th.provider"),
    t("fin.th.method"), t("fin.th.via"), t("c.status"), `${t("fin.th.amount")} €`,
  ];
  const payExportRow = (p: PaymentRow): string[] => [
    p.createdAt.slice(0, 16).replace("T", " "),
    p.orderRef,
    p.customerAlias,
    providerLabel(p.provider),
    methodLabel(p.method),
    p.channel === "email" ? t("fin.via.email") : t("fin.via.web"),
    payStatusWord(p.status),
    (p.amountCents / 100).toFixed(2),
  ];

  const runExport = async (fmt: "csv" | "xls" | "pdf") => {
    try {
      const out: PaymentRow[] = [];
      for (;;) {
        const r = await api.get<PaymentsResponse>(`/api/payments?${payQuery(filters, PAY_EXPORT_PAGE, out.length)}`);
        out.push(...r.payments);
        if (r.payments.length === 0 || out.length >= r.total) break;
      }
      if (out.length === 0) return toast(t("fin.nothingToExport"), "warn");
      const body = out.map(payExportRow);
      if (fmt === "csv") exportCSV("payments", payExportHeaders, body);
      else if (fmt === "xls") exportXLS("payments", payExportHeaders, body, t("fin.tab.payments"));
      else exportPDFPrint(t("fin.payExportTitle"), payExportHeaders, body);
      toast(`${t("fin.exportedPayments")}: ${out.length}`, "ok");
    } catch {
      toast(t("fin.exportFailed"), "danger");
    }
  };

  const set = (patch: Partial<PaymentFilters>) => setFilters((f) => ({ ...f, ...patch }));

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <ViewsBar {...sv.ViewsBarProps} />
      {summary && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <AStat label={t("fin.stat.today")} value={formatEur(summary.todayCents)} tone={summary.todayCents > 0 ? "ok" : undefined} />
          <AStat label={t("fin.stat.week")} value={formatEur(summary.weekCents)} />
          <AStat label={t("fin.stat.inFlight")} value={summary.pendingCount} tone={summary.pendingCount > 0 ? "warn" : undefined} />
        </div>
      )}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <APills options={STATUS_PILLS.map((p) => ({ id: p.id, label: t(p.label) }))} value={filters.status} onChange={(v) => set({ status: v })} />
        <APills options={[{ id: "all", label: t("fin.allProviders") }, ...PROVIDER_PILLS]} value={filters.provider} onChange={(v) => set({ provider: v })} />
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <SearchBox value={qInput} onChange={setQInput} placeholder={t("fin.paySearchPh")} />
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft }}>
          <input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => set({ from: e.target.value })} style={dateInputStyle} />
          –
          <input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => set({ to: e.target.value })} style={dateInputStyle} />
        </label>
        <div style={{ marginLeft: "auto" }}>
          <ExportMenu count={total} scope="filtered" noun={t("fin.nounPayments")} onPick={(fmt) => void runExport(fmt)} />
        </div>
      </div>
      <ACard pad={false}>
        {rows.length === 0 ? (
          <AEmpty text={t("fin.payEmpty")} />
        ) : (
          <ATable head={[t("fin.th.when"), t("fin.th.order"), t("fin.th.customer"), t("fin.th.provider"), t("fin.th.method"), t("fin.th.via"), t("c.status"), t("fin.th.amount"), ""]}>
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
                <ATd><span style={{ fontSize: 12, color: AT.inkSoft }}>{p.channel === "email" ? t("fin.via.email") : t("fin.via.web")}</span></ATd>
                <ATd>
                  <ABadge tone={PAYMENT_TONE[p.status] ?? "neutral"}>{payStatusWord(p.status)}</ABadge>
                  {p.providerStatus && p.providerStatus !== p.status && (
                    <div style={{ fontSize: 10, color: AT.inkSoft, marginTop: 2 }}>{p.providerStatus}</div>
                  )}
                </ATd>
                <ATd mono right><strong>{formatEur(p.amountCents)}</strong></ATd>
                <ATd>
                  <details>
                    <summary style={{ cursor: "pointer", fontSize: 11, color: AT.inkSoft }}>{t("fin.details")}</summary>
                    <div style={{ fontFamily: AT.mono, fontSize: 10.5, color: AT.inkSoft, marginTop: 4 }}>
                      <div>{t("fin.providerRef")} {p.providerId ?? "—"}</div>
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
              {loadingMore ? t("c.loading") : `${t("c.loadMore")} (${rows.length} ${t("c.of")} ${total})`}
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

function InvoicesTab() {
  const { t } = useT();
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

  const invExportHeaders = [
    t("fin.th.invoiceNo"), t("fin.th.order"), t("fin.th.buyer"), t("c.market"), t("fin.th.issued"),
    `${t("fin.vat.net")} €`, `${t("fin.th.vat")} €`, `${t("c.total")} €`, t("fin.th.reverseCharge"),
  ];
  const invExportRow = (inv: Invoice): string[] => [
    inv.number,
    inv.orderRef ?? "",
    inv.data.buyer.company ?? inv.data.buyer.alias,
    inv.data.marketCode,
    inv.issuedAt.slice(0, 10),
    ((inv.data.totalCents - inv.data.vatCents) / 100).toFixed(2),
    (inv.data.vatCents / 100).toFixed(2),
    (inv.data.totalCents / 100).toFixed(2),
    inv.data.reverseCharge ? t("c.yes") : t("c.no"),
  ];

  const runExport = async (fmt: "csv" | "xls" | "pdf") => {
    try {
      const out: Invoice[] = [];
      for (;;) {
        const r = await api.get<{ invoices: Invoice[]; total: number }>(`/api/invoices?${query(PAY_EXPORT_PAGE, out.length)}`);
        out.push(...r.invoices);
        if (r.invoices.length === 0 || out.length >= r.total) break;
      }
      if (out.length === 0) return toast(t("fin.nothingToExport"), "warn");
      const body = out.map(invExportRow);
      if (fmt === "csv") exportCSV("invoices", invExportHeaders, body);
      else if (fmt === "xls") exportXLS("invoices", invExportHeaders, body, t("fin.tab.invoices"));
      else exportPDFPrint(t("fin.invExportTitle"), invExportHeaders, body);
      toast(`${t("fin.exportedInvoices")}: ${out.length}`, "ok");
    } catch {
      toast(t("fin.exportFailed"), "danger");
    }
  };

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <SearchBox value={qInput} onChange={setQInput} placeholder={t("fin.invSearchPh")} />
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft }}>
          <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} style={dateInputStyle} />
          –
          <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} style={dateInputStyle} />
        </label>
        <div style={{ marginLeft: "auto" }}>
          <ExportMenu count={total} scope="filtered" noun={t("fin.nounInvoices")} onPick={(fmt) => void runExport(fmt)} />
        </div>
      </div>
    <ACard pad={false}>
      {rows.length === 0 ? (
        <AEmpty text={t("fin.invEmpty")} />
      ) : (
        <ATable head={[t("fin.th.invoiceNo"), t("fin.th.order"), t("fin.th.buyer"), t("c.market"), t("fin.th.issued"), t("fin.th.vat"), t("c.total"), ""]}>
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
                  <AIcon name="download" size={13} /> {t("fin.open")}
                </ABtn>
              </ATd>
            </ATr>
          ))}
        </ATable>
      )}
      {rows.length > 0 && rows.length < total && (
        <div style={{ padding: 12, display: "flex", justifyContent: "center", borderTop: `1px solid ${AT.ruleSoft}` }}>
          <ABtn kind="ghost" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? t("c.loading") : `${t("c.loadMore")} (${rows.length} ${t("c.of")} ${total})`}
          </ABtn>
        </div>
      )}
    </ACard>
    </div>
  );
}

function VatTab() {
  const { t } = useT();
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
      .catch(() => toast(t("fin.vat.loadFailed"), "danger"));
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
  const vatHeaders = [
    t("c.market"), t("fin.vat.invoices"), `${t("fin.vat.net")} €`, `${t("fin.vat.vatDue")} €`,
    `${t("fin.vat.gross")} €`, `${t("fin.vat.rcNet")} €`, t("fin.vat.rcInvoices"),
  ];
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
    if (fmt === "csv") exportCSV(name, vatHeaders, body);
    else if (fmt === "xls") exportXLS(name, vatHeaders, body, t("fin.th.vat"));
    else exportPDFPrint(`${t("fin.vat.reportTitle")} ${from} – ${to}`, vatHeaders, body);
  };

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
        <AField label={t("fin.vat.from")}><AInput type="date" value={from} onChange={setFrom} /></AField>
        <AField label={t("fin.vat.toIncl")}><AInput type="date" value={to} onChange={setTo} /></AField>
        <ABtn onClick={run}>{t("fin.vat.run")}</ABtn>
        {report && report.markets.length > 0 && (
          <ExportMenu count={report.markets.length} scope="filtered" noun={t("fin.nounMarkets")} onPick={runVatExport} />
        )}
        <span style={{ fontFamily: AT.body, fontSize: 11.5, color: AT.inkSoft, marginLeft: "auto" }}>
          {t("fin.vat.basis")}
        </span>
      </div>

      <ACard pad={false}>
        {!report || report.markets.length === 0 ? (
          <AEmpty text={t("fin.vat.empty")} />
        ) : (
          <ATable head={[t("c.market"), t("fin.vat.invoices"), t("fin.vat.net"), t("fin.vat.vatDue"), t("fin.vat.gross"), t("fin.vat.rcNet"), t("fin.vat.rcInvoices")]}>
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
                <ATd><strong>{t("c.total")}</strong></ATd>
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

// ── W6: Profit & stock value (finance.view only) ─────────────────────────────

interface ProfitLine {
  sku: string;
  title: string;
  orderRef: string;
  paidAt: string;
  soldCents: number;
  costCents: number | null;
  profitCents: number | null;
  marginPct: number | null;
}
interface ProfitConsignment {
  ref: string;
  supplier: string;
  receivedCount: number;
  soldCount: number;
  profitCents: number | null;
  noCostData: number;
}
interface ProfitReport {
  /**
   * The summary aggregates the WHOLE period; `lines` is capped at
   * `lineLimit` newest sales. `truncated` says the two no longer agree —
   * both stay optional so an older API build simply reads as "not capped".
   */
  summary: {
    soldCount: number;
    revenueCents: number;
    profitCents: number;
    /** profit ÷ cost — a markup, not a margin (see fin.pf.stat.margin). */
    marginPct: number | null;
    noCostData: number;
    truncated?: boolean;
    lineLimit?: number;
  };
  lines: ProfitLine[];
  consignments: ProfitConsignment[];
}
interface StockBucket { units: number; valueCents: number; noCostData: number }
interface StockValue { ready: StockBucket; drafts: StockBucket; quarantine: StockBucket; total: StockBucket }

/** Signed profit in green/red; em-dash when the cost is unknown. */
function ProfitCell({ cents }: { cents: number | null }) {
  if (cents == null) return <span style={{ color: AT.inkSoft }}>—</span>;
  const color = cents > 0 ? AT.ok : cents < 0 ? AT.danger : AT.ink;
  return <strong style={{ color }}>{formatEur(cents)}</strong>;
}

const pct = (v: number | null): string => (v == null ? "—" : `${v.toFixed(1)}%`);

/**
 * Profit per sold item (hammer − purchase cost, before buyer premium/VAT),
 * today's stock value and per-consignment profitability. Costs are optional:
 * items without one are never assumed free — they are counted separately as
 * "no cost data" and excluded from profit totals.
 */
function ProfitTab() {
  const { t } = useT();
  const toast = useToast();
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [report, setReport] = useState<ProfitReport | null>(null);
  const [stock, setStock] = useState<StockValue | null>(null);

  const run = () => {
    // `to` is exclusive in the API; include the chosen end day.
    const toExclusive = new Date(new Date(to).getTime() + 86_400_000).toISOString().slice(0, 10);
    void api
      .get<ProfitReport>(`/api/reports/profit?from=${from}&to=${toExclusive}`)
      .then(setReport)
      .catch(() => toast(t("fin.pf.loadFailed"), "danger"));
  };
  useEffect(run, []);
  useEffect(() => {
    void api.get<StockValue>("/api/reports/stock-value").then(setStock).catch(() => undefined);
  }, []);

  // The table (and therefore the CSV) can be the newest N sales of a longer
  // period — the totals above them are not.
  const truncated = report?.summary.truncated === true;
  const lineLimit = report?.summary.lineLimit ?? report?.lines.length ?? 0;

  const lineHeaders = [
    "SKU", t("fin.pf.th.item"), t("fin.th.order"), `${t("fin.pf.th.sold")} €`,
    `${t("fin.pf.th.cost")} €`, `${t("fin.pf.th.profit")} €`, t("fin.pf.th.markupPct"),
  ];
  const runExport = () => {
    if (!report || report.lines.length === 0) return toast(t("fin.nothingToExport"), "warn");
    const body = report.lines.map((l) => [
      l.sku,
      l.title,
      l.orderRef,
      (l.soldCents / 100).toFixed(2),
      l.costCents == null ? "" : (l.costCents / 100).toFixed(2),
      l.profitCents == null ? "" : (l.profitCents / 100).toFixed(2),
      l.marginPct == null ? "" : l.marginPct.toFixed(1),
    ]);
    // The file name carries the cap too — a CSV outlives the screen it came from.
    exportCSV(truncated ? `profit-${from}-to-${to}-newest-${report.lines.length}` : `profit-${from}-to-${to}`, lineHeaders, body);
    if (truncated) toast(t("fin.pf.exportedPartial"), "warn");
  };

  const stockRows: { label: TKey; bucket: StockBucket }[] = stock
    ? [
        { label: "fin.pf.stock.ready", bucket: stock.ready },
        { label: "fin.pf.stock.drafts", bucket: stock.drafts },
        { label: "fin.pf.stock.quarantine", bucket: stock.quarantine },
      ]
    : [];

  const noDataNote = (n: number) =>
    n > 0 ? (
      <span style={{ fontFamily: AT.body, fontSize: 10.5, color: AT.warn, marginLeft: 8 }}>
        {t("fin.pf.stock.noData")}: {n}
      </span>
    ) : null;

  const s = report?.summary;
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
        <AField label={t("fin.pf.from")}><AInput type="date" value={from} onChange={setFrom} /></AField>
        <AField label={t("fin.pf.toIncl")}><AInput type="date" value={to} onChange={setTo} /></AField>
        <ABtn onClick={run}>{t("fin.pf.run")}</ABtn>
        {report && report.lines.length > 0 && (
          <ABtn kind="ghost" onClick={runExport}>
            <AIcon name="download" size={13} /> {truncated ? t("fin.pf.exportCsvVisible") : t("fin.pf.exportCsv")}
          </ABtn>
        )}
        <span style={{ fontFamily: AT.body, fontSize: 11.5, color: AT.inkSoft, marginLeft: "auto" }}>
          {t("fin.pf.basis")}
        </span>
      </div>

      {s && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <AStat label={t("fin.pf.stat.sold")} value={s.soldCount} sub={`${t("fin.pf.itemsSuffix")} · ${t("fin.pf.revenue")} ${formatEur(s.revenueCents)}`} />
          <AStat label={t("fin.pf.stat.profit")} value={formatEur(s.profitCents)} tone={s.profitCents > 0 ? "ok" : s.profitCents < 0 ? "danger" : undefined} />
          <AStat label={t("fin.pf.stat.margin")} value={pct(s.marginPct)} sub={t("fin.pf.stat.marginHint")} />
          <AStat
            label={t("fin.pf.stat.noData")}
            value={s.noCostData}
            tone={s.noCostData > 0 ? "warn" : undefined}
            sub={s.noCostData > 0 ? t("fin.pf.noDataHint") : undefined}
          />
        </div>
      )}

      {truncated && report && (
        <div style={{
          fontFamily: AT.body, fontSize: 11.5, lineHeight: 1.45, color: AT.inkSoft,
          background: AT.surfaceAlt, border: `1px solid ${AT.ruleSoft}`,
          borderRadius: AT.radiusSm, padding: "9px 12px",
        }}>
          {t("fin.pf.truncated").replace("{n}", String(lineLimit || report.lines.length))}
        </div>
      )}

      <ACard pad={false}>
        {!report || report.lines.length === 0 ? (
          <AEmpty text={t("fin.pf.linesEmpty")} />
        ) : (
          <ATable head={["SKU", t("fin.pf.th.item"), t("fin.th.order"), t("fin.pf.th.sold"), t("fin.pf.th.cost"), t("fin.pf.th.profit"), t("fin.pf.th.markupPct")]}>
            {report.lines.map((l, idx) => (
              <ATr key={`${l.orderRef}-${idx}`}>
                <ATd mono>{l.sku}</ATd>
                <ATd><span style={{ fontWeight: 600 }}>{l.title}</span></ATd>
                <ATd mono>{l.orderRef}</ATd>
                <ATd mono right>{formatEur(l.soldCents)}</ATd>
                <ATd mono right>
                  {l.costCents == null
                    ? <span style={{ color: AT.inkSoft, fontFamily: AT.body, fontSize: 11.5 }}>{t("fin.pf.noCost")}</span>
                    : formatEur(l.costCents)}
                </ATd>
                <ATd mono right><ProfitCell cents={l.profitCents} /></ATd>
                <ATd mono right>{pct(l.marginPct)}</ATd>
              </ATr>
            ))}
          </ATable>
        )}
      </ACard>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14, alignItems: "start" }}>
        <ACard title={t("fin.pf.stock.title")} pad={false}>
          {!stock ? (
            <AEmpty text={t("c.loading")} />
          ) : (
            <div style={{ display: "grid" }}>
              {stockRows.map((r) => (
                <div key={r.label} style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "10px 16px", borderBottom: `1px solid ${AT.ruleSoft}` }}>
                  <span style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.ink }}>
                    {t(r.label)}
                    {noDataNote(r.bucket.noCostData)}
                  </span>
                  <span style={{ marginLeft: "auto", fontFamily: AT.body, fontSize: 11.5, color: AT.inkSoft }}>
                    {r.bucket.units} {t("fin.pf.stock.units")}
                  </span>
                  <span style={{ fontFamily: AT.mono, fontSize: 12.5, fontWeight: 600, color: AT.ink, minWidth: 80, textAlign: "right" }}>
                    {formatEur(r.bucket.valueCents)}
                  </span>
                </div>
              ))}
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "10px 16px" }}>
                <span style={{ fontFamily: AT.body, fontSize: 12.5, fontWeight: 700, color: AT.ink }}>
                  {t("c.total")}
                  {noDataNote(stock.total.noCostData)}
                </span>
                <span style={{ marginLeft: "auto", fontFamily: AT.body, fontSize: 11.5, color: AT.inkSoft }}>
                  {stock.total.units} {t("fin.pf.stock.units")}
                </span>
                <span style={{ fontFamily: AT.mono, fontSize: 12.5, fontWeight: 700, color: AT.ink, minWidth: 80, textAlign: "right" }}>
                  {formatEur(stock.total.valueCents)}
                </span>
              </div>
            </div>
          )}
        </ACard>

        <ACard title={t("fin.pf.cons.title")} pad={false}>
          {!report || report.consignments.length === 0 ? (
            <AEmpty text={t("fin.pf.cons.empty")} />
          ) : (
            <div style={{ display: "grid" }}>
              {report.consignments.map((c) => (
                <div key={c.ref} style={{ display: "flex", alignItems: "baseline", gap: 10, padding: "10px 16px", borderBottom: `1px solid ${AT.ruleSoft}` }}>
                  <span style={{ fontFamily: AT.mono, fontSize: 12, fontWeight: 700, color: AT.ink }}>{c.ref}</span>
                  <span style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {c.supplier}
                    {noDataNote(c.noCostData)}
                  </span>
                  <span style={{ marginLeft: "auto", fontFamily: AT.body, fontSize: 11.5, color: AT.inkSoft, whiteSpace: "nowrap" }}>
                    {c.soldCount}/{c.receivedCount} {t("fin.pf.cons.sold")}
                  </span>
                  <span style={{ fontFamily: AT.mono, fontSize: 12.5, minWidth: 70, textAlign: "right" }}>
                    <ProfitCell cents={c.profitCents} />
                  </span>
                </div>
              ))}
            </div>
          )}
        </ACard>
      </div>
    </div>
  );
}

// ── R1: supplier invoices — what we owe (finance.view only) ──────────────────

type PayStatus = "unpaid" | "overdue" | "paid" | "all";

/** One bill from a supplier, with the payments ledger already folded in. */
interface SupplierInvoice {
  id: string;
  number: string;
  supplierId: string;
  supplierName: string;
  consignmentId: string | null;
  consignmentRef: string | null;
  invoiceDate: string;
  dueDate: string;
  amountCents: number;
  paidCents: number;
  /** Zero once cancelled — a cancelled bill owes nothing. */
  outstandingCents: number;
  status: string;
  /** Whole days past due; 0 when settled, cancelled or still in term. */
  overdueDays: number;
  note: string;
}

interface SupplierPayment {
  id: string;
  amountCents: number;
  paidAt: string;
  method: string;
  note: string;
  actorLabel: string;
}

/**
 * The delivery's own cost records against what the supplier billed. A variance
 * only means something when every unit has a purchase price — `noCostDataCount`
 * travels with it so the screen never calls an incomplete comparison an error.
 */
interface InvoiceRecon {
  recordedCostCents: number;
  varianceCents: number;
  noCostDataCount: number;
}

interface InvoiceDetail {
  invoice: SupplierInvoice;
  supplier: { id: string; name: string };
  payments: SupplierPayment[];
  reconciliation: InvoiceRecon | null;
}

interface InvoiceListResponse {
  invoices: SupplierInvoice[];
  /** Covers the whole filtered set, not just the rows returned. */
  totals: {
    outstandingCents: number;
    overdueCents: number;
    dueThisWeekCents: number;
    paidThisMonthCents: number;
    count: number;
  };
}

interface DeliveryMismatch {
  consignmentId: string;
  consignmentRef: string;
  supplierName: string;
  invoicedCents: number;
  recordedCostCents: number;
  varianceCents: number;
  noCostDataCount: number;
}

interface PayablesReport {
  asOf: string;
  totals: {
    outstandingCents: number;
    overdueCents: number;
    dueThisWeekCents: number;
    paidThisMonthCents: number;
    invoiceCount: number;
    overdueCount: number;
  };
  aging: { current: number; d1_30: number; d31_60: number; d60plus: number };
  bySupplier: Array<{
    supplierId: string;
    name: string;
    outstandingCents: number;
    overdueCents: number;
    invoiceCount: number;
    oldestDueDate: string | null;
  }>;
  reconciliation: { checkedDeliveries: number; matchingDeliveries: number; mismatched: DeliveryMismatch[] };
}

/**
 * "125,40" / "125.4" → 12540. Anything else — blank, a minus sign, letters —
 * is null so the caller refuses to send rather than posting a bad amount.
 */
const payEurToCents = (s: string): number | null => {
  const v = s.trim().replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return null;
  const n = Math.round(Number(v) * 100);
  return Number.isFinite(n) ? n : null;
};

const PAY_METHODS = ["bank_transfer", "cash", "card", "other"] as const;
const PAY_METHOD_KEY: Record<string, TKey> = {
  bank_transfer: "fin.pay.m.bank_transfer",
  cash: "fin.pay.m.cash",
  card: "fin.pay.m.card",
  other: "fin.pay.m.other",
};

const PAY_STATUS_LABEL: Record<string, TKey> = {
  unpaid: "fin.pay.st.unpaid",
  partly_paid: "fin.pay.st.partly",
  paid: "fin.pay.st.paid",
  cancelled: "fin.pay.st.cancelled",
};
const PAY_STATUS_TONE: Record<string, Tone> = {
  unpaid: "neutral",
  partly_paid: "accent",
  paid: "ok",
  cancelled: "neutral",
};

const PAY_FILTERS: { id: PayStatus; label: TKey }[] = [
  { id: "unpaid", label: "fin.pay.f.unpaid" },
  { id: "overdue", label: "fin.pay.f.overdue" },
  { id: "paid", label: "fin.pay.f.paid" },
  { id: "all", label: "c.all" },
];

/** The API caps the list; ask for the most it will give in one go. */
const PAY_LIMIT = 200;

/** Lateness outranks the stored status — a bill 12 days past due reads as late,
 * not as "unpaid". Cancelled bills are muted: they are history, not work. */
function PayStatusPill({ status, overdueDays }: { status: string; overdueDays: number }) {
  const { t } = useT();
  if (overdueDays > 0) {
    return <ABadge tone="danger">{t("fin.pay.st.overdue").replace("{n}", String(overdueDays))}</ABadge>;
  }
  const key = PAY_STATUS_LABEL[status];
  const pill = <ABadge tone={PAY_STATUS_TONE[status] ?? "neutral"}>{key ? t(key) : status}</ABadge>;
  return status === "cancelled" ? <span style={{ opacity: 0.55 }}>{pill}</span> : pill;
}

/** Consignment refs are mono; a bill filed against no delivery gets a dash. */
function DeliveryRef({ refText }: { refText: string | null }) {
  if (!refText) return <span style={{ color: AT.inkSoft }}>—</span>;
  return <span style={{ fontFamily: AT.mono, fontSize: 12 }}>{refText}</span>;
}

/**
 * Payables: every unsettled supplier bill, what is already late, what falls due
 * this week, and whether the paperwork agrees with the purchase costs the
 * warehouse recorded against the same delivery.
 */
function PayablesTab() {
  const { t } = useT();
  const toast = useToast();
  const [status, setStatus] = useState<PayStatus>("unpaid");
  const [report, setReport] = useState<PayablesReport | null>(null);
  const [list, setList] = useState<InvoiceListResponse | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  /** Bumped after every mutation so the tiles, the list and the drawer agree. */
  const [rev, setRev] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    void api
      .get<PayablesReport>("/api/reports/payables")
      .then(setReport)
      .catch(() => toast(t("fin.pay.loadFailed"), "danger"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev]);

  useEffect(() => {
    const s = ++seq.current;
    void api
      .get<InvoiceListResponse>(`/api/supplier-invoices?status=${status}&limit=${PAY_LIMIT}`)
      .then((r) => {
        if (seq.current === s) setList(r);
      })
      .catch(() => undefined);
  }, [status, rev]);

  const rows = list?.invoices ?? [];
  const totalCount = list?.totals.count ?? rows.length;
  const truncated = totalCount > rows.length;

  const exportHeaders = [
    t("fin.pay.th.invoice"), t("fin.pay.th.supplier"), t("fin.pay.th.delivery"),
    t("fin.pay.th.invoiceDate"), t("fin.pay.th.due"), `${t("fin.pay.th.amount")} €`,
    `${t("fin.pay.dr.paid")} €`, `${t("fin.pay.th.outstanding")} €`, t("c.status"),
    t("fin.pay.th.overdueDays"),
  ];
  const runExport = () => {
    if (rows.length === 0) return toast(t("fin.nothingToExport"), "warn");
    const statusWord = (r: SupplierInvoice): string => {
      const key = PAY_STATUS_LABEL[r.status];
      return key ? t(key) : r.status;
    };
    const body = rows.map((r) => [
      r.number,
      r.supplierName,
      r.consignmentRef ?? "",
      r.invoiceDate.slice(0, 10),
      r.dueDate.slice(0, 10),
      (r.amountCents / 100).toFixed(2),
      (r.paidCents / 100).toFixed(2),
      (r.outstandingCents / 100).toFixed(2),
      statusWord(r),
      r.overdueDays > 0 ? String(r.overdueDays) : "",
    ]);
    exportCSV(`supplier-invoices-${status}`, exportHeaders, body);
    toast(`${t("fin.pay.exported")}: ${rows.length}`, "ok");
  };

  const totals = report?.totals;
  return (
    <div style={{ display: "grid", gap: 14 }}>
      {totals && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <AStat
            label={t("fin.pay.stat.outstanding")}
            value={formatEur(totals.outstandingCents)}
            sub={`${totals.invoiceCount} ${t("fin.pay.sub.open")}`}
          />
          <AStat
            label={t("fin.pay.stat.overdue")}
            value={formatEur(totals.overdueCents)}
            tone={totals.overdueCents > 0 ? "danger" : undefined}
            sub={`${totals.overdueCount} ${t("fin.pay.sub.overdue")}`}
          />
          <AStat
            label={t("fin.pay.stat.week")}
            value={formatEur(totals.dueThisWeekCents)}
            tone={totals.dueThisWeekCents > 0 ? "warn" : undefined}
          />
          <AStat label={t("fin.pay.stat.paidMonth")} value={formatEur(totals.paidThisMonthCents)} />
        </div>
      )}

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <APills
          options={PAY_FILTERS.map((f) => ({ id: f.id, label: t(f.label) }))}
          value={status}
          onChange={(v) => setStatus(v)}
        />
        <ABtn kind="ghost" size="sm" onClick={runExport}>
          <AIcon name="download" size={13} /> {t("fin.pf.exportCsv")}
        </ABtn>
        <span style={{ fontFamily: AT.body, fontSize: 11.5, color: AT.inkSoft, marginLeft: "auto" }}>
          {t("fin.pay.basis")}
        </span>
      </div>

      {truncated && (
        <div style={{
          fontFamily: AT.body, fontSize: 11.5, lineHeight: 1.45, color: AT.inkSoft,
          background: AT.surfaceAlt, border: `1px solid ${AT.ruleSoft}`,
          borderRadius: AT.radiusSm, padding: "9px 12px",
        }}>
          {t("fin.pay.truncated").replace("{n}", String(rows.length)).replace("{m}", String(totalCount))}
        </div>
      )}

      <ACard pad={false}>
        {rows.length === 0 ? (
          <AEmpty text={t("fin.pay.empty")} />
        ) : (
          <ATable head={[
            t("fin.pay.th.invoice"), t("fin.pay.th.supplier"), t("fin.pay.th.delivery"),
            t("fin.pay.th.due"), t("fin.pay.th.amount"), t("fin.pay.th.outstanding"), t("c.status"),
          ]}>
            {rows.map((r) => (
              <ATr key={r.id} onClick={() => setOpenId(r.id)} active={openId === r.id}>
                <ATd mono><strong>{r.number}</strong></ATd>
                <ATd>{r.supplierName}</ATd>
                <ATd><DeliveryRef refText={r.consignmentRef} /></ATd>
                <ATd>{formatDay(r.dueDate)}</ATd>
                <ATd mono right>{formatEur(r.amountCents)}</ATd>
                <ATd mono right>
                  <strong>{formatEur(r.outstandingCents)}</strong>
                </ATd>
                <ATd><PayStatusPill status={r.status} overdueDays={r.overdueDays} /></ATd>
              </ATr>
            ))}
          </ATable>
        )}
      </ACard>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14, alignItems: "start" }}>
        <ACard title={t("fin.pay.sup.title")} pad={false}>
          {!report || report.bySupplier.length === 0 ? (
            <AEmpty text={t("fin.pay.sup.empty")} />
          ) : (
            <div style={{ display: "grid" }}>
              {report.bySupplier.map((s) => (
                <div key={s.supplierId} style={{
                  display: "flex", alignItems: "baseline", gap: 10, padding: "10px 16px",
                  borderBottom: `1px solid ${AT.ruleSoft}`,
                }}>
                  <span style={{ fontFamily: AT.body, fontSize: 12.5, fontWeight: 600, color: AT.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {s.name}
                  </span>
                  {s.overdueCents > 0 && (
                    <span style={{ fontFamily: AT.body, fontSize: 11, fontWeight: 700, color: AT.danger, whiteSpace: "nowrap" }}>
                      {t("fin.pay.sup.overdue")} {formatEur(s.overdueCents)}
                    </span>
                  )}
                  <span style={{ marginLeft: "auto", fontFamily: AT.body, fontSize: 11.5, color: AT.inkSoft, whiteSpace: "nowrap" }}>
                    {s.invoiceCount} {t("fin.pay.sup.invoices")} · {t("fin.pay.sup.oldest")} {formatDay(s.oldestDueDate)}
                  </span>
                  <span style={{ fontFamily: AT.mono, fontSize: 12.5, fontWeight: 700, color: AT.ink, minWidth: 84, textAlign: "right" }}>
                    {formatEur(s.outstandingCents)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </ACard>

        <ACard title={t("fin.pay.age.title")} pad={false}>
          {!report ? <AEmpty text={t("c.loading")} /> : <AgingRows aging={report.aging} />}
        </ACard>
      </div>

      {report && report.reconciliation.mismatched.length > 0 && (
        <MismatchCard recon={report.reconciliation} />
      )}

      {openId && (
        <InvoiceDrawer
          id={openId}
          onClose={() => setOpenId(null)}
          onChanged={() => setRev((n) => n + 1)}
        />
      )}
    </div>
  );
}

/** Ageing buckets as proportional bars — plain divs, no chart library. */
function AgingRows({ aging }: { aging: PayablesReport["aging"] }) {
  const { t } = useT();
  const buckets: { label: TKey; value: number; color: string }[] = [
    { label: "fin.pay.age.current", value: aging.current, color: AT.accent },
    { label: "fin.pay.age.d1_30", value: aging.d1_30, color: AT.warn },
    { label: "fin.pay.age.d31_60", value: aging.d31_60, color: AT.warn },
    { label: "fin.pay.age.d60plus", value: aging.d60plus, color: AT.danger },
  ];
  // Bars are relative to the biggest bucket, so a small backlog is still
  // readable; the euro figure beside each one carries the absolute truth.
  const max = Math.max(1, ...buckets.map((b) => Math.abs(b.value)));
  return (
    <div style={{ display: "grid" }}>
      {buckets.map((b) => (
        <div key={b.label} style={{
          display: "grid", gridTemplateColumns: "84px 1fr 92px", gap: 12, alignItems: "center",
          padding: "11px 16px", borderBottom: `1px solid ${AT.ruleSoft}`,
        }}>
          <span style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.ink }}>{t(b.label)}</span>
          <span style={{ display: "block", height: 6, borderRadius: 3, background: AT.surfaceAlt, overflow: "hidden" }}>
            <span style={{
              display: "block", height: "100%",
              width: `${Math.round((Math.abs(b.value) / max) * 100)}%`,
              background: b.color,
            }} />
          </span>
          <span style={{
            fontFamily: AT.mono, fontSize: 12.5, textAlign: "right",
            fontWeight: b.value > 0 ? 700 : 400, color: b.value > 0 ? AT.ink : AT.inkSoft,
          }}>
            {formatEur(b.value)}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Deliveries where the bills and the recorded purchase costs disagree. Rows
 * with unpriced units are shown muted — the gap is missing data, not evidence
 * that the supplier over-billed.
 */
function MismatchCard({ recon }: { recon: PayablesReport["reconciliation"] }) {
  const { t } = useT();
  const rows = recon.mismatched.slice(0, 6);
  return (
    <ACard
      title={t("fin.pay.rc.title")}
      actions={
        <span style={{ fontFamily: AT.body, fontSize: 11.5, color: AT.inkSoft }}>
          {t("fin.pay.rc.summary")
            .replace("{n}", String(recon.checkedDeliveries))
            .replace("{m}", String(recon.matchingDeliveries))}
        </span>
      }
      pad={false}
    >
      <div style={{ display: "grid" }}>
        {rows.map((r) => {
          const incomplete = r.noCostDataCount > 0;
          // A tenth of the invoiced value out is a real problem; less is worth
          // a look. Neither reads as an error while units are unpriced.
          const tone = incomplete
            ? AT.inkSoft
            : Math.abs(r.varianceCents) > Math.abs(r.invoicedCents) * 0.1
              ? AT.danger
              : AT.warn;
          return (
            <div key={r.consignmentId} style={{ padding: "10px 16px", borderBottom: `1px solid ${AT.ruleSoft}` }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                <span style={{ fontFamily: AT.mono, fontSize: 12, fontWeight: 700, color: AT.ink }}>{r.consignmentRef}</span>
                <span style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.ink }}>{r.supplierName}</span>
                <span style={{ marginLeft: "auto", fontFamily: AT.body, fontSize: 11.5, color: AT.inkSoft, whiteSpace: "nowrap" }}>
                  {t("fin.pay.rc.invoiced")} <span style={{ fontFamily: AT.mono }}>{formatEur(r.invoicedCents)}</span>
                  {" · "}
                  {t("fin.pay.rc.recorded")} <span style={{ fontFamily: AT.mono }}>{formatEur(r.recordedCostCents)}</span>
                </span>
                <span style={{ fontFamily: AT.mono, fontSize: 12.5, fontWeight: 700, color: tone, minWidth: 90, textAlign: "right" }}>
                  {r.varianceCents > 0 ? "+" : ""}{formatEur(r.varianceCents)}
                </span>
              </div>
              {incomplete && (
                <div style={{ fontFamily: AT.body, fontSize: 11, color: AT.inkSoft, marginTop: 3 }}>
                  {t("fin.pay.rc.noCost").replace("{n}", String(r.noCostDataCount))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </ACard>
  );
}

/** One labelled money figure in the drawer's summary strip. */
function PayFigure({ label, cents, strong, tone }: { label: string; cents: number; strong?: boolean; tone?: string }) {
  return (
    <div style={{ display: "grid", gap: 2 }}>
      <span style={{ fontFamily: AT.body, fontSize: 11, fontWeight: 700, color: AT.inkSoft, textTransform: "uppercase", letterSpacing: "0.06em" }}>
        {label}
      </span>
      <span style={{ fontFamily: AT.mono, fontSize: strong ? 15 : 13.5, fontWeight: strong ? 700 : 600, color: tone ?? AT.ink }}>
        {formatEur(cents)}
      </span>
    </div>
  );
}

/**
 * One bill in full: the delivery it belongs to, the money, whether it agrees
 * with the recorded purchase costs, the payments already made, and the form to
 * record another. Every mutation re-reads the bill and tells the list to
 * refresh, so nothing on screen can drift out of date.
 */
function InvoiceDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { t } = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const [detail, setDetail] = useState<InvoiceDetail | null>(null);
  const [rev, setRev] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void api
      .get<InvoiceDetail>(`/api/supplier-invoices/${id}`)
      .then((r) => {
        if (alive) setDetail(r);
      })
      .catch(() => {
        if (!alive) return;
        toast(t("fin.pay.loadFailed"), "danger");
        onClose();
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, rev]);

  const refresh = () => {
    setRev((n) => n + 1);
    onChanged();
  };

  const inv = detail?.invoice;

  const removePayment = async (p: SupplierPayment) => {
    if (!inv || busy) return;
    const res = await confirm({
      title: t("fin.pay.dr.deletePayment"),
      body: t("fin.pay.dr.deleteBody").replace("{amount}", formatEur(p.amountCents)),
      danger: true,
      confirmLabel: t("c.delete"),
    });
    if (!res.ok) return;
    setBusy(true);
    try {
      await api.delete(`/api/supplier-invoices/${inv.id}/payments/${p.id}`);
      toast(t("fin.pay.dr.paymentDeleted"), "ok");
      refresh();
    } catch {
      toast(t("fin.pay.actionFailed"), "danger");
    } finally {
      setBusy(false);
    }
  };

  const cancelInvoice = async () => {
    if (!inv || busy) return;
    const res = await confirm({
      title: t("fin.pay.cancel"),
      body: t("fin.pay.cancelBody").replace("{number}", inv.number),
      danger: true,
      confirmLabel: t("fin.pay.cancel"),
    });
    if (!res.ok) return;
    setBusy(true);
    try {
      await api.patch(`/api/supplier-invoices/${inv.id}`, { status: "cancelled" });
      toast(t("fin.pay.cancelDone"), "ok");
      refresh();
    } catch (err) {
      // The server refuses to cancel anything that is no longer plain unpaid —
      // in this UI that can only mean a payment landed since the drawer opened.
      const conflict = err instanceof ApiError && err.status === 409;
      toast(t(conflict ? "fin.pay.cancelHasPayments" : "fin.pay.actionFailed"), "danger");
      if (conflict) refresh();
    } finally {
      setBusy(false);
    }
  };

  const recon = detail?.reconciliation ?? null;
  // An incomplete comparison is never dressed up as a variance to chase.
  const reconSolid = recon !== null && recon.noCostDataCount === 0;
  const reconOff = reconSolid && recon.varianceCents !== 0;

  return (
    <ADrawer
      title={inv ? `${inv.number} — ${detail?.supplier.name ?? inv.supplierName}` : t("c.loading")}
      onClose={onClose}
      width={620}
      footer={
        inv && inv.status !== "cancelled" && (detail?.payments.length ?? 0) === 0 ? (
          <ABtn kind="danger" disabled={busy} onClick={() => void cancelInvoice()}>{t("fin.pay.cancel")}</ABtn>
        ) : undefined
      }
    >
      {!detail || !inv ? (
        <AEmpty text={t("c.loading")} />
      ) : (
        <div style={{ display: "grid", gap: 16 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <PayStatusPill status={inv.status} overdueDays={inv.overdueDays} />
            <span style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft }}>
              {t("fin.pay.th.delivery")}: <DeliveryRef refText={inv.consignmentRef} />
            </span>
            <span style={{ marginLeft: "auto", fontFamily: AT.body, fontSize: 12, color: AT.inkSoft }}>
              {t("fin.pay.th.invoiceDate")} {formatDay(inv.invoiceDate)} · {t("fin.pay.th.due")} {formatDay(inv.dueDate)}
            </span>
          </div>

          <div style={{
            display: "flex", gap: 24, flexWrap: "wrap", padding: "12px 14px",
            background: AT.surfaceAlt, borderRadius: AT.radiusSm,
          }}>
            <PayFigure label={t("fin.pay.th.amount")} cents={inv.amountCents} />
            <PayFigure label={t("fin.pay.dr.paid")} cents={inv.paidCents} />
            <PayFigure
              label={t("fin.pay.th.outstanding")}
              cents={inv.outstandingCents}
              strong
              tone={inv.outstandingCents > 0 ? (inv.overdueDays > 0 ? AT.danger : AT.ink) : AT.ok}
            />
          </div>

          {inv.note && (
            <div style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft, lineHeight: 1.5 }}>
              {t("c.notes")}: {inv.note}
            </div>
          )}

          {recon && (
            <div style={{
              fontFamily: AT.body, fontSize: 12, lineHeight: 1.5, padding: "9px 12px",
              borderRadius: AT.radiusSm,
              background: reconOff ? AT.warnSoft : AT.surfaceAlt,
              border: `1px solid ${reconOff ? AT.warnSoft : AT.ruleSoft}`,
              color: reconOff ? AT.warn : AT.inkSoft,
            }}>
              {t("fin.pay.dr.recon")
                .replace("{cost}", formatEur(recon.recordedCostCents))
                .replace("{variance}", formatEur(recon.varianceCents))}
              {recon.noCostDataCount > 0 && (
                <div style={{ color: AT.inkSoft, marginTop: 3 }}>
                  {t("fin.pay.dr.reconIncomplete").replace("{n}", String(recon.noCostDataCount))}
                </div>
              )}
            </div>
          )}

          <div style={{ display: "grid", gap: 6 }}>
            <div style={{ fontFamily: AT.body, fontSize: 12, fontWeight: 700, color: AT.ink }}>
              {t("fin.pay.dr.payments")}
            </div>
            {detail.payments.length === 0 ? (
              <div style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft }}>{t("fin.pay.dr.noPayments")}</div>
            ) : (
              detail.payments.map((p) => (
                <div key={p.id} style={{
                  display: "flex", alignItems: "center", gap: 10, padding: "8px 10px",
                  border: `1px solid ${AT.rule}`, borderRadius: 10,
                }}>
                  <span style={{ fontFamily: AT.mono, fontSize: 13, fontWeight: 700, minWidth: 86 }}>
                    {formatEur(p.amountCents)}
                  </span>
                  <span style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.ink }}>
                    {PAY_METHOD_KEY[p.method] ? t(PAY_METHOD_KEY[p.method]!) : p.method}
                  </span>
                  <span style={{ fontFamily: AT.body, fontSize: 12, color: AT.inkSoft }}>{formatDay(p.paidAt)}</span>
                  <span style={{ fontFamily: AT.body, fontSize: 11.5, color: AT.inkSoft, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {p.actorLabel}{p.note ? ` · ${p.note}` : ""}
                  </span>
                  <button
                    aria-label={t("fin.pay.dr.deletePayment")}
                    title={t("fin.pay.dr.deletePayment")}
                    disabled={busy}
                    onClick={() => void removePayment(p)}
                    style={{
                      all: "unset", marginLeft: "auto", cursor: busy ? "not-allowed" : "pointer",
                      padding: 4, color: AT.inkSoft, opacity: busy ? 0.4 : 1,
                    }}
                  >
                    <AIcon name="trash" size={14} />
                  </button>
                </div>
              ))
            )}
          </div>

          {inv.status !== "cancelled" && inv.outstandingCents > 0 && (
            <PaymentForm key={inv.id} invoice={inv} onSaved={refresh} />
          )}
        </div>
      )}
    </ADrawer>
  );
}

/**
 * Record one payment against a bill. The amount is validated here — greater
 * than zero and never more than what is still outstanding — so a bad value is
 * shown inline instead of being posted and bounced by the API.
 */
function PaymentForm({ invoice, onSaved }: { invoice: SupplierInvoice; onSaved: () => void }) {
  const { t } = useT();
  const toast = useToast();
  const [amount, setAmount] = useState("");
  const [paidAt, setPaidAt] = useState(today());
  const [method, setMethod] = useState<string>("bank_transfer");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const cents = payEurToCents(amount);
  const typed = amount.trim().length > 0;
  const error = !typed
    ? null
    : cents === null || cents <= 0
      ? t("fin.pay.rec.badAmount")
      : cents > invoice.outstandingCents
        ? t("fin.pay.rec.tooMuch").replace("{amount}", formatEur(invoice.outstandingCents))
        : null;
  const ready = cents !== null && cents > 0 && cents <= invoice.outstandingCents;

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      await api.post(`/api/supplier-invoices/${invoice.id}/payments`, {
        amountCents: cents,
        // Today is the server's own "now" — only an explicit back-date travels.
        ...(paidAt && paidAt !== today() ? { paidAt } : {}),
        method,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setAmount("");
      setNote("");
      toast(t("fin.pay.rec.saved"), "ok");
      onSaved();
    } catch (err) {
      const api422 = err instanceof ApiError ? err : null;
      const code = api422 ? String(api422.body.error ?? "") : "";
      if (code === "exceeds_outstanding") {
        // The balance moved under us (a colleague paid part of it) — quote the
        // server's figure, not the stale one this form was validated against.
        const left = Number(api422?.body.outstandingCents ?? invoice.outstandingCents);
        toast(t("fin.pay.rec.tooMuch").replace("{amount}", formatEur(left)), "danger");
      } else {
        toast(t(code === "invoice_cancelled" ? "fin.pay.rec.invoiceCancelled" : "fin.pay.rec.failed"), "danger");
      }
      // Either conflict means the bill on screen is out of date — re-read it.
      if (code === "exceeds_outstanding" || code === "invoice_cancelled") onSaved();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 10, borderTop: `1px solid ${AT.rule}`, paddingTop: 14 }}>
      <div style={{ fontFamily: AT.body, fontSize: 12, fontWeight: 700, color: AT.ink }}>
        {t("fin.pay.rec.title")}
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ width: 150 }}>
          <AField
            label={t("fin.pay.rec.amount")}
            hint={t("fin.pay.rec.amountHint").replace("{amount}", formatEur(invoice.outstandingCents))}
          >
            <AInput value={amount} onChange={setAmount} placeholder="0,00" />
          </AField>
        </div>
        <div style={{ width: 160 }}>
          <AField label={t("c.date")}>
            <AInput type="date" value={paidAt} onChange={setPaidAt} />
          </AField>
        </div>
        <div style={{ paddingTop: 22 }}>
          <ASelect
            label={t("fin.pay.rec.method")}
            value={method}
            onChange={setMethod}
            options={PAY_METHODS.map((m) => ({ value: m, label: t(PAY_METHOD_KEY[m]!) }))}
          />
        </div>
      </div>
      {error && (
        <div style={{ fontFamily: AT.body, fontSize: 11.5, color: AT.danger }}>{error}</div>
      )}
      <AField label={t("fin.pay.rec.note")}>
        <AInput value={note} onChange={setNote} placeholder={t("fin.pay.rec.notePh")} />
      </AField>
      <div>
        <ABtn disabled={!ready || busy} onClick={() => void submit()}>
          {busy ? t("c.saving") : t("fin.pay.rec.title")}
        </ABtn>
      </div>
    </div>
  );
}
