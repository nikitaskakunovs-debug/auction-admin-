import { CATEGORIES } from "@auction/domain/categories";
import { CONDITIONS, conditionByCode, conditionRequiresNotes } from "@auction/domain/conditions";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError, type ConditionPreset, type Item, type Market } from "../api.js";
import type { Nav } from "../App.js";
import { useAuth } from "../auth.js";
import { exportCSV } from "../exporters.js";
import { formatDate, formatDay, formatEur } from "../format.js";
import { useT, type Lang, type TKey } from "../i18n.js";
import { openLabelWindow as openLabel } from "../labels.js";
import { AT, type Tone } from "../theme.js";
import {
  ABadge, ABtn, ACard, ADrawer, AEmpty, AField, AIcon, AInput, APills, ASelect,
  AStat, ATable, ATd, ATr, useConfirm, useToast,
} from "../ui.js";
import { useAuctionEvents } from "../useAuctionEvents.js";
import { BinsBrowser } from "./Bins.js";

interface Consignment {
  id: string;
  ref: string;
  supplier: string;
  /** R1: the supplier record behind the text. Null on older deliveries the
   * backfill could not match to a name. */
  supplierId?: string | null;
  notes: string;
  marketCode: string;
  status: string;
  expectedCount: number;
  receivedCount?: number;
  createdAt: string;
  closedAt: string | null;
  /** W6: transport/cleaning for the whole delivery; null = nothing recorded. */
  extraCostCents?: number | null;
}

/** R1 supplier row. Everything below `deliveryCount` is finance.view-only and
 * simply absent (not null) for everyone else — never assume it is there. */
interface Supplier {
  id: string;
  name: string;
  active: boolean;
  paymentTermsDays: number;
  deliveryCount: number;
  regNo?: string;
  vatNo?: string;
  email?: string;
  phone?: string;
  address?: string;
  bankAccount?: string;
  contactName?: string;
  lang?: string;
  model?: string;
  commissionBp?: number;
  pendingBankAccount?: string | null;
  portalLastLoginAt?: string | null;
  notes?: string;
  outstandingCents?: number;
  overdueCents?: number;
}

/** One bill from a supplier (finance.view only). */
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
  outstandingCents: number;
  status: string;
  overdueDays: number;
  note: string;
}

/** The bill against what the warehouse actually recorded for the delivery. */
interface Reconciliation {
  recordedCostCents: number;
  varianceCents: number;
  noCostDataCount: number;
}

const INVOICE_STATUS: Record<string, { key: TKey; tone: Tone }> = {
  unpaid: { key: "rcv.sup.st.unpaid", tone: "warn" },
  partly_paid: { key: "rcv.sup.st.partly", tone: "accent" },
  paid: { key: "rcv.sup.st.paid", tone: "ok" },
  cancelled: { key: "rcv.sup.st.cancelled", tone: "neutral" },
};

/** Payment terms in whole days. Blank → null ("leave as it is"), anything that
 * is not 0–365 → "bad", so a typo is refused inline instead of being sent. */
const parseTermsDays = (s: string): number | null | "bad" => {
  const v = s.trim();
  if (!v) return null;
  if (!/^\d{1,3}$/.test(v)) return "bad";
  const n = Number(v);
  return n <= 365 ? n : "bad";
};

const todayISO = (): string => new Date().toISOString().slice(0, 10);

/**
 * The supplier box on the delivery forms: free typing (a new name is allowed
 * and becomes a record) backed by a datalist of the names already on file, so
 * "nor" offers "Nordic Trade OÜ" instead of creating a third spelling.
 */
function SupplierPicker({ value, onChange, options, listId, placeholder, disabled }: {
  value: string;
  onChange: (v: string) => void;
  options: Supplier[];
  listId: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <>
      <input
        list={listId}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{
          height: 36, borderRadius: AT.radiusSm, border: `1px solid ${AT.rule}`, background: AT.panel,
          fontFamily: AT.body, fontSize: 13, color: AT.ink, padding: "0 11px", outline: "none", width: "100%",
        }}
      />
      <datalist id={listId}>
        {options.filter((s) => s.active).map((s) => <option key={s.id} value={s.name} />)}
      </datalist>
    </>
  );
}

/** Label/value line inside the invoice card. */
function InvLine({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
      <span style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft }}>{label}</span>
      <span style={{ fontFamily: AT.body, fontSize: 13, fontWeight: 600, color: AT.ink, textAlign: "right" }}>{children}</span>
    </div>
  );
}

/** W6: the API sends costCents only to finance.view holders. */
type ItemWithCost = Item & { costCents?: number | null };

const emptyReceive = { title: "", condition: "brand_new", conditionNotes: "", category: "other", weight: "", cost: "" };

/** W6 money entry. "12,50" / "12.5" → 1250, blank → null (unknown, never
 * zero), anything else (text, a minus sign) → "bad" so the caller can show an
 * inline error instead of quietly sending null. */
const eurToCents = (s: string): number | null | "bad" => {
  const v = s.trim().replace(/\s/g, "").replace(",", ".");
  if (!v) return null;
  if (!/^\d+(\.\d+)?$/.test(v)) return "bad";
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : "bad";
};

const centsToEur = (c: number | null | undefined): string => (c == null ? "" : (c / 100).toFixed(2));

/** Inline validation message under a money input. */
function CostError({ show, text }: { show: boolean; text: string }) {
  if (!show) return null;
  return <div style={{ fontFamily: AT.body, fontSize: 11.5, color: AT.danger, marginTop: 4 }}>{text}</div>;
}

/** One pending row from GET /api/grading/review. */
interface ReviewItem {
  id: string;
  sku: string;
  title: string;
  condition: string;
  conditionNotes: string;
  conditionPresetIds: string[];
  presets: Array<{ id: string; textLv: string; textRu: string; textEn: string }>;
  graderName: string | null;
  gradedAt: string | null;
  photos: string[];
}

