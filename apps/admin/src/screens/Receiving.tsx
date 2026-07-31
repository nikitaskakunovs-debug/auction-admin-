import { CATEGORIES } from "@auction/domain/categories";
import { CONDITIONS, conditionByCode, conditionRequiresNotes } from "@auction/domain/conditions";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type ConditionPreset, type Item, type Market } from "../api.js";
import type { Nav } from "../App.js";
import { useAuth } from "../auth.js";
import { exportCSV } from "../exporters.js";
import { formatDate, formatEur } from "../format.js";
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
  const titleRef = useRef<HTMLInputElement | null>(null);

  // W6: delivery-level costs — finance-only, both endpoints 403 otherwise.
  const canCost = can("finance.view");
  const [extraCost, setExtraCost] = useState("");
  const [spreadTotal, setSpreadTotal] = useState("");
  const [costBusy, setCostBusy] = useState(false);

  // W2 grading review queue — only for reviewers; badge stays live over WS.
  const canReview = can("grading.review");
  const [tab, setTab] = useState<"deliveries" | "review" | "bins" | "counts">("deliveries");
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
    refreshDetail(id);
  };

  const create = async () => {
    try {
      const r = await api.post<{ consignment: Consignment }>("/api/consignments", {
        supplier: createForm.supplier,
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
              {conditionByCode(form.condition) && (
                <div style={{ fontSize: 12, color: AT.inkSoft, marginTop: -6 }}>{conditionByCode(form.condition)!.description}</div>
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
          { id: "bins" as const, label: t("wh.bins") },
          { id: "counts" as const, label: t("rc.cnt.tab") },
        ]}
        value={tab}
        onChange={setTab}
      />

      {canReview && tab === "review" ? (
        <GradingReviewQueue items={pending} reload={loadReview} />
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
              <ABtn onClick={() => void create()} disabled={createForm.supplier.trim().length < 2}>{t("c.create")}</ABtn>
            </>
          }
        >
          <div style={{ display: "grid", gap: 14 }}>
            <AField label={t("rcv.supplier")} hint={t("rcv.supplierHint")}>
              <AInput value={createForm.supplier} onChange={(v) => setCreateForm({ ...createForm, supplier: v })} />
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
