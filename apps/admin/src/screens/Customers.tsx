import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Customer, type Order } from "../api.js";
import type { Nav } from "../App.js";
import { useAuth } from "../auth.js";
import { exportCSV, exportPDFPrint, exportXLS } from "../exporters.js";
import { formatDay, formatEur } from "../format.js";
import {
  BulkBar, BulkBtn, bulkDividerStyle, checkboxStyle, dateInputStyle, ExportMenu, FilterChips,
  makeFilterTools, SearchBox, TagChip, useDebounced, useSavedViews, useSelection, useStoredFilters,
  ViewsBar, type FilterChip, type TagDef,
} from "../powerkit.js";
import { AT, ORDER_STATUS_TONE } from "../theme.js";
import {
  AAvatar, ABadge, ABtn, ACard, ADrawer, AEmpty, AField, AIcon, AInput,
  ATable, ATd, ATr, ASelect, useConfirm, useToast,
} from "../ui.js";

interface CustomerFee {
  id: string;
  orderRef: string;
  type: "unpaid_restock" | "no_pickup_restock";
  amountCents: number;
  status: "outstanding" | "settled" | "waived";
  note: string;
  createdAt: string;
}

interface CustomerDetail {
  customer: Customer;
  orders: Order[];
  bidStats: { totalBids: number; auctionsBidOn: number };
  fees: CustomerFee[];
  outstandingFeeCents: number;
}

interface ListResponse {
  customers: Customer[];
  total: number;
  counts: { all: number; active: number; blocked: number; erased: number; strikes: number };
}

const COUNTRIES = [
  { value: "LV", label: "Latvia" },
  { value: "EE", label: "Estonia" },
  { value: "LT", label: "Lithuania" },
  { value: "", label: "Other" },
];

// ── A3 power filters ─────────────────────────────────────────────────────────

interface Filters {
  status: string;
  tag: string;
  country: string;
  debt: string;
  from: string;
  to: string;
  sort: string;
  q: string;
}

const DEFAULT_FILTERS: Filters = { status: "all", tag: "all", country: "all", debt: "any", from: "", to: "", sort: "newest", q: "" };
const filterTools = makeFilterTools(DEFAULT_FILTERS);
const FILTERS_KEY = "customersFilters.v1";
const PAGE = 50;
const EXPORT_PAGE = 200;

const STATUS_PILLS = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "blocked", label: "Blocked" },
  { id: "strikes", label: "Strikes" },
  { id: "erased", label: "Erased" },
] as const;

const SORTS = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "alias", label: "Alias A→Z" },
  { value: "strikes", label: "Most strikes" },
];

function buildQuery(f: Filters, limit: number, offset: number): string {
  const p = new URLSearchParams();
  if (f.status !== "all") p.set("status", f.status);
  if (f.tag !== "all") p.set("tag", f.tag);
  if (f.country !== "all") p.set("country", f.country);
  if (f.debt !== "any") p.set("debt", f.debt);
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.sort !== "newest") p.set("sort", f.sort);
  if (f.q.trim().length >= 2) p.set("q", f.q.trim());
  p.set("limit", String(limit));
  p.set("offset", String(offset));
  return p.toString();
}

const EXPORT_HEADERS = ["Alias", "Email", "Name", "Country", "Tags", "Strikes", "Fees due €", "Status", "Joined"];

