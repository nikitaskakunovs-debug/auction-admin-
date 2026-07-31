// Subpath import keeps the node-only parts of @auction/domain (TOTP) out of the browser bundle.
import { CATEGORIES } from "@auction/domain/categories";
import { CONDITIONS, conditionByCode, conditionRequiresNotes } from "@auction/domain/conditions";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type Item, type Market } from "../api.js";
import type { Nav } from "../App.js";
import { useAuth } from "../auth.js";
import { exportCSV, exportPDFPrint, exportXLS } from "../exporters.js";
import { formatDate } from "../format.js";
import { useT } from "../i18n.js";
import { ActivityTimeline, CommentsThread, useCommentsLive } from "../itemPanels.js";
import { openLabelWindow as openLabel } from "../labels.js";
import {
  BulkBar, BulkBtn, bulkDividerStyle, checkboxStyle, dateInputStyle, ExportMenu, FilterChips,
  makeFilterTools, SearchBox, useDebounced, useSavedViews, useSelection, useStoredFilters,
  ViewsBar, type FilterChip,
} from "../powerkit.js";
import { AT, ITEM_STATUS_TONE } from "../theme.js";
import {
  ABadge, ABtn, ACard, ADrawer, AEmpty, AField, AIcon, AInput, APills, ASelect,
  AStat, ATable, ATd, ATr, useConfirm, useToast,
} from "../ui.js";
import { useIsMobile } from "../useMobile.js";

const GROUPS = [
  { id: "all", label: "All", statuses: null as string[] | null },
  { id: "intake", label: "Intake", statuses: ["draft", "listed"] },
  { id: "selling", label: "Selling", statuses: ["live", "won", "awaiting_payment"] },
  { id: "fulfilment", label: "Fulfilment", statuses: ["paid", "picking", "packed", "shipped", "delivered"] },
  { id: "attention", label: "Attention", statuses: ["unsold", "unpaid_cancelled", "no_pickup_cancelled"] },
  { id: "restock", label: "Returned", statuses: ["unpaid_cancelled", "no_pickup_cancelled"] },
  { id: "closed", label: "Closed", statuses: ["closed"] },
];

const NEXT_STEP: Record<string, { to: string; label: string }> = {
  unpaid_cancelled: { to: "draft", label: "Return to stock" },
  no_pickup_cancelled: { to: "draft", label: "Return to stock" },
  paid: { to: "picking", label: "Start picking" },
  picking: { to: "packed", label: "Mark packed" },
  packed: { to: "shipped", label: "Mark shipped" },
  shipped: { to: "delivered", label: "Mark delivered" },
  delivered: { to: "closed", label: "Close" },
};

/** Items graded before the 16-grade taxonomy keep their free-text value. */
const conditionLabel = (code: string) => conditionByCode(code)?.label ?? code;

interface FormState {
  sku: string;
  title: string;
  description: string;
  condition: string;
  conditionNotes: string;
  category: string;
  location: string;
  weight: string;
  marketCode: string;
}

const emptyForm: FormState = { sku: "", title: "", description: "", condition: "brand_new", conditionNotes: "", category: "other", location: "", weight: "", marketCode: "LV" };

interface Bin { id: string; label: string; zone: string; active: boolean }

/** Drawer tabs — details plus the W2 Saruna (chat) and Vēsture (history). */
type DrawerTab = "details" | "chat" | "history";

// ── A3 power filters (server-side) ───────────────────────────────────────────

interface Filters {
  group: string;
  market: string;
  category: string;
  bin: string;
  from: string;
  to: string;
  sort: string;
  q: string;
}

const DEFAULT_FILTERS: Filters = { group: "all", market: "all", category: "all", bin: "all", from: "", to: "", sort: "newest", q: "" };
const filterTools = makeFilterTools(DEFAULT_FILTERS);
const FILTERS_KEY = "inventoryFilters.v1";
const PAGE = 50;
const EXPORT_PAGE = 200;

interface ListResponse {
  items: Item[];
  total: number;
  counts: Record<string, number>;
}

