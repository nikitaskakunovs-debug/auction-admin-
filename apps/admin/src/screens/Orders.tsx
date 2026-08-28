/**
 * Orders power screen (Phase A2). Two modes on one route:
 *  - #/orders          → server-filtered list: saved views, status pills with
 *    live counts, filter bar + removable chips, selection + bulk actions,
 *    server pagination, CSV/Excel/PDF export.
 *  - #/orders/<id>     → full-page order detail with sticky header, section
 *    jumps, and the preserved action flows (mark paid, refund, cancel-unpaid,
 *    shipping, invoice).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { api, ApiError, type Attribution, type Item, type Order } from "../api.js";
import { AttributionCard, channelLabel } from "../attribution.js";
import type { Nav } from "../App.js";
import { useAuth } from "../auth.js";
import { exportCSV, exportPDFPrint, exportXLS } from "../exporters.js";
import { formatDate, formatEur } from "../format.js";
import { itemStatusLabel, orderStatusLabel, t, useT, type TKey } from "../i18n.js";
import { isBnpl, methodLabel, providerLabel } from "../paymentLabels.js";
import {
  BulkBar, BulkBtn, bulkDividerStyle, checkboxStyle, dateInputStyle, ExportMenu, FilterChips,
  makeFilterTools, SearchBox, useDebounced, useSavedViews, useSelection, useStoredFilters,
  ViewsBar, type FilterChip,
} from "../powerkit.js";
import { AT, ITEM_STATUS_TONE, ORDER_STATUS_TONE } from "../theme.js";
import {
  AAvatar, ABadge, ABtn, ACard, AEmpty, AField, AIcon, AInput, ASelect,
  ATable, ATd, ATr, useConfirm, useToast,
} from "../ui.js";
import { useIsMobile } from "../useMobile.js";

// ── Shared row/detail types ──────────────────────────────────────────────────

type OrderRow = Order & {
  itemSku: string;
  itemStatus: string;
  itemTitle: string;
  paidVia: { provider: string; method: string | null } | null;
};

interface ListResponse {
  orders: OrderRow[];
  total: number;
  counts: Record<string, number>;
}

interface Refund {
  id: string;
  amountCents: number;
  reason: string;
  createdAt: string;
}

interface Payment {
  id: string;
  provider: string;
  /** Where the checkout was started: storefront button or email pay link. */
  channel: string; // web | email
  providerId: string | null;
  status: string; // created | paid | failed | expired
  providerStatus: string | null;
  /** Provider-reported method (klix_pay_later, swedbank_lv_pis, …). */
  method: string | null;
  /** Full last provider snapshot (BNPL terms, contract ids, …). */
  raw: Record<string, unknown> | null;
  amountCents: number;
  createdAt: string;
}

interface Shipment {
  id: string;
  provider: string;
  barcode: string;
  status: string; // registered | in_transit | delivered | cancelled | error
  providerStatus: string | null;
  events: Array<{ code: string; at: string; description?: string; location?: string }>;
  labelPrintedAt: string | null;
  createdAt: string;
}

interface Buyer {
  id: string;
  alias: string;
  email: string;
  blocked: boolean;
  strikes: number;
  createdAt: string;
  attribution: Attribution | null;
  attributionLast: Attribution | null;
  lastLoginMethod: string | null;
  ordersCount: number;
}

interface OrderDetail {
  order: Order;
  item: Item;
  refunds: Refund[];
  invoice: { id: string; number: string; issuedAt: string } | null;
  payments: Payment[];
  shipments: Shipment[];
  buyer: Buyer | null;
}

const SHIPMENT_TONE: Record<string, "ok" | "warn" | "danger" | "neutral" | "accent"> = {
  delivered: "ok",
  in_transit: "accent",
  registered: "warn",
  cancelled: "neutral",
  error: "danger",
};

const PAYMENT_TONE: Record<string, "ok" | "warn" | "danger" | "neutral"> = {
  paid: "ok",
  created: "warn",
  failed: "danger",
  expired: "neutral",
};

/** Payment-attempt status → translated label (raw value shown for unknowns). */
const PAYMENT_LABEL_KEY: Record<string, TKey> = {
  created: "ord.pay.created",
  paid: "ord.pay.paid",
  failed: "ord.pay.failed",
  expired: "ord.pay.expired",
};

const payStatusLabel = (s: string): string => {
  const k = PAYMENT_LABEL_KEY[s];
  return k ? t(k) : s;
};

/** Shipment status → translated label (raw value shown for unknowns). */
const SHIPMENT_LABEL_KEY: Record<string, TKey> = {
  registered: "ord.ship.registered",
  in_transit: "ord.ship.in_transit",
  delivered: "ord.ship.delivered",
  cancelled: "ord.ship.cancelled",
  error: "ord.ship.error",
};

const shipStatusLabel = (s: string): string => {
  const k = SHIPMENT_LABEL_KEY[s];
  return k ? t(k) : s.replace("_", " ");
};

// ── Filters ──────────────────────────────────────────────────────────────────

interface Filters {
  status: string;
  market: string;
  fulfilment: string;
  band: string;
  from: string;
  to: string;
  sort: string;
  q: string;
}

/** Сужение до одной кампании, пришедшее ссылкой из отчёта. */
export interface AttrFilter {
  model: "first" | "last";
  source: string;
  medium: string;
  campaign: string;
}

const DEFAULT_FILTERS: Filters = {
  status: "all", market: "all", fulfilment: "all", band: "any",
  from: "", to: "", sort: "newest", q: "",
};

const FILTERS_KEY = "ordersFilters.v1";
const PAGE = 50;
const EXPORT_PAGE = 200;

const STATUS_PILL_IDS = ["all", "awaiting_payment", "paid", "cancelled", "refunded"];

const pillLabel = (id: string): string => (id === "all" ? t("c.all") : orderStatusLabel(id));

/** Carrier/product names (Omniva, DPD) stay untranslated; only "pickup" has words. */
function fulfilmentLabel(f: string): string {
  if (f === "pickup") return t("ord.pickup");
  if (f === "omniva_pm") return "Omniva";
  if (f === "dpd_pm") return "DPD";
  return f;
}

/** Amount bands → min/max in cents (server-side filter). */
const BANDS: Array<{ id: string; labelKey: TKey; min?: number; max?: number }> = [
  { id: "any", labelKey: "ord.bandAny" },
  { id: "lt100", labelKey: "ord.bandLt100", max: 10000 },
  { id: "100-500", labelKey: "ord.band100_500", min: 10000, max: 50000 },
  { id: "500-1000", labelKey: "ord.band500_1000", min: 50000, max: 100000 },
  { id: "gt1000", labelKey: "ord.bandGt1000", min: 100000 },
];