export function ReceivingScreen({ nav }: { nav: Nav }) {
  const { can } = useAuth();
  const { t } = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const [list, setList] = useState<Consignment[]>([]);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState({ supplier: "", marketCode: "LV", expected: "", notes: "" });
  const [active, setActive] = useState<Consignment | null>(null);
  const [received, setReceived] = useState<Item[]>([]);
  const [form, setForm] = useState(emptyReceive);
  const [busy, setBusy] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const titleRef = useRef<HTMLInputElement | null>(null);

  // R1: suppliers are records now — the same list feeds the picker, the
  // "Piegādātāji" tab and the attach box on older deliveries.
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [attachName, setAttachName] = useState("");
  const [attachBusy, setAttachBusy] = useState(false);

  const loadSuppliers = useCallback(() => {
    void api.get<{ suppliers: Supplier[] }>("/api/suppliers").then((r) => setSuppliers(r.suppliers)).catch(() => undefined);
  }, []);
  useEffect(loadSuppliers, [loadSuppliers]);

  // W6: delivery-level costs — finance-only, both endpoints 403 otherwise.
  const canCost = can("finance.view");
  const [extraCost, setExtraCost] = useState("");
  const [spreadTotal, setSpreadTotal] = useState("");
  const [costBusy, setCostBusy] = useState(false);

  // W2 grading review queue — only for reviewers; badge stays live over WS.
  const canReview = can("grading.review");
  const [tab, setTab] = useState<"deliveries" | "review" | "suppliers" | "bins" | "counts">("deliveries");
  const [pending, setPending] = useState<ReviewItem[]>([]);

  const loadReview = useCallback(() => {
    if (!canReview) return;
    void api.get<{ items: ReviewItem[] }>("/api/grading/review").then((r) => setPending(r.items)).catch(() => undefined);
  }, [canReview]);
  useEffect(loadReview, [loadReview]);
  useAuctionEvents(canReview ? "admin" : null, (ev) => {
    if (ev.type === "grade_review_pending" || ev.type === "grade_edited" || ev.type === "grade_rejected") loadReview();
  });

  const load = () => {
    void api.get<{ consignments: Consignment[] }>("/api/consignments").then((r) => setList(r.consignments)).catch(() => undefined);
  };
  useEffect(() => {
    load();
    void api.get<{ markets: Market[] }>("/api/markets").then((r) => setMarkets(r.markets)).catch(() => undefined);
  }, []);

  /** Re-read one delivery without touching the intake form the operator may
   * be halfway through typing. */
  const refreshDetail = (id: string) => {
    void api
      .get<{ consignment: Consignment; items: Item[] }>(`/api/consignments/${id}`)
      .then((r) => {
        setActive(r.consignment);
        setReceived(r.items);
        setExtraCost(centsToEur(r.consignment.extraCostCents));
      })
      .catch(() => undefined);
  };

  const openDetail = (id: string) => {
    setForm(emptyReceive);
    setSpreadTotal("");
    setExtraCost("");
    setAttachName("");
    refreshDetail(id);
  };

  /**
   * R1 — a typed name becomes an id: an existing record wins (case-insensitive),
   * a genuinely new name is created with the name alone. A 409 means someone
   * else got there first, which is exactly the collision this feature exists to
   * end — take the winner's id and say nothing. Anything else returns null and
   * the caller falls back to sending the name, which the API still links.
   */
  const resolveSupplierId = async (typed: string): Promise<string | null> => {
    const name = typed.trim();
    if (name.length < 2) return null;
    const hit = suppliers.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (hit) return hit.id;
    try {
      // Name only: terms and bank details are money data and belong to the
      // supplier drawer, where the finance block is gated.
      const r = await api.post<{ supplier: { id: string } }>("/api/suppliers", { name });
      loadSuppliers();
      return r.supplier.id;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && typeof err.body.supplierId === "string") {
        loadSuppliers();
        return err.body.supplierId;
      }
      return null;
    }
  };

  const create = async () => {
    if (createBusy) return;
    setCreateBusy(true);
    try {
      const supplierId = await resolveSupplierId(createForm.supplier);
      const r = await api.post<{ consignment: Consignment }>("/api/consignments", {
        supplier: createForm.supplier.trim(),
        ...(supplierId ? { supplierId } : {}),
        marketCode: createForm.marketCode,
        expectedCount: createForm.expected ? Number(createForm.expected) : 0,
        notes: createForm.notes,
      });
      toast(`${r.consignment.ref} ${t("rcv.tCreated")}`, "ok");
      setCreating(false);
      load();
      openDetail(r.consignment.id);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("rcv.createFailed"), "danger");
    } finally {
      setCreateBusy(false);
    }
  };

  /** Older deliveries the backfill could not match: attach one after the fact
   * so the delivery can carry its invoice. */
  const attachSupplier = async () => {
    if (!active || attachBusy) return;
    setAttachBusy(true);
    try {
      const supplierId = await resolveSupplierId(attachName);
      if (!supplierId) {
        toast(t("rcv.sup.attachFailed"), "danger");
        return;
      }
      const r = await api.patch<{ consignment: Consignment }>(`/api/consignments/${active.id}/supplier`, { supplierId });
      setActive((prev) => (prev ? { ...prev, ...r.consignment } : r.consignment));
      setAttachName("");
      toast(t("rcv.sup.attached"), "ok");
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("rcv.sup.attachFailed"), "danger");
    } finally {
      setAttachBusy(false);
    }
  };

  const needsNotes = conditionRequiresNotes(form.condition);
  // W6: a mistyped cost blocks intake rather than silently dropping the money.
  const intakeCost = canCost ? eurToCents(form.cost) : null;
  const canReceive =
    form.title.trim().length >= 2 && (!needsNotes || form.conditionNotes.trim().length >= 3) && intakeCost !== "bad";

  const receive = async (printAfter: boolean) => {
    if (!active || !canReceive || busy) return;
    const body: {
      title: string; condition: string; conditionNotes: string; category: string;
      weightGrams: number | null; costCents?: number;
    } = {
      title: form.title.trim(),
      condition: form.condition,
      conditionNotes: form.conditionNotes,
      category: form.category,
      weightGrams: form.weight ? Number(form.weight) : null,
    };
    // Only finance.view may send costCents (the API 403s otherwise); blank
    // stays unknown and is left out of the payload entirely.
    if (canCost && typeof intakeCost === "number") body.costCents = intakeCost;
    setBusy(true);
    try {
      const r = await api.post<{ item: Item }>(`/api/consignments/${active.id}/receive`, body);
      setReceived((prev) => [r.item, ...prev]);
      // Keep the grade for runs of identical stock; clear the per-unit fields
      // (the cost included — a pallet price belongs in "spread cost" below).
      setForm((f) => ({ ...f, title: "", conditionNotes: "", weight: "", cost: "" }));
      toast(`${r.item.sku} ${t("wh.received")}`, "ok");
      titleRef.current?.focus();
      if (printAfter) void openLabel(`/api/items/${r.item.id}/label`, (m) => toast(m, "danger"));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("wh.receiveFailed"), "danger");
    } finally {
      setBusy(false);
    }
  };

  const closeConsignment = async () => {
    if (!active) return;
    const expected = active.expectedCount;
    const r = await confirm({
      title: `${t("rcv.closeConsignment")} ${active.ref}?`,
      body:
        expected > 0 && received.length !== expected
          ? `${t("rcv.mismatchA")} ${expected} ${t("rcv.mismatchB")} ${received.length}. ${t("rcv.closeStops")}`
          : t("rcv.closeBody"),
      confirmLabel: t("rcv.closeConsignment"),
    });
    if (!r.ok) return;
    try {
      await api.post(`/api/consignments/${active.id}/close`);
      toast(`${active.ref} ${t("rcv.tClosed")}`, "ok");
      setActive({ ...active, status: "closed" });
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("rcv.closeFailed"), "danger");
    }
  };

  // ── W6: delivery costs ──────────────────────────────────────────────────────

  const extraParsed = eurToCents(extraCost);
  const extraChanged = extraParsed !== "bad" && extraParsed !== (active?.extraCostCents ?? null);
  const spreadParsed = eurToCents(spreadTotal);

  const saveExtraCost = async () => {
    // Never send an unparseable amount as null, and never re-send an
    // untouched value.
    if (!active || costBusy || extraParsed === "bad" || !extraChanged) return;
    setCostBusy(true);
    try {
      const r = await api.patch<{ consignment: Consignment }>(`/api/consignments/${active.id}/costs`, {
        extraCostCents: extraParsed,
      });
      setActive((prev) => (prev ? { ...prev, ...r.consignment } : r.consignment));
      setExtraCost(centsToEur(r.consignment.extraCostCents));
      toast(t("rcv.cost.saved"), "ok");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("rcv.cost.saveFailed"), "danger");
    } finally {
      setCostBusy(false);
    }
  };

  const spreadCost = async () => {
    if (!active || costBusy || typeof spreadParsed !== "number") return;
    const r = await confirm({
      title: `${t("rcv.cost.spread")} — ${active.ref}?`,
      body: t("rcv.cost.spreadBody"),
      confirmLabel: t("rcv.cost.spreadBtn"),
      danger: true,
    });
    if (!r.ok) return;
    setCostBusy(true);
    try {
      const res = await api.post<{ ok: boolean; units: number; perUnitCents: number }>(
        `/api/consignments/${active.id}/spread-cost`,
        { totalCents: spreadParsed },
      );
      toast(
        t("rcv.cost.spreadDone").replace("{n}", String(res.units)).replace("{eur}", formatEur(res.perUnitCents)),
        "ok",
      );
      setSpreadTotal("");
      refreshDetail(active.id);
    } catch (err) {
      const code = err instanceof ApiError ? err.message : "";
      toast(code === "no_items" ? t("rcv.cost.noUnits") : t("rcv.cost.spreadFailed"), "danger");
    } finally {
      setCostBusy(false);
    }
  };

  // ── Detail: intake station ──────────────────────────────────────────────────
  if (active) {
    const open = active.status === "open";
    return (
      <div style={{ display: "grid", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <ABtn kind="ghost" size="sm" onClick={() => { setActive(null); load(); }}>← {t("rcv.allDeliveries")}</ABtn>
          <h1 style={{ fontFamily: AT.body, fontSize: 20, fontWeight: 700, color: AT.ink }}>
            {active.ref} <span style={{ color: AT.inkSoft, fontWeight: 500 }}>· {active.supplier}</span>
          </h1>
          <ABadge tone={open ? "ok" : "neutral"}>{open ? t("rcv.stOpen") : t("rcv.stClosed")}</ABadge>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            {received.length > 0 && (
              <ABtn kind="ghost" size="sm" onClick={() => void openLabel(`/api/consignments/${active.id}/labels`, (m) => toast(m, "danger"))}>
                {t("rcv.printAllLabels")} ({received.length})
              </ABtn>
            )}
            {open && can("warehouse.manage") && (
              <ABtn kind="dark" size="sm" onClick={() => void closeConsignment()}>{t("rcv.closeConsignment")}</ABtn>
            )}
          </div>
        </div>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <AStat label={t("rcv.received")} value={received.length} />
          <AStat label={t("rcv.expected")} value={active.expectedCount || "—"} />
          <AStat label={t("c.market")} value={active.marketCode} />
        </div>

        {/* R1: no supplier record behind the typed name — nothing can be billed
            against this delivery until one is picked. */}
        {!active.supplierId && (
          <ACard title={t("rcv.sup.noneLinked")}>
            <div style={{ display: "grid", gap: 8 }}>
              <div style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft, lineHeight: 1.5 }}>
                {can("warehouse.manage") ? t("rcv.sup.attachHint") : t("rcv.sup.attachManagerOnly")}
              </div>
              {can("warehouse.manage") && (
                <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
                  <div style={{ width: 280 }}>
                    <AField label={t("rcv.supplier")}>
                      <SupplierPicker
                        value={attachName}
                        onChange={setAttachName}
                        options={suppliers}
                        listId="rcv-sup-attach"
                        placeholder={t("rcv.sup.pickPh")}
                      />
                    </AField>
                  </div>
                  <ABtn onClick={() => void attachSupplier()} disabled={attachBusy || attachName.trim().length < 2}>
                    {t("rcv.sup.attach")}
                  </ABtn>
                </div>
              )}
            </div>
          </ACard>
        )}

        {open && can("warehouse.manage") && (
          <ACard title={t("rcv.receiveNextUnit")}>
            <div style={{ display: "grid", gap: 12 }}>
              <AField label={t("c.title")}>
                <AInput
                  inputRef={titleRef}
                  value={form.title}
                  onChange={(v) => setForm({ ...form, title: v })}
                  placeholder={t("wh.titlePlaceholder")}
                />
              </AField>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 160px", gap: 12 }}>
                <AField label={t("c.condition")}>
                  <ASelect
                    value={form.condition}
                    onChange={(v) => setForm({ ...form, condition: v })}
                    options={CONDITIONS.map((c) => ({ value: c.code, label: c.requiresNotes ? `${c.label} — ${t("rcv.seeNotes")}` : c.label }))}
                  />
                </AField>
                <AField label={t("rcv.weightG")}>
                  <AInput value={form.weight} onChange={(v) => setForm({ ...form, weight: v })} placeholder="1200" />
                </AField>
              </div>
              <AField label={t("rcv.category")}>
                <ASelect value={form.category} onChange={(v) => setForm({ ...form, category: v })} options={CATEGORIES.map((c) => ({ value: c.code, label: c.label }))} />
              </AField>
              {/* The grade's description belongs directly under the grade —
                  the cost field goes after it, not between the two. */}
              {conditionByCode(form.condition) && (
                <div style={{ fontSize: 12, color: AT.inkSoft, marginTop: -6 }}>{conditionByCode(form.condition)!.description}</div>
              )}
              {canCost && (
                <AField label={t("rcv.cost.intake")} hint={t("rcv.cost.intakeHint")}>
                  <AInput
                    value={form.cost}
                    onChange={(v) => setForm({ ...form, cost: v })}
                    placeholder={t("rcv.cost.unknownPh")}
                    style={{ borderColor: intakeCost === "bad" ? AT.danger : undefined }}
                  />
                  <CostError show={intakeCost === "bad"} text={t("rcv.cost.badAmount")} />
                </AField>
              )}
              <AField
                label={needsNotes ? t("wh.condNotesRequired") : t("wh.condNotes")}
                hint={needsNotes ? t("rcv.condNotesHint") : t("rcv.optionalDot")}
              >
                <textarea
                  value={form.conditionNotes}
                  onChange={(e) => setForm({ ...form, conditionNotes: e.target.value })}
                  rows={2}
                  style={{
                    width: "100%", borderRadius: AT.radiusSm, fontFamily: AT.body, fontSize: 13, color: AT.ink, padding: 10, resize: "vertical",
                    border: `1px solid ${needsNotes && form.conditionNotes.trim().length < 3 ? "#C24" : AT.rule}`,
                  }}
                />
              </AField>
              <div style={{ display: "flex", gap: 8 }}>
                <ABtn onClick={() => void receive(true)} disabled={!canReceive || busy}>
                  <AIcon name="plus" size={14} color="#fff" /> {t("rcv.receivePlusLabel")}
                </ABtn>
                <ABtn kind="ghost" onClick={() => void receive(false)} disabled={!canReceive || busy}>{t("rcv.receiveOnly")}</ABtn>
              </div>
            </div>
          </ACard>
        )}

        {canCost && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14, alignItems: "start" }}>
            <ACard title={t("rcv.cost.card")}>
              <div style={{ display: "grid", gap: 18 }}>
                {/* Transport/cleaning for the whole pallet — pro-rata at report time. */}
                <div style={{ display: "grid", gap: 6 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
                    <div style={{ width: 190 }}>
                      <AField label={t("rcv.cost.extra")}>
                        <AInput
                          value={extraCost}
                          onChange={setExtraCost}
                          placeholder={t("rcv.cost.unknownPh")}
                          style={{ borderColor: extraParsed === "bad" ? AT.danger : undefined }}
                        />
                      </AField>
                    </div>
                    <ABtn
                      kind="ghost"
                      onClick={() => void saveExtraCost()}
                      disabled={costBusy || extraParsed === "bad" || !extraChanged}
                    >{t("c.save")}</ABtn>
                  </div>
                  <CostError show={extraParsed === "bad"} text={t("rcv.cost.badAmount")} />
                  <div style={{ fontFamily: AT.body, fontSize: 11.5, color: AT.inkSoft, lineHeight: 1.5 }}>
                    {t("rcv.cost.extraHint")}
                  </div>
                </div>

                {/* Pallet price → per-unit cost on every item in the delivery. */}
                <div style={{ display: "grid", gap: 6, borderTop: `1px solid ${AT.ruleSoft}`, paddingTop: 14 }}>
                  <div style={{ fontFamily: AT.body, fontSize: 13, fontWeight: 700, color: AT.ink }}>{t("rcv.cost.spread")}</div>
                  <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
                    <div style={{ width: 190 }}>
                      <AField label={t("rcv.cost.spreadField")}>
                        <AInput
                          value={spreadTotal}
                          onChange={setSpreadTotal}
                          placeholder="0,00"
                          style={{ borderColor: spreadParsed === "bad" ? AT.danger : undefined }}
                        />
                      </AField>
                    </div>
                    <ABtn
                      kind="dark"
                      onClick={() => void spreadCost()}
                      disabled={costBusy || typeof spreadParsed !== "number" || received.length === 0}
                    >{t("rcv.cost.spreadBtn")}</ABtn>
                  </div>
                  <CostError show={spreadParsed === "bad"} text={t("rcv.cost.badAmount")} />
                  <div style={{ fontFamily: AT.body, fontSize: 11.5, color: AT.inkSoft, lineHeight: 1.5 }}>
                    {t("rcv.cost.spreadHint").replace("{n}", String(received.length))}
                  </div>
                </div>
              </div>
            </ACard>

            {/* R1: the supplier's bill for this delivery, next to what we
                recorded ourselves — the two are meant to be read together. */}
            <SupplierInvoiceCard key={active.id} consignmentId={active.id} hasSupplier={!!active.supplierId} nav={nav} />
          </div>
        )}

        <ACard title={`${t("rcv.receivedItems")} (${received.length})`} pad={false}>
          {received.length === 0 ? (
            <AEmpty text={t("rcv.noneReceived")} />
          ) : (
            <ATable head={["SKU", t("c.title"), t("c.condition"), t("rcv.weight"), ...(canCost ? [t("rcv.itemCost")] : []), ""]}>
              {received.map((i) => (
                <ATr key={i.id}>
                  <ATd mono>{i.sku}</ATd>
                  <ATd><span style={{ fontWeight: 600 }}>{i.title}</span></ATd>
                  <ATd>{conditionByCode(i.condition)?.label ?? i.condition}</ATd>
                  <ATd right>{i.weightGrams == null ? "—" : `${i.weightGrams} g`}</ATd>
                  {canCost && (
                    <ATd right mono>
                      {(i as ItemWithCost).costCents == null ? "—" : formatEur((i as ItemWithCost).costCents!)}
                    </ATd>
                  )}
                  <ATd right>
                    <ABtn size="sm" kind="ghost" onClick={() => void openLabel(`/api/items/${i.id}/label`, (m) => toast(m, "danger"))}>{t("rcv.label")}</ABtn>
                  </ATd>
                </ATr>
              ))}
            </ATable>
          )}
        </ACard>
      </div>
    );
  }

  // ── Master list ─────────────────────────────────────────────────────────────
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <h1 style={{ fontFamily: AT.body, fontSize: 20, fontWeight: 700, color: AT.ink }}>{t("rcv.title")}</h1>
        <div style={{ display: "flex", gap: 8 }}>
          {can("warehouse.manage") && (
            <ABtn kind="ghost" onClick={() => void openLabel("/api/warehouse/locations/labels", (m) => toast(m, "danger"))}>{t("rcv.printBinLabels")}</ABtn>
          )}
          {can("warehouse.manage") && (
            <ABtn onClick={() => { setCreateForm({ supplier: "", marketCode: "LV", expected: "", notes: "" }); setCreating(true); }}>
              <AIcon name="plus" size={15} color="#fff" /> {t("rcv.newDelivery")}
            </ABtn>
          )}
        </div>
      </div>

      <APills
        options={[
          { id: "deliveries" as const, label: t("rcv.tabDeliveries"), count: list.length },
          ...(canReview ? [{ id: "review" as const, label: t("rcv.tabReview"), count: pending.length }] : []),
          { id: "suppliers" as const, label: t("rcv.sup.tab"), count: suppliers.length },
          { id: "bins" as const, label: t("wh.bins") },
          { id: "counts" as const, label: t("rc.cnt.tab") },
        ]}
        value={tab}
        onChange={setTab}
      />

      {canReview && tab === "review" ? (
        <GradingReviewQueue items={pending} reload={loadReview} />
      ) : tab === "suppliers" ? (
        <SuppliersTab list={suppliers} reload={loadSuppliers} />
      ) : tab === "bins" ? (
        <BinsBrowser nav={nav} />
      ) : tab === "counts" ? (
        <StockCountsTab />
      ) : (
        <ACard pad={false}>
          {list.length === 0 ? (
            <AEmpty text={t("rcv.noDeliveries")} />
          ) : (
            <ATable head={[t("rcv.ref"), t("rcv.supplier"), t("c.market"), t("rcv.received"), t("c.status"), t("rcv.created")]}>
              {list.map((c) => (
                <ATr key={c.id} onClick={() => openDetail(c.id)}>
                  <ATd mono>{c.ref}</ATd>
                  <ATd><span style={{ fontWeight: 600 }}>{c.supplier}</span></ATd>
                  <ATd>{c.marketCode}</ATd>
                  <ATd right>{c.receivedCount ?? 0}{c.expectedCount ? ` / ${c.expectedCount}` : ""}</ATd>
                  <ATd><ABadge tone={c.status === "open" ? "ok" : "neutral"}>{c.status === "open" ? t("rcv.stOpen") : t("rcv.stClosed")}</ABadge></ATd>
                  <ATd>{formatDate(c.createdAt)}</ATd>
                </ATr>
              ))}
            </ATable>
          )}
        </ACard>
      )}

      {creating && (
        <ADrawer
          title={t("rcv.newDelivery")}
          onClose={() => setCreating(false)}
          footer={
            <>
              <ABtn kind="ghost" onClick={() => setCreating(false)}>{t("c.cancel")}</ABtn>
              <ABtn onClick={() => void create()} disabled={createBusy || createForm.supplier.trim().length < 2}>{t("c.create")}</ABtn>
            </>
          }
        >
          <div style={{ display: "grid", gap: 14 }}>
            {/* R1: still free text — but every name that already exists is one
                keystroke away, so the same supplier stops being typed three
                different ways. */}
            <AField label={t("rcv.supplier")} hint={t("rcv.sup.pickHint")}>
              <SupplierPicker
                value={createForm.supplier}
                onChange={(v) => setCreateForm({ ...createForm, supplier: v })}
                options={suppliers}
                listId="rcv-sup-create"
                placeholder={t("rcv.sup.pickPh")}
              />
            </AField>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <AField label={t("c.market")}>
                <ASelect value={createForm.marketCode} onChange={(v) => setCreateForm({ ...createForm, marketCode: v })} options={markets.map((m) => ({ value: m.code, label: m.code }))} />
              </AField>
              <AField label={t("rcv.expectedUnits")} hint={t("rcv.expectedHint")}>
                <AInput value={createForm.expected} onChange={(v) => setCreateForm({ ...createForm, expected: v })} placeholder="0" />
              </AField>
            </div>
            <AField label={t("c.notes")}>
              <textarea value={createForm.notes} onChange={(e) => setCreateForm({ ...createForm, notes: e.target.value })} rows={3} style={{
                width: "100%", borderRadius: AT.radiusSm, border: `1px solid ${AT.rule}`, fontFamily: AT.body, fontSize: 13, color: AT.ink, padding: 10, resize: "vertical",
              }} />
            </AField>
          </div>
        </ADrawer>
      )}
    </div>
  );
}

