import { conditionByCode } from "@auction/domain/conditions";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Auction, type Item, type Listing, type Market } from "../api.js";
import type { Nav } from "../App.js";
import { useAuth } from "../auth.js";
import { exportCSV, exportPDFPrint, exportXLS } from "../exporters.js";
import { formatDay, formatDate, formatEur } from "../format.js";
import {
  BulkBar, BulkBtn, bulkDividerStyle, checkboxStyle, dateInputStyle, ExportMenu, FilterChips,
  makeFilterTools, SearchBox, useDebounced, useSavedViews, useSelection, useStoredFilters,
  ViewsBar, type FilterChip,
} from "../powerkit.js";
import { AT, AUCTION_STATUS_TONE, ITEM_STATUS_TONE } from "../theme.js";
import {
  ABadge, ABtn, ACard, ADrawer, AEmpty, AField, AIcon, AInput, APills, ASelect,
  AStat, ATable, ATd, ATr, useConfirm, useToast,
} from "../ui.js";

const PILLS = [
  { id: "all", label: "All" },
  { id: "draft", label: "Draft" },
  { id: "published", label: "Published" },
  { id: "archived", label: "Archived" },
];

// ── A3 power filters (server-side) ───────────────────────────────────────────

interface Filters {
  status: string;
  type: string;
  market: string;
  from: string;
  to: string;
  sort: string;
  q: string;
}

const DEFAULT_FILTERS: Filters = { status: "all", type: "all", market: "all", from: "", to: "", sort: "newest", q: "" };
const filterTools = makeFilterTools(DEFAULT_FILTERS);
const FILTERS_KEY = "listingsFilters.v1";
const PAGE = 50;
const EXPORT_PAGE = 200;

interface ListResponse {
  listings: Listing[];
  total: number;
  counts: Record<string, number>;
}

function buildQuery(f: Filters, limit: number, offset: number): string {
  const p = new URLSearchParams();
  if (f.status !== "all") p.set("status", f.status);
  if (f.type !== "all") p.set("type", f.type);
  if (f.market !== "all") p.set("market", f.market);
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
  { value: "title", label: "Title A→Z" },
];

const EXPORT_HEADERS = ["Title", "Type", "Item SKU", "Item status", "Price €", "Reserve €", "Market", "Status", "Created"];

const eurToCents = (v: string): number | null => {
  const n = parseFloat(v.replace(",", "."));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};
const centsToEur = (c: number | null): string => (c == null ? "" : (c / 100).toFixed(2));

interface FormState {
  itemId: string;
  type: "auction" | "fixed";
  title: string;
  description: string;
  marketCode: string;
  startPrice: string;
  price: string;
  reserve: string;
  antiSnipe: string;
}

const emptyForm: FormState = {
  itemId: "", type: "auction", title: "", description: "", marketCode: "LV",
  startPrice: "", price: "", reserve: "", antiSnipe: "",
};

const thumbOf = (u: string) => (u.includes("-web.webp") ? u.replace("-web.webp", "-thumb.webp") : u);

/** datetime-local value for a Date in the browser's timezone. */
const toLocalInput = (d: Date): string => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