const SORTS: Array<{ value: string; labelKey: TKey }> = [
  { value: "newest", labelKey: "ord.sortNewest" },
  { value: "oldest", labelKey: "ord.sortOldest" },
  { value: "amount_desc", labelKey: "ord.sortAmountDesc" },
  { value: "amount_asc", labelKey: "ord.sortAmountAsc" },
];

const filterTools = makeFilterTools(DEFAULT_FILTERS);

function buildQuery(f: Filters, limit: number, offset: number, attr?: AttrFilter | null): string {
  const p = new URLSearchParams();
  if (attr) {
    p.set("attrModel", attr.model);
    p.set("attrSource", attr.source);
    p.set("attrMedium", attr.medium);
    p.set("attrCampaign", attr.campaign);
  }
  if (f.status !== "all") p.set("status", f.status);
  if (f.market !== "all") p.set("market", f.market);
  if (f.fulfilment !== "all") p.set("fulfilment", f.fulfilment);
  const band = BANDS.find((b) => b.id === f.band);
  if (band?.min !== undefined) p.set("min", String(band.min));
  if (band?.max !== undefined) p.set("max", String(band.max));
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.sort !== "newest") p.set("sort", f.sort);
  if (f.q.trim().length >= 2) p.set("q", f.q.trim());
  p.set("limit", String(limit));
  p.set("offset", String(offset));
  return p.toString();
}