// ── W2: Grading review queue ─────────────────────────────────────────────────

const REJECT_REASONS = ["rcv.rjPhotos", "rcv.rjWrongGrade", "rcv.rjNotes", "rcv.rjRecheck", "wh.chipOther"] as const;
type RejectReason = (typeof REJECT_REASONS)[number];

const chipText = (p: { textLv: string; textRu: string; textEn: string }, lang: Lang): string =>
  lang === "lv" ? p.textLv : lang === "ru" ? p.textRu : p.textEn;

const reviewThumb = (u: string) => (u.includes("-web.webp") ? u.replace("-web.webp", "-thumb.webp") : u);

function GradingReviewQueue({ items, reload }: { items: ReviewItem[]; reload: () => void }) {
  const toast = useToast();
  const { t, lang } = useT();
  const [presets, setPresets] = useState<ConditionPreset[]>([]);
  const [editing, setEditing] = useState<ReviewItem | null>(null);
  const [editForm, setEditForm] = useState({ condition: "", notes: "", picked: new Set<string>() });
  const [rejecting, setRejecting] = useState<ReviewItem | null>(null);
  const [rejectPill, setRejectPill] = useState<RejectReason | null>(null);
  const [rejectOther, setRejectOther] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.get<{ presets: ConditionPreset[] }>("/api/condition-presets").then((r) => setPresets(r.presets)).catch(() => undefined);
  }, []);

  const approve = async (it: ReviewItem) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.post(`/api/grading/${it.id}/approve`);
      toast(`${it.sku} ${t("rcv.tApproved")}`, "ok");
      reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("rcv.approveFailed"), "danger");
    } finally {
      setBusy(false);
    }
  };

  const openEdit = (it: ReviewItem) => {
    setEditing(it);
    setEditForm({ condition: it.condition, notes: it.conditionNotes ?? "", picked: new Set(it.conditionPresetIds) });
  };

  const editChips = presets.filter((p) => p.conditionCode === editForm.condition);
  const editPickedIds = editChips.filter((p) => editForm.picked.has(p.id)).map((p) => p.id);
  const editOk =
    !conditionRequiresNotes(editForm.condition) || editForm.notes.trim().length >= 3 || editPickedIds.length > 0;

  const saveEdit = async () => {
    if (!editing || !editOk || busy) return;
    setBusy(true);
    try {
      await api.post(`/api/grading/${editing.id}/edit`, {
        condition: editForm.condition,
        conditionNotes: editForm.notes,
        conditionPresetIds: editPickedIds,
      });
      toast(`${editing.sku} ${t("rcv.tApprovedEdits")}`, "ok");
      setEditing(null);
      reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("rcv.editFailed"), "danger");
    } finally {
      setBusy(false);
    }
  };

  const rejectReason = (rejectPill === "wh.chipOther" ? rejectOther.trim() : rejectPill ? t(rejectPill) : "").slice(0, 300);
  const rejectOk = rejectReason.length >= 2;

  const doReject = async () => {
    if (!rejecting || !rejectOk || busy) return;
    setBusy(true);
    try {
      await api.post(`/api/grading/${rejecting.id}/reject`, { reason: rejectReason });
      toast(`${rejecting.sku} ${t("rcv.tRejected")}`, "ok");
      setRejecting(null);
      setRejectPill(null);
      setRejectOther("");
      reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("rcv.rejectFailed"), "danger");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {items.length === 0 && (
        <ACard pad={false}>
          <AEmpty text={t("rcv.reviewEmpty")} />
        </ACard>
      )}
      {items.map((it) => (
        <ACard key={it.id}>
          <div style={{ display: "grid", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontFamily: AT.mono, fontSize: 14, fontWeight: 800, color: AT.ink }}>{it.sku}</span>
              <ABadge tone="warn">{conditionByCode(it.condition)?.label ?? it.condition}</ABadge>
              <span style={{ marginLeft: "auto", fontFamily: AT.body, fontSize: 12, color: AT.inkSoft }}>
                {it.graderName ?? "?"}{it.gradedAt ? ` · ${formatDate(it.gradedAt)}` : ""}
              </span>
            </div>
            <div style={{ fontFamily: AT.body, fontSize: 14, fontWeight: 600, color: AT.ink }}>{it.title}</div>
            {it.photos.length > 0 && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {it.photos.slice(0, 8).map((p) => (
                  <a key={p} href={p} target="_blank" rel="noreferrer">
                    <img src={reviewThumb(p)} alt="" style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 8, border: `1px solid ${AT.rule}`, display: "block" }} />
                  </a>
                ))}
                {it.photos.length > 8 && (
                  <span style={{ fontFamily: AT.body, fontSize: 12, color: AT.inkSoft, alignSelf: "center" }}>+{it.photos.length - 8}</span>
                )}
              </div>
            )}
            {it.presets.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {it.presets.map((p) => (
                  <span key={p.id} style={{
                    fontFamily: AT.body, fontSize: 12, fontWeight: 600, color: AT.accent,
                    background: AT.accentSoft, borderRadius: 999, padding: "4px 10px",
                  }}>{chipText(p, lang)}</span>
                ))}
              </div>
            )}
            {it.conditionNotes.trim().length > 0 && (
              <div style={{ fontFamily: AT.body, fontSize: 13, color: AT.inkSoft, fontStyle: "italic" }}>{it.conditionNotes}</div>
            )}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <ABtn size="sm" onClick={() => void approve(it)} disabled={busy}>{t("rcv.approve")}</ABtn>
              <ABtn size="sm" kind="ghost" onClick={() => openEdit(it)} disabled={busy}>{t("rcv.editGrading")}</ABtn>
              <ABtn size="sm" kind="danger" onClick={() => { setRejecting(it); setRejectPill(null); setRejectOther(""); }} disabled={busy}>{t("rcv.reject")}</ABtn>
            </div>
          </div>
        </ACard>
      ))}

      {editing && (
        <ADrawer
          title={<span>{t("rcv.editGradingTitle")} <span style={{ fontFamily: AT.mono, fontSize: 12, color: AT.inkSoft }}>{editing.sku}</span></span>}
          onClose={() => setEditing(null)}
          footer={
            <>
              <ABtn kind="ghost" onClick={() => setEditing(null)}>{t("c.cancel")}</ABtn>
              <ABtn onClick={() => void saveEdit()} disabled={!editOk || busy}>{t("rcv.saveApprove")}</ABtn>
            </>
          }
        >
          <div style={{ display: "grid", gap: 14 }}>
            <AField label={t("c.condition")}>
              <ASelect
                value={editForm.condition}
                onChange={(v) => setEditForm((f) => ({ ...f, condition: v }))}
                options={[
                  ...(conditionByCode(editForm.condition) ? [] : [{ value: editForm.condition, label: `${editForm.condition} (${t("rcv.legacy")})` }]),
                  ...CONDITIONS.map((c) => ({ value: c.code, label: c.requiresNotes ? `${c.label} — ${t("rcv.seeNotes")}` : c.label })),
                ]}
              />
            </AField>
            {editChips.length > 0 && (
              <AField label={t("wh.presetNotes")}>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {editChips.map((p) => {
                    const on = editForm.picked.has(p.id);
                    return (
                      <button
                        key={p.id}
                        onClick={() => setEditForm((f) => {
                          const picked = new Set(f.picked);
                          if (picked.has(p.id)) picked.delete(p.id);
                          else picked.add(p.id);
                          return { ...f, picked };
                        })}
                        style={{
                          all: "unset", boxSizing: "border-box", cursor: "pointer", padding: "6px 12px", borderRadius: 999,
                          fontFamily: AT.body, fontSize: 12.5, fontWeight: 600,
                          background: on ? AT.ink : AT.panel, color: on ? "#fff" : AT.ink,
                          border: `1px solid ${on ? AT.ink : AT.rule}`,
                        }}
                      >{chipText(p, lang)}</button>
                    );
                  })}
                </div>
              </AField>
            )}
            <AField
              label={conditionRequiresNotes(editForm.condition) && editPickedIds.length === 0 ? t("wh.condNotesRequired") : t("wh.condNotes")}
              hint={t("rcv.editNotesHint")}
            >
              <textarea
                value={editForm.notes}
                onChange={(e) => setEditForm((f) => ({ ...f, notes: e.target.value }))}
                rows={3}
                style={{
                  width: "100%", borderRadius: AT.radiusSm, fontFamily: AT.body, fontSize: 13, color: AT.ink,
                  padding: 10, resize: "vertical", border: `1px solid ${editOk ? AT.rule : "#C24"}`,
                }}
              />
            </AField>
          </div>
        </ADrawer>
      )}

      {rejecting && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 80, display: "grid", placeItems: "center", background: "rgba(10,10,10,0.4)" }}
          onClick={() => setRejecting(null)}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ width: 440, maxWidth: "92vw", background: AT.panel, borderRadius: AT.radius, padding: 20, display: "grid", gap: 12 }}>
            <h2 style={{ fontFamily: AT.body, fontSize: 15.5, fontWeight: 700, color: AT.ink }}>
              {t("rcv.reject")} {rejecting.sku}?
            </h2>
            <p style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft, lineHeight: 1.5 }}>
              {t("rcv.rejectBody")}
            </p>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {REJECT_REASONS.map((r) => (
                <button
                  key={r}
                  onClick={() => setRejectPill(r)}
                  style={{
                    all: "unset", boxSizing: "border-box", cursor: "pointer", padding: "7px 12px", borderRadius: 999,
                    fontFamily: AT.body, fontSize: 12.5, fontWeight: 600,
                    background: rejectPill === r ? AT.ink : AT.panel, color: rejectPill === r ? "#fff" : AT.ink,
                    border: `1px solid ${rejectPill === r ? AT.ink : AT.rule}`,
                  }}
                >{t(r)}</button>
              ))}
            </div>
            {rejectPill === "wh.chipOther" && (
              <AInput value={rejectOther} onChange={setRejectOther} placeholder={t("rcv.rejectWhy")} autoFocus />
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <ABtn kind="ghost" onClick={() => setRejecting(null)}>{t("c.cancel")}</ABtn>
              <ABtn kind="danger" onClick={() => void doReject()} disabled={!rejectOk || busy}>{t("rcv.rejectGrade")}</ABtn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── W5/W6: Stock counts ("Inventarizācija") ──────────────────────────────────

type CountStatus = "open" | "approved" | "cancelled";

interface StockCount {
  id: string;
  name: string;
  status: CountStatus;
  startedAt: string;
  binCount: number;
  doneCount: number;
  scanCount: number;
  zones: string[];
  /** Set once a manager approves; the diff then reads from the snapshot. */
  approvedAt?: string | null;
  approvedByName?: string | null;
}

type Outcome = "match" | "wrong_bin" | "missing" | "moved_during" | "unknown_label";

interface DiffLine {
  outcome: Outcome;
  itemId: string | null;
  sku: string | null;
  title: string | null;
  expectedLabel: string | null;
  foundLabel: string | null;
  code: string | null;
  /** Scanned in more than one bin during the session — the found bin below is
   * one observation of several. */
  multipleBins?: boolean;
}

interface CountDiff {
  count: StockCount;
  tally: Record<Outcome, number>;
  lines: DiffLine[];
}

const COUNT_STATUS: Record<CountStatus, { key: TKey; tone: Tone }> = {
  open: { key: "rc.cnt.stOpen", tone: "accent" },
  approved: { key: "rc.cnt.stApproved", tone: "ok" },
  cancelled: { key: "rc.cnt.stCancelled", tone: "neutral" },
};

const OUTCOME_META: Record<Outcome, { key: TKey; tone: Tone }> = {
  match: { key: "rc.cnt.match", tone: "ok" },
  wrong_bin: { key: "rc.cnt.wrongBin", tone: "warn" },
  missing: { key: "rc.cnt.missing", tone: "danger" },
  moved_during: { key: "rc.cnt.movedDuring", tone: "neutral" },
  unknown_label: { key: "rc.cnt.unknown", tone: "danger" },
};

function StockCountsTab() {
  const { can } = useAuth();
  const { t } = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const [counts, setCounts] = useState<StockCount[]>([]);
  const [zones, setZones] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createZones, setCreateZones] = useState<Set<string>>(new Set());
  /** The opened session. Floor staff get this far and no further — the diff is
   * the count's answer key, so /diff is manager-only (blind counting). */
  const [selected, setSelected] = useState<StockCount | null>(null);
  const [diff, setDiff] = useState<CountDiff | null>(null);
  const [showMatches, setShowMatches] = useState(false);
  const [busy, setBusy] = useState(false);

  const canManage = can("warehouse.manage");
  const canReviewDiff = can("grading.review");

  const load = useCallback(() => {
    void api.get<{ counts: StockCount[] }>("/api/stock-counts").then((r) => setCounts(r.counts)).catch(() => undefined);
  }, []);
  useEffect(load, [load]);

  // Distinct zone names for the create form, from the active bin list.
  useEffect(() => {
    void api
      .get<{ locations: Array<{ zone: string; active: boolean }> }>("/api/warehouse/locations")
      .then((r) => setZones([...new Set(r.locations.filter((l) => l.active).map((l) => l.zone))].sort()))
      .catch(() => undefined);
  }, []);

  /** Manager-only. For an approved/cancelled session the API replies from the
   * snapshot it stored at approval, so the list keeps showing the corrections
   * that were made instead of recomputing itself empty. */
  const loadDiff = useCallback((id: string) => {
    void api
      .get<CountDiff>(`/api/stock-counts/${id}/diff`)
      .then((d) => {
        setDiff(d);
        setSelected((prev) => {
          // The diff endpoint returns the bare session row — keep the progress
          // numbers only the list endpoint computes.
          const progress =
            prev && prev.id === d.count.id
              ? { binCount: prev.binCount, doneCount: prev.doneCount, scanCount: prev.scanCount }
              : { binCount: 0, doneCount: 0, scanCount: 0 };
          return { ...progress, ...d.count };
        });
      })
      .catch(() => undefined);
  }, []);

  const openDetail = (c: StockCount) => {
    setSelected(c);
    setDiff(null);
    setShowMatches(false);
    if (canReviewDiff) loadDiff(c.id);
  };

  const create = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.post<{ count: StockCount }>("/api/stock-counts", { name: createName.trim(), zones: [...createZones] });
      toast(`${createName.trim()} ${t("rc.cnt.tStarted")}`, "ok");
      setCreating(false);
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("rc.cnt.startFailed"), "danger");
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    if (!selected || busy) return;
    const r = await confirm({
      title: `${t("rc.cnt.approveBtn")} — ${selected.name}?`,
      body: t("rc.cnt.approveBody"),
      confirmLabel: t("rc.cnt.approveBtn"),
    });
    if (!r.ok) return;
    setBusy(true);
    try {
      const res = await api.post<{ ok: boolean; moved: number; missing: number }>(`/api/stock-counts/${selected.id}/approve`);
      toast(`${t("rc.cnt.tApproved")} — ${res.moved} ${t("rc.cnt.movedN")}, ${res.missing} ${t("rc.cnt.missingN")}`, "ok");
      setSelected((prev) => (prev ? { ...prev, status: "approved" } : prev));
      load();
      // Same endpoint, snapshot answer — the corrected lines stay on screen.
      loadDiff(selected.id);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("rcv.approveFailed"), "danger");
    } finally {
      setBusy(false);
    }
  };

  const cancelCount = async () => {
    if (!selected || busy) return;
    const r = await confirm({
      title: `${t("rc.cnt.cancelBtn")} — ${selected.name}?`,
      body: t("rc.cnt.cancelBody"),
      confirmLabel: t("rc.cnt.cancelBtn"),
      danger: true,
    });
    if (!r.ok) return;
    setBusy(true);
    try {
      await api.post(`/api/stock-counts/${selected.id}/cancel`);
      toast(`${selected.name} ${t("rc.cnt.tCancelled")}`, "ok");
      setSelected((prev) => (prev ? { ...prev, status: "cancelled" } : prev));
      load();
      loadDiff(selected.id);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("rc.cnt.cancelFailed"), "danger");
    } finally {
      setBusy(false);
    }
  };

  const exportDiff = () => {
    if (!diff || !canReviewDiff) return;
    exportCSV(
      "stock-count-diff",
      ["SKU", t("c.title"), t("rc.cnt.expectedCol"), t("rc.cnt.foundCol"), t("rc.cnt.outcome")],
      diff.lines.map((l) => [
        l.sku ?? l.code ?? "",
        l.title ?? "",
        l.expectedLabel ?? "",
        `${l.foundLabel ?? ""}${l.multipleBins ? ` (${t("rc.cnt.multiBins")})` : ""}`,
        t(OUTCOME_META[l.outcome].key),
      ]),
    );
  };

  // ── Detail: one session ─────────────────────────────────────────────────────
  if (selected) {
    const c = selected;
    const st = COUNT_STATUS[c.status];
    const open = c.status === "open";
    const lines = diff ? (showMatches ? diff.lines : diff.lines.filter((l) => l.outcome !== "match")) : [];
    return (
      <div style={{ display: "grid", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <ABtn kind="ghost" size="sm" onClick={() => { setSelected(null); setDiff(null); setShowMatches(false); load(); }}>← {t("rc.cnt.all")}</ABtn>
          <h1 style={{ fontFamily: AT.body, fontSize: 20, fontWeight: 700, color: AT.ink }}>
            {c.name} <span style={{ color: AT.inkSoft, fontWeight: 500 }}>· {t("rc.cnt.started").toLowerCase()} {formatDate(c.startedAt)}</span>
          </h1>
          <ABadge tone={st.tone}>{t(st.key)}</ABadge>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            {/* Every action below reads the answer key — managers only. */}
            {canReviewDiff && diff && (
              <ABtn kind="ghost" size="sm" onClick={exportDiff}>{t("rc.cnt.csv")}</ABtn>
            )}
            {open && canReviewDiff && canManage && (
              <ABtn kind="danger" size="sm" onClick={() => void cancelCount()} disabled={busy}>{t("rc.cnt.cancelBtn")}</ABtn>
            )}
            {open && canReviewDiff && (
              <ABtn kind="dark" size="sm" onClick={() => void approve()} disabled={busy}>{t("rc.cnt.approveBtn")}</ABtn>
            )}
          </div>
        </div>

        {/* The wording points at the list below, so it is for its readers. */}
        {c.status === "approved" && canReviewDiff && (
          <div style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft, lineHeight: 1.5 }}>
            {t("rc.cnt.approvedNote")}
            {c.approvedAt ? ` · ${formatDate(c.approvedAt)}` : ""}
            {c.approvedByName ? ` · ${t("rc.cnt.approvedByLbl")} ${c.approvedByName}` : ""}
          </div>
        )}
        {c.status === "cancelled" && (
          <div style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft, lineHeight: 1.5 }}>{t("rc.cnt.cancelledNote")}</div>
        )}

        {/* Progress is not the answer key — floor staff see it too. */}
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <AStat label={t("rc.cnt.progress")} value={`${c.doneCount} / ${c.binCount}`} sub={t("rcv.binsWord")} />
          <AStat label={t("rc.cnt.scans")} value={c.scanCount} />
          <AStat label={t("rc.cnt.zones")} value={c.zones.length > 0 ? c.zones.join(", ") : t("rc.cnt.wholeWh")} />
        </div>

        {!canReviewDiff ? (
          <div style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft, lineHeight: 1.5 }}>{t("rc.cnt.managerOnly")}</div>
        ) : diff ? (
          <>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <AStat label={t("rc.cnt.match")} value={diff.tally.match} tone="ok" />
              <AStat label={t("rc.cnt.wrongBin")} value={diff.tally.wrong_bin} tone="warn" />
              <AStat label={t("rc.cnt.missing")} value={diff.tally.missing} tone="danger" />
              <AStat label={t("rc.cnt.movedDuring")} value={diff.tally.moved_during} />
              <AStat label={t("rc.cnt.unknown")} value={diff.tally.unknown_label} tone="danger" />
            </div>

            <label style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: AT.body, fontSize: 13, color: AT.ink, cursor: "pointer", width: "fit-content" }}>
              <input type="checkbox" checked={showMatches} onChange={() => setShowMatches((v) => !v)} />
              {t("rc.cnt.showMatches")}
            </label>

            <ACard pad={false}>
              {lines.length === 0 ? (
                <AEmpty text={t("rc.cnt.noDiff")} />
              ) : (
                <ATable head={["SKU", t("c.title"), t("rc.cnt.expectedCol"), t("rc.cnt.foundCol"), t("rc.cnt.outcome")]}>
                  {lines.map((l, i) => {
                    const om = OUTCOME_META[l.outcome];
                    return (
                      <ATr key={`${l.itemId ?? l.code ?? "line"}-${i}`}>
                        <ATd mono>{l.sku ?? l.code ?? "—"}</ATd>
                        <ATd><span style={{ fontWeight: 600 }}>{l.title ?? "—"}</span></ATd>
                        <ATd mono>{l.expectedLabel ?? "—"}</ATd>
                        <ATd mono>
                          {l.foundLabel ?? "—"}
                          {l.multipleBins && (
                            <span title={t("rc.cnt.multiBinsHint")} style={{ marginLeft: 6 }}>
                              <ABadge tone="warn">⚠ {t("rc.cnt.multiBins")}</ABadge>
                            </span>
                          )}
                        </ATd>
                        <ATd><ABadge tone={om.tone}>{t(om.key)}</ABadge></ATd>
                      </ATr>
                    );
                  })}
                </ATable>
              )}
            </ACard>
          </>
        ) : null}
      </div>
    );
  }

  // ── Sessions list ───────────────────────────────────────────────────────────
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {canManage && (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <ABtn onClick={() => {
            setCreateName(`${t("rc.cnt.tab")} ${new Date().toISOString().slice(0, 10)}`);
            setCreateZones(new Set());
            setCreating(true);
          }}>
            <AIcon name="plus" size={15} color="#fff" /> {t("rc.cnt.start")}
          </ABtn>
        </div>
      )}

      <ACard pad={false}>
        {counts.length === 0 ? (
          <AEmpty text={t("rc.cnt.empty")} />
        ) : (
          <ATable head={[t("rc.cnt.name"), t("rc.cnt.started"), t("rc.cnt.zones"), t("rc.cnt.progress"), t("rc.cnt.scans"), t("c.status")]}>
            {counts.map((c) => {
              const st = COUNT_STATUS[c.status];
              return (
                <ATr key={c.id} onClick={() => openDetail(c)}>
                  <ATd><span style={{ fontWeight: 600 }}>{c.name}</span></ATd>
                  <ATd>{formatDate(c.startedAt)}</ATd>
                  <ATd>{c.zones.length > 0 ? c.zones.join(", ") : t("rc.cnt.wholeWh")}</ATd>
                  <ATd right>{c.doneCount} / {c.binCount} {t("rcv.binsWord")}</ATd>
                  <ATd right>{c.scanCount}</ATd>
                  <ATd><ABadge tone={st.tone}>{t(st.key)}</ABadge></ATd>
                </ATr>
              );
            })}
          </ATable>
        )}
      </ACard>

      {creating && (
        <ADrawer
          title={t("rc.cnt.start")}
          onClose={() => setCreating(false)}
          footer={
            <>
              <ABtn kind="ghost" onClick={() => setCreating(false)}>{t("c.cancel")}</ABtn>
              <ABtn onClick={() => void create()} disabled={createName.trim().length < 2 || busy}>{t("rc.cnt.start")}</ABtn>
            </>
          }
        >
          <div style={{ display: "grid", gap: 14 }}>
            <AField label={t("rc.cnt.name")}>
              <AInput value={createName} onChange={setCreateName} />
            </AField>
            <AField label={t("rc.cnt.zones")} hint={t("rc.cnt.zonesHint")}>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {zones.map((z) => {
                  const on = createZones.has(z);
                  return (
                    <button
                      key={z}
                      onClick={() => setCreateZones((prev) => {
                        const next = new Set(prev);
                        if (next.has(z)) next.delete(z);
                        else next.add(z);
                        return next;
                      })}
                      style={{
                        all: "unset", boxSizing: "border-box", cursor: "pointer", padding: "6px 12px", borderRadius: 999,
                        fontFamily: AT.body, fontSize: 12.5, fontWeight: 600,
                        background: on ? AT.ink : AT.panel, color: on ? "#fff" : AT.ink,
                        border: `1px solid ${on ? AT.ink : AT.rule}`,
                      }}
                    >{z}</button>
                  );
                })}
              </div>
            </AField>
          </div>
        </ADrawer>
      )}
    </div>
  );
}