export function CustomersScreen({ nav: _nav }: { nav: Nav }) {
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [filters, setFilters] = useState<Filters>(() => filterTools.loadStored(FILTERS_KEY));
  const [qInput, setQInput] = useState(filters.q);
  const [rows, setRows] = useState<Customer[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<ListResponse["counts"] | null>(null);
  const [tagDefs, setTagDefs] = useState<TagDef[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [bulkTagMode, setBulkTagMode] = useState<"add" | "remove" | null>(null);
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [form, setForm] = useState({ email: "", alias: "", name: "", country: "LV", company: "", vatNo: "" });
  const [edit, setEdit] = useState({ alias: "", name: "", notes: "" });
  const seq = useRef(0);

  useDebounced(qInput, (v) => setFilters((f) => (f.q === v ? f : { ...f, q: v })));
  useStoredFilters(FILTERS_KEY, filters);

  const sv = useSavedViews({
    screen: "customers",
    filters,
    defaults: DEFAULT_FILTERS,
    normalize: filterTools.normalize,
    same: filterTools.same,
    apply: (f) => {
      setQInput(f.q);
      setFilters(f);
    },
    noun: "segment",
  });
  const selection = useSelection(rows);
  const { selected, setSelected, allSelected, toggleAll, toggleOne, selectedRows } = selection;

  useEffect(() => {
    void api.get<{ tags: TagDef[] }>("/api/customer-tags").then((r) => setTagDefs(r.tags)).catch(() => undefined);
  }, []);
  const tagById = new Map(tagDefs.map((t) => [t.id, t]));
  const activeTagDefs = tagDefs.filter((t) => t.active);

  useEffect(() => {
    const s = ++seq.current;
    void api
      .get<ListResponse>(`/api/customers?${buildQuery(filters, PAGE, 0)}`)
      .then((r) => {
        if (seq.current !== s) return;
        setRows(r.customers);
        setTotal(r.total);
        setCounts(r.counts);
        setSelected(new Set());
        setBulkTagMode(null);
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, refreshTick]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const r = await api.get<ListResponse>(`/api/customers?${buildQuery(filters, PAGE, rows.length)}`);
      setRows((prev) => {
        const seen = new Set(prev.map((c) => c.id));
        return [...prev, ...r.customers.filter((c) => !seen.has(c.id))];
      });
      setTotal(r.total);
    } catch {
      toast("Failed to load more", "danger");
    } finally {
      setLoadingMore(false);
    }
  };

  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));
  const clearAll = () => {
    setQInput("");
    setFilters({ ...DEFAULT_FILTERS });
  };

  const chips: FilterChip[] = [];
  if (filters.status !== "all") chips.push({ key: "status", label: STATUS_PILLS.find((p) => p.id === filters.status)?.label ?? filters.status, clear: () => set({ status: "all" }) });
  if (filters.tag !== "all") chips.push({ key: "tag", label: `Tag: ${tagById.get(filters.tag)?.name ?? "?"}`, clear: () => set({ tag: "all" }) });
  if (filters.country !== "all") chips.push({ key: "country", label: `Country: ${filters.country || "Other"}`, clear: () => set({ country: "all" }) });
  if (filters.debt !== "any") chips.push({ key: "debt", label: "Has outstanding fees", clear: () => set({ debt: "any" }) });
  if (filters.from) chips.push({ key: "from", label: `From ${filters.from}`, clear: () => set({ from: "" }) });
  if (filters.to) chips.push({ key: "to", label: `To ${filters.to}`, clear: () => set({ to: "" }) });
  if (filters.sort !== "newest") chips.push({ key: "sort", label: SORTS.find((s) => s.value === filters.sort)?.label ?? filters.sort, clear: () => set({ sort: "newest" }) });
  if (filters.q.trim()) chips.push({ key: "q", label: `"${filters.q.trim()}"`, clear: () => { setQInput(""); set({ q: "" }); } });

  // ── Export ────────────────────────────────────────────────────────────────

  const toExportRow = (c: Customer): string[] => [
    c.alias,
    c.email,
    c.name ?? "",
    c.country ?? "",
    c.tags.map((t) => tagById.get(t)?.name ?? "").filter(Boolean).join("; "),
    String(c.strikes),
    ((c.outstandingFeeCents ?? 0) / 100).toFixed(2),
    c.erasedAt ? "erased" : c.blocked ? "blocked" : "active",
    c.createdAt.slice(0, 10),
  ];

  const gatherExportRows = async (): Promise<Customer[]> => {
    if (selectedRows.length > 0) return selectedRows;
    const out: Customer[] = [];
    for (;;) {
      const r = await api.get<ListResponse>(`/api/customers?${buildQuery(filters, EXPORT_PAGE, out.length)}`);
      out.push(...r.customers);
      if (r.customers.length === 0 || out.length >= r.total) break;
    }
    return out;
  };

  const runExport = async (fmt: "csv" | "xls" | "pdf") => {
    try {
      const list = await gatherExportRows();
      if (list.length === 0) return toast("Nothing to export", "warn");
      const body = list.map(toExportRow);
      if (fmt === "csv") exportCSV("bidders", EXPORT_HEADERS, body);
      else if (fmt === "xls") exportXLS("bidders", EXPORT_HEADERS, body, "Bidders");
      else exportPDFPrint("Bidders export", EXPORT_HEADERS, body);
      toast(`Exported ${list.length} bidders`, "ok");
    } catch {
      toast("Export failed", "danger");
    }
  };

  // ── Bulk tagging ──────────────────────────────────────────────────────────

  const bulkTag = async (tagId: string, mode: "add" | "remove") => {
    try {
      const r = await api.post<{ updated: number }>("/api/customers/bulk/tags", {
        ids: selectedRows.map((c) => c.id),
        ...(mode === "add" ? { add: [tagId] } : { remove: [tagId] }),
      });
      toast(`${r.updated} bidder${r.updated === 1 ? "" : "s"} updated`, "ok");
      setBulkTagMode(null);
      setRefreshTick((t) => t + 1);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Tagging failed", "danger");
    }
  };

  // ── Drawer data + actions (unchanged flows) ───────────────────────────────

  const openDetail = (id: string) => {
    void api.get<CustomerDetail>(`/api/customers/${id}`).then((d) => {
      setDetail(d);
      setEdit({ alias: d.customer.alias, name: d.customer.name ?? "", notes: d.customer.notes });
    }).catch(() => undefined);
  };

  const reload = () => setRefreshTick((t) => t + 1);

  const create = async () => {
    try {
      await api.post("/api/customers", {
        email: form.email,
        alias: form.alias,
        name: form.name || null,
        country: form.country || null,
        marketCode: form.country || null,
        company: form.company || null,
        vatNo: form.vatNo || null,
      });
      toast("Bidder created", "ok");
      setCreating(false);
      reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Create failed", "danger");
    }
  };

  const save = async () => {
    if (!detail) return;
    try {
      await api.patch(`/api/customers/${detail.customer.id}`, { alias: edit.alias, name: edit.name || null, notes: edit.notes });
      toast("Bidder saved", "ok");
      openDetail(detail.customer.id);
      reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Save failed", "danger");
    }
  };

  const toggleTag = async (tagId: string) => {
    if (!detail) return;
    const next = new Set(detail.customer.tags);
    if (next.has(tagId)) next.delete(tagId);
    else next.add(tagId);
    try {
      await api.post(`/api/customers/${detail.customer.id}/tags`, { tagIds: [...next] });
      setDetail({ ...detail, customer: { ...detail.customer, tags: [...next] } });
      reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Tag update failed", "danger");
    }
  };

  const viesCheck = async () => {
    if (!detail) return;
    try {
      const r = await api.post<{ vies: { valid: boolean; consult: string } }>(`/api/customers/${detail.customer.id}/vies-check`);
      toast(r.vies.valid ? `VIES: valid · consultation ${r.vies.consult}` : "VIES: number could NOT be validated — do not zero-rate", r.vies.valid ? "ok" : "danger");
      openDetail(detail.customer.id);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "VIES check failed", "danger");
    }
  };

  const feeAction = async (fee: CustomerFee, action: "settle" | "waive") => {
    if (!detail) return;
    let note = "";
    if (action === "waive") {
      const r = await confirm({
        title: `Waive ${formatEur(fee.amountCents)} for ${fee.orderRef}?`,
        body: "The claim is dropped and the account unblocks. Reason goes to the audit log.",
        requireReason: true,
        confirmLabel: "Waive fee",
      });
      if (!r.ok) return;
      note = r.reason ?? "";
    }
    try {
      await api.post(`/api/customers/${detail.customer.id}/fees/${fee.id}/${action}`, { note });
      toast(action === "settle" ? "Fee settled — account unblocked" : "Fee waived", "ok");
      openDetail(detail.customer.id);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Action failed", "danger");
    }
  };

  /** Zero-tolerance suspension — always via the audited block endpoint. */
  const ban = async () => {
    if (!detail) return;
    const r = await confirm({
      title: `Suspend ${detail.customer.alias}?`,
      body: "The account can no longer sign in to bid or buy. Use for zero-tolerance behaviour (threats, verbal abuse, aggression towards staff) or repeated strikes. The reason goes to the audit log.",
      danger: true,
      requireReason: true,
      confirmLabel: "Suspend account",
    });
    if (!r.ok) return;
    try {
      await api.post(`/api/customers/${detail.customer.id}/block`, { reason: r.reason });
      toast("Account suspended", "ok");
      openDetail(detail.customer.id);
      reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Failed", "danger");
    }
  };

  const unban = async () => {
    if (!detail) return;
    const r = await confirm({
      title: `Reinstate ${detail.customer.alias}?`,
      body: "The account can bid and buy again (outstanding restock fees still pause bidding until settled). The reason goes to the audit log.",
      requireReason: true,
      confirmLabel: "Reinstate",
    });
    if (!r.ok) return;
    try {
      await api.post(`/api/customers/${detail.customer.id}/unblock`, { reason: r.reason });
      toast("Account reinstated", "ok");
      openDetail(detail.customer.id);
      reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Failed", "danger");
    }
  };

  const strike = async () => {
    if (!detail) return;
    const r = await confirm({
      title: `Add a strike to ${detail.customer.alias}?`,
      body: "Strikes track unpaid-winner behaviour. Repeated strikes usually mean blocking the account.",
      requireReason: true,
      confirmLabel: "Add strike",
    });
    if (!r.ok) return;
    try {
      await api.post(`/api/customers/${detail.customer.id}/strike`, { reason: r.reason });
      toast("Strike added", "ok");
      openDetail(detail.customer.id);
      reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Failed", "danger");
    }
  };

  const erase = async () => {
    if (!detail) return;
    const r = await confirm({
      title: `GDPR-erase ${detail.customer.alias}?`,
      body: "Personal data (name, company, VAT number, email) is permanently removed and the account blocked. Past orders keep their anonymised snapshots for accounting. This cannot be undone.",
      danger: true,
      typeToConfirm: detail.customer.alias,
      requireReason: true,
      confirmLabel: "Erase",
    });
    if (!r.ok) return;
    try {
      await api.post(`/api/customers/${detail.customer.id}/erase`);
      toast("Personal data erased", "ok");
      setDetail(null);
      reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Erase failed", "danger");
    }
  };

  const exportCount = selected.size > 0 ? selected.size : total;

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <h1 style={{ fontFamily: AT.body, fontSize: 20, fontWeight: 700, color: AT.ink, flex: 1 }}>Bidders</h1>
        <ExportMenu count={exportCount} scope={selected.size > 0 ? "selected" : "filtered"} noun="bidders" onPick={(fmt) => void runExport(fmt)} />
        {can("customers.edit") && (
          <ABtn onClick={() => { setForm({ email: "", alias: "", name: "", country: "LV", company: "", vatNo: "" }); setCreating(true); }}>
            <AIcon name="plus" size={15} color="#fff" /> New bidder
          </ABtn>
        )}
      </div>

      <ViewsBar {...sv.ViewsBarProps} label="Segments" saveLabel="+ Save segment" />

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
              <span style={{ marginLeft: 6, opacity: 0.6, fontWeight: 700, fontSize: 11 }}>{counts?.[p.id] ?? 0}</span>
            </button>
          );
        })}
      </div>

      {/* Filter bar */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <SearchBox value={qInput} onChange={setQInput} placeholder="Search alias, email or name…" />
        <ASelect
          value={filters.tag}
          onChange={(v) => set({ tag: v })}
          options={[{ value: "all", label: "All tags" }, ...tagDefs.map((t) => ({ value: t.id, label: t.name }))]}
        />
        <ASelect
          value={filters.country}
          onChange={(v) => set({ country: v })}
          options={[{ value: "all", label: "All countries" }, ...COUNTRIES.map((c) => ({ value: c.value, label: c.label }))]}
        />
        <ASelect
          value={filters.debt}
          onChange={(v) => set({ debt: v })}
          options={[{ value: "any", label: "Any balance" }, { value: "has", label: "Has outstanding fees" }]}
        />
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft }}>
          <input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => set({ from: e.target.value })} style={dateInputStyle} />
          –
          <input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => set({ to: e.target.value })} style={dateInputStyle} />
        </label>
        <ASelect value={filters.sort} onChange={(v) => set({ sort: v })} options={SORTS} />
      </div>

      <FilterChips chips={chips} onClearAll={clearAll} />

      <ACard pad={false}>
        {rows.length === 0 ? (
          <AEmpty text="No bidders match these filters." />
        ) : (
          <>
            <ATable head={[
              <input key="all" type="checkbox" checked={allSelected} onChange={toggleAll} style={checkboxStyle} aria-label="Select all visible bidders" />,
              "Bidder", "Tags", "Country", "Strikes", "Fees due", "Status", "Joined",
            ]}>
              {rows.map((c) => {
                const erased = c.erasedAt !== null;
                return (
                  <ATr key={c.id} onClick={() => openDetail(c.id)} active={selected.has(c.id)}>
                    <ATd style={{ width: 34 }}>
                      <input
                        type="checkbox"
                        checked={selected.has(c.id)}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggleOne(c.id)}
                        style={checkboxStyle}
                        aria-label={`Select ${c.alias}`}
                      />
                    </ATd>
                    <ATd style={{ opacity: erased ? 0.5 : 1 }}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                        <AAvatar name={c.alias} size={24} />
                        <span>
                          <div style={{ fontWeight: 600 }}>{c.alias}</div>
                          <div style={{ fontSize: 10.5, color: AT.inkSoft }}>{c.email}</div>
                        </span>
                      </span>
                    </ATd>
                    <ATd>
                      <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
                        {c.tags.length === 0 ? <span style={{ color: AT.inkSoft, fontSize: 12 }}>—</span> :
                          c.tags.map((t) => {
                            const def = tagById.get(t);
                            return def ? <TagChip key={t} tag={def} small /> : null;
                          })}
                      </span>
                    </ATd>
                    <ATd>{c.country ?? "—"}</ATd>
                    <ATd>
                      {c.strikes === 0 ? (
                        <span style={{ color: AT.inkSoft, fontSize: 12 }}>0</span>
                      ) : (
                        <ABadge tone={c.strikes >= 3 ? "danger" : "warn"}>{c.strikes}</ABadge>
                      )}
                    </ATd>
                    <ATd mono right>
                      {(c.outstandingFeeCents ?? 0) > 0
                        ? <strong style={{ color: AT.danger }}>{formatEur(c.outstandingFeeCents!)}</strong>
                        : <span style={{ color: AT.inkSoft }}>—</span>}
                    </ATd>
                    <ATd>
                      {erased ? <ABadge tone="neutral">erased</ABadge> : c.blocked ? <ABadge tone="danger">blocked</ABadge> : <ABadge tone="ok">active</ABadge>}
                    </ATd>
                    <ATd>{formatDay(c.createdAt)}</ATd>
                  </ATr>
                );
              })}
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

      <BulkBar count={selected.size} onClear={() => { setSelected(new Set()); setBulkTagMode(null); }}>
        {can("customers.edit") && (
          <>
            <span style={bulkDividerStyle} />
            <BulkBtn onClick={() => setBulkTagMode((m) => (m === "add" ? null : "add"))}>Add tag ▾</BulkBtn>
            <BulkBtn onClick={() => setBulkTagMode((m) => (m === "remove" ? null : "remove"))}>Remove tag ▾</BulkBtn>
          </>
        )}
        <span style={bulkDividerStyle} />
        <BulkBtn onClick={() => void runExport("csv")}>Export CSV</BulkBtn>
        {bulkTagMode && (
          <>
            <span style={bulkDividerStyle} />
            <span style={{ display: "inline-flex", gap: 5, alignItems: "center", flexWrap: "wrap", maxWidth: 360 }}>
              {activeTagDefs.map((t) => (
                <button key={t.id} onClick={() => void bulkTag(t.id, bulkTagMode)} style={{ all: "unset", cursor: "pointer" }}>
                  <TagChip tag={t} />
                </button>
              ))}
            </span>
          </>
        )}
      </BulkBar>

      {creating && (
        <ADrawer
          title="New bidder"
          onClose={() => setCreating(false)}
          footer={
            <>
              <ABtn kind="ghost" onClick={() => setCreating(false)}>Cancel</ABtn>
              <ABtn onClick={() => void create()} disabled={!form.email || form.alias.length < 2}>Create</ABtn>
            </>
          }
        >
          <div style={{ display: "grid", gap: 14 }}>
            <AField label="Email"><AInput value={form.email} onChange={(v) => setForm({ ...form, email: v })} type="email" /></AField>
            <AField label="Alias" hint="Public display name shown in bid ledgers."><AInput value={form.alias} onChange={(v) => setForm({ ...form, alias: v })} /></AField>
            <AField label="Full name"><AInput value={form.name} onChange={(v) => setForm({ ...form, name: v })} /></AField>
            <AField label="Country">
              <ASelect value={form.country} onChange={(v) => setForm({ ...form, country: v })} options={COUNTRIES} />
            </AField>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <AField label="Company"><AInput value={form.company} onChange={(v) => setForm({ ...form, company: v })} /></AField>
              <AField label="VAT number"><AInput value={form.vatNo} onChange={(v) => setForm({ ...form, vatNo: v })} placeholder="EE123456789" /></AField>
            </div>
          </div>
        </ADrawer>
      )}

      {detail && (
        <ADrawer
          title={
            <span style={{ display: "inline-flex", alignItems: "center", gap: 9 }}>
              <AAvatar name={detail.customer.alias} size={26} />
              {detail.customer.alias}
              {detail.customer.erasedAt && <ABadge tone="neutral">erased</ABadge>}
            </span>
          }
          onClose={() => setDetail(null)}
          footer={
            detail.customer.erasedAt ? (
              <ABtn kind="ghost" onClick={() => setDetail(null)}>Close</ABtn>
            ) : (
              <>
                {can("customers.erase") && <ABtn kind="danger" onClick={() => void erase()}>GDPR erase</ABtn>}
                {can("customers.strike") && <ABtn kind="ghost" onClick={() => void strike()}>Add strike</ABtn>}
                <ABtn kind="ghost" onClick={() => setDetail(null)}>Close</ABtn>
                {can("customers.edit") && <ABtn onClick={() => void save()}>Save</ABtn>}
              </>
            )
          }
        >
          <div style={{ display: "grid", gap: 14 }}>
            <div style={{ display: "flex", gap: 12 }}>
              <Stat label="Bids" value={String(detail.bidStats.totalBids)} />
              <Stat label="Auctions" value={String(detail.bidStats.auctionsBidOn)} />
              <Stat label="Strikes" value={String(detail.customer.strikes)} warn={detail.customer.strikes > 0} />
              <Stat label="Fees due" value={formatEur(detail.outstandingFeeCents)} warn={detail.outstandingFeeCents > 0} />
            </div>

            {/* A3: tag editor — toggling saves immediately (audited). */}
            {!detail.customer.erasedAt && (
              <AField label="Tags" hint={can("customers.edit") ? "Tap to toggle. Manage the vocabulary in Settings → Tags." : undefined}>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {activeTagDefs.length === 0 && <span style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft }}>No tags defined yet.</span>}
                  {activeTagDefs.map((t) => {
                    const on = detail.customer.tags.includes(t.id);
                    return (
                      <button
                        key={t.id}
                        disabled={!can("customers.edit")}
                        onClick={() => void toggleTag(t.id)}
                        style={{
                          all: "unset", cursor: can("customers.edit") ? "pointer" : "default",
                          opacity: on ? 1 : 0.35, borderRadius: 6,
                          outline: on ? `2px solid ${AT.accent}` : "none", outlineOffset: 1,
                        }}
                      >
                        <TagChip tag={t} />
                      </button>
                    );
                  })}
                </div>
              </AField>
            )}

            {detail.customer.vatNo && (
              <div style={{ background: AT.surfaceAlt, borderRadius: AT.radiusSm, padding: "10px 12px", display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontFamily: AT.body, fontSize: 12, fontWeight: 700 }}>
                    VIES check{" "}
                    {detail.customer.vies ? (
                      detail.customer.vies.valid ? <ABadge tone="ok">valid</ABadge> : <ABadge tone="danger">invalid</ABadge>
                    ) : (
                      <ABadge tone="warn">not verified</ABadge>
                    )}
                  </div>
                  <div style={{ fontFamily: AT.mono, fontSize: 10.5, color: AT.inkSoft, marginTop: 2 }}>
                    {detail.customer.vatNo}
                    {detail.customer.vies ? ` · checked ${formatDay(detail.customer.vies.checkedAt)} · ${detail.customer.vies.consult}` : ""}
                  </div>
                </div>
                {can("customers.vies_check") && !detail.customer.erasedAt && (
                  <ABtn size="sm" kind="dark" onClick={() => void viesCheck()}>
                    {detail.customer.vies ? "Re-check" : "Validate"}
                  </ABtn>
                )}
              </div>
            )}

            {!detail.customer.erasedAt && can("customers.edit") && (
              <>
                <AField label="Alias"><AInput value={edit.alias} onChange={(v) => setEdit({ ...edit, alias: v })} /></AField>
                <AField label="Full name"><AInput value={edit.name} onChange={(v) => setEdit({ ...edit, name: v })} /></AField>
                <AField label="Notes">
                  <textarea value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} rows={3} style={{
                    width: "100%", borderRadius: AT.radiusSm, border: `1px solid ${AT.rule}`, fontFamily: AT.body,
                    fontSize: 13, color: AT.ink, padding: 10, resize: "vertical",
                  }} />
                </AField>
              </>
            )}

            {!detail.customer.erasedAt && can("customers.strike") && (
              detail.customer.blocked ? (
                <div style={{ background: "#FBE3E3", border: "1px solid #E8B4B4", borderRadius: AT.radiusSm, padding: "10px 12px", display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontFamily: AT.body, fontSize: 12, fontWeight: 700, color: "#8F1D21" }}>
                      Account suspended{detail.customer.blockedAt ? ` · ${formatDay(detail.customer.blockedAt)}` : ""}
                    </div>
                    <div style={{ fontSize: 12, color: "#A54A4D", marginTop: 2 }}>{detail.customer.blockedReason || "No reason recorded"}</div>
                  </div>
                  <ABtn size="sm" kind="dark" onClick={() => void unban()}>Reinstate</ABtn>
                </div>
              ) : (
                <div>
                  <ABtn kind="danger" size="sm" onClick={() => void ban()}>Suspend account</ABtn>
                </div>
              )
            )}

            {detail.fees.length > 0 && (
              <ACard title={`Restock fees (${detail.fees.length})`} pad={false}>
                <ATable head={["Order", "Type", "Amount", "Status", ""]}>
                  {detail.fees.map((f) => (
                    <ATr key={f.id}>
                      <ATd mono>{f.orderRef}</ATd>
                      <ATd>{f.type === "unpaid_restock" ? "unpaid" : "no pickup"}</ATd>
                      <ATd mono right>{formatEur(f.amountCents)}</ATd>
                      <ATd>
                        <ABadge tone={f.status === "outstanding" ? "danger" : f.status === "settled" ? "ok" : "neutral"}>{f.status}</ABadge>
                      </ATd>
                      <ATd right>
                        {f.status === "outstanding" && can("customers.strike") && (
                          <span style={{ display: "inline-flex", gap: 6 }}>
                            <ABtn size="sm" onClick={() => void feeAction(f, "settle")}>Settle</ABtn>
                            <ABtn size="sm" kind="ghost" onClick={() => void feeAction(f, "waive")}>Waive</ABtn>
                          </span>
                        )}
                      </ATd>
                    </ATr>
                  ))}
                </ATable>
              </ACard>
            )}

            <ACard title={`Orders (${detail.orders.length})`} pad={false}>
              {detail.orders.length === 0 ? (
                <AEmpty text="No orders yet." />
              ) : (
                <ATable head={["Ref", "Total", "Status"]}>
                  {detail.orders.map((o) => (
                    <ATr key={o.id}>
                      <ATd mono>{o.ref}</ATd>
                      <ATd mono right>{formatEur(o.totalCents)}</ATd>
                      <ATd>
                        <ABadge tone={ORDER_STATUS_TONE[o.status]?.tone ?? "neutral"}>
                          {ORDER_STATUS_TONE[o.status]?.label ?? o.status}
                        </ABadge>
                      </ATd>
                    </ATr>
                  ))}
                </ATable>
              )}
            </ACard>
          </div>
        </ADrawer>
      )}
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div style={{ flex: 1, background: AT.surfaceAlt, borderRadius: AT.radiusSm, padding: "10px 12px" }}>
      <div style={{ fontFamily: AT.body, fontSize: 10.5, fontWeight: 700, color: AT.inkSoft, textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</div>
      <div style={{ fontFamily: AT.body, fontSize: 19, fontWeight: 700, color: warn ? AT.warn : AT.ink }}>{value}</div>
    </div>
  );
}