/** dd/MM HH:mm — the dense table timestamp. */
function fmtShort(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** yyyy-mm-dd hh:mm (UTC) — spreadsheet-friendly export timestamp. */
function fmtExport(iso: string | null): string {
  return iso ? new Date(iso).toISOString().slice(0, 16).replace("T", " ") : "";
}

// ── Export ───────────────────────────────────────────────────────────────────

/** Built per export so the headers follow the current language. */
const exportHeaders = (): string[] => [
  t("ord.thOrder"), t("ord.created"), t("c.market"), t("ord.thBidder"), t("ord.expEmail"),
  t("ord.expItemSku"), t("ord.expItemTitle"), t("ord.expFulfilment"),
  `${t("ord.thHammer")} €`, `${t("ord.buyersPremium")} €`, `${t("ord.vat")} €`,
  `${t("ord.shipping")} €`, `${t("ord.handling")} €`, `${t("c.total")} €`,
  t("ord.expReverseCharge"), t("c.status"), t("ord.paidAt"),
];

const money = (cents: number): string => (cents / 100).toFixed(2);

function toExportRow(o: OrderRow): string[] {
  return [
    o.ref,
    fmtExport(o.createdAt),
    o.marketCode,
    o.customerAlias,
    o.customerEmail,
    o.itemSku,
    o.itemTitle,
    fulfilmentLabel(o.fulfilment),
    money(o.hammerCents),
    money(o.premiumCents),
    money(o.vatCents),
    money(o.shippingCents),
    money(o.handlingCents),
    money(o.totalCents),
    o.reverseCharge ? t("c.yes") : t("c.no"),
    orderStatusLabel(o.status),
    fmtExport(o.paidAt),
  ];
}

// ── Screen entry ─────────────────────────────────────────────────────────────

/** Ссылка из отчёта «Reklāmas atdeve»: список, суженный до одной кампании.
 *  Вид `attr:<модель>:<source>|<medium>|<campaign>`; пустые части значат
 *  «без метки» — так открывается и строка прямых заходов. */
function parseAttrParam(param: string | null): AttrFilter | null {
  if (!param?.startsWith("attr:")) return null;
  const [, model = "last", key = ""] = param.split(":");
  const [source = "", medium = "", campaign = ""] = key.split("|").map(decodeURIComponent);
  return { model: model === "first" ? "first" : "last", source, medium, campaign };
}

export function attrRoute(model: string, source: string, medium: string, campaign: string): string {
  const k = [source, medium, campaign].map(encodeURIComponent).join("|");
  return `attr:${model}:${k}`;
}

export function OrdersScreen({ nav }: { nav: Nav }) {
  const attr = parseAttrParam(nav.route.param);
  if (nav.route.param && !attr) return <OrderDetailPage id={nav.route.param} nav={nav} />;
  return <OrdersList nav={nav} attr={attr} />;
}

// ═════════════════════════════════════════════════════════════════════════════
// LIST VIEW
// ═════════════════════════════════════════════════════════════════════════════

function OrdersList({ nav, attr }: { nav: Nav; attr?: AttrFilter | null }) {
  const { can } = useAuth();
  const { t } = useT();
  const toast = useToast();
  const mobile = useIsMobile();
  const confirm = useConfirm();

  const [filters, setFilters] = useState<Filters>(() => filterTools.loadStored(FILTERS_KEY));
  const [qInput, setQInput] = useState(filters.q);
  const [rows, setRows] = useState<OrderRow[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const seq = useRef(0);

  // Search debounce: the input is instant, the server query trails by 300ms.
  useDebounced(qInput, (v) => setFilters((f) => (f.q === v ? f : { ...f, q: v })));
  // Last-used filters survive reloads (per browser).
  useStoredFilters(FILTERS_KEY, filters);

  const sv = useSavedViews({
    screen: "orders",
    filters,
    defaults: DEFAULT_FILTERS,
    normalize: filterTools.normalize,
    same: filterTools.same,
    apply: (f) => {
      setQInput(f.q);
      setFilters(f);
    },
  });
  const selection = useSelection(rows);
  const { selected, setSelected, allSelected, toggleAll, toggleOne, selectedRows } = selection;

  // Page 0 (re)load whenever a filter changes; stale responses are dropped.
  useEffect(() => {
    const s = ++seq.current;
    setLoading(true);
    void api
      .get<ListResponse>(`/api/orders?${buildQuery(filters, PAGE, 0, attr)}`)
      .then((r) => {
        if (seq.current !== s) return;
        setRows(r.orders);
        setTotal(r.total);
        setCounts(r.counts);
        setSelected(new Set());
        setLoading(false);
      })
      .catch(() => {
        if (seq.current === s) setLoading(false);
      });
    // attr — сужение из отчёта по рекламе; смена кампании обязана
    // перезапрашивать список, иначе останутся чужие строки.
  }, [filters, refreshTick, attr?.model, attr?.source, attr?.medium, attr?.campaign]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const r = await api.get<ListResponse>(`/api/orders?${buildQuery(filters, PAGE, rows.length, attr)}`);
      setRows((prev) => {
        const seen = new Set(prev.map((o) => o.id));
        return [...prev, ...r.orders.filter((o) => !seen.has(o.id))];
      });
      setTotal(r.total);
      setCounts(r.counts);
    } catch {
      toast(t("ord.loadMoreFailed"), "danger");
    } finally {
      setLoadingMore(false);
    }
  };

  // ── Filter helpers ─────────────────────────────────────────────────────────

  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));

  const clearAll = () => {
    setQInput("");
    setFilters({ ...DEFAULT_FILTERS });
  };

  const chips: FilterChip[] = [];
  if (filters.status !== "all") {
    chips.push({
      key: "status",
      label: pillLabel(filters.status),
      clear: () => set({ status: "all" }),
    });
  }
  if (filters.market !== "all") chips.push({ key: "market", label: `${t("c.market")}: ${filters.market}`, clear: () => set({ market: "all" }) });
  if (filters.fulfilment !== "all") {
    chips.push({
      key: "fulfilment",
      label: `${t("ord.chipDelivery")}: ${fulfilmentLabel(filters.fulfilment)}`,
      clear: () => set({ fulfilment: "all" }),
    });
  }
  if (filters.band !== "any") {
    const band = BANDS.find((b) => b.id === filters.band);
    chips.push({ key: "band", label: band ? t(band.labelKey) : filters.band, clear: () => set({ band: "any" }) });
  }
  if (filters.from) chips.push({ key: "from", label: `${t("ord.chipFrom")} ${filters.from}`, clear: () => set({ from: "" }) });
  if (filters.to) chips.push({ key: "to", label: `${t("ord.chipTo")} ${filters.to}`, clear: () => set({ to: "" }) });
  if (filters.sort !== "newest") {
    const sort = SORTS.find((s) => s.value === filters.sort);
    chips.push({ key: "sort", label: sort ? t(sort.labelKey) : filters.sort, clear: () => set({ sort: "newest" }) });
  }
  if (filters.q.trim()) {
    chips.push({
      key: "q",
      label: `"${filters.q.trim()}"`,
      clear: () => {
        setQInput("");
        set({ q: "" });
      },
    });
  }

  const selectedAwaiting = selectedRows.filter((r) => r.status === "awaiting_payment");

  // ── Export ─────────────────────────────────────────────────────────────────

  /** Selected rows if any; otherwise every page of the current filter. */
  const gatherExportRows = async (): Promise<OrderRow[]> => {
    if (selectedRows.length > 0) return selectedRows;
    const out: OrderRow[] = [];
    for (;;) {
      const r = await api.get<ListResponse>(`/api/orders?${buildQuery(filters, EXPORT_PAGE, out.length, attr)}`);
      out.push(...r.orders);
      if (r.orders.length === 0 || out.length >= r.total) break;
    }
    return out;
  };

  const runExport = async (fmt: "csv" | "xls" | "pdf") => {
    try {
      const list = await gatherExportRows();
      if (list.length === 0) {
        toast(t("ord.nothingToExport"), "warn");
        return;
      }
      const headers = exportHeaders();
      const body = list.map(toExportRow);
      if (fmt === "csv") exportCSV("orders", headers, body);
      else if (fmt === "xls") exportXLS("orders", headers, body, t("ord.title"));
      else exportPDFPrint(t("ord.exportPdfTitle"), headers, body);
      toast(
        fmt === "pdf"
          ? `${t("ord.openingPrint")} (${list.length})`
          : `${t("ord.exportDone")}: ${list.length} ${t("ord.exportNoun")}`,
        "ok",
      );
    } catch {
      toast(t("ord.exportFailed"), "danger");
    }
  };

  // ── Bulk cancel unpaid ─────────────────────────────────────────────────────

  const bulkCancelUnpaid = async () => {
    const targets = selectedAwaiting;
    if (targets.length === 0) return;
    const r = await confirm({
      title: targets.length === 1 ? t("ord.bulkCancelTitle1") : `${t("ord.bulkCancelTitleN")} (${targets.length})?`,
      body: t("ord.bulkCancelBody"),
      danger: true,
      typeToConfirm: "CANCEL",
      requireReason: true,
      confirmLabel: t("ord.cancelStrike"),
    });
    if (!r.ok) return;
    let ok = 0;
    let failed = 0;
    for (const o of targets) {
      try {
        await api.post(`/api/orders/${o.id}/cancel-unpaid`, { reason: r.reason, strike: true });
        ok++;
      } catch {
        failed++;
      }
    }
    toast(
      failed > 0 ? `${ok} ${t("ord.okCancelled")} · ${failed} ${t("ord.errFailed")}` : `${t("ord.bulkCancelDone")} (${ok})`,
      failed > 0 ? "warn" : "ok",
    );
    setRefreshTick((tick) => tick + 1);
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  const exportCount = selected.size > 0 ? selected.size : total;

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <h1 style={{ fontFamily: AT.body, fontSize: 20, fontWeight: 700, color: AT.ink, flex: 1 }}>{t("ord.title")}</h1>
        <ExportMenu count={exportCount} scope={selected.size > 0 ? "selected" : "filtered"} noun={t("ord.exportNoun")} onPick={(fmt) => void runExport(fmt)} />
      </div>

      <ViewsBar {...sv.ViewsBarProps} />

      {/* Status pills with live server counts */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {STATUS_PILL_IDS.map((id) => {
          const active = filters.status === id;
          return (
            <button key={id} onClick={() => set({ status: id })} style={{
              all: "unset", cursor: "pointer", padding: "6px 12px", borderRadius: 999,
              fontFamily: AT.body, fontWeight: 600, fontSize: 12.5,
              background: active ? AT.ink : AT.panel, color: active ? "#fff" : AT.ink,
              border: `1px solid ${active ? AT.ink : AT.rule}`,
            }}>
              {pillLabel(id)}
              <span style={{ marginLeft: 6, opacity: 0.6, fontWeight: 700, fontSize: 11 }}>{counts[id] ?? 0}</span>
            </button>
          );
        })}
      </div>

      {/* Filter bar */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <SearchBox value={qInput} onChange={setQInput} placeholder={t("ord.searchPh")} />
        <ASelect value={filters.market} onChange={(v) => set({ market: v })} options={[
          { value: "all", label: t("ord.allMarkets") },
          { value: "LV", label: "LV" },
          { value: "EE", label: "EE" },
          { value: "LT", label: "LT" },
        ]} />
        <ASelect value={filters.fulfilment} onChange={(v) => set({ fulfilment: v })} options={[
          { value: "all", label: t("ord.allDeliveries") },
          { value: "pickup", label: t("ord.pickup") },
          { value: "omniva_pm", label: "Omniva" },
          { value: "dpd_pm", label: "DPD" },
        ]} />
        <ASelect value={filters.band} onChange={(v) => set({ band: v })} options={BANDS.map((b) => ({ value: b.id, label: t(b.labelKey) }))} />
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft }}>
          <input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => set({ from: e.target.value })} style={dateInputStyle} />
          –
          <input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => set({ to: e.target.value })} style={dateInputStyle} />
        </label>
        <ASelect value={filters.sort} onChange={(v) => set({ sort: v })} options={SORTS.map((s) => ({ value: s.value, label: t(s.labelKey) }))} />
      </div>

      {attr && (
        <div style={{
          display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
          background: AT.accentSoft, borderRadius: AT.radiusSm, padding: "9px 12px",
        }}>
          <span style={{ fontFamily: AT.body, fontSize: 12.5, fontWeight: 700, color: AT.accent }}>
            {t(attr.model === "first" ? "mk.model.first" : "mk.model.last")}:
          </span>
          <span style={{ fontFamily: AT.body, fontSize: 12.5 }}>
            {channelLabel(attr, t("attr.direct"))}{attr.campaign ? ` · ${attr.campaign}` : ""}
          </span>
          <span style={{ flex: 1 }} />
          <ABtn size="sm" kind="ghost" onClick={() => nav.go("orders", null)}>{t("pk.clearAll")}</ABtn>
        </div>
      )}

      <FilterChips chips={chips} onClearAll={clearAll} />

      {/* Table */}
      <ACard pad={false}>
        {loading && rows.length === 0 ? (
          <AEmpty text={t("ord.loadingOrders")} />
        ) : rows.length === 0 ? (
          <AEmpty text={t("ord.emptyList")} />
        ) : mobile ? (
          // Phase B — the approved card reflow: ref + status, bidder + total.
          <div style={{ display: "grid" }}>
            {rows.map((o) => (
              <button key={o.id} onClick={() => nav.go("orders", o.id)} style={{
                all: "unset", cursor: "pointer", display: "grid", gap: 6,
                padding: "13px 14px", borderBottom: `1px solid ${AT.ruleSoft}`,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontFamily: AT.mono, fontSize: 13, fontWeight: 700, color: AT.ink }}>{o.ref}</span>
                  <span style={{ fontFamily: AT.mono, fontSize: 10.5, color: AT.inkSoft }}>{o.itemSku}</span>
                  <span style={{ marginLeft: "auto" }}>
                    <ABadge tone={ORDER_STATUS_TONE[o.status]?.tone ?? "neutral"}>
                      {orderStatusLabel(o.status)}
                    </ABadge>
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                  <span style={{ color: AT.inkSoft }}>{o.customerAlias} · {o.marketCode} · {fmtShort(o.createdAt)}</span>
                  <strong style={{ marginLeft: "auto", fontFamily: AT.mono, fontVariantNumeric: "tabular-nums", color: AT.ink }}>
                    {formatEur(o.totalCents)}
                  </strong>
                </div>
              </button>
            ))}
            {rows.length < total && (
              <div style={{ padding: 12, display: "flex", justifyContent: "center" }}>
                <ABtn kind="ghost" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
                  {loadingMore ? t("c.loading") : `${t("c.loadMore")} (${rows.length} ${t("c.of")} ${total})`}
                </ABtn>
              </div>
            )}
          </div>
        ) : (
          <>
            <ATable head={[
              <input
                key="all"
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                style={checkboxStyle}
                aria-label={t("ord.selectAllAria")}
              />,
              t("ord.thOrder"), t("c.date"), t("c.market"), t("ord.thBidder"), t("attr.title"), t("ord.thPayment"), t("c.total"), t("c.status"),
            ]}>
              {rows.map((o) => (
                <ATr key={o.id} onClick={() => nav.go("orders", o.id)} active={selected.has(o.id)}>
                  <ATd style={{ width: 34 }}>
                    <input
                      type="checkbox"
                      checked={selected.has(o.id)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => toggleOne(o.id)}
                      style={checkboxStyle}
                      aria-label={`${t("ord.selectAria")} ${o.ref}`}
                    />
                  </ATd>
                  <ATd>
                    <div style={{ fontFamily: AT.mono, fontWeight: 700 }}>{o.ref}</div>
                    <div style={{ fontFamily: AT.mono, fontSize: 10.5, color: AT.inkSoft }}>{o.itemSku}</div>
                  </ATd>
                  <ATd mono>{fmtShort(o.createdAt)}</ATd>
                  <ATd><ABadge tone="neutral">{o.marketCode}</ABadge></ATd>
                  <ATd>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                      <AAvatar name={o.customerAlias} size={20} />
                      <span style={{ fontWeight: 600 }}>{o.customerAlias}</span>
                    </span>
                  </ATd>
                  <ATd>
                    {/* Канал прямо в списке: «какие заказы из рекламы» — вопрос
                        к списку, а не к каждой карточке по очереди. */}
                    <span style={{ fontSize: 12, color: (o.attributionLast ?? o.attribution) ? AT.ink : AT.inkSoft }}>
                      {channelLabel(o.attributionLast ?? o.attribution, "—")}
                    </span>
                    {(o.attributionLast ?? o.attribution)?.campaign && (
                      <div style={{ fontFamily: AT.body, fontSize: 10.5, color: AT.inkSoft }}>
                        {(o.attributionLast ?? o.attribution)!.campaign}
                      </div>
                    )}
                  </ATd>
                  <ATd>
                    <span style={{ fontSize: 12, color: o.paidVia ? AT.ink : AT.inkSoft }}>
                      {o.paidVia
                        ? `${providerLabel(o.paidVia.provider)} · ${methodLabel(o.paidVia.method)}`
                        : o.status === "paid" ? t("ord.manual") : "—"}
                    </span>
                  </ATd>
                  <ATd mono right style={{ fontVariantNumeric: "tabular-nums" }}>
                    <strong>{formatEur(o.totalCents)}</strong>
                  </ATd>
                  <ATd>
                    <ABadge tone={ORDER_STATUS_TONE[o.status]?.tone ?? "neutral"}>
                      {orderStatusLabel(o.status)}
                    </ABadge>
                  </ATd>
                </ATr>
              ))}
            </ATable>
            {rows.length < total && (
              <div style={{ padding: 12, display: "flex", justifyContent: "center", borderTop: `1px solid ${AT.ruleSoft}` }}>
                <ABtn kind="ghost" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
                  {loadingMore ? t("c.loading") : `${t("c.loadMore")} (${rows.length} ${t("c.of")} ${total})`}
                </ABtn>
              </div>
            )}
          </>
        )}
      </ACard>

      <BulkBar count={selected.size} onClear={() => setSelected(new Set())}>
        <span style={bulkDividerStyle} />
        <BulkBtn onClick={() => void runExport("csv")}>{t("ord.exportCsv")}</BulkBtn>
        {can("orders.cancel_unpaid") && selectedAwaiting.length > 0 && (
          <>
            <span style={bulkDividerStyle} />
            <BulkBtn danger onClick={() => void bulkCancelUnpaid()}>
              {t("ord.cancelUnpaidBtn")} ({selectedAwaiting.length})
            </BulkBtn>
          </>
        )}
      </BulkBar>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// FULL-PAGE ORDER DETAIL
