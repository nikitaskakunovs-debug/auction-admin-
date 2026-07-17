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
import { api, ApiError, type Item, type Order } from "../api.js";
import type { Nav } from "../App.js";
import { useAuth } from "../auth.js";
import { exportCSV, exportPDFPrint, exportXLS } from "../exporters.js";
import { formatDate, formatEur } from "../format.js";
import { isBnpl, methodLabel, providerLabel } from "../paymentLabels.js";
import { AT, ITEM_STATUS_TONE, ORDER_STATUS_TONE } from "../theme.js";
import {
  AAvatar, ABadge, ABtn, ACard, AEmpty, AField, AIcon, AInput, ASelect,
  ATable, ATd, ATr, useConfirm, useToast, type IconName,
} from "../ui.js";

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

interface OrderDetail {
  order: Order;
  item: Item;
  refunds: Refund[];
  invoice: { id: string; number: string; issuedAt: string } | null;
  payments: Payment[];
  shipments: Shipment[];
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

const DEFAULT_FILTERS: Filters = {
  status: "all", market: "all", fulfilment: "all", band: "any",
  from: "", to: "", sort: "newest", q: "",
};

const FILTERS_KEY = "ordersFilters.v1";
const PAGE = 50;
const EXPORT_PAGE = 200;

const STATUS_PILLS = [
  { id: "all", label: "All" },
  { id: "awaiting_payment", label: "Awaiting payment" },
  { id: "paid", label: "Paid" },
  { id: "cancelled", label: "Cancelled" },
  { id: "refunded", label: "Refunded" },
];

const MARKETS = [
  { value: "all", label: "All markets" },
  { value: "LV", label: "LV" },
  { value: "EE", label: "EE" },
  { value: "LT", label: "LT" },
];

const FULFILMENTS = [
  { value: "all", label: "All deliveries" },
  { value: "pickup", label: "Pickup" },
  { value: "omniva_pm", label: "Omniva" },
  { value: "dpd_pm", label: "DPD" },
];

const FULFILMENT_LABEL: Record<string, string> = {
  pickup: "Pickup",
  omniva_pm: "Omniva",
  dpd_pm: "DPD",
};

/** Amount bands → min/max in cents (server-side filter). */
const BANDS: Array<{ id: string; label: string; min?: number; max?: number }> = [
  { id: "any", label: "Any amount" },
  { id: "lt100", label: "Under €100", max: 10000 },
  { id: "100-500", label: "€100 – €500", min: 10000, max: 50000 },
  { id: "500-1000", label: "€500 – €1000", min: 50000, max: 100000 },
  { id: "gt1000", label: "Over €1000", min: 100000 },
];

const SORTS = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "amount_desc", label: "Amount: high → low" },
  { value: "amount_asc", label: "Amount: low → high" },
];

const FILTER_KEYS = Object.keys(DEFAULT_FILTERS) as Array<keyof Filters>;

