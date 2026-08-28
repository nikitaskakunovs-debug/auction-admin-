import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Customer, type Order } from "../api.js";
import { AttributionCard } from "../attribution.js";
import type { Nav } from "../App.js";
import { useAuth } from "../auth.js";
import { exportCSV, exportPDFPrint, exportXLS } from "../exporters.js";
import { formatDay, formatEur } from "../format.js";
import { orderStatusLabel, useT, type TKey } from "../i18n.js";
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

interface CreditEntry {
  kind: "overpay" | "refund_to_credit" | "used_for_order" | "withdrawn" | "expired" | "grant";
  amountCents: number;
  orderRef: string | null;
  note: string;
  actorLabel: string | null;
  createdAt: string;
}

interface ConsentRow {
  id: string;
  mode: "accept" | "reject" | "custom";
  analytics: boolean;
  marketing: boolean;
  policyVersion: string;
  host: string;
  createdAt: string;
  /** Решение принято до регистрации — найдено по id браузера, а не по аккаунту. */
  viaVisitor: boolean;
}

interface MailRow {
  id: string;
  type: string;
  kind: string;
  subject: string;
  status: string;
  sentAt: string | null;
  scheduledFor: string | null;
  lastError: string | null;
  createdAt: string;
}

interface SessionRow {
  id: string;
  ua: string | null;
  ip: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

interface CustomerDetail {
  customer: Customer;
  orders: Order[];
  bidStats: { totalBids: number; auctionsBidOn: number };
  fees: CustomerFee[];
  outstandingFeeCents: number;
  credit: { balanceCents: number; entries: CreditEntry[] };
  consents: ConsentRow[];
  sessions: SessionRow[];
  mail: MailRow[];
  searches: Array<{ id: string; name: string; alertEmail: boolean; createdAt: string }>;
  watchCount: number;
  notificationPrefs: Array<{ event: string; email: boolean }>;
  lifetime: { paidOrders: number; revenueCents: number };
}

interface ListResponse {
  customers: Customer[];
  total: number;
  counts: { all: number; active: number; blocked: number; erased: number; strikes: number };
}

const COUNTRIES: { value: string; label: TKey }[] = [
  { value: "LV", label: "cust.country.lv" },
  { value: "EE", label: "cust.country.ee" },
  { value: "LT", label: "cust.country.lt" },
  { value: "", label: "cust.country.other" },
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
  { id: "all", label: "c.all" },
  { id: "active", label: "cust.pill.active" },
  { id: "blocked", label: "cust.pill.blocked" },
  { id: "strikes", label: "cust.pill.strikes" },
  { id: "erased", label: "cust.pill.erased" },
] as const satisfies ReadonlyArray<{ id: keyof ListResponse["counts"]; label: TKey }>;

const SORTS: { value: string; label: TKey }[] = [
  { value: "newest", label: "cust.sort.newest" },
  { value: "oldest", label: "cust.sort.oldest" },
  { value: "alias", label: "cust.sort.alias" },
  { value: "strikes", label: "cust.sort.strikes" },
];

const FEE_TYPE_KEY: Record<CustomerFee["type"], TKey> = {
  unpaid_restock: "cust.fees.unpaid",
  no_pickup_restock: "cust.fees.noPickup",
};

const FEE_STATUS_KEY: Record<CustomerFee["status"], TKey> = {
  outstanding: "cust.fees.st.outstanding",
  settled: "cust.fees.st.settled",
  waived: "cust.fees.st.waived",
};

const CREDIT_KIND_KEY: Record<CreditEntry["kind"], TKey> = {
  grant: "cust.credit.k.grant",
  overpay: "cust.credit.k.overpay",
  refund_to_credit: "cust.credit.k.refund_to_credit",
  used_for_order: "cust.credit.k.used_for_order",
  withdrawn: "cust.credit.k.withdrawn",
  expired: "cust.credit.k.expired",
};

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

export function CustomersScreen({ nav: _nav }: { nav: Nav }) {
  const { can } = useAuth();
  const { t } = useT();
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
  const [creditForm, setCreditForm] = useState({ amount: "", kind: "grant", note: "" });
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
    noun: t("cust.nounSegment"),
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
      toast(t("cust.loadMoreFailed"), "danger");
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
  if (filters.status !== "all") {
    const pill = STATUS_PILLS.find((p) => p.id === filters.status);
    chips.push({ key: "status", label: pill ? t(pill.label) : filters.status, clear: () => set({ status: "all" }) });
  }
  if (filters.tag !== "all") chips.push({ key: "tag", label: `${t("cust.chip.tag")} ${tagById.get(filters.tag)?.name ?? "?"}`, clear: () => set({ tag: "all" }) });
  if (filters.country !== "all") chips.push({ key: "country", label: `${t("cust.chip.country")} ${filters.country || t("cust.country.other")}`, clear: () => set({ country: "all" }) });
  if (filters.debt !== "any") chips.push({ key: "debt", label: t("cust.hasFees"), clear: () => set({ debt: "any" }) });
  if (filters.from) chips.push({ key: "from", label: `${t("cust.chip.from")} ${filters.from}`, clear: () => set({ from: "" }) });
  if (filters.to) chips.push({ key: "to", label: `${t("cust.chip.to")} ${filters.to}`, clear: () => set({ to: "" }) });
  if (filters.sort !== "newest") {
    const s = SORTS.find((x) => x.value === filters.sort);
    chips.push({ key: "sort", label: s ? t(s.label) : filters.sort, clear: () => set({ sort: "newest" }) });
  }
  if (filters.q.trim()) chips.push({ key: "q", label: `"${filters.q.trim()}"`, clear: () => { setQInput(""); set({ q: "" }); } });

  // ── Export ────────────────────────────────────────────────────────────────

  const exportHeaders = [
    t("cust.f.alias"), t("cust.f.email"), t("cust.f.fullName"), t("cust.th.country"), t("cust.th.tags"),
    t("cust.th.strikes"), `${t("cust.th.feesDue")} €`, t("c.status"), t("cust.th.joined"),
  ];

  const toExportRow = (c: Customer): string[] => [
    c.alias,
    c.email,
    c.name ?? "",
    c.country ?? "",
    c.tags.map((t) => tagById.get(t)?.name ?? "").filter(Boolean).join("; "),
    String(c.strikes),
    ((c.outstandingFeeCents ?? 0) / 100).toFixed(2),
    c.erasedAt ? t("cust.st.erased") : c.blocked ? t("cust.st.blocked") : t("cust.st.active"),
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
      if (list.length === 0) return toast(t("cust.nothingToExport"), "warn");
      const body = list.map(toExportRow);
      if (fmt === "csv") exportCSV("bidders", exportHeaders, body);
      else if (fmt === "xls") exportXLS("bidders", exportHeaders, body, t("cust.title"));
      else exportPDFPrint(t("cust.exportTitle"), exportHeaders, body);
      toast(`${t("cust.exported")}: ${list.length}`, "ok");
    } catch {
      toast(t("cust.exportFailed"), "danger");
    }
  };