// ── R1: suppliers ("Piegādātāji", fifth Receiving tab) ───────────────────────

interface SupplierForm {
  name: string;
  regNo: string;
  vatNo: string;
  email: string;
  phone: string;
  address: string;
  notes: string;
  /** Finance-only fields — never sent by a caller without finance.view. */
  bankAccount: string;
  contactName: string;
  lang: string;
  model: string;
  commission: string;
  terms: string;
  active: boolean;
}

const emptySupplierForm: SupplierForm = {
  name: "", regNo: "", vatNo: "", email: "", phone: "", address: "", notes: "",
  bankAccount: "", terms: "", active: true,
  contactName: "", lang: "lv", model: "buyout", commission: "",
};

/** Text fields the API accepts from any warehouse manager. */
type SupplierTextKey = "name" | "regNo" | "vatNo" | "email" | "phone" | "address" | "notes" | "bankAccount" | "contactName";

function SuppliersTab({ list, reload }: { list: Supplier[]; reload: () => void }) {
  const { can } = useAuth();
  const { t } = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const canManage = can("warehouse.manage");
  // Terms, bank details and what we owe are money data: the API strips them
  // from the list for everyone else, so the block is not rendered at all.
  const canMoney = can("finance.view");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Supplier | null>(null);
  const [form, setForm] = useState<SupplierForm>(emptySupplierForm);
  const [busy, setBusy] = useState(false);

  const openNew = () => {
    setEditing(null);
    setForm(emptySupplierForm);
    setOpen(true);
  };

  const openEdit = (s: Supplier) => {
    setEditing(s);
    setForm({
      name: s.name,
      regNo: s.regNo ?? "",
      vatNo: s.vatNo ?? "",
      email: s.email ?? "",
      phone: s.phone ?? "",
      address: s.address ?? "",
      notes: s.notes ?? "",
      bankAccount: s.bankAccount ?? "",
      terms: String(s.paymentTermsDays),
      active: s.active,
      contactName: s.contactName ?? "",
      lang: s.lang ?? "lv",
      model: s.model ?? "buyout",
      commission: s.commissionBp ? String(Math.round(s.commissionBp / 100)) : "",
    });
    setOpen(true);
  };

  const days = parseTermsDays(form.terms);
  const canSave = !busy && form.name.trim().length >= 2 && !(canMoney && days === "bad");

  /** Приглашение в кабинет: письмо со ссылкой на установку пароля. */
  const invite = async () => {
    if (!editing) return;
    try {
      const r = await api.post<{ sentTo: string }>(`/api/suppliers/${editing.id}/invite`);
      toast(`${t("rcv.sup.inviteSent")} ${r.sentTo}`, "ok");
    } catch {
      toast(t("rcv.sup.saveFailed"), "danger");
    }
  };

  /** Подтверждение или отказ по заявленной смене банковского счёта. */
  const decideBank = async (decision: "approve" | "reject") => {
    if (!editing) return;
    try {
      await api.post(`/api/suppliers/${editing.id}/bank-change`, { decision });
      toast(t("rcv.sup.saved"), "ok");
      setOpen(false);
      reload();
    } catch {
      toast(t("rcv.sup.saveFailed"), "danger");
    }
  };

  const save = async () => {
    if (!canSave) return;
    // Deactivating takes the supplier out of every picker — ask first.
    if (editing && editing.active && !form.active) {
      const r = await confirm({
        title: `${t("rcv.sup.deactivate")} — ${editing.name}?`,
        body: t("rcv.sup.deactivateBody"),
        confirmLabel: t("rcv.sup.deactivate"),
      });
      if (!r.ok) return;
    }

    /**
     * Only what actually changed goes on the wire. A manager without
     * finance.view never received regNo/vatNo/… in the first place, so their
     * blank (and untouched) field must not overwrite what is stored.
     */
    const body: Record<string, unknown> = {};
    const put = (key: SupplierTextKey, before: string | undefined) => {
      const v = form[key].trim();
      if (editing ? v !== (before ?? "") : v !== "") body[key] = v;
    };
    put("name", editing?.name);
    put("regNo", editing?.regNo);
    put("vatNo", editing?.vatNo);
    put("email", editing?.email);
    put("phone", editing?.phone);
    put("address", editing?.address);
    put("notes", editing?.notes);
    put("contactName", editing?.contactName);
    // Кабинет поставщика: язык переписки и модель работы.
    if (!editing || form.lang !== (editing.lang ?? "lv")) body.lang = form.lang;
    if (canMoney) {
      if (!editing || form.model !== (editing.model ?? "buyout")) body.model = form.model;
      const bp = form.model === "commission" ? Math.round(Number(form.commission) * 100) : 0;
      if (Number.isFinite(bp) && bp >= 0 && bp <= 10_000 && (!editing || bp !== (editing.commissionBp ?? 0))) {
        body.commissionBp = bp;
      }
    }
    if (canMoney) {
      put("bankAccount", editing?.bankAccount);
      if (typeof days === "number" && (!editing || days !== editing.paymentTermsDays)) body.paymentTermsDays = days;
    }
    if (editing && form.active !== editing.active) body.active = form.active;

    setBusy(true);
    try {
      if (editing) {
        if (Object.keys(body).length === 0) {
          setOpen(false);
          return;
        }
        await api.patch(`/api/suppliers/${editing.id}`, body);
        toast(t("rcv.sup.saved"), "ok");
      } else {
        await api.post("/api/suppliers", body);
        toast(t("rcv.sup.created"), "ok");
      }
      setOpen(false);
      reload();
    } catch (err) {
      toast(err instanceof ApiError && err.status === 409 ? t("rcv.sup.exists") : t("rcv.sup.saveFailed"), "danger");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {canManage && (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <ABtn onClick={openNew}>
            <AIcon name="plus" size={15} color="#fff" /> {t("rcv.sup.new")}
          </ABtn>
        </div>
      )}

      <ACard pad={false}>
        {list.length === 0 ? (
          <AEmpty text={t("rcv.sup.empty")} />
        ) : (
          <ATable
            head={[
              t("rcv.sup.nameField"),
              t("rcv.sup.deliveries"),
              t("rcv.sup.terms"),
              ...(canMoney ? [t("rcv.sup.outstanding")] : []),
              t("c.status"),
            ]}
          >
            {list.map((s) => (
              <ATr key={s.id} onClick={canManage ? () => openEdit(s) : undefined}>
                <ATd><span style={{ fontWeight: 600 }}>{s.name}</span></ATd>
                <ATd right>{s.deliveryCount}</ATd>
                <ATd right>{s.paymentTermsDays} {t("rcv.sup.daysShort")}</ATd>
                {canMoney && (
                  <ATd right>
                    <span style={{ fontFamily: AT.mono, fontSize: 12 }}>{formatEur(s.outstandingCents ?? 0)}</span>
                    {(s.overdueCents ?? 0) > 0 && (
                      <span style={{ marginLeft: 6 }}>
                        <ABadge tone="danger">{formatEur(s.overdueCents ?? 0)} {t("rcv.sup.overdue")}</ABadge>
                      </span>
                    )}
                  </ATd>
                )}
                <ATd>
                  <ABadge tone={s.active ? "ok" : "neutral"}>{s.active ? t("rcv.active") : t("rcv.sup.inactive")}</ABadge>
                </ATd>
              </ATr>
            ))}
          </ATable>
        )}
      </ACard>

      {open && (
        <ADrawer
          title={editing ? t("rcv.sup.editTitle") : t("rcv.sup.new")}
          onClose={() => setOpen(false)}
          footer={
            <>
              <ABtn kind="ghost" onClick={() => setOpen(false)}>{t("c.cancel")}</ABtn>
              <ABtn onClick={() => void save()} disabled={!canSave}>{editing ? t("c.save") : t("c.create")}</ABtn>
            </>
          }
        >
          <div style={{ display: "grid", gap: 14 }}>
            <AField label={t("rcv.sup.nameField")} hint={t("rcv.supplierHint")}>
              <AInput value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
            </AField>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <AField label={t("rcv.sup.regNo")}>
                <AInput value={form.regNo} onChange={(v) => setForm({ ...form, regNo: v })} />
              </AField>
              <AField label={t("rcv.sup.vatNo")}>
                <AInput value={form.vatNo} onChange={(v) => setForm({ ...form, vatNo: v })} />
              </AField>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <AField label={t("rcv.sup.email")}>
                <AInput value={form.email} onChange={(v) => setForm({ ...form, email: v })} />
              </AField>
              <AField label={t("rcv.sup.phone")}>
                <AInput value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} />
              </AField>
            </div>
            <AField label={t("rcv.sup.address")}>
              <AInput value={form.address} onChange={(v) => setForm({ ...form, address: v })} />
            </AField>
            <AField label={t("c.notes")}>
              <textarea
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                rows={3}
                style={{
                  width: "100%", borderRadius: AT.radiusSm, border: `1px solid ${AT.rule}`, fontFamily: AT.body,
                  fontSize: 13, color: AT.ink, padding: 10, resize: "vertical",
                }}
              />
            </AField>
            {/* Blank contact fields are ambiguous without finance.view — say so
                rather than let someone "fix" an empty box over real data. */}
            {!canMoney && (
              <div style={{ fontFamily: AT.body, fontSize: 11.5, color: AT.inkSoft, lineHeight: 1.5 }}>
                {t("rcv.sup.detailsHidden")}
              </div>
            )}
            {editing && (
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: AT.body, fontSize: 13, color: AT.ink, cursor: "pointer", width: "fit-content" }}>
                <input type="checkbox" checked={form.active} onChange={() => setForm({ ...form, active: !form.active })} />
                {t("rcv.sup.activeLbl")}
              </label>
            )}

            {canMoney && (
              <div style={{ display: "grid", gap: 12, borderTop: `1px solid ${AT.ruleSoft}`, paddingTop: 14 }}>
                <div style={{ fontFamily: AT.body, fontSize: 13, fontWeight: 700, color: AT.ink }}>{t("rcv.sup.commercial")}</div>
                <AField label={t("rcv.sup.termsField")} hint={t("rcv.sup.termsHint")}>
                  <AInput
                    value={form.terms}
                    onChange={(v) => setForm({ ...form, terms: v })}
                    placeholder="14"
                    style={{ borderColor: days === "bad" ? AT.danger : undefined }}
                  />
                  <CostError show={days === "bad"} text={t("rcv.sup.badTerms")} />
                </AField>
                <AField label={t("rcv.sup.bank")}>
                  <AInput value={form.bankAccount} onChange={(v) => setForm({ ...form, bankAccount: v })} placeholder="LV00 HABA 0000 0000 0000 0" />
                </AField>
                {/* Заявка на смену реквизитов из кабинета: платить по новому
                    счёту можно только после подтверждения здесь. */}
                {editing?.pendingBankAccount ? (
                  <div style={{ display: "grid", gap: 8, padding: 12, border: `1px solid ${AT.danger}`, borderRadius: AT.radiusSm }}>
                    <div style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.ink }}>
                      {t("rcv.sup.bankPending")}: <strong style={{ fontFamily: AT.mono }}>{editing.pendingBankAccount}</strong>
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <ABtn size="sm" onClick={() => void decideBank("approve")}>{t("rcv.sup.bankApprove")}</ABtn>
                      <ABtn size="sm" kind="danger" onClick={() => void decideBank("reject")}>{t("rcv.sup.bankReject")}</ABtn>
                    </div>
                  </div>
                ) : null}
                <AField label={t("rcv.sup.model")}>
                  <ASelect
                    value={form.model}
                    onChange={(v) => setForm({ ...form, model: v })}
                    options={[
                      { value: "buyout", label: t("rcv.sup.modelBuyout") },
                      { value: "commission", label: t("rcv.sup.modelCommission") },
                    ]}
                  />
                </AField>
                {form.model === "commission" && (
                  <AField label={t("rcv.sup.commission")} hint={t("rcv.sup.commissionHint")}>
                    <AInput value={form.commission} onChange={(v) => setForm({ ...form, commission: v })} placeholder="25" />
                  </AField>
                )}
              </div>
            )}

            {/* ── Кабинет поставщика ── */}
            {editing && (
              <div style={{ display: "grid", gap: 12, borderTop: `1px solid ${AT.ruleSoft}`, paddingTop: 14 }}>
                <div style={{ fontFamily: AT.body, fontSize: 13, fontWeight: 700, color: AT.ink }}>{t("rcv.sup.portal")}</div>
                <AField label={t("rcv.sup.contactName")}>
                  <AInput value={form.contactName} onChange={(v) => setForm({ ...form, contactName: v })} />
                </AField>
                <AField label={t("rcv.sup.lang")}>
                  <ASelect
                    value={form.lang}
                    onChange={(v) => setForm({ ...form, lang: v })}
                    options={[{ value: "lv", label: "LV" }, { value: "ru", label: "RU" }, { value: "en", label: "EN" }]}
                  />
                </AField>
                <div style={{ fontFamily: AT.body, fontSize: 11.5, color: AT.inkSoft }}>
                  {editing.portalLastLoginAt ? `${t("rcv.sup.lastLogin")}: ${formatDate(editing.portalLastLoginAt)}` : t("rcv.sup.neverLoggedIn")}
                </div>
                <ABtn kind="soft" onClick={() => void invite()} disabled={!editing.email}>{t("rcv.sup.invite")}</ABtn>
                {!editing.email ? (
                  <div style={{ fontFamily: AT.body, fontSize: 11.5, color: AT.inkSoft }}>{t("rcv.sup.inviteNeedsEmail")}</div>
                ) : null}
              </div>
            )}
          </div>
        </ADrawer>
      )}
    </div>
  );
}