/** An opaque saved-view blob (or stored localStorage state) → a clean Filters. */
function normalizeFilters(blob: Record<string, unknown>): Filters {
  const out: Filters = { ...DEFAULT_FILTERS };
  for (const k of FILTER_KEYS) {
    const v = blob[k];
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function sameFilters(a: Filters, b: Filters): boolean {
  return FILTER_KEYS.every((k) => a[k] === b[k]);
}

function loadStoredFilters(): Filters {
  try {
    const raw = localStorage.getItem(FILTERS_KEY);
    if (raw) return normalizeFilters(JSON.parse(raw) as Record<string, unknown>);
  } catch {
    /* corrupted/private mode — start from defaults */
  }
  return { ...DEFAULT_FILTERS };
}

function buildQuery(f: Filters, limit: number, offset: number): string {
  const p = new URLSearchParams();
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

// ── Saved views ──────────────────────────────────────────────────────────────

interface SavedView {
  id: string;
  name: string;
  filters: Record<string, unknown>;
  position: number;
}

// ── Export ───────────────────────────────────────────────────────────────────

const EXPORT_HEADERS = [
  "Order", "Created", "Market", "Bidder", "Email", "Item SKU", "Item title",
  "Fulfilment", "Hammer €", "Premium €", "VAT €", "Shipping €", "Handling €",
  "Total €", "Reverse charge", "Status", "Paid at",
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
    FULFILMENT_LABEL[o.fulfilment] ?? o.fulfilment,
    money(o.hammerCents),
    money(o.premiumCents),
    money(o.vatCents),
    money(o.shippingCents),
    money(o.handlingCents),
    money(o.totalCents),
    o.reverseCharge ? "Yes" : "No",
    ORDER_STATUS_TONE[o.status]?.label ?? o.status,
    fmtExport(o.paidAt),
  ];
}

// ── Screen entry ─────────────────────────────────────────────────────────────

export function OrdersScreen({ nav }: { nav: Nav }) {
  if (nav.route.param) return <OrderDetailPage id={nav.route.param} nav={nav} />;
  return <OrdersList nav={nav} />;
}

// ═════════════════════════════════════════════════════════════════════════════
// LIST VIEW
// ═════════════════════════════════════════════════════════════════════════════

function OrdersList({ nav }: { nav: Nav }) {
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();

  const [filters, setFilters] = useState<Filters>(loadStoredFilters);
  const [qInput, setQInput] = useState(filters.q);
  const [rows, setRows] = useState<OrderRow[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [views, setViews] = useState<SavedView[]>([]);
  const [lastViewId, setLastViewId] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const seq = useRef(0);

  // Search debounce: the input is instant, the server query trails by 300ms.
  useEffect(() => {
    const t = setTimeout(() => {
      setFilters((f) => (f.q === qInput ? f : { ...f, q: qInput }));
    }, 300);
    return () => clearTimeout(t);
  }, [qInput]);

  // Last-used filters survive reloads (per browser).
  useEffect(() => {
    try {
      localStorage.setItem(FILTERS_KEY, JSON.stringify(filters));
    } catch {
      /* private mode */
    }
  }, [filters]);

  // Page 0 (re)load whenever a filter changes; stale responses are dropped.
  useEffect(() => {
    const s = ++seq.current;
    setLoading(true);
    void api
      .get<ListResponse>(`/api/orders?${buildQuery(filters, PAGE, 0)}`)
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
  }, [filters, refreshTick]);

  useEffect(() => {
    void api.get<{ views: SavedView[] }>("/api/views?screen=orders").then((r) => setViews(r.views)).catch(() => undefined);
  }, []);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const r = await api.get<ListResponse>(`/api/orders?${buildQuery(filters, PAGE, rows.length)}`);
      setRows((prev) => {
        const seen = new Set(prev.map((o) => o.id));
        return [...prev, ...r.orders.filter((o) => !seen.has(o.id))];
      });
      setTotal(r.total);
      setCounts(r.counts);
    } catch {
      toast("Failed to load more", "danger");
    } finally {
      setLoadingMore(false);
    }
  };

  // ── Saved views ────────────────────────────────────────────────────────────

  const isDefault = sameFilters(filters, DEFAULT_FILTERS);
  const activeView = views.find((v) => sameFilters(normalizeFilters(v.filters), filters)) ?? null;
  const lastView = lastViewId ? views.find((v) => v.id === lastViewId) ?? null : null;

  const applyView = (v: SavedView) => {
    const f = normalizeFilters(v.filters);
    setQInput(f.q);
    setFilters(f);
    setLastViewId(v.id);
  };

  const saveView = async () => {
    const name = window.prompt("Name this view:", "");
    if (!name || !name.trim()) return;
    try {
      const r = await api.post<{ view: SavedView }>("/api/views", { screen: "orders", name: name.trim(), filters });
      setViews((vs) => [...vs, r.view]);
      setLastViewId(r.view.id);
      toast(`View "${r.view.name}" saved`, "ok");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Failed to save view", "danger");
    }
  };

  const renameView = async (v: SavedView) => {
    const name = window.prompt("Rename view:", v.name);
    if (!name || !name.trim() || name.trim() === v.name) return;
    try {
      const r = await api.patch<{ view: SavedView }>(`/api/views/${v.id}`, { name: name.trim() });
      setViews((vs) => vs.map((x) => (x.id === v.id ? r.view : x)));
      toast("View renamed", "ok");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Rename failed", "danger");
    }
  };

  const updateView = async (v: SavedView) => {
    try {
      const r = await api.patch<{ view: SavedView }>(`/api/views/${v.id}`, { filters });
      setViews((vs) => vs.map((x) => (x.id === v.id ? r.view : x)));
      toast(`View "${v.name}" updated to current filters`, "ok");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Update failed", "danger");
    }
  };

  const deleteView = async (v: SavedView) => {
    const r = await confirm({
      title: `Delete view "${v.name}"?`,
      body: "Only the saved filter preset is removed — no orders are touched.",
      danger: true,
      confirmLabel: "Delete view",
    });
    if (!r.ok) return;
    try {
      await api.delete(`/api/views/${v.id}`);
      setViews((vs) => vs.filter((x) => x.id !== v.id));
      if (lastViewId === v.id) setLastViewId(null);
      toast("View deleted", "ok");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Delete failed", "danger");
    }
  };

  // ── Filter helpers ─────────────────────────────────────────────────────────

  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));

  const clearAll = () => {
    setQInput("");
    setFilters({ ...DEFAULT_FILTERS });
  };

  const chips: Array<{ key: string; label: string; clear: () => void }> = [];
  if (filters.status !== "all") {
    chips.push({
      key: "status",
      label: STATUS_PILLS.find((p) => p.id === filters.status)?.label ?? filters.status,
      clear: () => set({ status: "all" }),
    });
  }
  if (filters.market !== "all") chips.push({ key: "market", label: `Market: ${filters.market}`, clear: () => set({ market: "all" }) });
  if (filters.fulfilment !== "all") {
    chips.push({
      key: "fulfilment",
      label: `Delivery: ${FULFILMENT_LABEL[filters.fulfilment] ?? filters.fulfilment}`,
      clear: () => set({ fulfilment: "all" }),
    });
  }
  if (filters.band !== "any") {
    chips.push({ key: "band", label: BANDS.find((b) => b.id === filters.band)?.label ?? filters.band, clear: () => set({ band: "any" }) });
  }
  if (filters.from) chips.push({ key: "from", label: `From ${filters.from}`, clear: () => set({ from: "" }) });
  if (filters.to) chips.push({ key: "to", label: `To ${filters.to}`, clear: () => set({ to: "" }) });
  if (filters.sort !== "newest") {
    chips.push({ key: "sort", label: SORTS.find((s) => s.value === filters.sort)?.label ?? filters.sort, clear: () => set({ sort: "newest" }) });
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

  // ── Selection ──────────────────────────────────────────────────────────────

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)));
  };
  const toggleOne = (id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const selectedRows = useMemo(() => rows.filter((r) => selected.has(r.id)), [rows, selected]);
  const selectedAwaiting = selectedRows.filter((r) => r.status === "awaiting_payment");

  // ── Export ─────────────────────────────────────────────────────────────────

  /** Selected rows if any; otherwise every page of the current filter. */
  const gatherExportRows = async (): Promise<OrderRow[]> => {
    if (selectedRows.length > 0) return selectedRows;
    const out: OrderRow[] = [];
    for (;;) {
      const r = await api.get<ListResponse>(`/api/orders?${buildQuery(filters, EXPORT_PAGE, out.length)}`);
      out.push(...r.orders);
      if (r.orders.length === 0 || out.length >= r.total) break;
    }
    return out;
  };

  const runExport = async (fmt: "csv" | "xls" | "pdf") => {
    try {
      const list = await gatherExportRows();
      if (list.length === 0) {
        toast("Nothing to export", "warn");
        return;
      }
      const body = list.map(toExportRow);
      if (fmt === "csv") exportCSV("orders", EXPORT_HEADERS, body);
      else if (fmt === "xls") exportXLS("orders", EXPORT_HEADERS, body, "Orders");
      else exportPDFPrint("Orders export", EXPORT_HEADERS, body);
      toast(fmt === "pdf" ? `Opening print dialog for ${list.length} orders…` : `Exported ${list.length} orders`, "ok");
    } catch {
      toast("Export failed", "danger");
    }
  };

  // ── Bulk cancel unpaid ─────────────────────────────────────────────────────

  const bulkCancelUnpaid = async () => {
    const targets = selectedAwaiting;
    if (targets.length === 0) return;
    const r = await confirm({
      title: `Cancel ${targets.length} unpaid order${targets.length === 1 ? "" : "s"}?`,
      body: "Each order is cancelled, the buyer gets an unpaid-winner strike, and the items are freed for relisting.",
      danger: true,
      typeToConfirm: "CANCEL",
      requireReason: true,
      confirmLabel: "Cancel + strike",
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
    toast(failed > 0 ? `${ok} cancelled · ${failed} failed` : `${ok} order${ok === 1 ? "" : "s"} cancelled, strikes added`, failed > 0 ? "warn" : "ok");
    setRefreshTick((t) => t + 1);
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  const exportCount = selected.size > 0 ? selected.size : total;

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <h1 style={{ fontFamily: AT.body, fontSize: 20, fontWeight: 700, color: AT.ink, flex: 1 }}>Orders</h1>
        <ExportMenu count={exportCount} scope={selected.size > 0 ? "selected" : "filtered"} onPick={(fmt) => void runExport(fmt)} />
      </div>

      {/* Saved views */}
      {(views.length > 0 || !isDefault) && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontFamily: AT.body, fontSize: 10.5, fontWeight: 700, color: AT.inkSoft, textTransform: "uppercase", letterSpacing: "0.07em", marginRight: 2 }}>
            Views
          </span>
          {views.map((v) => {
            const active = activeView?.id === v.id;
            return (
              <span key={v.id} style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                <button onClick={() => applyView(v)} style={viewPillStyle(active)}>
                  {v.name}
                </button>
                {active && (
                  <>
                    <MiniBtn title="Rename view" onClick={() => void renameView(v)}>✎</MiniBtn>
                    <MiniBtn title="Delete view" onClick={() => void deleteView(v)}>×</MiniBtn>
                  </>
                )}
              </span>
            );
          })}
          {!isDefault && !activeView && lastView && (
            <button onClick={() => void updateView(lastView)} style={dashedPillStyle}>
              Update “{lastView.name}”
            </button>
          )}
          {!isDefault && !activeView && (
            <button onClick={() => void saveView()} style={dashedPillStyle}>
              + Save current as view
            </button>
          )}
        </div>
      )}

      {/* Status pills with live server counts */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {STATUS_PILLS.map((p) => {
          const active = filters.status === p.id;
          return (
            <button key={p.id} onClick={() => set({ status: p.id })} style={{
              all: "unset", cursor: "pointer", padding: "6px 12px", borderRadius: 999,
              fontFamily: AT.body, fontWeight: 600, fontSize: 12.5,
              background: active ? AT.ink : AT.panel, color: active ? "#fff" : AT.ink,
              border: `1px solid ${active ? AT.ink : AT.rule}`,
            }}>
              {p.label}
              <span style={{ marginLeft: 6, opacity: 0.6, fontWeight: 700, fontSize: 11 }}>{counts[p.id] ?? 0}</span>
            </button>
          );
        })}
      </div>

      {/* Filter bar */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ position: "relative", flex: "1 1 220px", minWidth: 200, maxWidth: 340 }}>
          <span style={{ position: "absolute", left: 10, top: 10, color: AT.inkSoft }}>
            <AIcon name="search" size={15} />
          </span>
          <AInput value={qInput} onChange={setQInput} placeholder="Search ref, alias, email…" style={{ paddingLeft: 32 }} />
        </div>
        <ASelect value={filters.market} onChange={(v) => set({ market: v })} options={MARKETS} />
        <ASelect value={filters.fulfilment} onChange={(v) => set({ fulfilment: v })} options={FULFILMENTS} />
        <ASelect value={filters.band} onChange={(v) => set({ band: v })} options={BANDS.map((b) => ({ value: b.id, label: b.label }))} />
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft }}>
          <input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => set({ from: e.target.value })} style={dateInputStyle} />
          –
          <input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => set({ to: e.target.value })} style={dateInputStyle} />
        </label>
        <ASelect value={filters.sort} onChange={(v) => set({ sort: v })} options={SORTS} />
      </div>

      {/* Active-filter chips */}
      {chips.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {chips.map((c) => (
            <button key={c.key} onClick={c.clear} title="Remove filter" style={{
              all: "unset", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6,
              padding: "4px 10px", borderRadius: 999, background: AT.accentSoft, color: AT.accent,
              fontFamily: AT.body, fontWeight: 600, fontSize: 12,
            }}>
              {c.label}
              <span style={{ fontWeight: 700 }}>×</span>
            </button>
          ))}
          <button onClick={clearAll} style={{
            all: "unset", cursor: "pointer", padding: "4px 8px", fontFamily: AT.body,
            fontWeight: 600, fontSize: 12, color: AT.inkSoft, textDecoration: "underline",
          }}>
            Clear all
          </button>
        </div>
      )}

      {/* Table */}
      <ACard pad={false}>
        {loading && rows.length === 0 ? (
          <AEmpty text="Loading orders…" />
        ) : rows.length === 0 ? (
          <AEmpty text="No orders match these filters." />
        ) : (
          <>
            <ATable head={[
              <input
                key="all"
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                style={checkboxStyle}
                aria-label="Select all visible orders"
              />,
              "Order", "Date", "Market", "Bidder", "Payment", "Total", "Status",
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
                      aria-label={`Select ${o.ref}`}
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
                    <span style={{ fontSize: 12, color: o.paidVia ? AT.ink : AT.inkSoft }}>
                      {o.paidVia
                        ? `${providerLabel(o.paidVia.provider)} · ${methodLabel(o.paidVia.method)}`
                        : o.status === "paid" ? "manual" : "—"}
                    </span>
                  </ATd>
                  <ATd mono right style={{ fontVariantNumeric: "tabular-nums" }}>
                    <strong>{formatEur(o.totalCents)}</strong>
                  </ATd>
                  <ATd>
                    <ABadge tone={ORDER_STATUS_TONE[o.status]?.tone ?? "neutral"}>
                      {ORDER_STATUS_TONE[o.status]?.label ?? o.status}
                    </ABadge>
                  </ATd>
                </ATr>
              ))}
            </ATable>
            {rows.length < total && (
              <div style={{ padding: 12, display: "flex", justifyContent: "center", borderTop: `1px solid ${AT.ruleSoft}` }}>
                <ABtn kind="ghost" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
                  {loadingMore ? "Loading…" : `Load more (${rows.length} of ${total})`}
                </ABtn>
              </div>
            )}
          </>
        )}
      </ACard>

      {/* Bulk bar */}
      {selected.size > 0 && (
        <div style={{
          position: "fixed", bottom: 60, left: "50%", transform: "translateX(-50%)", zIndex: 50,
          background: AT.ink, color: "#fff", borderRadius: 12, padding: "9px 12px",
          display: "flex", alignItems: "center", gap: 8, boxShadow: "0 14px 40px rgba(0,0,0,0.28)",
          fontFamily: AT.body,
        }}>
          <span style={{ fontWeight: 700, fontSize: 13, padding: "0 4px" }}>{selected.size} selected</span>
          <span style={bulkDividerStyle} />
          <BulkBtn onClick={() => void runExport("csv")}>Export CSV</BulkBtn>
          {can("orders.cancel_unpaid") && selectedAwaiting.length > 0 && (
            <>
              <span style={bulkDividerStyle} />
              <BulkBtn danger onClick={() => void bulkCancelUnpaid()}>
                Cancel unpaid… ({selectedAwaiting.length})
              </BulkBtn>
            </>
          )}
          <span style={bulkDividerStyle} />
          <BulkBtn onClick={() => setSelected(new Set())}>Clear</BulkBtn>
        </div>
      )}
    </div>
  );
}

