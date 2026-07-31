import { CATEGORIES } from "@auction/domain/categories";
import { CONDITIONS, conditionByCode, conditionRequiresNotes } from "@auction/domain/conditions";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type ConditionPreset, type Item, type Market } from "../api.js";
import type { Nav } from "../App.js";
import { useAuth } from "../auth.js";
import { exportCSV } from "../exporters.js";
import { formatDate } from "../format.js";
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
}

const emptyReceive = { title: "", condition: "brand_new", conditionNotes: "", category: "other", weight: "" };

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

  const openDetail = (id: string) => {
    void api
      .get<{ consignment: Consignment; items: Item[] }>(`/api/consignments/${id}`)
      .then((r) => {
        setActive(r.consignment);
        setReceived(r.items);
        setForm(emptyReceive);
      })
      .catch(() => undefined);
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
  const canReceive = form.title.trim().length >= 2 && (!needsNotes || form.conditionNotes.trim().length >= 3);

  const receive = async (printAfter: boolean) => {
    if (!active || !canReceive || busy) return;
    setBusy(true);
    try {
      const r = await api.post<{ item: Item }>(`/api/consignments/${active.id}/receive`, {
        title: form.title.trim(),
        condition: form.condition,
        conditionNotes: form.conditionNotes,
        category: form.category,
        weightGrams: form.weight ? Number(form.weight) : null,
      });
      setReceived((prev) => [r.item, ...prev]);
      // Keep the grade for runs of identical stock; clear the per-unit fields.
      setForm((f) => ({ ...f, title: "", conditionNotes: "", weight: "" }));
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

        <ACard title={`${t("rcv.receivedItems")} (${received.length})`} pad={false}>
          {received.length === 0 ? (
            <AEmpty text={t("rcv.noneReceived")} />
          ) : (
            <ATable head={["SKU", t("c.title"), t("c.condition"), t("rcv.weight"), ""]}>
              {received.map((i) => (
                <ATr key={i.id}>
                  <ATd mono>{i.sku}</ATd>
                  <ATd><span style={{ fontWeight: 600 }}>{i.title}</span></ATd>
                  <ATd>{conditionByCode(i.condition)?.label ?? i.condition}</ATd>
                  <ATd right>{i.weightGrams == null ? "—" : `${i.weightGrams} g`}</ATd>
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
  const [diff, setDiff] = useState<CountDiff | null>(null);
  const [showMatches, setShowMatches] = useState(false);
  const [busy, setBusy] = useState(false);

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

  const openDetail = (id: string) => {
    void api.get<CountDiff>(`/api/stock-counts/${id}/diff`).then(setDiff).catch(() => undefined);
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
    if (!diff || busy) return;
    const r = await confirm({
      title: `${t("rc.cnt.approveBtn")} — ${diff.count.name}?`,
      body: t("rc.cnt.approveBody"),
      confirmLabel: t("rc.cnt.approveBtn"),
    });
    if (!r.ok) return;
    setBusy(true);
    try {
      const res = await api.post<{ ok: boolean; moved: number; missing: number }>(`/api/stock-counts/${diff.count.id}/approve`);
      toast(`${t("rc.cnt.tApproved")} — ${res.moved} ${t("rc.cnt.movedN")}, ${res.missing} ${t("rc.cnt.missingN")}`, "ok");
      load();
      openDetail(diff.count.id);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("rcv.approveFailed"), "danger");
    } finally {
      setBusy(false);
    }
  };

  const cancelCount = async () => {
    if (!diff || busy) return;
    const r = await confirm({
      title: `${t("rc.cnt.cancelBtn")} — ${diff.count.name}?`,
      body: t("rc.cnt.cancelBody"),
      confirmLabel: t("rc.cnt.cancelBtn"),
      danger: true,
    });
    if (!r.ok) return;
    setBusy(true);
    try {
      await api.post(`/api/stock-counts/${diff.count.id}/cancel`);
      toast(`${diff.count.name} ${t("rc.cnt.tCancelled")}`, "ok");
      load();
      openDetail(diff.count.id);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("rc.cnt.cancelFailed"), "danger");
    } finally {
      setBusy(false);
    }
  };

  const exportDiff = () => {
    if (!diff) return;
    exportCSV(
      "stock-count-diff",
      ["SKU", t("c.title"), t("rc.cnt.expectedCol"), t("rc.cnt.foundCol"), t("rc.cnt.outcome")],
      diff.lines.map((l) => [l.sku ?? l.code ?? "", l.title ?? "", l.expectedLabel ?? "", l.foundLabel ?? "", t(OUTCOME_META[l.outcome].key)]),
    );
  };

  // ── Detail: diff for one session ────────────────────────────────────────────
  if (diff) {
    const c = diff.count;
    const st = COUNT_STATUS[c.status];
    const open = c.status === "open";
    const lines = showMatches ? diff.lines : diff.lines.filter((l) => l.outcome !== "match");
    return (
      <div style={{ display: "grid", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <ABtn kind="ghost" size="sm" onClick={() => { setDiff(null); setShowMatches(false); load(); }}>← {t("rc.cnt.all")}</ABtn>
          <h1 style={{ fontFamily: AT.body, fontSize: 20, fontWeight: 700, color: AT.ink }}>
            {c.name} <span style={{ color: AT.inkSoft, fontWeight: 500 }}>· {t("rc.cnt.started").toLowerCase()} {formatDate(c.startedAt)}</span>
          </h1>
          <ABadge tone={st.tone}>{t(st.key)}</ABadge>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <ABtn kind="ghost" size="sm" onClick={exportDiff}>{t("rc.cnt.csv")}</ABtn>
            {open && can("warehouse.manage") && (
              <ABtn kind="danger" size="sm" onClick={() => void cancelCount()} disabled={busy}>{t("rc.cnt.cancelBtn")}</ABtn>
            )}
            {open && can("grading.review") && (
              <ABtn kind="dark" size="sm" onClick={() => void approve()} disabled={busy}>{t("rc.cnt.approveBtn")}</ABtn>
            )}
          </div>
        </div>

        {c.status === "approved" && (
          <div style={{ fontFamily: AT.body, fontSize: 13, color: AT.ok, fontWeight: 600 }}>{t("rc.cnt.approvedNote")}</div>
        )}

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
                    <ATd mono>{l.foundLabel ?? "—"}</ATd>
                    <ATd><ABadge tone={om.tone}>{t(om.key)}</ABadge></ATd>
                  </ATr>
                );
              })}
            </ATable>
          )}
        </ACard>
      </div>
    );
  }

  // ── Sessions list ───────────────────────────────────────────────────────────
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {can("warehouse.manage") && (
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
                <ATr key={c.id} onClick={() => openDetail(c.id)}>
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