// ═════════════════════════════════════════════════════════════════════════════

const SECTIONS: Array<{ id: string; labelKey: TKey }> = [
  { id: "sec-summary", labelKey: "ord.secSummary" },
  { id: "sec-lots", labelKey: "ord.secLots" },
  { id: "sec-pay", labelKey: "ord.secPay" },
  { id: "sec-delivery", labelKey: "ord.secDelivery" },
  { id: "sec-invoice", labelKey: "ord.secInvoice" },
];

function jumpTo(id: string): void {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function OrderDetailPage({ id, nav }: { id: string; nav: Nav }) {
  const { can } = useAuth();
  const { t } = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [refundAmount, setRefundAmount] = useState("");

  const load = useCallback(() => {
    void api
      .get<OrderDetail>(`/api/orders/${id}`)
      .then((d) => {
        setDetail(d);
        const refunded = d.refunds.reduce((a, r) => a + r.amountCents, 0);
        setRefundAmount(((d.order.totalCents - refunded) / 100).toFixed(2));
      })
      .catch(() => setMissing(true));
  }, [id]);

  useEffect(() => {
    setDetail(null);
    setMissing(false);
    load();
  }, [load]);

  // ── Preserved action flows ─────────────────────────────────────────────────

  const markPaid = async (o: Order) => {
    const r = await confirm({
      title: `${t("ord.markPaidTitlePre")} ${o.ref} ${t("ord.markPaidTitlePost")}`,
      body: `${formatEur(o.totalCents)} ${t("ord.fromWord")} ${o.customerAlias}. ${t("ord.markPaidBody")}`,
      confirmLabel: t("ord.markPaid"),
    });
    if (!r.ok) return;
    try {
      await api.post(`/api/orders/${o.id}/mark-paid`);
      toast(t("ord.markedPaid"), "ok");
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("ord.failed"), "danger");
    }
  };

  const refund = async (o: Order, viaProvider: boolean) => {
    const cents = Math.round(parseFloat(refundAmount.replace(",", ".")) * 100);
    if (!Number.isFinite(cents) || cents <= 0) {
      toast(t("ord.badRefundAmount"), "danger");
      return;
    }
    const r = await confirm({
      title: `${t("ord.refundTitlePre")} ${formatEur(cents)} ${t("ord.refundTitleMid")} ${o.ref}?`,
      body: viaProvider ? t("ord.refundViaBody") : t("ord.refundRecordBody"),
      requireReason: true,
      confirmLabel: t("ord.refundConfirm"),
    });
    if (!r.ok) return;
    try {
      await api.post(`/api/orders/${o.id}/refund`, { amountCents: cents, reason: r.reason, viaProvider });
      toast(viaProvider ? t("ord.refundSent") : t("ord.refundRecorded"), "ok");
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("ord.refundFailed"), "danger");
    }
  };

  const registerShipment = async (o: Order) => {
    const carrier = o.shippingTo?.provider === "dpd" ? "DPD" : "Omniva";
    const r = await confirm({
      title: `${t("ord.regShipTitlePre")} ${carrier} ${t("ord.regShipTitleMid")} ${o.ref}?`,
      body: `${t("ord.regShipBody1")} ${carrier}, ${t("ord.regShipBody2")}`,
      confirmLabel: t("ord.regShipConfirm"),
    });
    if (!r.ok) return;
    try {
      await api.post(`/api/orders/${o.id}/shipment`);
      toast(t("ord.shipRegistered"), "ok");
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("ord.regFailed"), "danger");
    }
  };

  const openLabel = (shipmentId: string) => {
    window.open(`/api/shipments/${shipmentId}/label?token=${encodeURIComponent(api.token ?? "")}`, "_blank");
  };

  const refreshShipment = async (shipmentId: string) => {
    try {
      await api.post(`/api/shipments/${shipmentId}/refresh`);
      load();
      toast(t("ord.trackingRefreshed"), "ok");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("ord.refreshFailed"), "danger");
    }
  };

  const issueInvoice = async (o: Order) => {
    try {
      await api.post(`/api/orders/${o.id}/issue-invoice`);
      toast(t("ord.invoiceIssued"), "ok");
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("ord.issueFailed"), "danger");
    }
  };

  const cancelUnpaid = async (o: Order) => {
    const r = await confirm({
      title: `${t("ord.cancelTitlePre")} ${o.ref} ${t("ord.cancelTitleMid")} ${o.customerAlias}?`,
      body: t("ord.cancelBody"),
      danger: true,
      requireReason: true,
      confirmLabel: t("ord.cancelStrike"),
    });
    if (!r.ok) return;
    try {
      await api.post(`/api/orders/${o.id}/cancel-unpaid`, { reason: r.reason, strike: true });
      toast(t("ord.cancelled"), "ok");
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("ord.cancelFailed"), "danger");
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  if (missing) {
    return (
      <div style={{ display: "grid", gap: 14 }}>
        <div>
          <ABtn kind="ghost" size="sm" onClick={() => nav.go("orders")}>{t("ord.backToOrders")}</ABtn>
        </div>
        <ACard><AEmpty text={t("ord.notFound")} /></ACard>
      </div>
    );
  }

  const o = detail?.order ?? null;
  const overdue =
    o !== null &&
    o.status === "awaiting_payment" &&
    o.paymentDeadlineAt !== null &&
    new Date(o.paymentDeadlineAt).getTime() < Date.now();

  return (
    <div>
      {/* Sticky header: ref + status + CTAs + section jumps */}
      <div style={{
        position: "sticky", top: 0, zIndex: 10, background: AT.app,
        margin: "-22px -26px 0", padding: "16px 26px 0",
        borderBottom: `1px solid ${AT.rule}`,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <ABtn kind="ghost" size="sm" onClick={() => nav.go("orders")}>{`← ${t("ord.title")}`}</ABtn>
          <h1 style={{ fontFamily: AT.mono, fontSize: 18, fontWeight: 700, color: AT.ink }}>{o?.ref ?? "…"}</h1>
          {o && (
            <ABadge tone={ORDER_STATUS_TONE[o.status]?.tone ?? "neutral"}>
              {orderStatusLabel(o.status)}
            </ABadge>
          )}
          {overdue && <ABadge tone="danger">{t("ord.deadlinePassed")}</ABadge>}
          <span style={{ flex: 1 }} />
          {o && o.status === "paid" && can("orders.refund") && (
            <ABtn kind="ghost" size="sm" onClick={() => jumpTo("sec-pay")}>
              <AIcon name="refund" size={14} /> {t("ord.refundDots")}
            </ABtn>
          )}
          {o && o.status === "awaiting_payment" && can("orders.cancel_unpaid") && (
            <ABtn kind="danger" size="sm" onClick={() => void cancelUnpaid(o)}>{t("ord.cancelStrike")}</ABtn>
          )}
          {o && o.status === "awaiting_payment" && can("orders.mark_paid") && (
            <ABtn size="sm" onClick={() => void markPaid(o)}>{t("ord.markPaid")}</ABtn>
          )}
        </div>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 10, paddingBottom: 8 }}>
          {SECTIONS.map((s) => (
            <button key={s.id} onClick={() => jumpTo(s.id)} style={{
              all: "unset", cursor: "pointer", padding: "5px 10px", borderRadius: 8,
              fontFamily: AT.body, fontWeight: 600, fontSize: 12, color: AT.inkSoft,
            }}
              onMouseEnter={(e) => { e.currentTarget.style.background = AT.surfaceAlt; e.currentTarget.style.color = AT.ink; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = AT.inkSoft; }}
            >
              {t(s.labelKey)}
            </button>
          ))}
        </div>
      </div>

      {!detail || !o ? (
        <div style={{ paddingTop: 18 }}>
          <ACard><AEmpty text={t("ord.loadingOrder")} /></ACard>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 14, paddingTop: 18 }}>
          {/* Summary */}
          <div id="sec-summary" style={sectionAnchorStyle}>
            <ACard title={t("ord.secSummary")}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
                <AAvatar name={o.customerAlias} size={34} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: AT.body, fontWeight: 700, fontSize: 14 }}>{o.customerAlias}</div>
                  <div style={{ fontFamily: AT.body, fontSize: 11.5, color: AT.inkSoft }}>{o.customerEmail}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontFamily: AT.body, fontSize: 11, fontWeight: 700, color: AT.inkSoft, textTransform: "uppercase", letterSpacing: "0.06em" }}>{t("ord.totalDue")}</div>
                  <div style={{ fontFamily: AT.mono, fontSize: 20, fontWeight: 700 }}>{formatEur(o.totalCents)}</div>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
                <KV k={t("c.market")} v={<ABadge tone="neutral">{o.marketCode}</ABadge>} />
                <KV k={t("ord.created")} v={formatDate(o.createdAt)} />
                <KV
                  k={t("ord.paymentDeadline")}
                  v={
                    <span style={{ color: overdue ? AT.danger : AT.ink, fontWeight: overdue ? 700 : 400 }}>
                      {formatDate(o.paymentDeadlineAt)}
                    </span>
                  }
                />
                <KV k={t("ord.paidAt")} v={formatDate(o.paidAt)} />
                <KV k={t("ord.secDelivery")} v={fulfilmentLabel(o.fulfilment)} />
                {o.pickupCode && <KV k={t("ord.pickupCode")} v={<span style={{ fontFamily: AT.mono, fontWeight: 700 }}>{o.pickupCode}</span>} />}
              </div>

              {/* Откуда пришёл заказ. Стоит прямо в сводке, а не отдельным
                  экраном: вопрос «это из рекламы?» задают в ту же секунду,
                  что и «сколько он должен». */}
              <div style={{ marginTop: 14 }}>
                <AttributionCard
                  first={o.attribution ?? detail.buyer?.attribution}
                  last={o.attributionLast ?? detail.buyer?.attributionLast}
                  note={o.attribution || o.attributionLast ? t("attr.orderNote") : undefined}
                />
              </div>

              {/* Кто покупатель на самом деле: сколько заказов, когда пришёл,
                  чем входит. Без этого о госте и о постоянном покупателе
                  карточка говорила одинаково. */}
              {detail.buyer && (
                <div style={{
                  marginTop: 10, background: AT.surfaceAlt, borderRadius: AT.radiusSm, padding: "10px 12px",
                  display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
                }}>
                  <span style={{ fontFamily: AT.body, fontSize: 12, fontWeight: 700 }}>{t("cd.buyer")}</span>
                  <span style={{ fontFamily: AT.body, fontSize: 12.5 }}>
                    {detail.buyer.ordersCount} {t("cd.buyer.orders")}
                  </span>
                  <span style={{ fontFamily: AT.body, fontSize: 11.5, color: AT.inkSoft }}>
                    · {t("ord.created")} {formatDate(detail.buyer.createdAt)}
                  </span>
                  {detail.buyer.lastLoginMethod && (
                    <span style={{ fontFamily: AT.body, fontSize: 11.5, color: AT.inkSoft }}>
                      · {detail.buyer.lastLoginMethod === "password" ? t("cd.login.password") : detail.buyer.lastLoginMethod}
                    </span>
                  )}
                  {detail.buyer.blocked && <ABadge tone="danger">{t("cust.st.blocked")}</ABadge>}
                  {detail.buyer.strikes > 0 && <ABadge tone="warn">{t("cust.th.strikes")}: {detail.buyer.strikes}</ABadge>}
                  <span style={{ flex: 1 }} />
                  <ABtn size="sm" kind="ghost" onClick={() => (nav.openTab ?? nav.go)("customers", o.customerId)}>
                    {t("cd.openCustomer")}
                  </ABtn>
                </div>
              )}
            </ACard>
          </div>

          {/* Lots */}
          <div id="sec-lots" style={sectionAnchorStyle}>
            <ACard title={t("ord.secLots")} pad={false}>
              <ATable head={["SKU", t("ord.thLot"), t("c.condition"), t("c.location"), t("ord.thHammer"), t("ord.thItemState")]}>
                <ATr>
                  <ATd mono>{detail.item.sku}</ATd>
                  <ATd><span style={{ fontWeight: 600 }}>{detail.item.title}</span></ATd>
                  <ATd>{detail.item.condition}</ATd>
                  <ATd>{detail.item.location || "—"}</ATd>
                  <ATd mono right>{formatEur(o.hammerCents)}</ATd>
                  <ATd>
                    <ABadge tone={ITEM_STATUS_TONE[detail.item.status]?.tone ?? "neutral"}>
                      {itemStatusLabel(detail.item.status)}
                    </ABadge>
                  </ATd>
                </ATr>
              </ATable>
            </ACard>
          </div>

          {/* Payment & refunds */}
          <div id="sec-pay" style={sectionAnchorStyle}>
            <div style={{ display: "grid", gap: 14 }}>
              <ACard title={t("ord.paymentAttempts")} pad={false}>
                {detail.payments.length === 0 ? (
                  <AEmpty text={t("ord.noPayments")} />
                ) : (
                  <ATable head={[t("ord.thWhen"), t("ord.thProvider"), t("ord.thMethod"), t("c.status"), t("ord.thVia"), t("ord.thAmount"), ""]}>
                    {detail.payments.map((p) => (
                      <ATr key={p.id}>
                        <ATd>{formatDate(p.createdAt)}</ATd>
                        <ATd><span style={{ fontSize: 12, fontWeight: 600 }}>{providerLabel(p.provider)}</span></ATd>
                        <ATd>
                          <span style={{ fontSize: 12 }}>{methodLabel(p.method)}</span>
                          {isBnpl(p.method) && <span style={{ marginLeft: 6 }}><ABadge tone="accent">BNPL</ABadge></span>}
                        </ATd>
                        <ATd>
                          <ABadge tone={PAYMENT_TONE[p.status] ?? "neutral"}>{payStatusLabel(p.status)}</ABadge>
                          {p.providerStatus && p.providerStatus !== p.status && (
                            <div style={{ fontSize: 10, color: AT.inkSoft, marginTop: 2 }}>{p.providerStatus}</div>
                          )}
                        </ATd>
                        <ATd><span style={{ fontSize: 12, color: AT.inkSoft }}>{p.channel === "email" ? t("ord.viaEmail") : t("ord.viaWeb")}</span></ATd>
                        <ATd mono right>{formatEur(p.amountCents)}</ATd>
                        <ATd>
                          {/* Everything the provider reported — terms, contract
                              ids, timestamps — nothing is hidden from the admin. */}
                          <details>
                            <summary style={{ cursor: "pointer", fontSize: 11, color: AT.inkSoft }}>{t("ord.details")}</summary>
                            <div style={{ fontFamily: AT.mono, fontSize: 10.5, color: AT.inkSoft, marginTop: 4 }}>
                              <div>{t("ord.attempt")}: {p.id}</div>
                              <div>{t("ord.providerRef")}: {p.providerId ?? "—"}</div>
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

              {detail.refunds.length > 0 && (
                <ACard title={t("ord.refunds")} pad={false}>
                  <ATable head={[t("ord.thWhen"), t("ord.thAmount"), t("c.reason")]}>
                    {detail.refunds.map((r) => (
                      <ATr key={r.id}>
                        <ATd>{formatDate(r.createdAt)}</ATd>
                        <ATd mono right>{formatEur(r.amountCents)}</ATd>
                        <ATd><span style={{ fontSize: 12, color: AT.inkSoft }}>{r.reason}</span></ATd>
                      </ATr>
                    ))}
                  </ATable>
                </ACard>
              )}

              {o.status === "paid" && can("orders.refund") && (() => {
                const paidVia = detail.payments.find((p) => p.status === "paid" && p.providerId)?.provider ?? null;
                const klixPaid = paidVia === "klix";
                return (
                  <ACard title={t("ord.refundCard")}>
                    <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                      <div style={{ flex: 1 }}>
                        <AField label={t("ord.amountEur")}>
                          <AInput value={refundAmount} onChange={setRefundAmount} />
                        </AField>
                      </div>
                      <ABtn kind="ghost" onClick={() => void refund(o, klixPaid)}>
                        {klixPaid ? t("ord.refundViaKlix") : t("ord.refundDots")}
                      </ABtn>
                    </div>
                    {klixPaid ? (
                      <div style={{ fontSize: 11.5, color: AT.inkSoft, marginTop: 8 }}>
                        {t("ord.klixNote")}{" "}
                        <button
                          onClick={() => void refund(o, false)}
                          style={{ border: "none", background: "none", padding: 0, font: "inherit", color: AT.inkSoft, textDecoration: "underline", cursor: "pointer" }}
                        >
                          {t("ord.recordOnly")}
                        </button>
                      </div>
                    ) : paidVia === "inbank" ? (
                      <div style={{ fontSize: 11.5, color: AT.inkSoft, marginTop: 8 }}>
                        {t("ord.inbankNote")}
                      </div>
                    ) : (
                      <div style={{ fontSize: 11.5, color: AT.inkSoft, marginTop: 8 }}>
                        {t("ord.manualNote")}
                      </div>
                    )}
                  </ACard>
                );
              })()}
            </div>
          </div>

          {/* Delivery */}
          <div id="sec-delivery" style={sectionAnchorStyle}>
            <ACard
              title={t("ord.secDelivery")}
              actions={
                o.fulfilment !== "pickup" &&
                o.status === "paid" &&
                detail.shipments.length === 0 &&
                can("orders.mark_paid") ? (
                  <ABtn size="sm" onClick={() => void registerShipment(o)}>
                    {`${t("ord.regShipBtnPre")} ${o.shippingTo?.provider === "dpd" ? "DPD" : "Omniva"} ${t("ord.regShipBtnPost")}`.trim()}
                  </ABtn>
                ) : undefined
              }
            >
              {o.fulfilment !== "pickup" && o.shippingTo ? (
                <div style={{ display: "grid", gap: 8, fontSize: 12.5 }}>
                  <div>
                    <ABadge tone="accent">{o.shippingTo.provider === "dpd" ? t("ord.dpdLocker") : t("ord.omnivaPm")}</ABadge>
                    <span style={{ marginLeft: 8, fontWeight: 600 }}>{o.shippingTo.name}</span>
                    <span style={{ color: AT.inkSoft }}> — {o.shippingTo.address} ({o.shippingTo.country})</span>
                  </div>
                  <div style={{ color: AT.inkSoft }}>
                    {t("ord.recipient")}: <strong style={{ color: AT.ink }}>{o.recipientName ?? o.customerAlias}</strong>
                    {o.recipientPhone ? ` · ${o.recipientPhone}` : ""} · {t("ord.shippingWord")} {formatEur(o.shippingCents)}
                  </div>
                  {detail.shipments.map((s) => (
                    <div key={s.id} style={{ border: `1px solid ${AT.rule}`, borderRadius: 10, padding: "10px 12px", display: "grid", gap: 6 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <span style={{ fontFamily: AT.mono, fontWeight: 700 }}>{s.barcode}</span>
                        <ABadge tone={SHIPMENT_TONE[s.status] ?? "neutral"}>{shipStatusLabel(s.status)}</ABadge>
                        {s.providerStatus && <span style={{ fontSize: 11, color: AT.inkSoft }}>{s.providerStatus}</span>}
                        <span style={{ flex: 1 }} />
                        <ABtn size="sm" kind="ghost" onClick={() => openLabel(s.id)}>
                          <AIcon name="download" size={13} /> {t("ord.printLabel")}
                        </ABtn>
                        <ABtn size="sm" kind="ghost" onClick={() => void refreshShipment(s.id)}>{t("ord.refreshTracking")}</ABtn>
                      </div>
                      {s.labelPrintedAt && (
                        <div style={{ fontSize: 11, color: AT.inkSoft }}>{t("ord.labelPrinted")} {formatDate(s.labelPrintedAt)}</div>
                      )}
                      {s.events.length > 0 && (
                        <div style={{ display: "grid", gap: 3 }}>
                          {s.events.slice(0, 6).map((e, i) => (
                            <div key={i} style={{ fontSize: 11.5, color: AT.inkSoft, display: "flex", gap: 8 }}>
                              <span style={{ fontFamily: AT.mono, minWidth: 130 }}>{e.at ? formatDate(e.at) : "—"}</span>
                              <span style={{ color: AT.ink }}>{e.description ?? e.code}</span>
                              {e.location && <span>· {e.location}</span>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                  {detail.shipments.length === 0 && o.status !== "paid" && (
                    <div style={{ fontSize: 11.5, color: AT.inkSoft }}>{t("ord.shipAfterPaid")}</div>
                  )}
                </div>
              ) : (
                <div style={{ fontSize: 12.5, color: AT.inkSoft }}>
                  {t("ord.warehousePickup")}{o.pickupCode ? <> — {t("ord.codeWord")} <strong style={{ fontFamily: AT.mono, color: AT.ink }}>{o.pickupCode}</strong></> : ""}.
                </div>
              )}
            </ACard>
          </div>

          {/* Invoice */}
          <div id="sec-invoice" style={sectionAnchorStyle}>
            <ACard title={t("ord.secInvoice")}>
              <div style={{ display: "grid", gap: 7, fontFamily: AT.body, fontSize: 13 }}>
                <Line k={`${t("ord.hammerPrice")} — ${detail.item.title}`} v={formatEur(o.hammerCents)} />
                <Line k={`${t("ord.buyersPremium")} (10%)`} v={formatEur(o.premiumCents)} />
                <Line k={t("ord.net")} v={formatEur(o.hammerCents + o.premiumCents)} />
                <Line k={`${t("ord.vat")} (${(o.vatRateBp / 100).toFixed(1).replace(/\.0$/, "")}%)`} v={formatEur(o.vatCents)} />
                {o.shippingCents > 0 && <Line k={t("ord.shipping")} v={formatEur(o.shippingCents)} />}
                {o.handlingCents > 0 && <Line k={t("ord.handling")} v={formatEur(o.handlingCents)} />}
                <div style={{ borderTop: `1px solid ${AT.rule}`, paddingTop: 7 }}>
                  <Line k={t("ord.totalDue")} v={formatEur(o.totalCents)} bold />
                </div>
                {o.reverseCharge && (
                  <div style={{ fontSize: 11.5, color: AT.inkSoft, marginTop: 3 }}>
                    {t("ord.reverseChargeNote")}
                  </div>
                )}
                <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
                  {detail.invoice ? (
                    <>
                      <span style={{ fontFamily: AT.mono, fontSize: 12 }}>{detail.invoice.number}</span>
                      <ABtn size="sm" kind="ghost" onClick={() =>
                        window.open(`/api/invoices/${detail.invoice!.id}/html?token=${encodeURIComponent(api.token ?? "")}`, "_blank")
                      }>{t("ord.openInvoice")}</ABtn>
                    </>
                  ) : can("invoices.issue") ? (
                    <ABtn size="sm" kind="ghost" onClick={() => void issueInvoice(o)}>{t("ord.issueInvoice")}</ABtn>
                  ) : (
                    <span style={{ fontSize: 11.5, color: AT.inkSoft }}>{t("ord.noInvoice")}</span>
                  )}
                </div>
              </div>
            </ACard>
          </div>
        </div>
      )}
    </div>
  );
}

/** Sections clear the sticky header when jumped to. */
const sectionAnchorStyle: CSSProperties = { scrollMarginTop: 108 };

function KV({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div>
      <div style={{ fontFamily: AT.body, fontSize: 10.5, fontWeight: 700, color: AT.inkSoft, textTransform: "uppercase", letterSpacing: "0.06em" }}>{k}</div>
      <div style={{ marginTop: 3, fontFamily: AT.body, fontSize: 13, color: AT.ink }}>{v}</div>
    </div>
  );
}

function Line({ k, v, bold }: { k: string; v: string; bold?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 14 }}>
      <span style={{ color: bold ? AT.ink : AT.inkSoft, fontWeight: bold ? 700 : 400 }}>{k}</span>
      <span style={{ fontFamily: AT.mono, fontWeight: bold ? 700 : 500 }}>{v}</span>
    </div>
  );
}