// ── List-view styling helpers ────────────────────────────────────────────────

const checkboxStyle: CSSProperties = { width: 15, height: 15, accentColor: AT.accent, cursor: "pointer", verticalAlign: "middle" };

const dateInputStyle: CSSProperties = {
  height: 32, borderRadius: AT.radiusSm, border: `1px solid ${AT.rule}`, background: AT.panel,
  fontFamily: AT.body, fontSize: 12.5, color: AT.ink, padding: "0 8px",
};

const bulkDividerStyle: CSSProperties = { width: 1, height: 18, background: "rgba(255,255,255,0.22)" };

function viewPillStyle(active: boolean): CSSProperties {
  return {
    all: "unset", cursor: "pointer", padding: "5px 11px", borderRadius: 999,
    fontFamily: AT.body, fontWeight: 600, fontSize: 12,
    background: active ? AT.accent : AT.panel, color: active ? "#fff" : AT.ink,
    border: `1px solid ${active ? AT.accent : AT.rule}`,
  };
}

const dashedPillStyle: CSSProperties = {
  all: "unset", cursor: "pointer", padding: "5px 11px", borderRadius: 999,
  fontFamily: AT.body, fontWeight: 600, fontSize: 12,
  background: "transparent", color: AT.inkSoft, border: `1px dashed ${AT.rule}`,
};