export function ListingsScreen({ nav }: { nav: Nav }) {
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [listings, setListings] = useState<Listing[]>([]);
  const [total, setTotal] = useState(0);
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({});
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [filters, setFilters] = useState<Filters>(() => filterTools.loadStored(FILTERS_KEY));
  const [qInput, setQInput] = useState(filters.q);
  const [bulkPub, setBulkPub] = useState(false);
  const seq = useRef(0);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Listing | null>(null);
  const [history, setHistory] = useState<Auction[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [form, setForm] = useState<FormState>(emptyForm);
  const canPrice = can("listings.set_pricing");

  // ── Ready-to-list queue (drafts that have been photographed + graded) ──────
  const [queue, setQueue] = useState<Item[] | null>(null); // null = drawer closed
  const [queueItem, setQueueItem] = useState<Item | null>(null);
  const [readyCount, setReadyCount] = useState(0);
  const [noPhotoCount, setNoPhotoCount] = useState(0);
  // Schedule is sticky between queue items — a batch usually shares one slot.
  const [sched, setSched] = useState(() => ({
    startsAt: toLocalInput(new Date(Date.now() + 3_600_000)),
    endsAt: toLocalInput(new Date(Date.now() + 3 * 24 * 3_600_000)),
  }));

  const loadReady = async (): Promise<Item[]> => {
    try {
      const r = await api.get<{ items: Item[] }>("/api/items?status=draft");
      const ready = r.items.filter((i) => i.photos.length > 0);
      setReadyCount(ready.length);
      setNoPhotoCount(r.items.length - ready.length);
      return ready;
    } catch {
      return [];
    }
  };

  useDebounced(qInput, (v) => setFilters((f) => (f.q === v ? f : { ...f, q: v })));
  useStoredFilters(FILTERS_KEY, filters);

  const sv = useSavedViews({
    screen: "listings",
    filters,
    defaults: DEFAULT_FILTERS,
    normalize: filterTools.normalize,
    same: filterTools.same,
    apply: (f) => {
      setQInput(f.q);
      setFilters(f);
    },
  });
  const selection = useSelection(listings);
  const { selected, setSelected, allSelected, toggleAll, toggleOne, selectedRows } = selection;
  const selectedDrafts = selectedRows.filter((l) => l.status === "draft");

  /** Mutation handlers call load() — it refreshes page 0 of the current filter. */
  const load = () => setRefreshTick((t) => t + 1);
  useEffect(() => {
    const s = ++seq.current;
    void api.get<ListResponse>(`/api/listings?${buildQuery(filters, PAGE, 0)}`).then((r) => {
      if (seq.current !== s) return;
      setListings(r.listings);
      setTotal(r.total);
      setStatusCounts(r.counts);
      setSelected(new Set());
      setBulkPub(false);
    }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, refreshTick]);
  useEffect(() => {
    void loadReady();
    void api.get<{ markets: Market[] }>("/api/markets").then((r) => setMarkets(r.markets)).catch(() => undefined);
  }, []);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const r = await api.get<ListResponse>(`/api/listings?${buildQuery(filters, PAGE, listings.length)}`);
      setListings((prev) => {
        const seen = new Set(prev.map((l) => l.id));
        return [...prev, ...r.listings.filter((l) => !seen.has(l.id))];
      });
      setTotal(r.total);
    } catch {
      toast("Failed to load more", "danger");
    } finally {
      setLoadingMore(false);
    }
  };

  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  const openCreate = async () => {
    try {
      const [draft, listed] = await Promise.all([
        api.get<{ items: Item[] }>("/api/items?status=draft"),
        api.get<{ items: Item[] }>("/api/items?status=listed"),
      ]);
      const eligible = [...draft.items, ...listed.items];
      setItems(eligible);
      setForm({ ...emptyForm, itemId: eligible[0]?.id ?? "", title: eligible[0]?.title ?? "" });
      setCreating(true);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Failed to load items", "danger");
    }
  };

  const submitCreate = async () => {
    const body: Record<string, unknown> = {
      itemId: form.itemId,
      type: form.type,
      title: form.title,
      description: form.description,
      marketCode: form.marketCode,
    };
    if (form.type === "auction") {
      body.startPriceCents = eurToCents(form.startPrice);
      if (canPrice && form.reserve) body.reserveCents = eurToCents(form.reserve);
    } else {
      body.priceCents = eurToCents(form.price);
    }
    if (form.antiSnipe) body.antiSnipeSec = Number(form.antiSnipe);
    try {
      await api.post("/api/listings", body);
      toast("Listing created", "ok");
      setCreating(false);
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Create failed", "danger");
    }
  };

  const openQueue = async () => {
    setQueueItem(null);
    setQueue(await loadReady());
  };

  const pickQueueItem = (it: Item) => {
    setQueueItem(it);
    setForm({
      ...emptyForm,
      itemId: it.id,
      type: form.type, // sticky — batches are usually all-auction or all-fixed
      title: it.title,
      description: it.description,
      marketCode: it.marketCode,
    });
  };

  const quickValid =
    queueItem !== null &&
    form.title.trim().length > 0 &&
    (form.type === "auction"
      ? eurToCents(form.startPrice) !== null && sched.startsAt !== "" && sched.endsAt !== "" && new Date(sched.endsAt) > new Date(sched.startsAt)
      : eurToCents(form.price) !== null);

  /** Create → publish → (auction) schedule, one click. A mid-chain failure
   * leaves an ordinary draft listing that can be finished by hand. */
  const submitQuick = async () => {
    if (!queueItem || !quickValid) return;
    const body: Record<string, unknown> = {
      itemId: queueItem.id,
      type: form.type,
      title: form.title,
      description: form.description,
      marketCode: queueItem.marketCode,
    };
    if (form.type === "auction") {
      body.startPriceCents = eurToCents(form.startPrice);
      if (canPrice && form.reserve) body.reserveCents = eurToCents(form.reserve);
    } else {
      body.priceCents = eurToCents(form.price);
    }
    if (form.antiSnipe) body.antiSnipeSec = Number(form.antiSnipe);
    try {
      const created = await api.post<{ listing: { id: string } }>("/api/listings", body);
      await api.post(`/api/listings/${created.listing.id}/publish`);
      if (form.type === "auction") {
        await api.post("/api/auctions", {
          listingId: created.listing.id,
          startsAt: new Date(sched.startsAt).toISOString(),
          endsAt: new Date(sched.endsAt).toISOString(),
        });
      }
      toast(`${queueItem.sku} published${form.type === "auction" ? " & scheduled" : ""}`, "ok");
      setQueue((q) => q?.filter((i) => i.id !== queueItem.id) ?? q);
      setQueueItem(null);
      load();
      void loadReady();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Listing failed — check Listings for a leftover draft", "danger");
    }
  };

  const openEdit = (l: Listing) => {
    setEditing(l);
    setHistory([]);
    setForm({
      itemId: l.itemId,
      type: l.type,
      title: l.title,
      description: l.description,
      marketCode: l.marketCode,
      startPrice: centsToEur(l.startPriceCents),
      price: centsToEur(l.priceCents),
      reserve: centsToEur(l.reserveCents),
      antiSnipe: l.antiSnipeSec == null ? "" : String(l.antiSnipeSec),
    });
    void api
      .get<{ auctions: Auction[] }>(`/api/listings/${l.id}`)
      .then((r) => setHistory(r.auctions))
      .catch(() => undefined);
  };

  const submitEdit = async () => {
    if (!editing) return;
    const body: Record<string, unknown> = {
      title: form.title,
      description: form.description,
    };
    if (canPrice) {
      if (form.type === "auction") {
        body.startPriceCents = eurToCents(form.startPrice);
        body.reserveCents = form.reserve ? eurToCents(form.reserve) : null;
      } else {
        body.priceCents = eurToCents(form.price);
      }
    }
    if (form.antiSnipe !== "") body.antiSnipeSec = Number(form.antiSnipe);
    try {
      await api.patch(`/api/listings/${editing.id}`, body);
      toast("Listing saved", "ok");
      setEditing(null);
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Save failed", "danger");
    }
  };

  const publish = async () => {
    if (!editing) return;
    try {
      await api.post(`/api/listings/${editing.id}/publish`);
      toast("Published — item is now listed", "ok");
      setEditing(null);
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Publish failed", "danger");
    }
  };

  const counts: Record<string, number> = {
    all: Object.values(statusCounts).reduce((a, n) => a + n, 0),
    draft: statusCounts.draft ?? 0,
    published: statusCounts.published ?? 0,
    archived: statusCounts.archived ?? 0,
  };

  const setF = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));
  const clearAll = () => {
    setQInput("");
    setFilters({ ...DEFAULT_FILTERS });
  };

  const chips: FilterChip[] = [];
  if (filters.status !== "all") chips.push({ key: "status", label: PILLS.find((p) => p.id === filters.status)?.label ?? filters.status, clear: () => setF({ status: "all" }) });
  if (filters.type !== "all") chips.push({ key: "type", label: `Type: ${filters.type}`, clear: () => setF({ type: "all" }) });
  if (filters.market !== "all") chips.push({ key: "market", label: `Market: ${filters.market}`, clear: () => setF({ market: "all" }) });
  if (filters.from) chips.push({ key: "from", label: `From ${filters.from}`, clear: () => setF({ from: "" }) });
  if (filters.to) chips.push({ key: "to", label: `To ${filters.to}`, clear: () => setF({ to: "" }) });
  if (filters.sort !== "newest") chips.push({ key: "sort", label: SORTS.find((s) => s.value === filters.sort)?.label ?? filters.sort, clear: () => setF({ sort: "newest" }) });
  if (filters.q.trim()) chips.push({ key: "q", label: `"${filters.q.trim()}"`, clear: () => { setQInput(""); setF({ q: "" }); } });

  // ── Export ─────────────────────────────────────────────────────────────────

  const toExportRow = (l: Listing): string[] => [
    l.title,
    l.type,
    l.itemSku ?? "",
    l.itemStatus ?? "",
    l.type === "auction" ? centsToEur(l.startPriceCents) : centsToEur(l.priceCents),
    centsToEur(l.reserveCents),
    l.marketCode,
    l.status,
    l.createdAt.slice(0, 10),
  ];

  const gatherExportRows = async (): Promise<Listing[]> => {
    if (selectedRows.length > 0) return selectedRows;
    const out: Listing[] = [];
    for (;;) {
      const r = await api.get<ListResponse>(`/api/listings?${buildQuery(filters, EXPORT_PAGE, out.length)}`);
      out.push(...r.listings);
      if (r.listings.length === 0 || out.length >= r.total) break;
    }
    return out;
  };

  const runExport = async (fmt: "csv" | "xls" | "pdf") => {
    try {
      const list = await gatherExportRows();
      if (list.length === 0) return toast("Nothing to export", "warn");
      const body = list.map(toExportRow);
      if (fmt === "csv") exportCSV("listings", EXPORT_HEADERS, body);
      else if (fmt === "xls") exportXLS("listings", EXPORT_HEADERS, body, "Listings");
      else exportPDFPrint("Listings export", EXPORT_HEADERS, body);
      toast(`Exported ${list.length} listings`, "ok");
    } catch {
      toast("Export failed", "danger");
    }
  };

  // ── Bulk publish (with optional schedule) + bulk archive ──────────────────

  const bulkPublish = async (withSchedule: boolean) => {
    try {
      const r = await api.post<{ published: number; scheduled: number; failed: Array<{ id: string; error: string }> }>(
        "/api/listings/bulk/publish",
        {
          ids: selectedDrafts.map((l) => l.id),
          ...(withSchedule
            ? { schedule: { startsAt: new Date(sched.startsAt).toISOString(), endsAt: new Date(sched.endsAt).toISOString() } }
            : {}),
        },
      );
      const msg = `${r.published} published${r.scheduled > 0 ? `, ${r.scheduled} auctions scheduled` : ""}${r.failed.length > 0 ? ` · ${r.failed.length} failed` : ""}`;
      toast(msg, r.failed.length > 0 ? "warn" : "ok");
      setBulkPub(false);
      load();
      void loadReady();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Bulk publish failed", "danger");
    }
  };

  const bulkArchive = async () => {
    const r = await confirm({
      title: `Archive ${selectedDrafts.length} draft listing${selectedDrafts.length === 1 ? "" : "s"}?`,
      body: "Only drafts are archived — published listings are skipped. The items stay in stock.",
      confirmLabel: "Archive drafts",
    });
    if (!r.ok) return;
    try {
      const res = await api.post<{ archived: number; skipped: number }>("/api/listings/bulk/archive", {
        ids: selectedDrafts.map((l) => l.id),
      });
      toast(`${res.archived} archived${res.skipped > 0 ? ` · ${res.skipped} skipped` : ""}`, "ok");
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Bulk archive failed", "danger");
    }
  };

  const exportCount = selected.size > 0 ? selected.size : total;

  const priceFields = (
    <>
      {form.type === "auction" ? (
        <>
          <AField label="Start price €">
            <AInput value={form.startPrice} onChange={(v) => set({ startPrice: v })} placeholder="100.00" />
          </AField>
          {canPrice && (
            <AField label="Reserve €" hint="Hidden from bidders — “reserve not met” is all they see.">
              <AInput value={form.reserve} onChange={(v) => set({ reserve: v })} placeholder="none" />
            </AField>
          )}
        </>
      ) : (
        <AField label="Price €">
          <AInput value={form.price} onChange={(v) => set({ price: v })} placeholder="220.00" />
        </AField>
      )}
      <AField label="Anti-snipe override (seconds)" hint="Empty = market default (60s).">
        <AInput value={form.antiSnipe} onChange={(v) => set({ antiSnipe: v })} placeholder="60" />
      </AField>
    </>
  );

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <h1 style={{ fontFamily: AT.body, fontSize: 20, fontWeight: 700, color: AT.ink, flex: 1 }}>Listings</h1>
        <ExportMenu count={exportCount} scope={selected.size > 0 ? "selected" : "filtered"} noun="listings" onPick={(fmt) => void runExport(fmt)} />
        {can("listings.create") && can("listings.publish") && (
          <ABtn kind={readyCount > 0 ? "dark" : "ghost"} onClick={() => void openQueue()}>
            Ready to list{readyCount > 0 ? ` (${readyCount})` : ""}
          </ABtn>
        )}
        {can("listings.create") && (
          <ABtn onClick={() => void openCreate()}>
            <AIcon name="plus" size={15} color="#fff" /> New listing
          </ABtn>
        )}
      </div>

      <ViewsBar {...sv.ViewsBarProps} />

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <AStat label="Draft" value={counts.draft ?? 0} />
        <AStat label="Published" value={counts.published ?? 0} tone={(counts.published ?? 0) > 0 ? "ok" : undefined} />
        <AStat label="Ready to list" value={readyCount} tone={readyCount > 0 ? "accent" : undefined} sub={noPhotoCount > 0 ? `${noPhotoCount} drafts still need photos` : undefined} />
        <AStat label="Archived" value={counts.archived ?? 0} />
      </div>

      <APills options={PILLS.map((p) => ({ id: p.id, label: p.label, count: counts[p.id] ?? 0 }))} value={filters.status} onChange={(v) => setF({ status: v })} />

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <SearchBox value={qInput} onChange={setQInput} placeholder="Search title or SKU…" />
        <ASelect
          value={filters.type}
          onChange={(v) => setF({ type: v })}
          options={[{ value: "all", label: "All types" }, { value: "auction", label: "Auction" }, { value: "fixed", label: "Fixed price" }]}
        />
        <ASelect
          value={filters.market}
          onChange={(v) => setF({ market: v })}
          options={[{ value: "all", label: "All markets" }, ...markets.map((m) => ({ value: m.code, label: m.code }))]}
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
        {listings.length === 0 ? (
          <AEmpty text="No listings match these filters." />
        ) : (
          <>
            <ATable head={[
              <input key="all" type="checkbox" checked={allSelected} onChange={toggleAll} style={checkboxStyle} aria-label="Select all visible listings" />,
              "Title", "Type", "Item", "Price", "Reserve", "Market", "Created", "Status",
            ]}>
              {listings.map((l) => (
                <ATr key={l.id} onClick={() => openEdit(l)} active={selected.has(l.id)}>
                  <ATd style={{ width: 34 }}>
                    <input
                      type="checkbox"
                      checked={selected.has(l.id)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => toggleOne(l.id)}
                      style={checkboxStyle}
                      aria-label={`Select ${l.title}`}
                    />
                  </ATd>
                  <ATd><span style={{ fontWeight: 600 }}>{l.title}</span></ATd>
                  <ATd><ABadge tone={l.type === "auction" ? "accent" : "neutral"}>{l.type}</ABadge></ATd>
                  <ATd>
                    <div style={{ fontFamily: AT.mono, fontSize: 11.5 }}>{l.itemSku}</div>
                    {l.itemStatus && (
                      <ABadge tone={ITEM_STATUS_TONE[l.itemStatus]?.tone ?? "neutral"}>
                        {ITEM_STATUS_TONE[l.itemStatus]?.label ?? l.itemStatus}
                      </ABadge>
                    )}
                  </ATd>
                  <ATd mono right>{l.type === "auction" ? (l.startPriceCents != null ? formatEur(l.startPriceCents) : "—") : l.priceCents != null ? formatEur(l.priceCents) : "—"}</ATd>
                  <ATd mono right>{l.reserveCents != null ? formatEur(l.reserveCents) : "—"}</ATd>
                  <ATd>{l.marketCode}</ATd>
                  <ATd>{formatDay(l.createdAt)}</ATd>
                  <ATd><ABadge tone={l.status === "published" ? "ok" : "neutral"}>{l.status}</ABadge></ATd>
                </ATr>
              ))}
            </ATable>
            {listings.length < total && (
              <div style={{ padding: 12, display: "flex", justifyContent: "center", borderTop: `1px solid ${AT.ruleSoft}` }}>
                <ABtn kind="ghost" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
                  {loadingMore ? "Loading…" : `Load more (${listings.length} of ${total})`}
                </ABtn>
              </div>
            )}
          </>
        )}
      </ACard>

      <BulkBar count={selected.size} onClear={() => { setSelected(new Set()); setBulkPub(false); }}>
        {can("listings.publish") && selectedDrafts.length > 0 && (
          <>
            <span style={bulkDividerStyle} />
            <BulkBtn onClick={() => setBulkPub((v) => !v)}>Publish… ({selectedDrafts.length})</BulkBtn>
          </>
        )}
        {can("listings.edit") && selectedDrafts.length > 0 && (
          <>
            <span style={bulkDividerStyle} />
            <BulkBtn onClick={() => void bulkArchive()}>Archive ({selectedDrafts.length})</BulkBtn>
          </>
        )}
        <span style={bulkDividerStyle} />
        <BulkBtn onClick={() => void runExport("csv")}>Export CSV</BulkBtn>
      </BulkBar>

      {/* Bulk publish dialog — publish now or publish + schedule the auctions. */}
      {bulkPub && selectedDrafts.length > 0 && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 80, display: "grid", placeItems: "center", background: "rgba(10,10,10,0.4)" }}
          onClick={() => setBulkPub(false)}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ width: 460, maxWidth: "92vw", background: AT.panel, borderRadius: AT.radius, padding: 20, display: "grid", gap: 12 }}>
            <h2 style={{ fontFamily: AT.body, fontSize: 15.5, fontWeight: 700, color: AT.ink }}>
              Publish {selectedDrafts.length} draft{selectedDrafts.length === 1 ? "" : "s"}?
            </h2>
            <p style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft, lineHeight: 1.5 }}>
              Items go to "listed". Optionally schedule an auction run for the auction-type listings — fixed-price listings just go live.
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <AField label="Auction starts">
                <input type="datetime-local" value={sched.startsAt} onChange={(e) => setSched((x) => ({ ...x, startsAt: e.target.value }))} style={{ ...dateInputStyle, width: "100%", height: 36 }} />
              </AField>
              <AField label="Auction ends">
                <input type="datetime-local" value={sched.endsAt} min={sched.startsAt} onChange={(e) => setSched((x) => ({ ...x, endsAt: e.target.value }))} style={{ ...dateInputStyle, width: "100%", height: 36 }} />
              </AField>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <ABtn kind="ghost" onClick={() => setBulkPub(false)}>Cancel</ABtn>
              <ABtn kind="ghost" onClick={() => void bulkPublish(false)}>Publish only</ABtn>
              <ABtn onClick={() => void bulkPublish(true)} disabled={new Date(sched.endsAt) <= new Date(sched.startsAt)}>
                Publish + schedule
              </ABtn>
            </div>
          </div>
        </div>
      )}

      {queue !== null && (
        <ADrawer
          title={queueItem ? (
            <span>List <span style={{ fontFamily: AT.mono, fontSize: 12, color: AT.inkSoft }}>{queueItem.sku}</span></span>
          ) : `Ready to list (${queue.length})`}
          onClose={() => { setQueue(null); setQueueItem(null); }}
          footer={
            queueItem ? (
              <>
                <ABtn kind="ghost" onClick={() => setQueueItem(null)}>← Back to queue</ABtn>
                <ABtn onClick={() => void submitQuick()} disabled={!quickValid}>
                  {form.type === "auction" ? "Publish & schedule" : "Publish"}
                </ABtn>
              </>
            ) : (
              <ABtn kind="ghost" onClick={() => setQueue(null)}>Close</ABtn>
            )
          }
        >
          {queueItem ? (
            <div style={{ display: "grid", gap: 14 }}>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                {queueItem.photos[0] && (
                  <img src={thumbOf(queueItem.photos[0])} alt="" style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 8, border: `1px solid ${AT.rule}` }} />
                )}
                <div style={{ fontSize: 12.5, color: AT.inkSoft }}>
                  {conditionByCode(queueItem.condition)?.label ?? queueItem.condition}
                  {queueItem.conditionNotes ? ` — ${queueItem.conditionNotes}` : ""} · {queueItem.photos.length} photo{queueItem.photos.length === 1 ? "" : "s"} · {queueItem.marketCode}
                </div>
              </div>
              <AField label="Type">
                <ASelect value={form.type} onChange={(v) => set({ type: v as "auction" | "fixed" })} options={[{ value: "auction", label: "Auction" }, { value: "fixed", label: "Fixed price" }]} />
              </AField>
              <AField label="Title"><AInput value={form.title} onChange={(v) => set({ title: v })} /></AField>
              <AField label="Description" hint="Copied from the item — polish the selling copy here.">
                <textarea value={form.description} onChange={(e) => set({ description: e.target.value })} rows={4} style={{
                  width: "100%", borderRadius: AT.radiusSm, border: `1px solid ${AT.rule}`, fontFamily: AT.body,
                  fontSize: 13, color: AT.ink, padding: 10, resize: "vertical",
                }} />
              </AField>
              {priceFields}
              {form.type === "auction" && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <AField label="Starts" hint="Sticky for the whole batch.">
                    <input type="datetime-local" value={sched.startsAt} onChange={(e) => setSched({ ...sched, startsAt: e.target.value })} style={{
                      width: "100%", height: 36, borderRadius: AT.radiusSm, border: `1px solid ${AT.rule}`, fontFamily: AT.body, fontSize: 13, color: AT.ink, padding: "0 10px", boxSizing: "border-box",
                    }} />
                  </AField>
                  <AField label="Ends">
                    <input type="datetime-local" value={sched.endsAt} onChange={(e) => setSched({ ...sched, endsAt: e.target.value })} style={{
                      width: "100%", height: 36, borderRadius: AT.radiusSm, border: `1px solid ${AT.rule}`, fontFamily: AT.body, fontSize: 13, color: AT.ink, padding: "0 10px", boxSizing: "border-box",
                    }} />
                  </AField>
                </div>
              )}
            </div>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              <div style={{ fontSize: 12.5, color: AT.inkSoft }}>
                Draft items with photos and a grade — one click from published.
                {noPhotoCount > 0 && <> <b>{noPhotoCount}</b> more draft{noPhotoCount === 1 ? "" : "s"} still need photos (shoot them in warehouse mode).</>}
              </div>
              {queue.length === 0 && <AEmpty text="Nothing ready — receive and photograph items first." />}
              {queue.map((it) => (
                <button key={it.id} onClick={() => pickQueueItem(it)} style={{
                  all: "unset", cursor: "pointer", display: "flex", gap: 10, alignItems: "center",
                  border: `1px solid ${AT.rule}`, borderRadius: 10, padding: 10, background: AT.panel,
                }}>
                  {it.photos[0] ? (
                    <img src={thumbOf(it.photos[0])} alt="" style={{ width: 46, height: 46, objectFit: "cover", borderRadius: 7 }} />
                  ) : (
                    <div style={{ width: 46, height: 46, borderRadius: 7, background: AT.surfaceAlt }} />
                  )}
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontFamily: AT.mono, fontSize: 11.5, color: AT.inkSoft }}>{it.sku}</div>
                    <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.title}</div>
                  </div>
                  <ABadge tone="neutral">{conditionByCode(it.condition)?.label ?? it.condition}</ABadge>
                </button>
              ))}
            </div>
          )}
        </ADrawer>
      )}

      {creating && (
        <ADrawer
          title="New listing"
          onClose={() => setCreating(false)}
          footer={
            <>
              <ABtn kind="ghost" onClick={() => setCreating(false)}>Cancel</ABtn>
              <ABtn onClick={() => void submitCreate()} disabled={!form.itemId || !form.title || (form.type === "auction" ? !form.startPrice : !form.price)}>Create</ABtn>
            </>
          }
        >
          <div style={{ display: "grid", gap: 14 }}>
            {items.length === 0 ? (
              <div style={{ fontFamily: AT.body, fontSize: 13, color: AT.inkSoft }}>
                No draft or listed items available. Add one under Inventory first.
              </div>
            ) : (
              <AField label="Item">
                <ASelect
                  value={form.itemId}
                  onChange={(v) => {
                    const it = items.find((i) => i.id === v);
                    set({ itemId: v, title: it?.title ?? form.title });
                  }}
                  options={items.map((i) => ({ value: i.id, label: `${i.sku} — ${i.title}` }))}
                />
              </AField>
            )}
            <AField label="Type">
              <ASelect value={form.type} onChange={(v) => set({ type: v as "auction" | "fixed" })} options={[{ value: "auction", label: "Auction" }, { value: "fixed", label: "Fixed price" }]} />
            </AField>
            <AField label="Title"><AInput value={form.title} onChange={(v) => set({ title: v })} /></AField>
            <AField label="Description">
              <textarea value={form.description} onChange={(e) => set({ description: e.target.value })} rows={4} style={{
                width: "100%", borderRadius: AT.radiusSm, border: `1px solid ${AT.rule}`, fontFamily: AT.body,
                fontSize: 13, color: AT.ink, padding: 10, resize: "vertical",
              }} />
            </AField>
            <AField label="Market">
              <ASelect value={form.marketCode} onChange={(v) => set({ marketCode: v })} options={markets.map((m) => ({ value: m.code, label: `${m.name} (${m.code})` }))} />
            </AField>
            {priceFields}
          </div>
        </ADrawer>
      )}

      {editing && (
        <ADrawer
          title={<span>Edit listing <span style={{ fontFamily: AT.mono, fontSize: 12, color: AT.inkSoft }}>{editing.itemSku}</span></span>}
          onClose={() => setEditing(null)}
          footer={
            <>
              {editing.status === "draft" && can("listings.publish") && (
                <ABtn kind="dark" onClick={() => void publish()}>Publish</ABtn>
              )}
              <ABtn kind="ghost" onClick={() => setEditing(null)}>Close</ABtn>
              {can("listings.edit") && <ABtn onClick={() => void submitEdit()}>Save</ABtn>}
            </>
          }
        >
          <div style={{ display: "grid", gap: 14 }}>
            <AField label="Title"><AInput value={form.title} onChange={(v) => set({ title: v })} /></AField>
            <AField label="Description">
              <textarea value={form.description} onChange={(e) => set({ description: e.target.value })} rows={4} style={{
                width: "100%", borderRadius: AT.radiusSm, border: `1px solid ${AT.rule}`, fontFamily: AT.body,
                fontSize: 13, color: AT.ink, padding: 10, resize: "vertical",
              }} />
            </AField>
            {!canPrice && (
              <div style={{ fontFamily: AT.body, fontSize: 12, color: AT.inkSoft, background: AT.surfaceAlt, borderRadius: 8, padding: "8px 10px" }}>
                Pricing fields need the Sales Manager permission (listings.set_pricing).
              </div>
            )}
            {canPrice && priceFields}
            {editing.status === "published" && editing.type === "auction" && (
              <div style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft }}>
                Ready to run? <button onClick={() => nav.go("auctions")} style={{ all: "unset", cursor: "pointer", color: AT.accent, fontWeight: 600 }}>Schedule an auction →</button>
              </div>
            )}
            {history.length > 0 && (
              <ACard title="Auction history" pad={false}>
                <ATable head={["Status", "Price", "Ends"]}>
                  {history.map((a) => (
                    <ATr key={a.id} onClick={() => nav.go("auctions", a.id)}>
                      <ATd><ABadge tone={AUCTION_STATUS_TONE[a.status]?.tone ?? "neutral"}>{AUCTION_STATUS_TONE[a.status]?.label ?? a.status}</ABadge></ATd>
                      <ATd mono right>{a.currentPriceCents != null ? formatEur(a.currentPriceCents) : "—"}</ATd>
                      <ATd>{formatDate(a.endsAt)}</ATd>
                    </ATr>
                  ))}
                </ATable>
              </ACard>
            )}
          </div>
        </ADrawer>
      )}
    </div>
  );
}
