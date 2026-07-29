import { CATEGORIES } from "@auction/domain/categories";
import { CONDITIONS, conditionByCode, conditionRequiresNotes } from "@auction/domain/conditions";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type ConditionPreset, type Item, type Market } from "../api.js";
import type { Nav } from "../App.js";
import { useAuth } from "../auth.js";
import { formatDate } from "../format.js";
import { useT, type Lang } from "../i18n.js";
import { openLabelWindow as openLabel } from "../labels.js";
import { AT } from "../theme.js";
import {
  ABadge, ABtn, ACard, ADrawer, AEmpty, AField, AIcon, AInput, APills, ASelect,
  AStat, ATable, ATd, ATr, useConfirm, useToast,
} from "../ui.js";
import { useAuctionEvents } from "../useAuctionEvents.js";

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

export function ReceivingScreen({ nav: _nav }: { nav: Nav }) {
  const { can } = useAuth();
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
  const [tab, setTab] = useState<"deliveries" | "review">("deliveries");
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
      toast(`${r.consignment.ref} created`, "ok");
      setCreating(false);
      load();
      openDetail(r.consignment.id);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Create failed", "danger");
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
      toast(`${r.item.sku} received`, "ok");
      titleRef.current?.focus();
      if (printAfter) void openLabel(`/api/items/${r.item.id}/label`, (m) => toast(m, "danger"));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Receive failed", "danger");
    } finally {
      setBusy(false);
    }
  };

  const closeConsignment = async () => {
    if (!active) return;
    const expected = active.expectedCount;
    const r = await confirm({
      title: `Close ${active.ref}?`,
      body:
        expected > 0 && received.length !== expected
          ? `Paperwork expected ${expected} units but ${received.length} were received. Closing stops further receiving.`
          : "Closing stops further receiving against this delivery.",
      confirmLabel: "Close consignment",
    });
    if (!r.ok) return;
    try {
      await api.post(`/api/consignments/${active.id}/close`);
      toast(`${active.ref} closed`, "ok");
      setActive({ ...active, status: "closed" });
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Close failed", "danger");
    }
  };

  // ── Detail: intake station ──────────────────────────────────────────────────
  if (active) {
    const open = active.status === "open";
    return (
      <div style={{ display: "grid", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <ABtn kind="ghost" size="sm" onClick={() => { setActive(null); load(); }}>← All deliveries</ABtn>
          <h1 style={{ fontFamily: AT.body, fontSize: 20, fontWeight: 700, color: AT.ink }}>
            {active.ref} <span style={{ color: AT.inkSoft, fontWeight: 500 }}>· {active.supplier}</span>
          </h1>
          <ABadge tone={open ? "ok" : "neutral"}>{active.status}</ABadge>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            {received.length > 0 && (
              <ABtn kind="ghost" size="sm" onClick={() => void openLabel(`/api/consignments/${active.id}/labels`, (m) => toast(m, "danger"))}>
                Print all labels ({received.length})
              </ABtn>
            )}
            {open && can("warehouse.manage") && (
              <ABtn kind="dark" size="sm" onClick={() => void closeConsignment()}>Close consignment</ABtn>
            )}
          </div>
        </div>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <AStat label="Received" value={received.length} />
          <AStat label="Expected" value={active.expectedCount || "—"} />
          <AStat label="Market" value={active.marketCode} />
        </div>

        {open && can("warehouse.manage") && (
          <ACard title="Receive next unit">
            <div style={{ display: "grid", gap: 12 }}>
              <AField label="Title">
                <AInput
                  inputRef={titleRef}
                  value={form.title}
                  onChange={(v) => setForm({ ...form, title: v })}
                  placeholder="Bosch cordless drill GSR 18V, boxed"
                />
              </AField>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 160px", gap: 12 }}>
                <AField label="Condition">
                  <ASelect
                    value={form.condition}
                    onChange={(v) => setForm({ ...form, condition: v })}
                    options={CONDITIONS.map((c) => ({ value: c.code, label: c.requiresNotes ? `${c.label} — see notes` : c.label }))}
                  />
                </AField>
                <AField label="Weight (g)">
                  <AInput value={form.weight} onChange={(v) => setForm({ ...form, weight: v })} placeholder="1200" />
                </AField>
              </div>
              <AField label="Category">
                <ASelect value={form.category} onChange={(v) => setForm({ ...form, category: v })} options={CATEGORIES.map((c) => ({ value: c.code, label: c.label }))} />
              </AField>
              {conditionByCode(form.condition) && (
                <div style={{ fontSize: 12, color: AT.inkSoft, marginTop: -6 }}>{conditionByCode(form.condition)!.description}</div>
              )}
              <AField
                label={needsNotes ? "Condition notes (required)" : "Condition notes"}
                hint={needsNotes ? "SEE NOTES grade — describe the specific issue (shown to bidders)." : "Optional."}
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
                  <AIcon name="plus" size={14} color="#fff" /> Receive + label
                </ABtn>
                <ABtn kind="ghost" onClick={() => void receive(false)} disabled={!canReceive || busy}>Receive only</ABtn>
              </div>
            </div>
          </ACard>
        )}

        <ACard title={`Received items (${received.length})`} pad={false}>
          {received.length === 0 ? (
            <AEmpty text="Nothing received yet — the first unit gets the next free SKU automatically." />
          ) : (
            <ATable head={["SKU", "Title", "Condition", "Weight", ""]}>
              {received.map((i) => (
                <ATr key={i.id}>
                  <ATd mono>{i.sku}</ATd>
                  <ATd><span style={{ fontWeight: 600 }}>{i.title}</span></ATd>
                  <ATd>{conditionByCode(i.condition)?.label ?? i.condition}</ATd>
                  <ATd right>{i.weightGrams == null ? "—" : `${i.weightGrams} g`}</ATd>
                  <ATd right>
                    <ABtn size="sm" kind="ghost" onClick={() => void openLabel(`/api/items/${i.id}/label`, (m) => toast(m, "danger"))}>Label</ABtn>
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
        <h1 style={{ fontFamily: AT.body, fontSize: 20, fontWeight: 700, color: AT.ink }}>Receiving</h1>
        <div style={{ display: "flex", gap: 8 }}>
          {can("warehouse.manage") && (
            <ABtn kind="ghost" onClick={() => void openLabel("/api/warehouse/locations/labels", (m) => toast(m, "danger"))}>Print bin labels</ABtn>
          )}
          {can("warehouse.manage") && (
            <ABtn onClick={() => { setCreateForm({ supplier: "", marketCode: "LV", expected: "", notes: "" }); setCreating(true); }}>
              <AIcon name="plus" size={15} color="#fff" /> New delivery
            </ABtn>
          )}
        </div>
      </div>

      {canReview && (
        <APills
          options={[
            { id: "deliveries" as const, label: "Deliveries", count: list.length },
            { id: "review" as const, label: "Grading review", count: pending.length },
          ]}
          value={tab}
          onChange={setTab}
        />
      )}

      {canReview && tab === "review" ? (
        <GradingReviewQueue items={pending} reload={loadReview} />
      ) : (
        <ACard pad={false}>
          {list.length === 0 ? (
            <AEmpty text="No deliveries yet. Create one when a truck arrives, then receive units against it." />
          ) : (
            <ATable head={["Ref", "Supplier", "Market", "Received", "Status", "Created"]}>
              {list.map((c) => (
                <ATr key={c.id} onClick={() => openDetail(c.id)}>
                  <ATd mono>{c.ref}</ATd>
                  <ATd><span style={{ fontWeight: 600 }}>{c.supplier}</span></ATd>
                  <ATd>{c.marketCode}</ATd>
                  <ATd right>{c.receivedCount ?? 0}{c.expectedCount ? ` / ${c.expectedCount}` : ""}</ATd>
                  <ATd><ABadge tone={c.status === "open" ? "ok" : "neutral"}>{c.status}</ABadge></ATd>
                  <ATd>{formatDate(c.createdAt)}</ATd>
                </ATr>
              ))}
            </ATable>
          )}
        </ACard>
      )}

      {creating && (
        <ADrawer
          title="New delivery"
          onClose={() => setCreating(false)}
          footer={
            <>
              <ABtn kind="ghost" onClick={() => setCreating(false)}>Cancel</ABtn>
              <ABtn onClick={() => void create()} disabled={createForm.supplier.trim().length < 2}>Create</ABtn>
            </>
          }
        >
          <div style={{ display: "grid", gap: 14 }}>
            <AField label="Supplier" hint="Who the goods came from — retailer, liquidator, consignor.">
              <AInput value={createForm.supplier} onChange={(v) => setCreateForm({ ...createForm, supplier: v })} />
            </AField>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <AField label="Market">
                <ASelect value={createForm.marketCode} onChange={(v) => setCreateForm({ ...createForm, marketCode: v })} options={markets.map((m) => ({ value: m.code, label: m.code }))} />
              </AField>
              <AField label="Expected units" hint="From the paperwork; 0 = unknown.">
                <AInput value={createForm.expected} onChange={(v) => setCreateForm({ ...createForm, expected: v })} placeholder="0" />
              </AField>
            </div>
            <AField label="Notes">
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

const REJECT_REASONS = ["Photos unclear", "Wrong grade", "Notes don't match", "Re-check item", "Other…"] as const;

const chipText = (p: { textLv: string; textRu: string; textEn: string }, lang: Lang): string =>
  lang === "lv" ? p.textLv : lang === "ru" ? p.textRu : p.textEn;

const reviewThumb = (u: string) => (u.includes("-web.webp") ? u.replace("-web.webp", "-thumb.webp") : u);

function GradingReviewQueue({ items, reload }: { items: ReviewItem[]; reload: () => void }) {
  const toast = useToast();
  const { lang } = useT();
  const [presets, setPresets] = useState<ConditionPreset[]>([]);
  const [editing, setEditing] = useState<ReviewItem | null>(null);
  const [editForm, setEditForm] = useState({ condition: "", notes: "", picked: new Set<string>() });
  const [rejecting, setRejecting] = useState<ReviewItem | null>(null);
  const [rejectPill, setRejectPill] = useState<string | null>(null);
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
      toast(`${it.sku} approved`, "ok");
      reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Approve failed", "danger");
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
      toast(`${editing.sku} approved with edits`, "ok");
      setEditing(null);
      reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Edit failed", "danger");
    } finally {
      setBusy(false);
    }
  };

  const rejectReason = (rejectPill === "Other…" ? rejectOther.trim() : rejectPill ?? "").slice(0, 300);
  const rejectOk = rejectReason.length >= 2;

  const doReject = async () => {
    if (!rejecting || !rejectOk || busy) return;
    setBusy(true);
    try {
      await api.post(`/api/grading/${rejecting.id}/reject`, { reason: rejectReason });
      toast(`${rejecting.sku} rejected — sent back to the grader`, "ok");
      setRejecting(null);
      setRejectPill(null);
      setRejectOther("");
      reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Reject failed", "danger");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {items.length === 0 && (
        <ACard pad={false}>
          <AEmpty text="Nothing waiting for review. Damaged-family grades (and everything, when 'review all' is on) land here." />
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
              <ABtn size="sm" onClick={() => void approve(it)} disabled={busy}>Approve</ABtn>
              <ABtn size="sm" kind="ghost" onClick={() => openEdit(it)} disabled={busy}>Edit grading…</ABtn>
              <ABtn size="sm" kind="danger" onClick={() => { setRejecting(it); setRejectPill(null); setRejectOther(""); }} disabled={busy}>Reject</ABtn>
            </div>
          </div>
        </ACard>
      ))}

      {editing && (
        <ADrawer
          title={<span>Edit grading <span style={{ fontFamily: AT.mono, fontSize: 12, color: AT.inkSoft }}>{editing.sku}</span></span>}
          onClose={() => setEditing(null)}
          footer={
            <>
              <ABtn kind="ghost" onClick={() => setEditing(null)}>Cancel</ABtn>
              <ABtn onClick={() => void saveEdit()} disabled={!editOk || busy}>Save &amp; approve</ABtn>
            </>
          }
        >
          <div style={{ display: "grid", gap: 14 }}>
            <AField label="Condition">
              <ASelect
                value={editForm.condition}
                onChange={(v) => setEditForm((f) => ({ ...f, condition: v }))}
                options={[
                  ...(conditionByCode(editForm.condition) ? [] : [{ value: editForm.condition, label: `${editForm.condition} (legacy)` }]),
                  ...CONDITIONS.map((c) => ({ value: c.code, label: c.requiresNotes ? `${c.label} — see notes` : c.label })),
                ]}
              />
            </AField>
            {editChips.length > 0 && (
              <AField label="Preset notes">
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
              label={conditionRequiresNotes(editForm.condition) && editPickedIds.length === 0 ? "Condition notes (required)" : "Condition notes"}
              hint="Shown to bidders alongside the preset chips."
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
              Reject {rejecting.sku}?
            </h2>
            <p style={{ fontFamily: AT.body, fontSize: 12.5, color: AT.inkSoft, lineHeight: 1.5 }}>
              The grader sees the reason on their warehouse home screen and re-grades the item.
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
                >{r}</button>
              ))}
            </div>
            {rejectPill === "Other…" && (
              <AInput value={rejectOther} onChange={setRejectOther} placeholder="Why is this grade going back?" autoFocus />
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <ABtn kind="ghost" onClick={() => setRejecting(null)}>Cancel</ABtn>
              <ABtn kind="danger" onClick={() => void doReject()} disabled={!rejectOk || busy}>Reject grade</ABtn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