function MiniBtn({ children, onClick, title }: { children: ReactNode; onClick: () => void; title: string }) {
  return (
    <button title={title} onClick={onClick} style={{
      all: "unset", cursor: "pointer", width: 22, height: 22, borderRadius: 999,
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      fontFamily: AT.body, fontSize: 12, color: AT.inkSoft,
      background: AT.panel, border: `1px solid ${AT.rule}`,
    }}>
      {children}
    </button>
  );
}

function BulkBtn({ children, onClick, danger }: { children: ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick} style={{
      all: "unset", cursor: "pointer", padding: "6px 10px", borderRadius: 8,
      fontFamily: AT.body, fontSize: 12.5, fontWeight: 700,
      color: danger ? "#FCA5A5" : "#fff", background: "rgba(255,255,255,0.12)",
      whiteSpace: "nowrap",
    }}>
      {children}
    </button>
  );
}

/** Export dropdown — Shhh's AExportMenu, typed. */
function ExportMenu({ count, scope, onPick }: {
  count: number;
  scope: "selected" | "filtered";
  onPick: (fmt: "csv" | "xls" | "pdf") => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  const opts: Array<{ fmt: "xls" | "csv" | "pdf"; label: string; ext: string; icon: IconName }> = [
    { fmt: "xls", label: "Excel", ext: ".xls", icon: "finance" },
    { fmt: "csv", label: "CSV", ext: ".csv", icon: "list" },
    { fmt: "pdf", label: "PDF", ext: ".pdf", icon: "download" },
  ];
  return (
    <div ref={ref} style={{ position: "relative", flexShrink: 0 }}>
      <button onClick={() => setOpen((o) => !o)} style={{
        all: "unset", boxSizing: "border-box", cursor: "pointer", display: "inline-flex",
        alignItems: "center", gap: 7, height: 38, padding: "0 12px", borderRadius: AT.radiusSm,
        border: `1px solid ${AT.rule}`, background: AT.panel, color: AT.ink,
        fontFamily: AT.body, fontWeight: 600, fontSize: 12.5,
      }}>
        <AIcon name="download" size={15} color={AT.ink} />
        Export <span style={{ color: AT.inkSoft, fontFamily: AT.mono, fontSize: 11 }}>{count}</span>
        <span style={{ display: "inline-flex", transform: open ? "rotate(180deg)" : "none", transition: "transform .15s" }}>
          <AIcon name="chevDown" size={13} color={AT.inkSoft} />
        </span>
      </button>
      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 60, minWidth: 210,
          background: AT.panel, border: `1px solid ${AT.rule}`, borderRadius: AT.radiusSm,
          boxShadow: "0 14px 40px rgba(0,0,0,0.16)", overflow: "hidden", padding: 5,
        }}>
          <div style={{
            padding: "7px 10px 6px", fontFamily: AT.body, fontSize: 10.5, fontWeight: 700,
            letterSpacing: "0.07em", textTransform: "uppercase", color: AT.inkSoft,
          }}>
            {scope === "selected" ? `Download ${count} selected` : `Download ${count} order${count === 1 ? "" : "s"}`}
          </div>
          {opts.map((o) => (
            <button
              key={o.fmt}
              onClick={() => {
                setOpen(false);
                onPick(o.fmt);
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = AT.surfaceAlt; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              style={{
                all: "unset", cursor: "pointer", boxSizing: "border-box", width: "100%",
                display: "flex", alignItems: "center", gap: 10, padding: "9px 10px",
                borderRadius: 8, fontFamily: AT.body, fontSize: 13, color: AT.ink,
              }}
            >
              <span style={{
                width: 28, height: 28, borderRadius: 7, background: AT.surfaceAlt,
                display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
              }}>
                <AIcon name={o.icon} size={15} color={AT.ink} />
              </span>
              <span style={{ flex: 1 }}>
                <span style={{ fontWeight: 700 }}>{o.label}</span>{" "}
                <span style={{ color: AT.inkSoft, fontFamily: AT.mono, fontSize: 11 }}>{o.ext}</span>
              </span>
              <AIcon name="download" size={14} color={AT.inkSoft} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// FULL-PAGE ORDER DETAIL
// ═════════════════════════════════════════════════════════════════════════════

const SECTIONS = [
  { id: "sec-summary", label: "Summary" },
  { id: "sec-lots", label: "Lots" },
  { id: "sec-pay", label: "Payment & refunds" },
  { id: "sec-delivery", label: "Delivery" },
  { id: "sec-invoice", label: "Invoice" },
];

function jumpTo(id: string): void {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function OrderDetailPage({ id, nav }: { id: string; nav: Nav }) {
  const { can } = useAuth();
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
      title: `Mark ${o.ref} as paid?`,
      body: `${formatEur(o.totalCents)} from ${o.customerAlias}. The item moves to the fulfilment queue.`,
      confirmLabel: "Mark paid",
    });
    if (!r.ok) return;
    try {
      await api.post(`/api/orders/${o.id}/mark-paid`);
      toast("Order marked paid", "ok");
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Failed", "danger");
    }
  };

  const refund = async (o: Order, viaProvider: boolean) => {
    const cents = Math.round(parseFloat(refundAmount.replace(",", ".")) * 100);
    if (!Number.isFinite(cents) || cents <= 0) {
      toast("Enter a valid refund amount", "danger");
      return;
    }
    const r = await confirm({
      title: `Refund ${formatEur(cents)} on ${o.ref}?`,
      body: viaProvider
        ? "The money is returned to the customer through Klix and the refund is recorded."
        : "Record-only: no money moves — use when the refund was already made in the Klix portal or in cash.",
      requireReason: true,
      confirmLabel: "Refund",
    });
    if (!r.ok) return;
    try {
      await api.post(`/api/orders/${o.id}/refund`, { amountCents: cents, reason: r.reason, viaProvider });
      toast(viaProvider ? "Refund sent + recorded" : "Refund recorded", "ok");
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Refund failed", "danger");
    }
  };

  const registerShipment = async (o: Order) => {
    const carrier = o.shippingTo?.provider === "dpd" ? "DPD" : "Omniva";
    const r = await confirm({
      title: `Register ${carrier} shipment for ${o.ref}?`,
      body: `The parcel is registered with ${carrier}, a tracking barcode is issued, and the customer gets the tracking email. Print the label right after.`,
      confirmLabel: "Register",
    });
    if (!r.ok) return;
    try {
      await api.post(`/api/orders/${o.id}/shipment`);
      toast("Shipment registered", "ok");
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Registration failed", "danger");
    }
  };

  const openLabel = (shipmentId: string) => {
    window.open(`/api/shipments/${shipmentId}/label?token=${encodeURIComponent(api.token ?? "")}`, "_blank");
  };

  const refreshShipment = async (shipmentId: string) => {
    try {
      await api.post(`/api/shipments/${shipmentId}/refresh`);
      load();
      toast("Tracking refreshed", "ok");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Refresh failed", "danger");
    }
  };

  const issueInvoice = async (o: Order) => {
    try {
      await api.post(`/api/orders/${o.id}/issue-invoice`);
      toast("Invoice issued", "ok");
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Issue failed", "danger");
    }
  };

  const cancelUnpaid = async (o: Order) => {
    const r = await confirm({
      title: `Cancel ${o.ref} and strike ${o.customerAlias}?`,
      body: "The order is cancelled, the buyer gets an unpaid-winner strike, and the item is freed for relisting.",
      danger: true,
      requireReason: true,
      confirmLabel: "Cancel + strike",
    });
    if (!r.ok) return;
    try {
      await api.post(`/api/orders/${o.id}/cancel-unpaid`, { reason: r.reason, strike: true });
      toast("Order cancelled, strike added", "ok");
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Cancel failed", "danger");
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  if (missing) {
    return (
      <div style={{ display: "grid", gap: 14 }}>
        <div>
          <ABtn kind="ghost" size="sm" onClick={() => nav.go("orders")}>← Back to orders</ABtn>
        </div>
        <ACard><AEmpty text="Order not found." /></ACard>
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
          <ABtn kind="ghost" size="sm" onClick={() => nav.go("orders")}>← Orders</ABtn>
          <h1 style={{ fontFamily: AT.mono, fontSize: 18, fontWeight: 700, color: AT.ink }}>{o?.ref ?? "…"}</h1>
          {o && (
            <ABadge tone={ORDER_STATUS_TONE[o.status]?.tone ?? "neutral"}>
              {ORDER_STATUS_TONE[o.status]?.label ?? o.status}
            </ABadge>
          )}
          {overdue && <ABadge tone="danger">Deadline passed</ABadge>}
          <span style={{ flex: 1 }} />
          {o && o.status === "paid" && can("orders.refund") && (
            <ABtn kind="ghost" size="sm" onClick={() => jumpTo("sec-pay")}>
              <AIcon name="refund" size={14} /> Refund…
            </ABtn>
          )}
          {o && o.status === "awaiting_payment" && can("orders.cancel_unpaid") && (
            <ABtn kind="danger" size="sm" onClick={() => void cancelUnpaid(o)}>Cancel + strike</ABtn>
          )}
          {o && o.status === "awaiting_payment" && can("orders.mark_paid") && (
            <ABtn size="sm" onClick={() => void markPaid(o)}>Mark paid</ABtn>
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
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {!detail || !o ? (
        <div style={{ paddingTop: 18 }}>
          <ACard><AEmpty text="Loading order…" /></ACard>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 14, paddingTop: 18 }}>
          {/* Summary */}
          <div id="sec-summary" style={sectionAnchorStyle}>
            <ACard title="Summary">
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
                <AAvatar name={o.customerAlias} size={34} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: AT.body, fontWeight: 700, fontSize: 14 }}>{o.customerAlias}</div>
                  <div style={{ fontFamily: AT.body, fontSize: 11.5, color: AT.inkSoft }}>{o.customerEmail}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontFamily: AT.body, fontSize: 11, fontWeight: 700, color: AT.inkSoft, textTransform: "uppercase", letterSpacing: "0.06em" }}>Total due</div>
                  <div style={{ fontFamily: AT.mono, fontSize: 20, fontWeight: 700 }}>{formatEur(o.totalCents)}</div>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
                <KV k="Market" v={<ABadge tone="neutral">{o.marketCode}</ABadge>} />
                <KV k="Created" v={formatDate(o.createdAt)} />
                <KV
                  k="Payment deadline"
                  v={
                    <span style={{ color: overdue ? AT.danger : AT.ink, fontWeight: overdue ? 700 : 400 }}>
                      {formatDate(o.paymentDeadlineAt)}
                    </span>
                  }
                />
                <KV k="Paid at" v={formatDate(o.paidAt)} />
                <KV k="Delivery" v={FULFILMENT_LABEL[o.fulfilment] ?? o.fulfilment} />
                {o.pickupCode && <KV k="Pickup code" v={<span style={{ fontFamily: AT.mono, fontWeight: 700 }}>{o.pickupCode}</span>} />}
              </div>
            </ACard>
          </div>

          {/* Lots */}
          <div id="sec-lots" style={sectionAnchorStyle}>
            <ACard title="Lots" pad={false}>
              <ATable head={["SKU", "Lot", "Condition", "Location", "Hammer", "Item state"]}>
                <ATr>
                  <ATd mono>{detail.item.sku}</ATd>
                  <ATd><span style={{ fontWeight: 600 }}>{detail.item.title}</span></ATd>
                  <ATd>{detail.item.condition}</ATd>
                  <ATd>{detail.item.location || "—"}</ATd>
                  <ATd mono right>{formatEur(o.hammerCents)}</ATd>
                  <ATd>
                    <ABadge tone={ITEM_STATUS_TONE[detail.item.status]?.tone ?? "neutral"}>
                      {ITEM_STATUS_TONE[detail.item.status]?.label ?? detail.item.status}
                    </ABadge>
                  </ATd>
                </ATr>
              </ATable>
            </ACard>
          </div>

          {/* Payment & refunds */}
          <div id="sec-pay" style={sectionAnchorStyle}>
            <div style={{ display: "grid", gap: 14 }}>
              <ACard title="Payment attempts" pad={false}>
                {detail.payments.length === 0 ? (
                  <AEmpty text="No online payment attempts — the order is settled manually or not yet paid." />
                ) : (
                  <ATable head={["When", "Provider", "Method", "Status", "Via", "Amount", ""]}>
                    {detail.payments.map((p) => (
                      <ATr key={p.id}>
                        <ATd>{formatDate(p.createdAt)}</ATd>
                        <ATd><span style={{ fontSize: 12, fontWeight: 600 }}>{providerLabel(p.provider)}</span></ATd>
                        <ATd>
                          <span style={{ fontSize: 12 }}>{methodLabel(p.method)}</span>
                          {isBnpl(p.method) && <span style={{ marginLeft: 6 }}><ABadge tone="accent">BNPL</ABadge></span>}
                        </ATd>
                        <ATd>
                          <ABadge tone={PAYMENT_TONE[p.status] ?? "neutral"}>{p.status}</ABadge>
                          {p.providerStatus && p.providerStatus !== p.status && (
                            <div style={{ fontSize: 10, color: AT.inkSoft, marginTop: 2 }}>{p.providerStatus}</div>
                          )}
                        </ATd>
                        <ATd><span style={{ fontSize: 12, color: AT.inkSoft }}>{p.channel === "email" ? "Email link" : "Web"}</span></ATd>
                        <ATd mono right>{formatEur(p.amountCents)}</ATd>
                        <ATd>
                          {/* Everything the provider reported — terms, contract
                              ids, timestamps — nothing is hidden from the admin. */}
                          <details>
                            <summary style={{ cursor: "pointer", fontSize: 11, color: AT.inkSoft }}>details</summary>
                            <div style={{ fontFamily: AT.mono, fontSize: 10.5, color: AT.inkSoft, marginTop: 4 }}>
                              <div>attempt: {p.id}</div>
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

              {detail.refunds.length > 0 && (
                <ACard title="Refunds" pad={false}>
                  <ATable head={["When", "Amount", "Reason"]}>
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
                  <ACard title="Refund">
                    <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                      <div style={{ flex: 1 }}>
                        <AField label="Amount €">
                          <AInput value={refundAmount} onChange={setRefundAmount} />
                        </AField>
                      </div>
                      <ABtn kind="ghost" onClick={() => void refund(o, klixPaid)}>
                        {klixPaid ? "Refund via Klix…" : "Refund…"}
                      </ABtn>
                    </div>
                    {klixPaid ? (
                      <div style={{ fontSize: 11.5, color: AT.inkSoft, marginTop: 8 }}>
                        Paid through Klix — the money is returned to the customer automatically.{" "}
                        <button
                          onClick={() => void refund(o, false)}
                          style={{ border: "none", background: "none", padding: 0, font: "inherit", color: AT.inkSoft, textDecoration: "underline", cursor: "pointer" }}
                        >
                          Record only (already refunded elsewhere)
                        </button>
                      </div>
                    ) : paidVia === "inbank" ? (
                      <div style={{ fontSize: 11.5, color: AT.inkSoft, marginTop: 8 }}>
                        Paid through Inbank — credit/terminate the contract in the Inbank partner portal first; this button then records it.
                      </div>
                    ) : (
                      <div style={{ fontSize: 11.5, color: AT.inkSoft, marginTop: 8 }}>
                        Paid manually — this records the refund; return the money the way it was received.
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
              title="Delivery"
              actions={
                o.fulfilment !== "pickup" &&
                o.status === "paid" &&
                detail.shipments.length === 0 &&
                can("orders.mark_paid") ? (
                  <ABtn size="sm" onClick={() => void registerShipment(o)}>
                    Register {o.shippingTo?.provider === "dpd" ? "DPD" : "Omniva"} shipment
                  </ABtn>
                ) : undefined
              }
            >
              {o.fulfilment !== "pickup" && o.shippingTo ? (
                <div style={{ display: "grid", gap: 8, fontSize: 12.5 }}>
                  <div>
                    <ABadge tone="accent">{o.shippingTo.provider === "dpd" ? "DPD locker" : "Omniva parcel machine"}</ABadge>
                    <span style={{ marginLeft: 8, fontWeight: 600 }}>{o.shippingTo.name}</span>
                    <span style={{ color: AT.inkSoft }}> — {o.shippingTo.address} ({o.shippingTo.country})</span>
                  </div>
                  <div style={{ color: AT.inkSoft }}>
                    Recipient: <strong style={{ color: AT.ink }}>{o.recipientName ?? o.customerAlias}</strong>
                    {o.recipientPhone ? ` · ${o.recipientPhone}` : ""} · shipping {formatEur(o.shippingCents)}
                  </div>
                  {detail.shipments.map((s) => (
                    <div key={s.id} style={{ border: `1px solid ${AT.rule}`, borderRadius: 10, padding: "10px 12px", display: "grid", gap: 6 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <span style={{ fontFamily: AT.mono, fontWeight: 700 }}>{s.barcode}</span>
                        <ABadge tone={SHIPMENT_TONE[s.status] ?? "neutral"}>{s.status.replace("_", " ")}</ABadge>
                        {s.providerStatus && <span style={{ fontSize: 11, color: AT.inkSoft }}>{s.providerStatus}</span>}
                        <span style={{ flex: 1 }} />
                        <ABtn size="sm" kind="ghost" onClick={() => openLabel(s.id)}>
                          <AIcon name="download" size={13} /> Print label
                        </ABtn>
                        <ABtn size="sm" kind="ghost" onClick={() => void refreshShipment(s.id)}>Refresh tracking</ABtn>
                      </div>
                      {s.labelPrintedAt && (
                        <div style={{ fontSize: 11, color: AT.inkSoft }}>Label printed {formatDate(s.labelPrintedAt)}</div>
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
                    <div style={{ fontSize: 11.5, color: AT.inkSoft }}>Shipment can be registered once the order is paid.</div>
                  )}
                </div>
              ) : (
                <div style={{ fontSize: 12.5, color: AT.inkSoft }}>
                  Warehouse pickup{o.pickupCode ? <> — code <strong style={{ fontFamily: AT.mono, color: AT.ink }}>{o.pickupCode}</strong></> : ""}.
                </div>
              )}
            </ACard>
          </div>

          {/* Invoice */}
          <div id="sec-invoice" style={sectionAnchorStyle}>
            <ACard title="Invoice">
              <div style={{ display: "grid", gap: 7, fontFamily: AT.body, fontSize: 13 }}>
                <Line k={`Hammer price — ${detail.item.title}`} v={formatEur(o.hammerCents)} />
                <Line k="Buyer's premium (10%)" v={formatEur(o.premiumCents)} />
                <Line k="Net" v={formatEur(o.hammerCents + o.premiumCents)} />
                <Line k={`VAT (${(o.vatRateBp / 100).toFixed(1).replace(/\.0$/, "")}%)`} v={formatEur(o.vatCents)} />
                {o.shippingCents > 0 && <Line k="Shipping" v={formatEur(o.shippingCents)} />}
                {o.handlingCents > 0 && <Line k="Packing & handling" v={formatEur(o.handlingCents)} />}
                <div style={{ borderTop: `1px solid ${AT.rule}`, paddingTop: 7 }}>
                  <Line k="Total due" v={formatEur(o.totalCents)} bold />
                </div>
                {o.reverseCharge && (
                  <div style={{ fontSize: 11.5, color: AT.inkSoft, marginTop: 3 }}>
                    Reverse charge — VAT payable by recipient, Art. 196 Dir. 2006/112/EC.
                  </div>
                )}
                <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
                  {detail.invoice ? (
                    <>
                      <span style={{ fontFamily: AT.mono, fontSize: 12 }}>{detail.invoice.number}</span>
                      <ABtn size="sm" kind="ghost" onClick={() =>
                        window.open(`/api/invoices/${detail.invoice!.id}/html?token=${encodeURIComponent(api.token ?? "")}`, "_blank")
                      }>Open invoice</ABtn>
                    </>
                  ) : can("invoices.issue") ? (
                    <ABtn size="sm" kind="ghost" onClick={() => void issueInvoice(o)}>Issue invoice</ABtn>
                  ) : (
                    <span style={{ fontSize: 11.5, color: AT.inkSoft }}>No invoice issued.</span>
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