function buildQuery(f: Filters, limit: number, offset: number): string {
  const p = new URLSearchParams();
  const g = GROUPS.find((x) => x.id === f.group);
  if (g?.statuses) p.set("statuses", g.statuses.join(","));
  if (f.market !== "all") p.set("market", f.market);
  if (f.category !== "all") p.set("category", f.category);
  if (f.bin !== "all") p.set("bin", f.bin);
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.sort !== "newest") p.set("sort", f.sort);
  if (f.q.trim().length >= 2) p.set("q", f.q.trim());
  p.set("limit", String(limit));
  p.set("offset", String(offset));
  return p.toString();
}

const SORTS = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "updated", label: "Recently updated" },
  { value: "title", label: "Title A→Z" },
];

const EXPORT_HEADERS = ["SKU", "Title", "Condition", "Category", "Bin", "Weight g", "Status", "Market", "Received", "Updated"];

export function InventoryScreen({ nav }: { nav: Nav }) {
  const { can } = useAuth();
  const { t } = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const mobile = useIsMobile();
  const [items, setItems] = useState<Item[]>([]);
  const [total, setTotal] = useState(0);
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({});
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [filters, setFilters] = useState<Filters>(() => filterTools.loadStored(FILTERS_KEY));
  const [qInput, setQInput] = useState(filters.q);
  const [bulkBinPick, setBulkBinPick] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Item | null>(null);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>("details");
  const [form, setForm] = useState<FormState>(emptyForm);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [bins, setBins] = useState<Bin[]>([]);
  const seq = useRef(0);
  // W2: per-item unread comment badges, live over WS.
  const { unread, bump, refreshUnread } = useCommentsLive();

  useDebounced(qInput, (v) => setFilters((f) => (f.q === v ? f : { ...f, q: v })));
  useStoredFilters(FILTERS_KEY, filters);

  const sv = useSavedViews({
    screen: "inventory",
    filters,
    defaults: DEFAULT_FILTERS,
    normalize: filterTools.normalize,
    same: filterTools.same,
    apply: (f) => {
      setQInput(f.q);
      setFilters(f);
    },
  });
  const selection = useSelection(items);
  const { selected, setSelected, allSelected, toggleAll, toggleOne, selectedRows } = selection;

  /** Mutation handlers call load() — it refreshes page 0 of the current filter. */
  const load = () => setRefreshTick((t) => t + 1);
  useEffect(() => {
    const s = ++seq.current;
    void api.get<ListResponse>(`/api/items?${buildQuery(filters, PAGE, 0)}`).then((r) => {
      if (seq.current !== s) return;
      setItems(r.items);
      setTotal(r.total);
      setStatusCounts(r.counts);
      setSelected(new Set());
      setBulkBinPick(false);
    }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, refreshTick]);
  useEffect(() => {
    void api.get<{ markets: Market[] }>("/api/markets").then((r) => setMarkets(r.markets)).catch(() => undefined);
    void api.get<{ locations: Bin[] }>("/api/warehouse/locations").then((r) => setBins(r.locations.filter((b) => b.active))).catch(() => undefined);
  }, []);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const r = await api.get<ListResponse>(`/api/items?${buildQuery(filters, PAGE, items.length)}`);
      setItems((prev) => {
        const seen = new Set(prev.map((i) => i.id));
        return [...prev, ...r.items.filter((i) => !seen.has(i.id))];
      });
      setTotal(r.total);
    } catch {
      toast("Failed to load more", "danger");
    } finally {
      setLoadingMore(false);
    }
  };

  // Deep link (#/inventory/<itemId>) from ⌘K search and the W3 bin drawer —
  // opens the item's detail drawer directly.
  const param = nav.route.param;
  useEffect(() => {
    if (!param) return;
    void api.get<{ item: Item }>(`/api/items/${param}`).then((r) => {
      const i = r.item;
      setEditing(i);
      setDrawerTab("details");
      setForm({
        sku: i.sku, title: i.title, description: i.description, condition: i.condition,
        conditionNotes: i.conditionNotes ?? "", category: i.category ?? "other",
        location: i.location, weight: i.weightGrams == null ? "" : String(i.weightGrams), marketCode: i.marketCode,
      });
    }).catch(() => undefined);
  }, [param]);

  const putaway = async (locationId: string | null) => {
    if (!editing) return;
    try {
      await api.post(`/api/items/${editing.id}/putaway`, { locationId, reason: "" });
      toast(locationId ? "Bin assigned" : "Bin cleared", "ok");
      setEditing({ ...editing, locationId });
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Putaway failed", "danger");
    }
  };

  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  // ── Photos (upload → server re-encodes to web+thumb webp) ────────────────
  const thumbOf = (u: string) => (u.includes("-web.webp") ? u.replace("-web.webp", "-thumb.webp") : u);

  const uploadPhotos = async (files: FileList | null) => {
    if (!editing || !files || files.length === 0) return;
    const fd = new FormData();
    for (const f of Array.from(files)) fd.append("photos", f);
    try {
      const r = await api.postForm<{ item: Item }>(`/api/items/${editing.id}/photos`, fd);
      setEditing(r.item);
      toast(files.length > 1 ? `${files.length} photos uploaded` : "Photo uploaded", "ok");
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Upload failed", "danger");
    }
  };

  const removePhoto = async (url: string) => {
    if (!editing) return;
    try {
      const r = await api.delete<{ item: Item }>(`/api/items/${editing.id}/photos`, { url });
      setEditing(r.item);
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Delete failed", "danger");
    }
  };

  const setCover = async (url: string) => {
    if (!editing) return;
    try {
      const r = await api.post<{ item: Item }>(`/api/items/${editing.id}/photos/cover`, { url });
      setEditing(r.item);
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Failed", "danger");
    }
  };

  const submit = async () => {
    const body = {
      sku: form.sku,
      title: form.title,
      description: form.description,
      condition: form.condition,
      conditionNotes: form.conditionNotes,
      category: form.category,
      location: form.location,
      weightGrams: form.weight ? Number(form.weight) : null,
      marketCode: form.marketCode,
    };
    try {
      if (editing) {
        await api.patch(`/api/items/${editing.id}`, body);
        toast("Item saved", "ok");
      } else {
        await api.post("/api/items", body);
        toast("Item created", "ok");
      }
      setCreating(false);
      setEditing(null);
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Save failed", "danger");
    }
  };

  const transition = async (item: Item, to: string) => {
    try {
      await api.post(`/api/items/${item.id}/transition`, { to });
      toast(`${item.sku} → ${to.replace(/_/g, " ")}`, "ok");
      setEditing(null);
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Transition failed", "danger");
    }
  };

  const remove = async (item: Item) => {
    const r = await confirm({
      title: `Delete ${item.sku}?`,
      body: "Only draft items can be deleted. This cannot be undone.",
      danger: true,
      typeToConfirm: item.sku,
      confirmLabel: "Delete",
    });
    if (!r.ok) return;
    try {
      await api.delete(`/api/items/${item.id}`);
      toast("Item deleted", "ok");
      setEditing(null);
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Delete failed", "danger");
    }
  };

  // Group pills + tiles fold the server's per-status counts (exact even
  // beyond the loaded page).
  const groupCounts = useMemo(() => {
    const sum = (statuses: string[] | null) =>
      statuses === null
        ? Object.values(statusCounts).reduce((a, n) => a + n, 0)
        : statuses.reduce((a, s) => a + (statusCounts[s] ?? 0), 0);
    const map: Record<string, number> = {};
    for (const g of GROUPS) map[g.id] = sum(g.statuses);
    return map;
  }, [statusCounts]);

  const kpis = useMemo(() => {
    const by = (statuses: string[]) => statuses.reduce((a, s) => a + (statusCounts[s] ?? 0), 0);
    return {
      total: Object.values(statusCounts).reduce((a, n) => a + n, 0),
      fulfilment: by(["paid", "picking", "packed", "shipped"]),
      awaiting: by(["awaiting_payment"]),
      attention: by(["unsold", "unpaid_cancelled", "no_pickup_cancelled"]),
    };
  }, [statusCounts]);

  const setF = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));
  const clearAll = () => {
    setQInput("");
    setFilters({ ...DEFAULT_FILTERS });
  };

  const binById = useMemo(() => new Map(bins.map((b) => [b.id, b])), [bins]);
  const chips: FilterChip[] = [];
  if (filters.group !== "all") chips.push({ key: "group", label: GROUPS.find((g) => g.id === filters.group)?.label ?? filters.group, clear: () => setF({ group: "all" }) });
  if (filters.market !== "all") chips.push({ key: "market", label: `Market: ${filters.market}`, clear: () => setF({ market: "all" }) });
  if (filters.category !== "all") chips.push({ key: "category", label: `Category: ${CATEGORIES.find((c) => c.code === filters.category)?.label ?? filters.category}`, clear: () => setF({ category: "all" }) });
  if (filters.bin !== "all") chips.push({ key: "bin", label: `Bin: ${filters.bin === "none" ? "unassigned" : binById.get(filters.bin)?.label ?? "?"}`, clear: () => setF({ bin: "all" }) });
  if (filters.from) chips.push({ key: "from", label: `From ${filters.from}`, clear: () => setF({ from: "" }) });
  if (filters.to) chips.push({ key: "to", label: `To ${filters.to}`, clear: () => setF({ to: "" }) });
  if (filters.sort !== "newest") chips.push({ key: "sort", label: SORTS.find((s) => s.value === filters.sort)?.label ?? filters.sort, clear: () => setF({ sort: "newest" }) });
  if (filters.q.trim()) chips.push({ key: "q", label: `"${filters.q.trim()}"`, clear: () => { setQInput(""); setF({ q: "" }); } });

  // ── Export ─────────────────────────────────────────────────────────────────

  const toExportRow = (i: Item): string[] => [
    i.sku,
    i.title,
    conditionLabel(i.condition),
    i.category ?? "other",
    i.location || "",
    i.weightGrams == null ? "" : String(i.weightGrams),
    ITEM_STATUS_TONE[i.status]?.label ?? i.status,
    i.marketCode,
    i.createdAt.slice(0, 10),
    i.updatedAt.slice(0, 10),
  ];

  const gatherExportRows = async (): Promise<Item[]> => {
    if (selectedRows.length > 0) return selectedRows;
    const out: Item[] = [];
    for (;;) {
      const r = await api.get<ListResponse>(`/api/items?${buildQuery(filters, EXPORT_PAGE, out.length)}`);
      out.push(...r.items);
      if (r.items.length === 0 || out.length >= r.total) break;
    }
    return out;
  };

  const runExport = async (fmt: "csv" | "xls" | "pdf") => {
    try {
      const list = await gatherExportRows();
      if (list.length === 0) return toast("Nothing to export", "warn");
      const body = list.map(toExportRow);
      if (fmt === "csv") exportCSV("inventory", EXPORT_HEADERS, body);
      else if (fmt === "xls") exportXLS("inventory", EXPORT_HEADERS, body, "Inventory");
      else exportPDFPrint("Inventory export", EXPORT_HEADERS, body);
      toast(`Exported ${list.length} items`, "ok");
    } catch {
      toast("Export failed", "danger");
    }
  };

  // ── Bulk: print labels (one print run) + move to bin ──────────────────────

  const bulkLabels = () => {
    const ids = selectedRows.map((i) => i.id).join(",");
    void openLabel(`/api/items/labels?ids=${ids}`, (m) => toast(m, "danger"));
  };

  const bulkMove = async (locationId: string) => {
    let ok = 0;
    let failed = 0;
    for (const i of selectedRows) {
      try {
        await api.post(`/api/items/${i.id}/putaway`, { locationId, reason: "bulk move" });
        ok++;
      } catch {
        failed++;
      }
    }
    toast(failed > 0 ? `${ok} moved · ${failed} failed` : `${ok} item${ok === 1 ? "" : "s"} moved`, failed > 0 ? "warn" : "ok");
    setBulkBinPick(false);
    load();
  };

  const exportCount = selected.size > 0 ? selected.size : total;

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <h1 style={{ fontFamily: AT.body, fontSize: 20, fontWeight: 700, color: AT.ink, flex: 1 }}>Inventory</h1>
        <ExportMenu count={exportCount} scope={selected.size > 0 ? "selected" : "filtered"} noun="items" onPick={(fmt) => void runExport(fmt)} />
        {can("items.create") && (
          <ABtn onClick={() => { setForm(emptyForm); setEditing(null); setDrawerTab("details"); setCreating(true); }}>
            <AIcon name="plus" size={15} color="#fff" /> New item
          </ABtn>
        )}
      </div>

      <ViewsBar {...sv.ViewsBarProps} />

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <AStat label="Items" value={kpis.total} />
        <AStat label="In fulfilment" value={kpis.fulfilment} />
        <AStat label="Awaiting payment" value={kpis.awaiting} tone={kpis.awaiting > 0 ? "warn" : undefined} />
        <AStat label="Needs attention" value={kpis.attention} tone={kpis.attention > 0 ? "warn" : undefined} sub="unsold / cancelled" />
      </div>

      <APills options={GROUPS.map((g) => ({ id: g.id, label: g.label, count: groupCounts[g.id] ?? 0 }))} value={filters.group} onChange={(v) => setF({ group: v })} />

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <SearchBox value={qInput} onChange={setQInput} placeholder="Search sku or title…" />
        <ASelect
          value={filters.market}
          onChange={(v) => setF({ market: v })}
          options={[{ value: "all", label: "All markets" }, ...markets.map((m) => ({ value: m.code, label: m.code }))]}
        />
        <ASelect
          value={filters.category}
          onChange={(v) => setF({ category: v })}
          options={[{ value: "all", label: "All categories" }, ...CATEGORIES.map((c) => ({ value: c.code, label: c.label }))]}
        />
        <ASelect
          value={filters.bin}
          onChange={(v) => setF({ bin: v })}
          options={[{ value: "all", label: "Any bin" }, { value: "none", label: "No bin" }, ...bins.map((b) => ({ value: b.id, label: b.label }))]}
        />
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft }}>
          <input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => setF({ from: e.target.value })} style={dateInputStyle} />
          –
          <input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => setF({ to: e.target.value })} style={dateInputStyle} />
        </label>
        <ASelect value={filters.sort} onChange={(v) => setF({ sort: v })} options={SORTS} />
      </div>

      <FilterChips chips={chips} onClearAll={clearAll} />

      <ACard pad={false}>
        {items.length === 0 ? (
          <AEmpty text="No items match these filters." />
        ) : mobile ? (
          // Phase B — card reflow: SKU + status, title, condition + location.
          <div style={{ display: "grid" }}>
            {items.map((i) => (
              <button key={i.id} onClick={() => {
                setEditing(i);
                setDrawerTab("details");
                setForm({
                  sku: i.sku, title: i.title, description: i.description, condition: i.condition,
                  conditionNotes: i.conditionNotes ?? "", category: i.category ?? "other",
                  location: i.location, weight: i.weightGrams == null ? "" : String(i.weightGrams), marketCode: i.marketCode,
                });
              }} style={{
                all: "unset", cursor: "pointer", display: "grid", gap: 5,
                padding: "13px 14px", borderBottom: `1px solid ${AT.ruleSoft}`,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontFamily: AT.mono, fontSize: 12.5, fontWeight: 700, color: AT.ink }}>{i.sku}</span>
                  {(unread.get(i.id) ?? 0) > 0 && (
                    <span style={{
                      display: "inline-grid", placeItems: "center", minWidth: 16, height: 16, padding: "0 4px",
                      borderRadius: 999, background: AT.accent, color: "#fff", fontSize: 10, fontWeight: 800,
                    }}>{unread.get(i.id)}</span>
                  )}
                  <span style={{ marginLeft: "auto" }}>
                    <ABadge tone={ITEM_STATUS_TONE[i.status]?.tone ?? "neutral"}>
                      {ITEM_STATUS_TONE[i.status]?.label ?? i.status}
                    </ABadge>
                  </span>
                </div>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: AT.ink }}>{i.title}</div>
                <div style={{ fontSize: 12, color: AT.inkSoft }}>
                  {conditionLabel(i.condition)}{i.location ? ` · ${i.location}` : ""}
                </div>
              </button>
            ))}
            {items.length < total && (
              <div style={{ padding: 12, display: "flex", justifyContent: "center" }}>
                <ABtn kind="ghost" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
                  {loadingMore ? "Loading…" : `Load more (${items.length} of ${total})`}
                </ABtn>
              </div>
            )}
          </div>
        ) : (
          <>
            <ATable head={[
              <input key="all" type="checkbox" checked={allSelected} onChange={toggleAll} style={checkboxStyle} aria-label="Select all visible items" />,
              "SKU", "Title", "Condition", "Location", "Weight", "Status", "Updated",
            ]}>
              {items.map((i) => (
                <ATr key={i.id} active={selected.has(i.id)} onClick={() => {
                  setEditing(i);
                  setDrawerTab("details");
                  setForm({
                    sku: i.sku, title: i.title, description: i.description, condition: i.condition,
                    conditionNotes: i.conditionNotes ?? "", category: i.category ?? "other",
                    location: i.location, weight: i.weightGrams == null ? "" : String(i.weightGrams), marketCode: i.marketCode,
                  });
                }}>
                  <ATd style={{ width: 34 }}>
                    <input
                      type="checkbox"
                      checked={selected.has(i.id)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => toggleOne(i.id)}
                      style={checkboxStyle}
                      aria-label={`Select ${i.sku}`}
                    />
                  </ATd>
                  <ATd mono>
                    {i.sku}
                    {(unread.get(i.id) ?? 0) > 0 && (
                      <span style={{
                        marginLeft: 7, display: "inline-grid", placeItems: "center", verticalAlign: "middle",
                        minWidth: 16, height: 16, padding: "0 4px", borderRadius: 999, background: AT.accent,
                        color: "#fff", fontFamily: AT.body, fontSize: 10, fontWeight: 800,
                      }}>{unread.get(i.id)}</span>
                    )}
                  </ATd>
                  <ATd><span style={{ fontWeight: 600 }}>{i.title}</span></ATd>
                  <ATd>{conditionLabel(i.condition)}</ATd>
                  <ATd mono>{i.location || "—"}</ATd>
                  <ATd right>{i.weightGrams == null ? "—" : `${i.weightGrams} g`}</ATd>
                  <ATd><ABadge tone={ITEM_STATUS_TONE[i.status]?.tone ?? "neutral"}>{ITEM_STATUS_TONE[i.status]?.label ?? i.status}</ABadge></ATd>
                  <ATd>{formatDate(i.updatedAt)}</ATd>
                </ATr>
              ))}
            </ATable>
            {items.length < total && (
              <div style={{ padding: 12, display: "flex", justifyContent: "center", borderTop: `1px solid ${AT.ruleSoft}` }}>
                <ABtn kind="ghost" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
                  {loadingMore ? "Loading…" : `Load more (${items.length} of ${total})`}
                </ABtn>
              </div>
            )}
          </>
        )}
      </ACard>

      <BulkBar count={selected.size} onClear={() => { setSelected(new Set()); setBulkBinPick(false); }}>
        <span style={bulkDividerStyle} />
        <BulkBtn onClick={bulkLabels}>Print labels</BulkBtn>
        {can("warehouse.manage") && <BulkBtn onClick={() => setBulkBinPick((v) => !v)}>Move to bin ▾</BulkBtn>}
        <span style={bulkDividerStyle} />
        <BulkBtn onClick={() => void runExport("csv")}>Export CSV</BulkBtn>
        {bulkBinPick && (
          <>
            <span style={bulkDividerStyle} />
            <select
              onChange={(e) => e.target.value && void bulkMove(e.target.value)}
              defaultValue=""
              style={{ borderRadius: 7, border: "none", padding: "5px 8px", fontFamily: AT.body, fontSize: 12.5 }}
            >
              <option value="" disabled>Pick a bin…</option>
              {bins.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
            </select>
          </>
        )}
      </BulkBar>

      {(creating || editing) && (
        <ADrawer
          title={editing ? <span>Edit item <span style={{ fontFamily: AT.mono, fontSize: 12, color: AT.inkSoft }}>{editing.sku}</span></span> : "New item"}
          onClose={() => { setCreating(false); setEditing(null); }}
          footer={
            <>
              {drawerTab === "details" && editing && editing.status === "draft" && can("items.delete") && (
                <ABtn kind="danger" onClick={() => void remove(editing)}>Delete</ABtn>
              )}
              <ABtn kind="ghost" onClick={() => { setCreating(false); setEditing(null); }}>Close</ABtn>
              {drawerTab === "details" && (editing ? can("items.edit") : can("items.create")) && (
                <ABtn onClick={() => void submit()} disabled={!form.sku || !form.title || (conditionRequiresNotes(form.condition) && form.conditionNotes.trim().length < 3)}>{editing ? "Save" : "Create"}</ABtn>
              )}
            </>
          }
        >
          <div style={{ display: "grid", gap: 14 }}>
            {editing && (
              <div style={{ display: "flex", gap: 2, borderBottom: `1px solid ${AT.rule}` }}>
                {([
                  { id: "details" as DrawerTab, label: "Details", badge: 0 },
                  { id: "chat" as DrawerTab, label: t("wh.tab.chat"), badge: unread.get(editing.id) ?? 0 },
                  { id: "history" as DrawerTab, label: t("wh.tab.history"), badge: 0 },
                ]).map((tb) => (
                  <button key={tb.id} onClick={() => setDrawerTab(tb.id)} style={{
                    all: "unset", cursor: "pointer", padding: "8px 13px", fontFamily: AT.body,
                    fontSize: 12.5, fontWeight: 600, color: drawerTab === tb.id ? AT.ink : AT.inkSoft,
                    borderBottom: `2px solid ${drawerTab === tb.id ? AT.accent : "transparent"}`, marginBottom: -1,
                    display: "inline-flex", alignItems: "center", gap: 6,
                  }}>
                    {tb.label}
                    {tb.badge > 0 && (
                      <span style={{
                        display: "inline-grid", placeItems: "center", minWidth: 16, height: 16, padding: "0 4px",
                        borderRadius: 999, background: AT.accent, color: "#fff", fontSize: 10, fontWeight: 800,
                      }}>{tb.badge}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
            {editing && drawerTab === "chat" && (
              <CommentsThread itemId={editing.id} bump={bump} onRead={refreshUnread} />
            )}
            {editing && drawerTab === "history" && <ActivityTimeline itemId={editing.id} />}
            {(!editing || drawerTab === "details") && (<>
            {editing && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <ABadge tone={ITEM_STATUS_TONE[editing.status]?.tone ?? "neutral"}>{ITEM_STATUS_TONE[editing.status]?.label ?? editing.status}</ABadge>
                {NEXT_STEP[editing.status] && can("items.transition") && (
                  <ABtn size="sm" kind="dark" onClick={() => void transition(editing, NEXT_STEP[editing.status]!.to)}>
                    <AIcon name="pkg" size={13} color="#fff" /> {NEXT_STEP[editing.status]!.label}
                  </ABtn>
                )}
                <ABtn size="sm" kind="ghost" onClick={() => void openLabel(`/api/items/${editing.id}/label`, (m) => toast(m, "danger"))}>
                  Print label
                </ABtn>
              </div>
            )}
            <AField label="SKU"><AInput value={form.sku} onChange={(v) => set({ sku: v })} placeholder="LOT-0042" /></AField>
            <AField label="Title"><AInput value={form.title} onChange={(v) => set({ title: v })} /></AField>
            <AField label="Description">
              <textarea value={form.description} onChange={(e) => set({ description: e.target.value })} rows={4} style={{
                width: "100%", borderRadius: AT.radiusSm, border: `1px solid ${AT.rule}`, fontFamily: AT.body,
                fontSize: 13, color: AT.ink, padding: 10, resize: "vertical",
              }} />
            </AField>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <AField label="Condition">
                <ASelect
                  value={form.condition}
                  onChange={(v) => set({ condition: v })}
                  options={[
                    ...(conditionByCode(form.condition) ? [] : [{ value: form.condition, label: `${form.condition} (legacy)` }]),
                    ...CONDITIONS.map((c) => ({ value: c.code, label: c.requiresNotes ? `${c.label} — see notes` : c.label })),
                  ]}
                />
              </AField>
              <AField label="Market">
                <ASelect value={form.marketCode} onChange={(v) => set({ marketCode: v })} options={markets.map((m) => ({ value: m.code, label: m.code }))} />
              </AField>
              <AField label="Category">
                <ASelect value={form.category} onChange={(v) => setF({ category: v })} options={CATEGORIES.map((c) => ({ value: c.code, label: c.label }))} />
              </AField>
              <AField label="Location (note)"><AInput value={form.location} onChange={(v) => set({ location: v })} placeholder="A-01-03" /></AField>
              <AField label="Weight (grams)"><AInput value={form.weight} onChange={(v) => set({ weight: v })} placeholder="1200" /></AField>
            </div>
            {conditionByCode(form.condition) && (
              <div style={{ fontSize: 12, color: AT.inkSoft, marginTop: -8 }}>{conditionByCode(form.condition)!.description}</div>
            )}
            <AField
              label={conditionRequiresNotes(form.condition) ? "Condition notes (required)" : "Condition notes"}
              hint={conditionRequiresNotes(form.condition)
                ? "This is a SEE NOTES grade — describe the specific issue (shown to bidders)."
                : "Optional details shown to bidders."}
            >
              <textarea value={form.conditionNotes} onChange={(e) => set({ conditionNotes: e.target.value })} rows={2} style={{
                width: "100%", borderRadius: AT.radiusSm, fontFamily: AT.body,
                border: `1px solid ${conditionRequiresNotes(form.condition) && form.conditionNotes.trim().length < 3 ? "#C24" : AT.rule}`,
                fontSize: 13, color: AT.ink, padding: 10, resize: "vertical",
              }} />
            </AField>
            {editing && (
              <AField label={`Photos (${editing.photos.length})`} hint="The first photo is the storefront cover. Uploads are resized server-side.">
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {editing.photos.map((p, idx) => (
                    <div key={p} style={{ position: "relative", width: 84 }}>
                      <a href={p} target="_blank" rel="noreferrer">
                        <img src={thumbOf(p)} alt="" style={{ width: 84, height: 84, objectFit: "cover", borderRadius: 8, border: `1px solid ${AT.rule}`, display: "block" }} />
                      </a>
                      {can("items.edit") && (
                        <button
                          onClick={() => void removePhoto(p)}
                          title="Remove photo"
                          style={{ position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: 99, border: "none", background: "#B0282C", color: "#fff", fontSize: 12, cursor: "pointer", lineHeight: 1 }}
                        >×</button>
                      )}
                      {idx === 0 ? (
                        <div style={{ fontSize: 9.5, fontWeight: 700, textAlign: "center", color: AT.inkSoft, marginTop: 3, textTransform: "uppercase", letterSpacing: "0.05em" }}>cover</div>
                      ) : can("items.edit") ? (
                        <button
                          onClick={() => void setCover(p)}
                          style={{ all: "unset", cursor: "pointer", display: "block", width: "100%", textAlign: "center", fontSize: 9.5, fontWeight: 700, color: "#2D4BFF", marginTop: 3, textTransform: "uppercase", letterSpacing: "0.05em" }}
                        >set cover</button>
                      ) : null}
                    </div>
                  ))}
                  {can("items.edit") && (
                    <label style={{ width: 84, height: 84, borderRadius: 8, border: `1.5px dashed ${AT.rule}`, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: AT.inkSoft, fontSize: 22 }}>
                      +
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        multiple
                        style={{ display: "none" }}
                        onChange={(e) => { void uploadPhotos(e.target.files); e.target.value = ""; }}
                      />
                    </label>
                  )}
                </div>
              </AField>
            )}
            {editing && can("warehouse.manage") && (
              <AField label="Warehouse bin" hint="Changing the bin writes a putaway/move into the stock ledger.">
                <ASelect
                  value={editing.locationId ?? ""}
                  onChange={(v) => void putaway(v || null)}
                  options={[{ value: "", label: "— no bin —" }, ...bins.map((b) => ({ value: b.id, label: b.label }))]}
                />
              </AField>
            )}
            </>)}
          </div>
        </ADrawer>
      )}
    </div>
  );
}