  // ── Bulk tagging ──────────────────────────────────────────────────────────

  const bulkTag = async (tagId: string, mode: "add" | "remove") => {
    try {
      const r = await api.post<{ updated: number }>("/api/customers/bulk/tags", {
        ids: selectedRows.map((c) => c.id),
        ...(mode === "add" ? { add: [tagId] } : { remove: [tagId] }),
      });
      toast(`${t("cust.bulkUpdated")}: ${r.updated}`, "ok");
      setBulkTagMode(null);
      setRefreshTick((t) => t + 1);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("cust.tagFailed"), "danger");
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
      toast(t("cust.created"), "ok");
      setCreating(false);
      reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("cust.createFailed"), "danger");
    }
  };

  const save = async () => {
    if (!detail) return;
    try {
      await api.patch(`/api/customers/${detail.customer.id}`, { alias: edit.alias, name: edit.name || null, notes: edit.notes });
      toast(t("cust.saved"), "ok");
      openDetail(detail.customer.id);
      reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("cust.saveFailed"), "danger");
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
      toast(err instanceof ApiError ? err.message : t("cust.tagUpdateFailed"), "danger");
    }
  };

  const viesCheck = async () => {
    if (!detail) return;
    try {
      const r = await api.post<{ vies: { valid: boolean; consult: string } }>(`/api/customers/${detail.customer.id}/vies-check`);
      toast(r.vies.valid ? `${t("cust.vies.toastValidPre")} ${r.vies.consult}` : t("cust.vies.toastInvalid"), r.vies.valid ? "ok" : "danger");
      openDetail(detail.customer.id);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("cust.vies.failed"), "danger");
    }
  };

  const feeAction = async (fee: CustomerFee, action: "settle" | "waive") => {
    if (!detail) return;
    let note = "";
    if (action === "waive") {
      const r = await confirm({
        title: `${t("cust.fees.waiveTitlePre")} ${formatEur(fee.amountCents)} ${t("cust.fees.waiveTitleFor")} ${fee.orderRef}?`,
        body: t("cust.fees.waiveBody"),
        requireReason: true,
        confirmLabel: t("cust.fees.waiveConfirm"),
      });
      if (!r.ok) return;
      note = r.reason ?? "";
    }
    try {
      await api.post(`/api/customers/${detail.customer.id}/fees/${fee.id}/${action}`, { note });
      toast(action === "settle" ? t("cust.fees.settled") : t("cust.fees.waived"), "ok");
      openDetail(detail.customer.id);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("cust.fees.actionFailed"), "danger");
    }
  };

  /** Ручное движение аванса: переплата по перечислению, компенсация,
   *  исправление. Сумма в форме — в евро, знак задаёт направление. */
  const creditMove = async () => {
    if (!detail) return;
    const amountCents = Math.round(Number(creditForm.amount.replace(",", ".")) * 100);
    if (!Number.isFinite(amountCents) || amountCents === 0) return;
    try {
      await api.post(`/api/customers/${detail.customer.id}/credit`, {
        amountCents,
        kind: creditForm.kind,
        note: creditForm.note,
      });
      toast(t("cust.credit.done"), "ok");
      setCreditForm({ amount: "", kind: "grant", note: "" });
      openDetail(detail.customer.id);
    } catch (err) {
      if (err instanceof ApiError && err.message === "insufficient_credit") toast(t("cust.credit.insufficient"), "danger");
      else toast(err instanceof ApiError ? err.message : t("cust.credit.failed"), "danger");
    }
  };

  /** Zero-tolerance suspension — always via the audited block endpoint. */
  const ban = async () => {
    if (!detail) return;
    const r = await confirm({
      title: `${t("cust.ban.titlePre")} ${detail.customer.alias}?`,
      body: t("cust.ban.body"),
      danger: true,
      requireReason: true,
      confirmLabel: t("cust.ban.confirm"),
    });
    if (!r.ok) return;
    try {
      await api.post(`/api/customers/${detail.customer.id}/block`, { reason: r.reason });
      toast(t("cust.ban.done"), "ok");
      openDetail(detail.customer.id);
      reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("cust.failed"), "danger");
    }
  };

  const unban = async () => {
    if (!detail) return;
    const r = await confirm({
      title: `${t("cust.unban.titlePre")} ${detail.customer.alias}?`,
      body: t("cust.unban.body"),
      requireReason: true,
      confirmLabel: t("cust.unban.confirm"),
    });
    if (!r.ok) return;
    try {
      await api.post(`/api/customers/${detail.customer.id}/unblock`, { reason: r.reason });
      toast(t("cust.unban.done"), "ok");
      openDetail(detail.customer.id);
      reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("cust.failed"), "danger");
    }
  };

  const strike = async () => {
    if (!detail) return;
    const r = await confirm({
      title: `${t("cust.strike.titlePre")} ${detail.customer.alias}?`,
      body: t("cust.strike.body"),
      requireReason: true,
      confirmLabel: t("cust.strike.confirm"),
    });
    if (!r.ok) return;
    try {
      await api.post(`/api/customers/${detail.customer.id}/strike`, { reason: r.reason });
      toast(t("cust.strike.added"), "ok");
      openDetail(detail.customer.id);
      reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("cust.failed"), "danger");
    }
  };

  const erase = async () => {
    if (!detail) return;
    const r = await confirm({
      title: `${t("cust.erase.titlePre")} ${detail.customer.alias}?`,
      body: t("cust.erase.body"),
      danger: true,
      typeToConfirm: detail.customer.alias,
      requireReason: true,
      confirmLabel: t("cust.erase.confirm"),
    });
    if (!r.ok) return;
    try {
      await api.post(`/api/customers/${detail.customer.id}/erase`);
      toast(t("cust.erase.done"), "ok");
      setDetail(null);
      reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("cust.erase.failed"), "danger");
    }
  };

  const exportCount = selected.size > 0 ? selected.size : total;

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <h1 style={{ fontFamily: AT.body, fontSize: 20, fontWeight: 700, color: AT.ink, flex: 1 }}>{t("cust.title")}</h1>
        <ExportMenu count={exportCount} scope={selected.size > 0 ? "selected" : "filtered"} noun={t("cust.nounBidders")} onPick={(fmt) => void runExport(fmt)} />
        {can("customers.edit") && (
          <ABtn onClick={() => { setForm({ email: "", alias: "", name: "", country: "LV", company: "", vatNo: "" }); setCreating(true); }}>
            <AIcon name="plus" size={15} color="#fff" /> {t("cust.new")}
          </ABtn>
        )}
      </div>

      <ViewsBar {...sv.ViewsBarProps} label={t("cust.segments")} saveLabel={t("cust.saveSegment")} />

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
              {t(p.label)}
              <span style={{ marginLeft: 6, opacity: 0.6, fontWeight: 700, fontSize: 11 }}>{counts?.[p.id] ?? 0}</span>
            </button>
          );
        })}
      </div>

      {/* Filter bar */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <SearchBox value={qInput} onChange={setQInput} placeholder={t("cust.searchPh")} />
        <ASelect
          value={filters.tag}
          onChange={(v) => set({ tag: v })}
          options={[{ value: "all", label: t("cust.allTags") }, ...tagDefs.map((t) => ({ value: t.id, label: t.name }))]}
        />
        <ASelect
          value={filters.country}
          onChange={(v) => set({ country: v })}
          options={[{ value: "all", label: t("cust.allCountries") }, ...COUNTRIES.map((c) => ({ value: c.value, label: t(c.label) }))]}
        />
        <ASelect
          value={filters.debt}
          onChange={(v) => set({ debt: v })}
          options={[{ value: "any", label: t("cust.anyBalance") }, { value: "has", label: t("cust.hasFees") }]}
        />
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft }}>
          <input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => set({ from: e.target.value })} style={dateInputStyle} />
          –
          <input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => set({ to: e.target.value })} style={dateInputStyle} />
        </label>
        <ASelect value={filters.sort} onChange={(v) => set({ sort: v })} options={SORTS.map((s) => ({ value: s.value, label: t(s.label) }))} />
      </div>

      <FilterChips chips={chips} onClearAll={clearAll} />

      <ACard pad={false}>
        {rows.length === 0 ? (
          <AEmpty text={t("cust.empty")} />
        ) : (
          <>
            <ATable head={[
              <input key="all" type="checkbox" checked={allSelected} onChange={toggleAll} style={checkboxStyle} aria-label={t("cust.aria.selectAll")} />,
              t("cust.th.bidder"), t("cust.th.tags"), t("cust.th.country"), t("cust.th.strikes"), t("cust.th.feesDue"), t("cust.th.marketing"), t("c.status"), t("cust.th.joined"),
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
                        aria-label={`${t("cust.aria.select")} ${c.alias}`}
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
                    {/* Кому законно писать рассылку. Без даты согласие ничего
                        не стоит, поэтому она в подсказке. */}
                    <ATd>
                      {c.marketingOptIn
                        ? <span title={c.marketingOptInAt ? `${formatDay(c.marketingOptInAt)} · ${c.marketingSource ?? ""}` : undefined}>
                            <ABadge tone="ok">{t("cust.mk.yes")}</ABadge>
                          </span>
                        : <span style={{ color: AT.inkSoft, fontSize: 12 }}>{t("cust.mk.no")}</span>}
                    </ATd>
                    <ATd>
                      {erased ? <ABadge tone="neutral">{t("cust.st.erased")}</ABadge> : c.blocked ? <ABadge tone="danger">{t("cust.st.blocked")}</ABadge> : <ABadge tone="ok">{t("cust.st.active")}</ABadge>}
                    </ATd>
                    <ATd>{formatDay(c.createdAt)}</ATd>
                  </ATr>
                );
              })}
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

      <BulkBar count={selected.size} onClear={() => { setSelected(new Set()); setBulkTagMode(null); }}>
        {can("customers.edit") && (
          <>
            <span style={bulkDividerStyle} />
            <BulkBtn onClick={() => setBulkTagMode((m) => (m === "add" ? null : "add"))}>{t("cust.bulk.addTag")}</BulkBtn>
            <BulkBtn onClick={() => setBulkTagMode((m) => (m === "remove" ? null : "remove"))}>{t("cust.bulk.removeTag")}</BulkBtn>
          </>
        )}
        <span style={bulkDividerStyle} />
        <BulkBtn onClick={() => void runExport("csv")}>{t("cust.bulk.exportCsv")}</BulkBtn>
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
          title={t("cust.new")}
          onClose={() => setCreating(false)}
          footer={
            <>
              <ABtn kind="ghost" onClick={() => setCreating(false)}>{t("c.cancel")}</ABtn>
              <ABtn onClick={() => void create()} disabled={!form.email || form.alias.length < 2}>{t("c.create")}</ABtn>
            </>
          }
        >
          <div style={{ display: "grid", gap: 14 }}>
            <AField label={t("cust.f.email")}><AInput value={form.email} onChange={(v) => setForm({ ...form, email: v })} type="email" /></AField>
            <AField label={t("cust.f.alias")} hint={t("cust.f.aliasHint")}><AInput value={form.alias} onChange={(v) => setForm({ ...form, alias: v })} /></AField>
            <AField label={t("cust.f.fullName")}><AInput value={form.name} onChange={(v) => setForm({ ...form, name: v })} /></AField>
            <AField label={t("cust.f.country")}>
              <ASelect value={form.country} onChange={(v) => setForm({ ...form, country: v })} options={COUNTRIES.map((c) => ({ value: c.value, label: t(c.label) }))} />
            </AField>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <AField label={t("cust.f.company")}><AInput value={form.company} onChange={(v) => setForm({ ...form, company: v })} /></AField>
              <AField label={t("cust.f.vatNo")}><AInput value={form.vatNo} onChange={(v) => setForm({ ...form, vatNo: v })} placeholder="EE123456789" /></AField>
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
              {detail.customer.erasedAt && <ABadge tone="neutral">{t("cust.st.erased")}</ABadge>}
            </span>
          }
          onClose={() => setDetail(null)}
          footer={
            detail.customer.erasedAt ? (
              <ABtn kind="ghost" onClick={() => setDetail(null)}>{t("c.close")}</ABtn>
            ) : (
              <>
                {can("customers.erase") && <ABtn kind="danger" onClick={() => void erase()}>{t("cust.erase.btn")}</ABtn>}
                {can("customers.strike") && <ABtn kind="ghost" onClick={() => void strike()}>{t("cust.strike.confirm")}</ABtn>}
                <ABtn kind="ghost" onClick={() => setDetail(null)}>{t("c.close")}</ABtn>
                {can("customers.edit") && <ABtn onClick={() => void save()}>{t("c.save")}</ABtn>}
              </>
            )
          }
        >
          <div style={{ display: "grid", gap: 14 }}>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <Stat label={t("cd.lifetime")} value={formatEur(detail.lifetime.revenueCents)} />
              <Stat label={t("cust.stat.bids")} value={String(detail.bidStats.totalBids)} />
              <Stat label={t("cust.stat.auctions")} value={String(detail.bidStats.auctionsBidOn)} />
              <Stat label={t("cust.th.strikes")} value={String(detail.customer.strikes)} warn={detail.customer.strikes > 0} />
              <Stat label={t("cust.th.feesDue")} value={formatEur(detail.outstandingFeeCents)} warn={detail.outstandingFeeCents > 0} />
            </div>

            {/* Откуда пришёл — первым делом: с этого начинается любой разговор
                о клиенте, и раньше ответа на него в панели не было вовсе. */}
            <AttributionCard
              first={detail.customer.attribution}
              last={detail.customer.attributionLast}
              touches={detail.customer.attributionTouches}
            />

            {/* A3: tag editor — toggling saves immediately (audited). */}
            {!detail.customer.erasedAt && (
              <AField label={t("cust.th.tags")} hint={can("customers.edit") ? t("cust.tagsHint") : undefined}>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {activeTagDefs.length === 0 && <span style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft }}>{t("cust.noTagsDefined")}</span>}
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
                    {t("cust.vies.title")}{" "}
                    {detail.customer.vies ? (
                      detail.customer.vies.valid ? <ABadge tone="ok">{t("cust.vies.valid")}</ABadge> : <ABadge tone="danger">{t("cust.vies.invalid")}</ABadge>
                    ) : (
                      <ABadge tone="warn">{t("cust.vies.notVerified")}</ABadge>
                    )}
                  </div>
                  <div style={{ fontFamily: AT.mono, fontSize: 10.5, color: AT.inkSoft, marginTop: 2 }}>
                    {detail.customer.vatNo}
                    {detail.customer.vies ? ` · ${t("cust.vies.checked")} ${formatDay(detail.customer.vies.checkedAt)} · ${detail.customer.vies.consult}` : ""}
                  </div>
                </div>
                {can("customers.vies_check") && !detail.customer.erasedAt && (
                  <ABtn size="sm" kind="dark" onClick={() => void viesCheck()}>
                    {detail.customer.vies ? t("cust.vies.recheck") : t("cust.vies.validate")}
                  </ABtn>
                )}
              </div>
            )}

            {/* Как человек входит: почта (подтверждена или нет) и соцсети. */}
            <div style={{ background: AT.surfaceAlt, borderRadius: AT.radiusSm, padding: "10px 12px", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontFamily: AT.body, fontSize: 12, fontWeight: 700, flex: 1 }}>{t("cust.verif.title")}</span>
              {detail.customer.email.endsWith("@nav.izsoli.lv")
                ? <ABadge tone="warn">{t("cust.verif.pending")}</ABadge>
                : detail.customer.emailVerifiedAt
                  ? <span title={formatDay(detail.customer.emailVerifiedAt)}><ABadge tone="ok">{t("cust.verif.ok")}</ABadge></span>
                  : <ABadge tone="warn">{t("cust.verif.no")}</ABadge>}
              {detail.customer.googleId && <ABadge tone="neutral">Google</ABadge>}
              {detail.customer.facebookId && <ABadge tone="neutral">Facebook</ABadge>}
              {detail.customer.telegramId && <ABadge tone="neutral">Telegram</ABadge>}
              {!detail.customer.googleId && !detail.customer.facebookId && !detail.customer.telegramId && (
                <span style={{ fontFamily: AT.body, fontSize: 12, color: AT.inkSoft }}>{t("cust.social.none")}</span>
              )}
              {/* Привязка говорит лишь, что связка есть. Чем человек реально
                  пользуется — вот это, и при разборе «не могу войти» важно
                  именно оно. */}
              {detail.customer.lastLoginAt && (
                <div style={{ flexBasis: "100%", fontFamily: AT.body, fontSize: 11.5, color: AT.inkSoft }}>
                  {t("cd.lastLogin")}: {formatDay(detail.customer.lastLoginAt)}
                  {detail.customer.lastLoginMethod
                    ? ` · ${detail.customer.lastLoginMethod === "password" ? t("cd.login.password") : detail.customer.lastLoginMethod}`
                    : ""}
                  {detail.sessions.length > 0 ? ` · ${t("cd.sessions")}: ${detail.sessions.length}` : ""}
                </div>
              )}
            </div>

            {/* Согласия: и cookie, и рассылка, и стоп-сигналы — в одном месте.
                На запрос «докажите, что он соглашался» ответ обязан находиться
                за один клик, а не собираться из трёх экранов. */}
            <ACard title={t("cd.consents")} pad={false}>
              <div style={{ padding: "10px 12px", display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", borderBottom: `1px solid ${AT.ruleSoft}` }}>
                <span style={{ fontFamily: AT.body, fontSize: 12, color: AT.inkSoft, minWidth: 92 }}>{t("cd.consent.marketing")}</span>
                {detail.customer.marketingOptIn
                  ? <ABadge tone="ok">{t("c.yes")}</ABadge>
                  : <ABadge tone="neutral">{t("c.no")}</ABadge>}
                {detail.customer.marketingOptInAt && (
                  <span style={{ fontFamily: AT.body, fontSize: 11.5, color: AT.inkSoft }}>
                    {formatDay(detail.customer.marketingOptInAt)}
                    {detail.customer.marketingSource ? ` · ${detail.customer.marketingSource}` : ""}
                  </span>
                )}
                {detail.customer.marketingOptOutAt && (
                  <span style={{ fontFamily: AT.body, fontSize: 11.5, color: AT.inkSoft }}>
                    ✕ {formatDay(detail.customer.marketingOptOutAt)}
                  </span>
                )}
                {detail.customer.unsubscribedAt && (
                  <span title={formatDay(detail.customer.unsubscribedAt)}><ABadge tone="warn">{t("cd.unsubscribed")}</ABadge></span>
                )}
                {detail.customer.emailBouncedAt && (
                  <span title={formatDay(detail.customer.emailBouncedAt)}><ABadge tone="danger">{t("cd.bounced")}</ABadge></span>
                )}
              </div>
              {detail.consents.length === 0 ? (
                <div style={{ padding: "10px 12px", fontFamily: AT.body, fontSize: 12, color: AT.inkSoft }}>
                  {t("cd.consent.none")}
                </div>
              ) : (
                <ATable head={[t("cust.credit.when"), t("cd.consent.cookies"), t("cd.consent.analytics"), t("cd.consent.marketing"), t("cd.consent.version")]}>
                  {detail.consents.map((c) => (
                    <ATr key={c.id}>
                      <ATd>
                        {formatDay(c.createdAt)}
                        {c.viaVisitor && (
                          <span style={{ fontFamily: AT.body, fontSize: 10.5, color: AT.inkSoft }}> · {t("cd.consent.beforeSignup")}</span>
                        )}
                      </ATd>
                      <ATd>
                        <ABadge tone={c.mode === "accept" ? "ok" : c.mode === "reject" ? "neutral" : "warn"}>
                          {t(`cd.consent.mode.${c.mode}` as TKey)}
                        </ABadge>
                      </ATd>
                      <ATd>{c.analytics ? "✓" : "—"}</ATd>
                      <ATd>{c.marketing ? "✓" : "—"}</ATd>
                      <ATd mono>{c.policyVersion}</ATd>
                    </ATr>
                  ))}
                </ATable>
              )}
            </ACard>

            {/* Интересы: чего человек ждёт. По ним понятно, что ему предлагать
                и почему он вообще подписался на письма. */}
            {(detail.searches.length > 0 || detail.watchCount > 0) && (
              <div style={{ background: AT.surfaceAlt, borderRadius: AT.radiusSm, padding: "10px 12px", display: "grid", gap: 6 }}>
                <span style={{ fontFamily: AT.body, fontSize: 12, fontWeight: 700 }}>{t("cd.interests")}</span>
                {detail.watchCount > 0 && (
                  <div style={{ fontFamily: AT.body, fontSize: 12.5 }}>{t("cd.watchlist")}: {detail.watchCount}</div>
                )}
                {detail.searches.length > 0 && (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {detail.searches.map((s) => (
                      <ABadge key={s.id} tone={s.alertEmail ? "accent" : "neutral"}>
                        {s.name}{s.alertEmail ? ` · ${t("cd.alertOn")}` : ""}
                      </ABadge>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Письма: что человеку реально ушло и дошло ли. Без этого на
                «мне ничего не приходило» ответить нечем. */}
            <ACard title={`${t("cd.mail.title")} (${detail.mail.length})`} pad={false}>
              {detail.mail.length === 0 ? (
                <AEmpty text={t("cd.mail.none")} />
              ) : (
                <ATable head={[t("cust.credit.when"), t("cd.mail.subject"), t("c.status")]}>
                  {detail.mail.map((m) => (
                    <ATr key={m.id}>
                      <ATd>{formatDay(m.sentAt ?? m.createdAt)}</ATd>
                      <ATd>
                        {m.subject}
                        {m.kind === "marketing" && (
                          <span style={{ fontFamily: AT.body, fontSize: 10.5, color: AT.inkSoft }}> · {t("cd.mail.marketing")}</span>
                        )}
                      </ATd>
                      <ATd>
                        <span title={m.lastError ?? (m.scheduledFor ? formatDay(m.scheduledFor) : undefined)}>
                          <ABadge tone={m.status === "sent" ? "ok" : m.status === "failed" ? "danger" : "warn"}>
                            {m.status === "pending" && m.scheduledFor ? t("cd.mail.scheduled") : m.status}
                          </ABadge>
                        </span>
                      </ATd>
                    </ATr>
                  ))}
                </ATable>
              )}
            </ACard>

            {!detail.customer.erasedAt && can("customers.edit") && (
              <>
                <AField label={t("cust.f.alias")}><AInput value={edit.alias} onChange={(v) => setEdit({ ...edit, alias: v })} /></AField>
                <AField label={t("cust.f.fullName")}><AInput value={edit.name} onChange={(v) => setEdit({ ...edit, name: v })} /></AField>
                <AField label={t("c.notes")}>
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
                      {t("cust.suspendedTitle")}{detail.customer.blockedAt ? ` · ${formatDay(detail.customer.blockedAt)}` : ""}
                    </div>
                    <div style={{ fontSize: 12, color: "#A54A4D", marginTop: 2 }}>{detail.customer.blockedReason || t("cust.noReason")}</div>
                  </div>
                  <ABtn size="sm" kind="dark" onClick={() => void unban()}>{t("cust.unban.confirm")}</ABtn>
                </div>
              ) : (
                <div>
                  <ABtn kind="danger" size="sm" onClick={() => void ban()}>{t("cust.ban.confirm")}</ABtn>
                </div>
              )
            )}

            {/* Аванс: баланс, движения и ручная кустība (№ 69b, 71–73).
                Право то же, что у «отметить оплаченным» — оба признают деньги. */}
            {(detail.credit.balanceCents !== 0 || detail.credit.entries.length > 0 || (!detail.customer.erasedAt && can("orders.mark_paid"))) && (
              <ACard title={`${t("cust.credit.title")} · ${formatEur(detail.credit.balanceCents)}`} pad={false}>
                {detail.credit.entries.length > 0 && (
                  <ATable head={[t("cust.credit.when"), t("cust.credit.kind"), t("cust.credit.amount"), t("cust.credit.note"), t("cust.credit.who")]}>
                    {detail.credit.entries.map((e, i) => (
                      <ATr key={i}>
                        <ATd>{formatDay(e.createdAt)}</ATd>
                        <ATd>{t(CREDIT_KIND_KEY[e.kind])}{e.orderRef ? ` · ${e.orderRef}` : ""}</ATd>
                        <ATd mono right>
                          <span style={{ color: e.amountCents < 0 ? AT.danger : AT.ink }}>{formatEur(e.amountCents)}</span>
                        </ATd>
                        <ATd>{e.note || "—"}</ATd>
                        <ATd>{e.actorLabel ?? "—"}</ATd>
                      </ATr>
                    ))}
                  </ATable>
                )}
                {!detail.customer.erasedAt && can("orders.mark_paid") && (
                  <div style={{ padding: 12, display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap", borderTop: `1px solid ${AT.ruleSoft}` }}>
                    <AField label={t("cust.credit.amount")} hint={t("cust.credit.amountHint")}>
                      <AInput value={creditForm.amount} onChange={(v) => setCreditForm({ ...creditForm, amount: v })} placeholder="10.00" />
                    </AField>
                    <AField label={t("cust.credit.kind")}>
                      <ASelect value={creditForm.kind} onChange={(v) => setCreditForm({ ...creditForm, kind: v })}
                        options={(["grant", "overpay", "refund_to_credit", "withdrawn", "expired"] as const).map((k) => ({ value: k, label: t(CREDIT_KIND_KEY[k]) }))} />
                    </AField>
                    <AField label={t("cust.credit.note")}>
                      <AInput value={creditForm.note} onChange={(v) => setCreditForm({ ...creditForm, note: v })} />
                    </AField>
                    <ABtn size="sm" onClick={() => void creditMove()} disabled={!creditForm.amount.trim()}>{t("cust.credit.apply")}</ABtn>
                  </div>
                )}
              </ACard>
            )}

            {detail.fees.length > 0 && (
              <ACard title={`${t("cust.fees.title")} (${detail.fees.length})`} pad={false}>
                <ATable head={[t("cust.fees.order"), t("cust.fees.type"), t("cust.fees.amount"), t("c.status"), ""]}>
                  {detail.fees.map((f) => (
                    <ATr key={f.id}>
                      <ATd mono>{f.orderRef}</ATd>
                      <ATd>{t(FEE_TYPE_KEY[f.type])}</ATd>
                      <ATd mono right>{formatEur(f.amountCents)}</ATd>
                      <ATd>
                        <ABadge tone={f.status === "outstanding" ? "danger" : f.status === "settled" ? "ok" : "neutral"}>{t(FEE_STATUS_KEY[f.status])}</ABadge>
                      </ATd>
                      <ATd right>
                        {f.status === "outstanding" && can("customers.strike") && (
                          <span style={{ display: "inline-flex", gap: 6 }}>
                            <ABtn size="sm" onClick={() => void feeAction(f, "settle")}>{t("cust.fees.settle")}</ABtn>
                            <ABtn size="sm" kind="ghost" onClick={() => void feeAction(f, "waive")}>{t("cust.fees.waive")}</ABtn>
                          </span>
                        )}
                      </ATd>
                    </ATr>
                  ))}
                </ATable>
              </ACard>
            )}

            <ACard title={`${t("cust.orders.title")} (${detail.orders.length})`} pad={false}>
              {detail.orders.length === 0 ? (
                <AEmpty text={t("cust.orders.empty")} />
              ) : (
                <ATable head={[t("cust.orders.ref"), t("c.total"), t("c.status")]}>
                  {detail.orders.map((o) => (
                    <ATr key={o.id}>
                      <ATd mono>{o.ref}</ATd>
                      <ATd mono right>{formatEur(o.totalCents)}</ATd>
                      <ATd>
                        <ABadge tone={ORDER_STATUS_TONE[o.status]?.tone ?? "neutral"}>
                          {orderStatusLabel(o.status)}
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