// ── R1: the supplier's bill for one delivery (finance.view only) ─────────────

function SupplierInvoiceCard({ consignmentId, hasSupplier, nav }: {
  consignmentId: string;
  hasSupplier: boolean;
  nav: Nav;
}) {
  const { t } = useT();
  const toast = useToast();
  const [invoice, setInvoice] = useState<SupplierInvoice | null>(null);
  const [recon, setRecon] = useState<Reconciliation | null>(null);
  const [form, setForm] = useState({ number: "", date: todayISO(), amount: "", note: "" });
  const [busy, setBusy] = useState(false);

  /** Every payables row carries its consignmentId, so one list read finds this
   * delivery's bill; the detail read adds payments and the reconciliation. */
  const load = useCallback(() => {
    void api
      .get<{ invoices: SupplierInvoice[] }>("/api/supplier-invoices?status=all")
      .then((r) => {
        const row = r.invoices.find((i) => i.consignmentId === consignmentId);
        if (!row) {
          setInvoice(null);
          setRecon(null);
          return;
        }
        return api
          .get<{ invoice: SupplierInvoice; reconciliation: Reconciliation | null }>(`/api/supplier-invoices/${row.id}`)
          .then((d) => {
            setInvoice(d.invoice);
            setRecon(d.reconciliation);
          });
      })
      .catch(() => undefined);
  }, [consignmentId]);
  useEffect(load, [load]);

  const amount = eurToCents(form.amount);
  // A bill always has an amount — blank stays "not set" and simply blocks the
  // save instead of filing a €0 invoice.
  const canFile = hasSupplier && !busy && form.number.trim().length > 0 && !!form.date && typeof amount === "number";

  const file = async () => {
    // The typeof repeat is what narrows `amount` — a "bad" or blank amount is
    // never sent, and never turns into a zero.
    if (!canFile || typeof amount !== "number") return;
    setBusy(true);
    try {
      await api.post<{ invoice: SupplierInvoice }>("/api/supplier-invoices", {
        consignmentId,
        number: form.number.trim(),
        invoiceDate: form.date,
        amountCents: amount,
        ...(form.note.trim() ? { note: form.note.trim() } : {}),
      });
      toast(t("rcv.sup.invSaved"), "ok");
      setForm({ number: "", date: todayISO(), amount: "", note: "" });
      load();
    } catch (err) {
      const code = err instanceof ApiError ? err.message : "";
      toast(
        code === "supplier_required" || code === "consignment_supplier_missing"
          ? t("rcv.sup.invNeedSupplier")
          : t("rcv.sup.invFailed"),
        "danger",
      );
    } finally {
      setBusy(false);
    }
  };

  if (invoice) {
    const meta = INVOICE_STATUS[invoice.status] ?? { key: "rcv.sup.st.unpaid" as TKey, tone: "neutral" as Tone };
    const off = recon && recon.varianceCents !== 0;
    return (
      <ACard title={t("rcv.sup.invCard")}>
        <div style={{ display: "grid", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontFamily: AT.mono, fontSize: 13.5, fontWeight: 800, color: AT.ink }}>{invoice.number}</span>
            <ABadge tone={meta.tone}>{t(meta.key)}</ABadge>
            {invoice.overdueDays > 0 && (
              <ABadge tone="danger">{t("rcv.sup.invOverdue").replace("{n}", String(invoice.overdueDays))}</ABadge>
            )}
          </div>
          <InvLine label={t("rcv.sup.invDate")}>{formatDay(invoice.invoiceDate)}</InvLine>
          <InvLine label={t("rcv.sup.invDue")}>{formatDay(invoice.dueDate)}</InvLine>
          <InvLine label={t("rcv.sup.invAmountLbl")}>{formatEur(invoice.amountCents)}</InvLine>
          <InvLine label={t("rcv.sup.invPaid")}>{formatEur(invoice.paidCents)}</InvLine>
          <InvLine label={t("rcv.sup.invOutstanding")}>{formatEur(invoice.outstandingCents)}</InvLine>
          {invoice.note.trim().length > 0 && (
            <div style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft, fontStyle: "italic" }}>{invoice.note}</div>
          )}

          {/* What the supplier billed vs. what the warehouse recorded. */}
          {recon && (
            <div style={{
              borderRadius: AT.radiusSm, padding: "9px 11px", lineHeight: 1.5, fontFamily: AT.body, fontSize: 12,
              background: off ? AT.warnSoft : AT.surfaceAlt, color: off ? AT.warn : AT.inkSoft,
            }}>
              <div style={{ fontWeight: off ? 700 : 500 }}>
                {t("rcv.sup.recon")
                  .replace("{rec}", formatEur(recon.recordedCostCents))
                  .replace("{var}", formatEur(recon.varianceCents))}
              </div>
              {/* A variance means little when half the units were never priced. */}
              {recon.noCostDataCount > 0 && (
                <div style={{ color: AT.inkSoft, marginTop: 4 }}>
                  {t("rcv.sup.reconIncomplete").replace("{n}", String(recon.noCostDataCount))}
                </div>
              )}
            </div>
          )}

          {/* Payment belongs to the payables ledger, not to intake. */}
          <div style={{ fontFamily: AT.body, fontSize: 11.5, color: AT.inkSoft, lineHeight: 1.5 }}>
            {t("rcv.sup.payHint")}{" "}
            <button
              onClick={() => nav.go("finance")}
              style={{ all: "unset", cursor: "pointer", color: AT.accent, fontWeight: 600 }}
            >{t("rcv.sup.payLink")}</button>
          </div>
        </div>
      </ACard>
    );
  }

  return (
    <ACard title={t("rcv.sup.invCard")}>
      <div style={{ display: "grid", gap: 12 }}>
        {!hasSupplier && (
          <div style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.warn, lineHeight: 1.5 }}>
            {t("rcv.sup.invNeedSupplier")}
          </div>
        )}
        {/* Nothing here can be filed until the delivery has a supplier. */}
        <div style={{
          display: "grid", gap: 12,
          opacity: hasSupplier ? 1 : 0.45,
          pointerEvents: hasSupplier ? undefined : "none",
        }}>
          <AField label={t("rcv.sup.invNumber")}>
            <AInput value={form.number} onChange={(v) => setForm({ ...form, number: v })} placeholder={t("rcv.sup.invNumberPh")} />
          </AField>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <AField label={t("rcv.sup.invDate")}>
              <AInput type="date" value={form.date} onChange={(v) => setForm({ ...form, date: v })} />
            </AField>
            <AField label={t("rcv.sup.invAmount")}>
              <AInput
                value={form.amount}
                onChange={(v) => setForm({ ...form, amount: v })}
                placeholder="0,00"
                style={{ borderColor: amount === "bad" ? AT.danger : undefined }}
              />
              <CostError show={amount === "bad"} text={t("rcv.cost.badAmount")} />
            </AField>
          </div>
          <AField label={t("rcv.sup.invNote")}>
            <AInput value={form.note} onChange={(v) => setForm({ ...form, note: v })} />
          </AField>
          <div style={{ fontFamily: AT.body, fontSize: 11.5, color: AT.inkSoft, lineHeight: 1.5 }}>
            {t("rcv.sup.invDueHint")}
          </div>
          <div>
            <ABtn onClick={() => void file()} disabled={!canFile}>{t("rcv.sup.invSave")}</ABtn>
          </div>
        </div>
      </div>
    </ACard>
  );
}
