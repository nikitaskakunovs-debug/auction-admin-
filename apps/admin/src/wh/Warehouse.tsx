import { CONDITIONS, conditionByCode, conditionRequiresNotes } from "@auction/domain/conditions";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, type ConditionPreset, type Item } from "../api.js";
import { useAuth } from "../auth.js";
import { adminOrigin, isWarehouseHost } from "../host.js";
import { useT, type Lang, type TKey } from "../i18n.js";
import { CommentsThread, ActivityTimeline, useCommentsLive } from "../itemPanels.js";
import { LangSwitch } from "../LangSwitch.js";
import { openLabelWindow } from "../labels.js";
import { ReportModal } from "../ReportModal.js";
import { AT, ITEM_STATUS_TONE, toneColors, type Tone } from "../theme.js";
import { useAuctionEvents } from "../useAuctionEvents.js";
import { CameraScanner, normalizeScan } from "./CameraScanner.js";

/**
 * Warehouse mode — the phone-first shell for storage workers, served on its
 * own hostname (wh.<domain>) and at #/wh. Same session/RBAC as the admin.
 * Camera QR scanning + hardware type+Enter scanners both work everywhere.
 */

interface LookupResult {
  item: Item & { conditionNotes?: string };
  binLabel: string | null;
  consignmentRef: string | null;
}

interface Consignment {
  id: string;
  ref: string;
  supplier: string;
  marketCode: string;
  status: string;
  expectedCount: number;
  receivedCount?: number;
}

interface Bin {
  id: string;
  label: string;
  zone: string;
  active: boolean;
}

interface TicketLine {
  id: string;
  status: string;
  sku: string;
  title: string;
  locationLabel: string | null;
  legacyLocation: string;
  orderRef: string;
}

interface Ticket {
  id: string;
  number: number;
  status: string;
  customerAlias: string;
  claimedById: string | null;
  claimedByName: string | null;
  passToId: string | null;
  passToName: string | null;
  passReason: string | null;
  lines: TicketLine[];
}

/** Row from GET /api/warehouse/status/today. */
interface WorkerToday {
  userId: string;
  name: string;
  status: "working" | "coffee" | "lunch" | "done";
  sinceAt: string;
  currentTicketNumber: number | null;
}

const WORKER_STATUSES = ["working", "coffee", "lunch", "done"] as const;
type WorkerStatus = (typeof WORKER_STATUSES)[number];

type View =
  | { v: "home" }
  | { v: "scan"; forPutaway?: boolean }
  | { v: "item"; data: LookupResult }
  | { v: "receive" }
  | { v: "receive-into"; con: Consignment }
  | { v: "pick" }
  | { v: "ticket"; id: string }
  | { v: "bins" }
  | { v: "bin"; id: string; label: string }
  | { v: "cnt" }
  | { v: "cnt-session"; id: string; name: string }
  | { v: "cnt-bin"; countId: string; countName: string; locationId: string; binLabel: string };

const SHADOW = "0 1px 2px rgba(10,10,10,0.06), 0 4px 14px rgba(10,10,10,0.05)";

const S = {
  btn: {
    all: "unset",
    boxSizing: "border-box",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    minHeight: 56,
    padding: "12px 18px",
    borderRadius: 14,
    background: AT.ink,
    color: "#fff",
    fontSize: 16,
    fontWeight: 700,
    cursor: "pointer",
    textAlign: "center",
    width: "100%",
    boxShadow: SHADOW,
  } as const,
  btnGhost: {
    background: "#fff",
    color: AT.ink,
    border: `1.5px solid ${AT.rule}`,
    boxShadow: SHADOW,
  } as const,
  btnAccent: {
    background: AT.accent,
  } as const,
  btnDanger: {
    background: "#fff",
    color: AT.danger,
    border: `1.5px solid ${AT.dangerSoft}`,
  } as const,
  input: {
    boxSizing: "border-box",
    width: "100%",
    minHeight: 52,
    borderRadius: 12,
    border: `1.5px solid ${AT.rule}`,
    fontSize: 17,
    padding: "0 14px",
    fontFamily: AT.body,
    color: AT.ink,
    outline: "none",
    background: "#fff",
  } as const,
  card: {
    background: "#fff",
    border: `1px solid ${AT.ruleSoft}`,
    borderRadius: 16,
    padding: 16,
    boxShadow: SHADOW,
  } as const,
  label: {
    fontSize: 11.5,
    fontWeight: 800,
    color: AT.inkSoft,
    textTransform: "uppercase",
    letterSpacing: "0.07em",
  } as const,
};

function Pill({ text, tone }: { text: string; tone: Tone }) {
  const c = toneColors[tone];
  return (
    <span style={{
      display: "inline-block", padding: "3px 10px", borderRadius: 999, background: c.bg, color: c.fg,
      fontSize: 11.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap",
    }}>{text}</span>
  );
}

const thumbOf = (u: string) => (u.includes("-web.webp") ? u.replace("-web.webp", "-thumb.webp") : u);

export function WarehouseMode() {
  const { user, can, logout } = useAuth();
  const { t } = useT();
  const [view, setView] = useState<View>({ v: "home" });
  const [flash, setFlash] = useState<{ text: string; tone: "ok" | "danger" } | null>(null);
  const [reporting, setReporting] = useState(false);

  const toast = (text: string, tone: "ok" | "danger" = "ok") => {
    setFlash({ text, tone });
    setTimeout(() => setFlash(null), 2600);
  };

  const openItem = async (code: string, forPutaway = false) => {
    try {
      const data = await api.get<LookupResult>(`/api/items/lookup?code=${encodeURIComponent(code.trim())}`);
      setView({ v: "item", data });
      if (forPutaway) toast(t("wh.nowPickBin"));
    } catch (err) {
      toast(err instanceof ApiError && err.status === 404 ? t("wh.noMatch") : t("wh.lookupFailed"), "danger");
    }
  };

  const refreshItem = async (id: string) => void openItem(id);

  const title =
    view.v === "home" ? t("wh.title") :
    view.v === "scan" ? t("wh.scan") :
    view.v === "item" ? view.data.item.sku :
    view.v === "receive" ? t("wh.receive") :
    view.v === "receive-into" ? view.con.ref :
    view.v === "pick" ? t("wh.pickQueue") :
    view.v === "bins" ? t("wh.bins") :
    view.v === "bin" ? view.label :
    view.v === "cnt" ? t("wh.cnt.title") :
    view.v === "cnt-session" ? view.name :
    view.v === "cnt-bin" ? view.binLabel : t("wh.ticket");

  const back = () => {
    if (view.v === "item" || view.v === "scan" || view.v === "receive" || view.v === "pick" || view.v === "bins" || view.v === "cnt") setView({ v: "home" });
    else if (view.v === "receive-into") setView({ v: "receive" });
    else if (view.v === "ticket") setView({ v: "pick" });
    else if (view.v === "bin") setView({ v: "bins" });
    else if (view.v === "cnt-session") setView({ v: "cnt" });
    else if (view.v === "cnt-bin") setView({ v: "cnt-session", id: view.countId, name: view.countName });
  };

  return (
    <div style={{ minHeight: "100%", background: AT.app, fontFamily: AT.body }}>
      <header style={{
        position: "sticky", top: 0, zIndex: 5, background: AT.side, color: "#fff",
        borderBottom: `3px solid ${AT.accent}`,
        display: "flex", alignItems: "center", gap: 10, padding: "13px 16px",
      }}>
        {view.v !== "home" ? (
          <button onClick={back} style={{ all: "unset", cursor: "pointer", fontSize: 24, lineHeight: 1, padding: "0 6px 2px 0" }}>‹</button>
        ) : (
          <span style={{
            width: 30, height: 30, borderRadius: 8, background: AT.accent, display: "grid", placeItems: "center", fontSize: 15,
          }}>📦</span>
        )}
        <div style={{ fontSize: 17, fontWeight: 800, flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</div>
        {view.v === "home" && (
          <button onClick={() => void logout()} style={{ all: "unset", cursor: "pointer", fontSize: 12.5, fontWeight: 700, color: "rgba(255,255,255,0.75)" }}>
            {t("wh.signOut")}
          </button>
        )}
      </header>

      {flash && (
        <div style={{
          position: "fixed", top: 66, left: "50%", transform: "translateX(-50%)", zIndex: 30,
          background: flash.tone === "ok" ? "#123B22" : "#7A1B1E", color: "#fff",
          borderRadius: 12, padding: "11px 18px", fontSize: 14.5, fontWeight: 700, maxWidth: "90vw",
          boxShadow: "0 8px 26px rgba(0,0,0,0.35)", animation: "toast-in 160ms ease-out",
        }}>{flash.text}</div>
      )}

      <main style={{ maxWidth: 560, margin: "0 auto", padding: "16px 14px 90px", display: "grid", gap: 12 }}>
        {view.v === "home" && (
          <>
            {can("pickup.operate") && (
              <IncomingPassWatcher toast={toast} onOpen={(id) => setView({ v: "ticket", id })} />
            )}
            {can("items.view") && <GradingNotices toast={toast} onOpen={(itemId) => void openItem(itemId)} />}
            <button style={{ ...S.btn, ...S.btnAccent, minHeight: 64, fontSize: 17 }} onClick={() => setView({ v: "scan" })}>
              🔍 {t("wh.scanLookup")}
            </button>
            {can("warehouse.manage") && (
              <button style={S.btn} onClick={() => setView({ v: "receive" })}>📥 {t("wh.receive")}</button>
            )}
            {can("warehouse.manage") && (
              <button style={{ ...S.btn, ...S.btnGhost }} onClick={() => setView({ v: "scan", forPutaway: true })}>🗄️ {t("wh.putaway")}</button>
            )}
            {can("pickup.operate") && (
              <button style={S.btn} onClick={() => setView({ v: "pick" })}>🛒 {t("wh.pickQueue")}</button>
            )}
            {can("items.view") && (
              <button style={{ ...S.btn, ...S.btnGhost }} onClick={() => setView({ v: "bins" })}>🗂️ {t("wh.bins")}</button>
            )}
            <button style={{ ...S.btn, ...S.btnGhost }} onClick={() => setView({ v: "cnt" })}>📋 {t("wh.cnt.title")}</button>
            <div style={{ ...S.card, display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{
                width: 38, height: 38, borderRadius: 999, background: AT.accentSoft, color: AT.accent,
                display: "grid", placeItems: "center", fontSize: 15, fontWeight: 800, flexShrink: 0,
              }}>{(user?.name ?? "?").slice(0, 1).toUpperCase()}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{user?.name}</div>
                <div style={{ fontSize: 12, color: AT.inkSoft }}>{user?.role.replace(/_/g, " ")}</div>
              </div>
              <a href={isWarehouseHost() ? `${adminOrigin()}/#/dashboard` : "#/dashboard"} style={{ fontSize: 12.5, fontWeight: 700, color: AT.accent, textDecoration: "none" }}>
                {t("wh.fullAdmin")}
              </a>
            </div>
            {(can("pickup.operate") || can("warehouse.manage")) && <StatusSelector toast={toast} />}
            <button style={{ ...S.btn, ...S.btnGhost, minHeight: 48 }} onClick={() => setReporting(true)}>
              🐞 {t("bug.title")}
            </button>
            <ScannerSetupCard onTryScan={() => setView({ v: "scan" })} />
            <div style={{ display: "flex", justifyContent: "center" }}>
              <LangSwitch />
            </div>
            <div style={{ fontSize: 12, color: AT.inkSoft, textAlign: "center", lineHeight: 1.5 }}>
              {t("wh.scannersHint")}
            </div>
          </>
        )}

        {view.v === "scan" && <ScanView onCode={(c) => void openItem(c, view.forPutaway)} />}
        {view.v === "item" && (
          <ItemView
            data={view.data}
            canEdit={can("items.edit")}
            canBin={can("warehouse.manage")}
            toast={toast}
            refresh={() => void refreshItem(view.data.item.id)}
            scanNext={() => setView({ v: "scan" })}
          />
        )}
        {view.v === "receive" && <ReceiveList onPick={(con) => setView({ v: "receive-into", con })} />}
        {view.v === "receive-into" && (
          <ReceiveForm con={view.con} toast={toast} onReceived={(item) => void openItem(item.id)} />
        )}
        {view.v === "pick" && <PickQueue toast={toast} onOpen={(id) => setView({ v: "ticket", id })} />}
        {view.v === "ticket" && <TicketView id={view.id} toast={toast} onDone={() => setView({ v: "pick" })} />}
        {view.v === "bins" && <BinsList toast={toast} onOpen={(id, label) => setView({ v: "bin", id, label })} />}
        {view.v === "bin" && <BinContentsView id={view.id} onItem={(code) => void openItem(code)} />}
        {view.v === "cnt" && <CountList onPick={(c) => setView({ v: "cnt-session", id: c.id, name: c.name })} />}
        {view.v === "cnt-session" && (
          <CountSessionView
            id={view.id}
            onBin={(locationId, binLabel) => setView({ v: "cnt-bin", countId: view.id, countName: view.name, locationId, binLabel })}
          />
        )}
        {view.v === "cnt-bin" && (
          <CountBinView
            countId={view.countId}
            countName={view.countName}
            locationId={view.locationId}
            binLabel={view.binLabel}
            toast={toast}
            onDone={() => setView({ v: "cnt-session", id: view.countId, name: view.countName })}
            onClosed={() => setView({ v: "cnt" })}
          />
        )}
      </main>
      {reporting && (
        <ReportModal
          screen={view.v === "item" ? `warehouse · ${view.data.item.sku}` : `warehouse · ${view.v}`}
          onClose={() => setReporting(false)}
        />
      )}
    </div>
  );
}

// ── Scan ─────────────────────────────────────────────────────────────────────

function ScanView({ onCode }: { onCode: (code: string) => void }) {
  const { t } = useT();
  const [code, setCode] = useState("");
  const [camera, setCamera] = useState(false);
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <button style={{ ...S.btn, ...S.btnAccent, minHeight: 64, fontSize: 17 }} onClick={() => setCamera(true)}>{t("wh.scanCamera")}</button>
      <form
        onSubmit={(e) => { e.preventDefault(); if (code.trim().length >= 3) onCode(code); setCode(""); }}
        style={{ display: "grid", gap: 12 }}
      >
        <div style={S.label}>{t("wh.scanOrType")}</div>
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="LOT-000123" autoCapitalize="characters" style={{ ...S.input, fontFamily: AT.mono, fontSize: 20, textAlign: "center", minHeight: 60 }} />
        <button type="submit" style={{ ...S.btn, ...S.btnGhost }} disabled={code.trim().length < 3}>{t("wh.lookUp")}</button>
      </form>
      {camera && (
        <CameraScanner
          hint={t("wh.aimItem")}
          onCode={(raw) => { setCamera(false); onCode(normalizeScan(raw)); }}
          onClose={() => setCamera(false)}
        />
      )}
    </div>
  );
}

// ── Item card: gallery, grade, putaway, history ──────────────────────────────

const PULL_REASONS = ["damaged", "rephoto", "regrade", "recount", "other"] as const;
type PullReason = (typeof PULL_REASONS)[number];

/** Chip text in the worker's UI language. */
const presetText = (p: ConditionPreset, lang: Lang): string =>
  lang === "lv" ? p.textLv : lang === "ru" ? p.textRu : p.textEn;

function ItemView({ data, canEdit, canBin, toast, refresh, scanNext }: {
  data: LookupResult;
  canEdit: boolean;
  canBin: boolean;
  toast: (t: string, tone?: "ok" | "danger") => void;
  refresh: () => void;
  scanNext: () => void;
}) {
  const { t, lang } = useT();
  const { item, binLabel, consignmentRef } = data;
  const [grading, setGrading] = useState(false);
  const [binPick, setBinPick] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [pullReason, setPullReason] = useState<PullReason | null>(null);
  const [pullNote, setPullNote] = useState("");
  const [condition, setCondition] = useState(item.condition);
  const [notes, setNotes] = useState((item as { conditionNotes?: string }).conditionNotes ?? "");
  const [busy, setBusy] = useState(false);
  const [viewer, setViewer] = useState<number | null>(null);
  // W2: preset note chips + review flow.
  const [presets, setPresets] = useState<ConditionPreset[]>([]);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(item.conditionPresetIds ?? []));
  const [showNotes, setShowNotes] = useState(() => ((item as { conditionNotes?: string }).conditionNotes ?? "").trim().length > 0);
  const [sentReview, setSentReview] = useState(false);
  const needsNotes = conditionRequiresNotes(condition);

  useEffect(() => {
    void api.get<{ presets: ConditionPreset[] }>("/api/condition-presets").then((r) => setPresets(r.presets)).catch(() => undefined);
  }, []);

  // Chips shown for the currently selected grade; only their ids are sent.
  const chipsForCondition = presets.filter((p) => p.conditionCode === condition);
  const pickedIds = chipsForCondition.filter((p) => picked.has(p.id)).map((p) => p.id);
  const gradeOk = !needsNotes || notes.trim().length >= 3 || pickedIds.length > 0;
  const statusTone = ITEM_STATUS_TONE[item.status] ?? { label: item.status.replace(/_/g, " "), tone: "neutral" as Tone };

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const fd = new FormData();
    for (const f of Array.from(files)) fd.append("photos", f);
    setBusy(true);
    try {
      await api.postForm(`/api/items/${item.id}/photos`, fd);
      toast(files.length > 1 ? `${files.length} ${t("wh.photosAdded")}` : t("wh.photoAdded"));
      refresh();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("wh.uploadFailed"), "danger");
    } finally {
      setBusy(false);
    }
  };

  const saveGrade = async () => {
    if (!gradeOk) return;
    setBusy(true);
    try {
      const r = await api.patch<{ item: Item }>(`/api/items/${item.id}`, {
        condition,
        conditionNotes: notes,
        conditionPresetIds: pickedIds,
      });
      // A grade that lands in review gets the inline "→ uz pārbaudi"
      // confirmation instead of the plain success toast.
      if (r.item.gradeStatus === "pending_review") setSentReview(true);
      else {
        setSentReview(false);
        toast(t("wh.gradeSaved"));
      }
      setGrading(false);
      refresh();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("wh.saveFailed"), "danger");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={S.card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
          <div style={{ fontFamily: AT.mono, fontSize: 19, fontWeight: 800 }}>{item.sku}</div>
          <Pill text={statusTone.label} tone={statusTone.tone} />
        </div>
        <div style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.35, marginTop: 4 }}>{item.title}</div>
        <div style={{ fontSize: 12.5, color: AT.inkSoft, marginTop: 3 }}>
          {conditionByCode(item.condition)?.label ?? item.condition}
        </div>
        <div style={{
          display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginTop: 14,
          borderTop: `1px solid ${AT.ruleSoft}`, paddingTop: 12,
        }}>
          <div><div style={S.label}>{t("wh.bin")}</div><div style={{ fontFamily: AT.mono, fontSize: 15, fontWeight: 700, marginTop: 2 }}>{binLabel ?? item.location ?? "—"}</div></div>
          <div><div style={S.label}>{t("wh.delivery")}</div><div style={{ fontFamily: AT.mono, fontSize: 15, fontWeight: 700, marginTop: 2 }}>{consignmentRef ?? "—"}</div></div>
          <div><div style={S.label}>{t("wh.photos")}</div><div style={{ fontSize: 15, fontWeight: 700, marginTop: 2 }}>{item.photos.length}</div></div>
        </div>
      </div>

      {/* Photo gallery — every photo, tap to open the full-screen viewer. */}
      <div style={{ ...S.card, display: "grid", gap: 10 }}>
        <div style={S.label}>{t("wh.allPhotos")}</div>
        {item.photos.length === 0 ? (
          <div style={{ color: AT.inkSoft, fontSize: 13.5 }}>{t("wh.noPhotos")}</div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(84px, 1fr))", gap: 8 }}>
            {item.photos.map((p, i) => (
              <button key={p} onClick={() => setViewer(i)} style={{ all: "unset", cursor: "pointer", position: "relative" }}>
                <img src={thumbOf(p)} alt="" style={{ width: "100%", aspectRatio: "1", objectFit: "cover", borderRadius: 10, border: `1px solid ${AT.rule}`, display: "block" }} />
                {i === 0 && (
                  <span style={{
                    position: "absolute", top: 5, left: 5, background: AT.ink, color: "#fff",
                    fontSize: 9.5, fontWeight: 800, padding: "2px 6px", borderRadius: 6, textTransform: "uppercase",
                  }}>1</span>
                )}
              </button>
            ))}
          </div>
        )}
        {canEdit && (
          <label style={{ ...S.btn, minHeight: 50, ...(busy ? { opacity: 0.6 } : {}) }}>
            {t("wh.addPhotos")}
            <input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" multiple style={{ display: "none" }} onChange={(e) => { void upload(e.target.files); e.currentTarget.value = ""; }} />
          </label>
        )}
      </div>

      {viewer !== null && item.photos[viewer] && (
        <PhotoViewer
          photos={item.photos}
          index={viewer}
          canEdit={canEdit}
          itemId={item.id}
          toast={toast}
          onChanged={() => { setViewer(null); refresh(); }}
          onNav={setViewer}
          onClose={() => setViewer(null)}
        />
      )}

      {canEdit && !grading && sentReview && (
        <div style={{
          ...S.card, border: `1.5px solid ${AT.accent}`, color: AT.accent,
          fontSize: 14.5, fontWeight: 800, textAlign: "center",
        }}>{t("wh.sentReview")}</div>
      )}
      {canEdit && !grading && (
        <button style={{ ...S.btn, ...S.btnGhost }} onClick={() => setGrading(true)}>{t("wh.grade")}</button>
      )}
      {canEdit && grading && (
        <div style={{ ...S.card, display: "grid", gap: 10 }}>
          <div style={S.label}>{t("wh.condition")}</div>
          <select value={condition} onChange={(e) => setCondition(e.target.value)} style={{ ...S.input, minHeight: 52 }}>
            {!conditionByCode(item.condition) && <option value={item.condition}>{item.condition} (legacy)</option>}
            {CONDITIONS.map((c) => (
              <option key={c.code} value={c.code}>{c.requiresNotes ? `${c.label} — see notes` : c.label}</option>
            ))}
          </select>
          {conditionByCode(condition) && <div style={{ fontSize: 12.5, color: AT.inkSoft }}>{conditionByCode(condition)!.description}</div>}
          {/* W2: standardized note chips for this grade — tapping beats typing. */}
          {chipsForCondition.length > 0 && (
            <>
              <div style={S.label}>{t("wh.presetNotes")}</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {chipsForCondition.map((p) => {
                  const on = picked.has(p.id);
                  return (
                    <button
                      key={p.id}
                      onClick={() => setPicked((s) => {
                        const next = new Set(s);
                        if (next.has(p.id)) next.delete(p.id);
                        else next.add(p.id);
                        return next;
                      })}
                      style={{
                        all: "unset", boxSizing: "border-box", cursor: "pointer", padding: "9px 13px", borderRadius: 999,
                        fontSize: 13.5, fontWeight: 700, fontFamily: AT.body,
                        background: on ? AT.ink : "#fff", color: on ? "#fff" : AT.ink,
                        border: `1.5px solid ${on ? AT.ink : AT.rule}`,
                      }}
                    >{presetText(p, lang)}</button>
                  );
                })}
                <button
                  onClick={() => setShowNotes((v) => !v)}
                  style={{
                    all: "unset", boxSizing: "border-box", cursor: "pointer", padding: "9px 13px", borderRadius: 999,
                    fontSize: 13.5, fontWeight: 700, fontFamily: AT.body,
                    background: showNotes ? AT.accent : "#fff", color: showNotes ? "#fff" : AT.accent,
                    border: `1.5px solid ${AT.accent}`,
                  }}
                >{t("wh.chipOther")}</button>
              </div>
            </>
          )}
          {(showNotes || chipsForCondition.length === 0) && (
            <>
              <div style={S.label}>{needsNotes && pickedIds.length === 0 ? t("wh.notesRequired") : t("wh.notes")}</div>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} style={{ ...S.input, minHeight: 80, padding: 12, borderColor: gradeOk ? AT.rule : "#C24" }} />
            </>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button style={{ ...S.btn, flex: 1, ...(gradeOk ? {} : { opacity: 0.5 }) }} onClick={() => void saveGrade()} disabled={busy || !gradeOk}>{t("wh.saveGrade")}</button>
            <button style={{ ...S.btn, ...S.btnGhost, flex: 1 }} onClick={() => setGrading(false)}>{t("wh.cancel")}</button>
          </div>
        </div>
      )}

      {canBin && !binPick && (
        <button style={{ ...S.btn, ...S.btnGhost }} onClick={() => setBinPick(true)}>{t("wh.putawayMove")}</button>
      )}
      {canBin && binPick && <BinPicker itemId={item.id} current={item.locationId} toast={toast} done={() => { setBinPick(false); refresh(); }} />}

      {canBin && !pulling && (
        <button style={{ ...S.btn, ...S.btnGhost }} onClick={() => setPulling(true)}>{t("wh.pull")}</button>
      )}
      {canBin && pulling && (
        <div style={{ ...S.card, display: "grid", gap: 10 }}>
          <div style={S.label}>{t("wh.pullWhy")}</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {PULL_REASONS.map((r) => (
              <button
                key={r}
                onClick={() => setPullReason(r)}
                style={{
                  all: "unset", boxSizing: "border-box", cursor: "pointer", padding: "9px 13px", borderRadius: 999,
                  fontSize: 13.5, fontWeight: 700, fontFamily: AT.body,
                  background: pullReason === r ? (r === "damaged" ? AT.danger : AT.ink) : "#fff",
                  color: pullReason === r ? "#fff" : AT.ink,
                  border: `1.5px solid ${pullReason === r ? (r === "damaged" ? AT.danger : AT.ink) : AT.rule}`,
                }}
              >
                {t(`wh.pullR.${r}` as TKey)}
              </button>
            ))}
          </div>
          {pullReason === "other" && (
            <input
              value={pullNote}
              onChange={(e) => setPullNote(e.target.value)}
              placeholder={t("wh.pullNotePlaceholder")}
              maxLength={200}
              style={S.input}
            />
          )}
          {pullReason !== null && (
            <button
              style={{
                ...S.btn,
                ...(pullReason === "damaged" ? { background: AT.danger } : {}),
                ...(busy ? { opacity: 0.6 } : {}),
              }}
              disabled={busy}
              onClick={() => {
                void (async () => {
                  setBusy(true);
                  try {
                    await api.post(`/api/items/${item.id}/pull`, {
                      reason: pullReason,
                      ...(pullNote.trim() ? { note: pullNote.trim().slice(0, 200) } : {}),
                      toQuarantine: pullReason === "damaged",
                    });
                    toast(t("wh.pulled"));
                    setPulling(false);
                    setPullReason(null);
                    setPullNote("");
                    refresh();
                  } catch (err) {
                    toast(err instanceof ApiError ? err.message : t("wh.pullFailed"), "danger");
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
            >
              {pullReason === "damaged" ? t("wh.pullQuar") : t("wh.pullConfirm")}
            </button>
          )}
          <button style={{ ...S.btn, ...S.btnGhost, minHeight: 46, boxShadow: "none" }} onClick={() => { setPulling(false); setPullReason(null); }}>{t("wh.cancel")}</button>
        </div>
      )}

      <button style={{ ...S.btn, ...S.btnGhost }} onClick={() => void openLabelWindow(`/api/items/${item.id}/label`, (m) => toast(m, "danger"))}>{t("wh.printLabel")}</button>

      <ItemTabs itemId={item.id} />

      <button style={{ ...S.btn, ...S.btnAccent }} onClick={scanNext}>{t("wh.scanNext")}</button>
    </div>
  );
}

/** Full-screen photo viewer with prev/next, make-cover, and delete. */
function PhotoViewer({ photos, index, canEdit, itemId, toast, onChanged, onNav, onClose }: {
  photos: string[];
  index: number;
  canEdit: boolean;
  itemId: string;
  toast: (t: string, tone?: "ok" | "danger") => void;
  onChanged: () => void;
  onNav: (i: number) => void;
  onClose: () => void;
}) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const url = photos[index]!;

  const setCover = async () => {
    setBusy(true);
    try {
      await api.post(`/api/items/${itemId}/photos/cover`, { url });
      toast(t("wh.coverSet"));
      onChanged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("wh.saveFailed"), "danger");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(t("wh.confirmDeletePhoto"))) return;
    setBusy(true);
    try {
      await api.delete(`/api/items/${itemId}/photos`, { url });
      toast(t("wh.photoDeleted"));
      onChanged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("wh.saveFailed"), "danger");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 40, background: "rgba(0,0,0,0.94)", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", color: "#fff" }}>
        <span style={{ fontFamily: AT.body, fontSize: 14, fontWeight: 700 }}>{index + 1} / {photos.length}</span>
        <button onClick={onClose} style={{ all: "unset", cursor: "pointer", fontSize: 15, fontWeight: 800, padding: "6px 10px", color: "#fff", fontFamily: AT.body }}>
          ✕ {t("wh.close")}
        </button>
      </div>
      <div style={{ flex: 1, position: "relative", display: "grid", placeItems: "center", overflow: "hidden" }}>
        <img src={url} alt="" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
        {index > 0 && (
          <button onClick={() => onNav(index - 1)} style={{ all: "unset", cursor: "pointer", position: "absolute", left: 0, top: 0, bottom: 0, width: 64, color: "#fff", fontSize: 34, display: "grid", placeItems: "center" }}>‹</button>
        )}
        {index < photos.length - 1 && (
          <button onClick={() => onNav(index + 1)} style={{ all: "unset", cursor: "pointer", position: "absolute", right: 0, top: 0, bottom: 0, width: 64, color: "#fff", fontSize: 34, display: "grid", placeItems: "center" }}>›</button>
        )}
      </div>
      {canEdit && (
        <div style={{ display: "flex", gap: 10, padding: "12px 16px 20px" }}>
          {index !== 0 && (
            <button onClick={() => void setCover()} disabled={busy} style={{ ...S.btn, ...S.btnGhost, flex: 1, minHeight: 48, boxShadow: "none" }}>
              ⭐ {t("wh.setCover")}
            </button>
          )}
          <button onClick={() => void remove()} disabled={busy} style={{ ...S.btn, ...S.btnDanger, flex: 1, minHeight: 48, boxShadow: "none" }}>
            🗑️ {t("wh.deletePhoto")}
          </button>
        </div>
      )}
    </div>
  );
}

/** W2 item tabs — «Saruna» (per-item chat) and «Vēsture» (audit timeline). */
function ItemTabs({ itemId }: { itemId: string }) {
  const { t } = useT();
  const [tab, setTab] = useState<"chat" | "history">("chat");
  const { unread, bump, refreshUnread } = useCommentsLive();
  const unreadCount = unread.get(itemId) ?? 0;

  const tabBtn = (id: "chat" | "history", label: string, badge?: number) => (
    <button
      onClick={() => setTab(id)}
      style={{
        all: "unset", boxSizing: "border-box", cursor: "pointer", padding: "9px 14px", borderRadius: 999,
        fontSize: 13.5, fontWeight: 700, fontFamily: AT.body, display: "inline-flex", alignItems: "center", gap: 7,
        background: tab === id ? AT.ink : "#fff", color: tab === id ? "#fff" : AT.ink,
        border: `1.5px solid ${tab === id ? AT.ink : AT.rule}`,
      }}
    >
      {label}
      {badge !== undefined && badge > 0 && (
        <span style={{
          background: AT.accent, color: "#fff", borderRadius: 999, fontSize: 11, fontWeight: 800,
          minWidth: 18, height: 18, display: "inline-grid", placeItems: "center", padding: "0 5px",
        }}>{badge}</span>
      )}
    </button>
  );

  return (
    <div style={{ ...S.card, display: "grid", gap: 10 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {tabBtn("chat", t("wh.tab.chat"), unreadCount)}
        {tabBtn("history", t("wh.tab.history"))}
      </div>
      {tab === "chat" ? (
        <CommentsThread itemId={itemId} bump={bump} onRead={refreshUnread} />
      ) : (
        <ActivityTimeline itemId={itemId} limit={20} />
      )}
    </div>
  );
}

// ── Grading review notices (home) ────────────────────────────────────────────

interface GradingNotice {
  itemId: string;
  sku: string;
  title: string;
  kind: "edited" | "rejected";
  rejectReason: string | null;
  oldCondition: string | null;
  newCondition: string | null;
  condition: string;
  reviewerName: string | null;
  reviewedAt: string | null;
}

/** Accent-bordered banners: "the reviewer edited/rejected your grade". */
function GradingNotices({ toast, onOpen }: {
  toast: (t: string, tone?: "ok" | "danger") => void;
  onOpen: (itemId: string) => void;
}) {
  const { t } = useT();
  const [notices, setNotices] = useState<GradingNotice[]>([]);

  const load = () => {
    void api.get<{ notices: GradingNotice[] }>("/api/grading/notices").then((r) => setNotices(r.notices)).catch(() => undefined);
  };
  useEffect(load, []);
  useAuctionEvents("admin", (ev) => {
    if (ev.type === "grade_edited" || ev.type === "grade_rejected") load();
  });

  const ack = async (n: GradingNotice) => {
    try {
      await api.post(`/api/grading/${n.itemId}/notice-ack`);
      setNotices((list) => list.filter((x) => x.itemId !== n.itemId));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("wh.actionFailed"), "danger");
    }
  };

  if (notices.length === 0) return null;
  const condLabel = (code: string | null) => (code ? conditionByCode(code)?.label ?? code.replace(/_/g, " ") : "?");
  return (
    <>
      {notices.map((n) => (
        <div
          key={n.itemId}
          onClick={() => onOpen(n.itemId)}
          style={{ ...S.card, border: `2px solid ${AT.accent}`, display: "grid", gap: 10, cursor: "pointer" }}
        >
          <div style={{ fontSize: 14.5, fontWeight: 600, lineHeight: 1.45 }}>
            <b>{n.reviewerName ?? "?"}</b>{" "}
            {n.kind === "edited" ? (
              <>
                {t("wh.noticeEdited")} <span style={{ fontFamily: AT.mono, fontWeight: 800 }}>{n.sku}</span>{" "}
                <span style={{ color: AT.inkSoft }}>({condLabel(n.oldCondition)} → {condLabel(n.newCondition)})</span>
              </>
            ) : (
              <>
                {t("wh.noticeRejected")} <span style={{ fontFamily: AT.mono, fontWeight: 800 }}>{n.sku}</span>
                {n.rejectReason ? <span style={{ color: AT.inkSoft }}>: {n.rejectReason}</span> : null}
              </>
            )}
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); void ack(n); }}
            style={{ ...S.btn, ...S.btnGhost, minHeight: 44, boxShadow: "none" }}
          >{t("wh.ok")}</button>
        </div>
      ))}
    </>
  );
}

function BinPicker({ itemId, current, toast, done }: {
  itemId: string;
  current: string | null;
  toast: (t: string, tone?: "ok" | "danger") => void;
  done: () => void;
}) {
  const { t } = useT();
  const [bins, setBins] = useState<Bin[]>([]);
  const [q, setQ] = useState("");
  const [camera, setCamera] = useState(false);
  useEffect(() => {
    void api.get<{ locations: Bin[] }>("/api/warehouse/locations").then((r) => setBins(r.locations.filter((b) => b.active))).catch(() => undefined);
  }, []);
  const assign = async (locationId: string | null) => {
    try {
      await api.post(`/api/items/${itemId}/putaway`, { locationId, reason: "warehouse mode" });
      toast(locationId ? t("wh.binAssigned") : t("wh.binCleared"));
      done();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("wh.putawayFailed"), "danger");
    }
  };
  // Shelf labels encode BIN:<uuid> — scanning one assigns the bin directly.
  const onBinScan = (raw: string) => {
    setCamera(false);
    const scanned = raw.trim();
    if (scanned.startsWith("BIN:")) return void assign(scanned.slice(4));
    const byLabel = bins.find((b) => b.label.toLowerCase() === scanned.toLowerCase());
    if (byLabel) return void assign(byLabel.id);
    toast(t("wh.notABin"), "danger");
  };
  const visible = bins.filter((b) => !q || b.label.toLowerCase().includes(q.toLowerCase()));
  return (
    <div style={{ ...S.card, display: "grid", gap: 8 }}>
      <button style={{ ...S.btn, ...S.btnAccent, minHeight: 48 }} onClick={() => setCamera(true)}>{t("wh.scanShelf")}</button>
      {camera && <CameraScanner hint={t("wh.aimShelf")} onCode={onBinScan} onClose={() => setCamera(false)} />}
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("wh.filterBins")} style={S.input} />
      <div style={{ maxHeight: 260, overflowY: "auto", display: "grid", gap: 6 }}>
        {current && (
          <button style={{ ...S.btn, ...S.btnDanger, minHeight: 46, boxShadow: "none" }} onClick={() => void assign(null)}>{t("wh.clearBin")}</button>
        )}
        {visible.map((b) => (
          <button key={b.id} onClick={() => void assign(b.id)} style={{
            ...S.btn, ...S.btnGhost, minHeight: 46, boxShadow: "none", justifyContent: "space-between", fontFamily: AT.mono, fontSize: 15,
            ...(b.id === current ? { borderColor: AT.accent, borderWidth: 2 } : {}),
          }}>
            <span>{b.label}</span><span style={{ fontSize: 11.5, color: AT.inkSoft, fontFamily: AT.body }}>{b.zone}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── W3: bin browser (list + contents) ────────────────────────────────────────

interface BrowserBin extends Bin {
  capacity: number | null;
  itemCount: number;
  lastActivity: { type: string; actorLabel: string; at: string } | null;
}

/** "pirms 2 st." / "2 ч назад" / "2 h ago" — coarse, phone-sized. */
function agoShort(iso: string, lang: Lang): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  const x =
    s < 90 ? null :
    s < 5400 ? `${Math.round(s / 60)} min` :
    s < 129_600 ? `${Math.round(s / 3600)} ${lang === "lv" ? "st." : lang === "ru" ? "ч" : "h"}` :
    `${Math.round(s / 86_400)} ${lang === "ru" ? "д" : "d."}`;
  if (x === null) return lang === "lv" ? "tikko" : lang === "ru" ? "только что" : "just now";
  return lang === "lv" ? `pirms ${x}` : lang === "ru" ? `${x} назад` : `${x} ago`;
}

function BinsList({ toast, onOpen }: {
  toast: (t: string, tone?: "ok" | "danger") => void;
  onOpen: (id: string, label: string) => void;
}) {
  const { t, lang } = useT();
  const [bins, setBins] = useState<BrowserBin[]>([]);
  const [q, setQ] = useState("");
  const [camera, setCamera] = useState(false);

  useEffect(() => {
    void api.get<{ bins: BrowserBin[] }>("/api/warehouse/bins").then((r) => setBins(r.bins.filter((b) => b.active))).catch(() => undefined);
  }, []);

  const onBinScan = (raw: string) => {
    setCamera(false);
    const scanned = raw.trim();
    const byId = scanned.startsWith("BIN:") ? bins.find((b) => b.id === scanned.slice(4)) : undefined;
    const bin = byId ?? bins.find((b) => b.label.toLowerCase() === scanned.toLowerCase());
    if (bin) onOpen(bin.id, bin.label);
    else toast(t("wh.notABin"), "danger");
  };

  const visible = bins.filter((b) => !q || b.label.toLowerCase().includes(q.toLowerCase()));
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <button style={{ ...S.btn, ...S.btnAccent, minHeight: 52 }} onClick={() => setCamera(true)}>{t("wh.scanShelf")}</button>
      {camera && <CameraScanner hint={t("wh.aimShelf")} onCode={onBinScan} onClose={() => setCamera(false)} />}
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("wh.filterBins")} style={S.input} />
      {visible.length === 0 && <div style={{ ...S.card, color: AT.inkSoft, fontSize: 14 }}>{t("wh.noBins")}</div>}
      {visible.map((b) => {
        const over = b.capacity !== null && b.itemCount > b.capacity;
        return (
          <button key={b.id} onClick={() => onOpen(b.id, b.label)} style={{ ...S.btn, ...S.btnGhost, justifyContent: "space-between", minHeight: 58 }}>
            <span style={{ textAlign: "left" }}>
              <span style={{ display: "block", fontFamily: AT.mono, fontSize: 15 }}>{b.label}</span>
              <span style={{ display: "block", fontSize: 11.5, color: AT.inkSoft, fontWeight: 600 }}>
                {b.lastActivity ? agoShort(b.lastActivity.at, lang) : b.zone}
              </span>
            </span>
            <span style={{
              fontSize: 12.5, fontWeight: 800, borderRadius: 999, padding: "3px 11px",
              background: over ? AT.warnSoft : b.itemCount === 0 ? AT.surfaceAlt : AT.accentSoft,
              color: over ? AT.warn : b.itemCount === 0 ? AT.inkSoft : AT.accent,
            }}>
              {b.itemCount === 0 && b.capacity === null ? t("wh.emptyBin") : `${b.itemCount}${b.capacity !== null ? ` / ${b.capacity}` : ""}`}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function BinContentsView({ id, onItem }: { id: string; onItem: (code: string) => void }) {
  const { t, lang } = useT();
  const [data, setData] = useState<{
    bin: BrowserBin;
    contents: Array<{ id: string; sku: string; title: string; status: string; photos: string[]; sinceAt: string }>;
  } | null>(null);

  useEffect(() => {
    void api.get<typeof data>(`/api/warehouse/bins/${id}`).then((r) => setData(r)).catch(() => undefined);
  }, [id]);

  if (!data) return null;
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ ...S.card, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={S.label}>{t("wh.binContents")}</span>
        <span style={{ fontSize: 14, fontWeight: 800 }}>
          {data.contents.length}{data.bin.capacity !== null ? ` / ${data.bin.capacity}` : ""} {t("wh.pieces")}
        </span>
      </div>
      {data.contents.length === 0 && <div style={{ ...S.card, color: AT.inkSoft, fontSize: 14 }}>{t("wh.emptyBin")}</div>}
      {data.contents.map((c) => (
        <button key={c.id} onClick={() => onItem(c.id)} style={{ ...S.btn, ...S.btnGhost, justifyContent: "flex-start", gap: 12, minHeight: 62 }}>
          {c.photos[0] ? (
            <img src={thumbOf(c.photos[0])} alt="" style={{ width: 42, height: 42, objectFit: "cover", borderRadius: 9, flexShrink: 0 }} />
          ) : (
            <span style={{ width: 42, height: 42, borderRadius: 9, background: AT.surfaceAlt, display: "grid", placeItems: "center", flexShrink: 0 }}>📷</span>
          )}
          <span style={{ textAlign: "left", minWidth: 0, flex: 1 }}>
            <span style={{ display: "block", fontSize: 14, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.title}</span>
            <span style={{ display: "block", fontFamily: AT.mono, fontSize: 11.5, color: AT.inkSoft }}>{c.sku} · {agoShort(c.sinceAt, lang)}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

// ── Receive ──────────────────────────────────────────────────────────────────

function ReceiveList({ onPick }: { onPick: (c: Consignment) => void }) {
  const { t } = useT();
  const [list, setList] = useState<Consignment[]>([]);
  useEffect(() => {
    void api.get<{ consignments: Consignment[] }>("/api/consignments?status=open").then((r) => setList(r.consignments)).catch(() => undefined);
  }, []);
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={S.label}>{t("wh.openDeliveries")}</div>
      {list.length === 0 && <div style={{ ...S.card, color: AT.inkSoft, fontSize: 14 }}>{t("wh.noDeliveries")}</div>}
      {list.map((c) => (
        <button key={c.id} onClick={() => onPick(c)} style={{ ...S.btn, ...S.btnGhost, justifyContent: "space-between" }}>
          <span style={{ fontFamily: AT.mono }}>{c.ref}</span>
          <span style={{ fontSize: 13.5, fontWeight: 600, flex: 1, textAlign: "left", marginLeft: 10, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.supplier}</span>
          <span style={{ fontSize: 13, color: AT.inkSoft }}>{c.receivedCount ?? 0}{c.expectedCount ? `/${c.expectedCount}` : ""}</span>
        </button>
      ))}
    </div>
  );
}

function ReceiveForm({ con, toast, onReceived }: {
  con: Consignment;
  toast: (t: string, tone?: "ok" | "danger") => void;
  onReceived: (item: Item) => void;
}) {
  const { t } = useT();
  const [title, setTitle] = useState("");
  const [condition, setCondition] = useState("brand_new");
  const [notes, setNotes] = useState("");
  const [count, setCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [lastSku, setLastSku] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const needsNotes = conditionRequiresNotes(condition);
  const ok = title.trim().length >= 2 && (!needsNotes || notes.trim().length >= 3);

  const receive = async (thenPhotos: boolean) => {
    if (!ok || busy) return;
    setBusy(true);
    try {
      const r = await api.post<{ item: Item }>(`/api/consignments/${con.id}/receive`, {
        title: title.trim(),
        condition,
        conditionNotes: notes,
      });
      setCount((n) => n + 1);
      setLastSku(r.item.sku);
      setTitle("");
      setNotes("");
      toast(`${r.item.sku} ${t("wh.received")}`);
      if (thenPhotos) onReceived(r.item);
      else titleRef.current?.focus();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("wh.receiveFailed"), "danger");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ ...S.card, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 13.5, fontWeight: 600 }}>{con.supplier}</span>
        <span style={{ fontSize: 13, color: AT.inkSoft }}>{t("wh.thisSession")}: <b>{count}</b>{lastSku ? ` · ${t("wh.last")} ${lastSku}` : ""}</span>
      </div>
      <div style={S.label}>{t("wh.itemTitle")}</div>
      <input ref={titleRef} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("wh.titlePlaceholder")} autoFocus style={S.input} />
      <div style={S.label}>{t("wh.condition")}</div>
      <select value={condition} onChange={(e) => setCondition(e.target.value)} style={S.input}>
        {CONDITIONS.map((c) => (
          <option key={c.code} value={c.code}>{c.requiresNotes ? `${c.label} — see notes` : c.label}</option>
        ))}
      </select>
      {conditionByCode(condition) && <div style={{ fontSize: 12.5, color: AT.inkSoft }}>{conditionByCode(condition)!.description}</div>}
      <div style={S.label}>{needsNotes ? t("wh.condNotesRequired") : t("wh.condNotes")}</div>
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} style={{ ...S.input, minHeight: 64, padding: 12, borderColor: needsNotes && notes.trim().length < 3 ? "#C24" : AT.rule }} />
      <button style={{ ...S.btn, ...(ok ? {} : { opacity: 0.5 }) }} onClick={() => void receive(true)} disabled={!ok || busy}>{t("wh.receivePhotos")}</button>
      <button style={{ ...S.btn, ...S.btnGhost, ...(ok ? {} : { opacity: 0.5 }) }} onClick={() => void receive(false)} disabled={!ok || busy}>{t("wh.receiveNext")}</button>
    </div>
  );
}

// ── Worker status (home) ─────────────────────────────────────────────────────

function StatusSelector({ toast }: { toast: (t: string, tone?: "ok" | "danger") => void }) {
  const { user } = useAuth();
  const { t } = useT();
  const [cur, setCur] = useState<WorkerStatus | null>(null);

  useEffect(() => {
    void api
      .get<{ workers: WorkerToday[] }>("/api/warehouse/status/today")
      .then((r) => setCur(r.workers.find((w) => w.userId === user?.id)?.status ?? null))
      .catch(() => undefined);
  }, [user?.id]);

  const set = async (s: WorkerStatus) => {
    try {
      await api.post("/api/warehouse/status", { status: s });
      setCur(s);
      toast(t("wh.statusSaved"));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("wh.statusFailed"), "danger");
    }
  };

  return (
    <div style={{ ...S.card, display: "grid", gap: 8 }}>
      <div style={S.label}>{t("wh.myStatus")}</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {WORKER_STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => void set(s)}
            style={{
              all: "unset", boxSizing: "border-box", cursor: "pointer", padding: "10px 14px", borderRadius: 999,
              fontSize: 13.5, fontWeight: 700, fontFamily: AT.body,
              background: cur === s ? AT.ink : "#fff", color: cur === s ? "#fff" : AT.ink,
              border: `1.5px solid ${cur === s ? AT.ink : AT.rule}`,
            }}
          >
            {t(`wh.st.${s}` as TKey)}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Scanner first-run card (home) ────────────────────────────────────────────

function ScannerSetupCard({ onTryScan }: { onTryScan: () => void }) {
  const { t } = useT();
  const [hidden, setHidden] = useState<boolean>(() => {
    try {
      return localStorage.getItem("scannerCardDone") === "1";
    } catch {
      return true;
    }
  });
  if (hidden) return null;
  const hide = () => {
    setHidden(true);
    try {
      localStorage.setItem("scannerCardDone", "1");
    } catch {
      /* private mode — card returns next visit, harmless */
    }
  };
  return (
    <div style={{ ...S.card, border: `1.5px solid ${AT.accent}`, display: "grid", gap: 8 }}>
      <div style={{ ...S.label, color: AT.accent }}>{t("wh.scanSetupTitle")}</div>
      <div style={{ fontSize: 13.5, lineHeight: 1.5 }}>{t("wh.scanStep1")}</div>
      <div style={{ fontSize: 13.5, lineHeight: 1.5 }}>{t("wh.scanStep2")}</div>
      <div style={{ fontSize: 13.5, lineHeight: 1.5 }}>{t("wh.scanStep3")}</div>
      <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
        <button style={{ ...S.btn, ...S.btnAccent, minHeight: 46, flex: 1, boxShadow: "none" }} onClick={onTryScan}>{t("wh.tryScan")}</button>
        <button style={{ ...S.btn, ...S.btnGhost, minHeight: 46, flex: 1, boxShadow: "none" }} onClick={hide}>{t("wh.hideCard")}</button>
      </div>
    </div>
  );
}

// ── Incoming pass offer (home + pick queue) ──────────────────────────────────

function PassOfferCard({ ticket, toast, onAccepted, onDeclined }: {
  ticket: Ticket;
  toast: (t: string, tone?: "ok" | "danger") => void;
  onAccepted: () => void;
  onDeclined: () => void;
}) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);

  const act = async (path: "accept" | "decline", okMsg: string, after: () => void) => {
    setBusy(true);
    try {
      await api.post(`/api/pickup/tickets/${ticket.id}/${path}`);
      toast(okMsg);
      after();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("wh.actionFailed"), "danger");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ ...S.card, border: `2px solid ${AT.accent}`, display: "grid", gap: 10 }}>
      <div style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.45 }}>
        «{ticket.claimedByName ?? "?"}» {t("wh.passesYou")}{" "}
        <span style={{ fontFamily: AT.mono, fontWeight: 800 }}>#{ticket.number}</span>
        {ticket.passReason ? <span style={{ fontWeight: 600, color: AT.inkSoft }}> — {ticket.passReason}</span> : null}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          style={{ ...S.btn, ...S.btnAccent, minHeight: 48, flex: 1, boxShadow: "none", ...(busy ? { opacity: 0.6 } : {}) }}
          disabled={busy}
          onClick={() => void act("accept", t("wh.passAccepted"), onAccepted)}
        >{t("wh.accept")}</button>
        <button
          style={{ ...S.btn, ...S.btnGhost, minHeight: 48, flex: 1, boxShadow: "none", ...(busy ? { opacity: 0.6 } : {}) }}
          disabled={busy}
          onClick={() => void act("decline", t("wh.passDeclined"), onDeclined)}
        >{t("wh.decline")}</button>
      </div>
    </div>
  );
}

/** Home-screen watcher: polls the queue and surfaces a pass offer aimed at me. */
function IncomingPassWatcher({ toast, onOpen }: {
  toast: (t: string, tone?: "ok" | "danger") => void;
  onOpen: (id: string) => void;
}) {
  const { user } = useAuth();
  const [offer, setOffer] = useState<Ticket | null>(null);

  useEffect(() => {
    if (!user?.id) return;
    const load = () => {
      void api
        .get<{ tickets: Ticket[] }>("/api/pickup/queue")
        .then((r) => setOffer(r.tickets.find((x) => x.passToId === user.id && x.status === "picking") ?? null))
        .catch(() => undefined);
    };
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [user?.id]);

  if (!offer) return null;
  return <PassOfferCard ticket={offer} toast={toast} onAccepted={() => onOpen(offer.id)} onDeclined={() => setOffer(null)} />;
}

// ── Pick ─────────────────────────────────────────────────────────────────────

const ticketTone = (status: string): Tone => (status === "waiting" ? "warn" : status === "picking" ? "ok" : "accent");

function statusText(t: (k: TKey) => string, status: string): string {
  const key = `wh.status.${status}` as TKey;
  try {
    return t(key);
  } catch {
    return status;
  }
}

function PickQueue({ toast, onOpen }: {
  toast: (t: string, tone?: "ok" | "danger") => void;
  onOpen: (id: string) => void;
}) {
  const { t } = useT();
  const { user } = useAuth();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const load = () => {
    void api.get<{ tickets: Ticket[] }>("/api/pickup/queue").then((r) => setTickets(r.tickets.filter((x) => x.status === "waiting" || x.status === "picking"))).catch(() => undefined);
  };
  useEffect(() => {
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);
  const offer = tickets.find((x) => x.passToId === user?.id && x.status === "picking") ?? null;
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {offer && <PassOfferCard ticket={offer} toast={toast} onAccepted={() => onOpen(offer.id)} onDeclined={load} />}
      {tickets.length === 0 && <div style={{ ...S.card, color: AT.inkSoft, fontSize: 14 }}>{t("wh.queueEmpty")}</div>}
      {tickets.map((tk) => (
        <button key={tk.id} onClick={() => onOpen(tk.id)} style={{ ...S.btn, ...S.btnGhost, justifyContent: "space-between", minHeight: 64 }}>
          <span style={{ fontFamily: AT.mono, fontSize: 26, fontWeight: 800 }}>{tk.number}</span>
          <span style={{ fontSize: 13, color: AT.inkSoft }}>{tk.lines.length} {tk.lines.length === 1 ? t("wh.items1") : t("wh.itemsN")}</span>
          <Pill text={statusText(t, tk.status)} tone={ticketTone(tk.status)} />
        </button>
      ))}
    </div>
  );
}

const PASS_REASONS = ["busy", "endShift", "break", "needHelp", "other"] as const;
type PassReason = (typeof PASS_REASONS)[number];

function TicketView({ id, toast, onDone }: {
  id: string;
  toast: (t: string, tone?: "ok" | "danger") => void;
  onDone: () => void;
}) {
  const { t } = useT();
  const { user } = useAuth();
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [code, setCode] = useState("");
  const [passing, setPassing] = useState(false);
  const [passReason, setPassReason] = useState<PassReason | null>(null);
  const [passOther, setPassOther] = useState("");
  const [colleagues, setColleagues] = useState<WorkerToday[]>([]);
  const [passBusy, setPassBusy] = useState(false);

  useEffect(() => {
    if (!passing) return;
    void api
      .get<{ workers: WorkerToday[] }>("/api/warehouse/status/today")
      .then((r) => setColleagues(r.workers.filter((w) => w.userId !== user?.id)))
      .catch(() => undefined);
  }, [passing, user?.id]);
  const load = () => {
    void api.get<{ tickets: Ticket[] }>("/api/pickup/queue").then((r) => {
      const found = r.tickets.find((x) => x.id === id) ?? null;
      setTicket(found);
      if (!found) onDone(); // completed/cancelled elsewhere
    }).catch(() => undefined);
  };
  useEffect(load, [id]);

  const act = async (fn: () => Promise<unknown>, okMsg?: string) => {
    try {
      await fn();
      if (okMsg) toast(okMsg);
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("wh.actionFailed"), "danger");
    }
  };

  if (!ticket) return <div style={{ ...S.card, color: AT.inkSoft }}>{t("wh.loading")}</div>;
  const lines = [...ticket.lines].sort((a, b) => (a.locationLabel ?? "~").localeCompare(b.locationLabel ?? "~"));
  const allDone = lines.every((l) => l.status !== "pending");
  const iAmClaimer = ticket.status === "picking" && ticket.claimedById === user?.id;

  // Reason sent to the API: the translated pill label, or the free text for "other".
  const passReasonText = (passReason === "other" ? passOther.trim() : passReason ? t(`wh.passR.${passReason}` as TKey) : "").slice(0, 60);
  const passReasonOk = passReasonText.length >= 2;

  const doPass = async (toUserId: string | null) => {
    if (!passReasonOk || passBusy) return;
    setPassBusy(true);
    try {
      await api.post(`/api/pickup/tickets/${ticket.id}/pass`, { toUserId, reason: passReasonText });
      if (toUserId === null) {
        toast(t("wh.passQueued"));
        onDone(); // no longer ours — back to the queue list
      } else {
        toast(t("wh.passOffered"));
        setPassing(false);
        setPassReason(null);
        setPassOther("");
        load();
      }
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("wh.actionFailed"), "danger");
    } finally {
      setPassBusy(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ ...S.card, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontFamily: AT.mono, fontSize: 32, fontWeight: 800 }}>{ticket.number}</span>
        <Pill text={statusText(t, ticket.status)} tone={ticketTone(ticket.status)} />
      </div>

      {ticket.passToId === user?.id && ticket.status === "picking" && (
        <PassOfferCard ticket={ticket} toast={toast} onAccepted={load} onDeclined={load} />
      )}

      {ticket.status === "waiting" && (
        <button style={{ ...S.btn, ...S.btnAccent }} onClick={() => void act(() => api.post(`/api/pickup/tickets/${ticket.id}/claim`), t("wh.claimed"))}>{t("wh.claim")}</button>
      )}

      {iAmClaimer && !passing && (
        <button style={{ ...S.btn, ...S.btnGhost }} onClick={() => setPassing(true)}>{t("wh.passTicket")}</button>
      )}
      {iAmClaimer && passing && (
        <div style={{ ...S.card, display: "grid", gap: 10 }}>
          <div style={S.label}>{t("wh.passWhy")}</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {PASS_REASONS.map((r) => (
              <button
                key={r}
                onClick={() => setPassReason(r)}
                style={{
                  all: "unset", boxSizing: "border-box", cursor: "pointer", padding: "9px 13px", borderRadius: 999,
                  fontSize: 13.5, fontWeight: 700, fontFamily: AT.body,
                  background: passReason === r ? AT.ink : "#fff", color: passReason === r ? "#fff" : AT.ink,
                  border: `1.5px solid ${passReason === r ? AT.ink : AT.rule}`,
                }}
              >
                {t(`wh.passR.${r}` as TKey)}
              </button>
            ))}
          </div>
          {passReason === "other" && (
            <input
              value={passOther}
              onChange={(e) => setPassOther(e.target.value)}
              placeholder={t("wh.passOtherPlaceholder")}
              maxLength={60}
              style={S.input}
            />
          )}
          <div style={S.label}>{t("wh.passToWhom")}</div>
          <div style={{ display: "grid", gap: 6 }}>
            {colleagues.map((w) => {
              const free = w.status === "working" && w.currentTicketNumber === null;
              const hint =
                w.currentTicketNumber !== null ? `${t("wh.busyWith")} #${w.currentTicketNumber}` :
                w.status === "working" ? t("wh.free") : t(`wh.st.${w.status}` as TKey);
              return (
                <button
                  key={w.userId}
                  disabled={!passReasonOk || passBusy}
                  onClick={() => void doPass(w.userId)}
                  style={{
                    ...S.btn, ...S.btnGhost, minHeight: 48, boxShadow: "none", justifyContent: "space-between",
                    opacity: w.status === "done" ? 0.45 : passReasonOk ? 1 : 0.55,
                  }}
                >
                  <span style={{ fontSize: 14.5 }}>{w.name}</span>
                  <span style={{ fontSize: 11.5, fontWeight: 800, color: free ? AT.ok : AT.inkSoft, letterSpacing: "0.04em" }}>{hint}</span>
                </button>
              );
            })}
          </div>
          <button
            style={{ ...S.btn, ...(passReasonOk ? {} : { opacity: 0.5 }) }}
            disabled={!passReasonOk || passBusy}
            onClick={() => void doPass(null)}
          >{t("wh.passToQueue")}</button>
          <button style={{ ...S.btn, ...S.btnGhost, minHeight: 46, boxShadow: "none" }} onClick={() => setPassing(false)}>{t("wh.cancel")}</button>
        </div>
      )}

      {lines.map((l) => (
        <div key={l.id} style={{ ...S.card, display: "grid", gap: 8, opacity: l.status === "pending" ? 1 : 0.72 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
            <span style={{ fontFamily: AT.mono, fontWeight: 800, fontSize: 16 }}>{l.locationLabel ?? l.legacyLocation ?? "—"}</span>
            <Pill
              text={statusText(t, l.status)}
              tone={l.status === "picked" ? "ok" : l.status === "pending" ? "neutral" : "danger"}
            />
          </div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{l.title}</div>
          <div style={{ fontFamily: AT.mono, fontSize: 12, color: AT.inkSoft }}>{l.sku} · {l.orderRef}</div>
          {ticket.status === "picking" && l.status === "pending" && (
            <div style={{ display: "flex", gap: 6 }}>
              <button style={{ ...S.btn, minHeight: 46, flex: 2, boxShadow: "none" }} onClick={() => void act(() => api.post(`/api/pickup/tickets/${ticket.id}/lines/${l.id}`, { status: "picked" }))}>{t("wh.picked")}</button>
              <button style={{ ...S.btn, ...S.btnGhost, minHeight: 46, flex: 1, boxShadow: "none" }} onClick={() => void act(() => api.post(`/api/pickup/tickets/${ticket.id}/lines/${l.id}`, { status: "missing" }))}>{t("wh.missing")}</button>
              <button style={{ ...S.btn, ...S.btnGhost, minHeight: 46, flex: 1, boxShadow: "none" }} onClick={() => void act(() => api.post(`/api/pickup/tickets/${ticket.id}/lines/${l.id}`, { status: "damaged" }))}>{t("wh.damaged")}</button>
            </div>
          )}
        </div>
      ))}

      {ticket.status === "picking" && allDone && (
        <button style={{ ...S.btn, ...S.btnAccent }} onClick={() => void act(() => api.post(`/api/pickup/tickets/${ticket.id}/delivering`), t("wh.onBoard"))}>
          {t("wh.toCounter")}
        </button>
      )}

      {ticket.status === "delivering" && (
        <div style={{ ...S.card, display: "grid", gap: 10 }}>
          <div style={S.label}>{t("wh.pickupCode")}</div>
          <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" placeholder="••••••" style={{ ...S.input, fontFamily: AT.mono, fontSize: 26, textAlign: "center", letterSpacing: "0.3em" }} />
          <button
            style={{ ...S.btn, ...(code.length === 6 ? {} : { opacity: 0.5 }) }}
            disabled={code.length !== 6}
            onClick={() => void act(async () => { await api.post(`/api/pickup/tickets/${ticket.id}/complete`, { pickupCode: code }); onDone(); }, t("wh.handedOver"))}
          >{t("wh.completeHandover")}</button>
        </div>
      )}
    </div>
  );
}

// ── W5/W6: stock counting — «Inventarizācija», blind counts ──────────────────

interface StockCountRow {
  id: string;
  name: string;
  status: "open" | "approved" | "cancelled";
  startedAt: string;
  binCount: number;
  doneCount: number;
  scanCount: number;
}

interface StockCountBin {
  id: string;
  label: string;
  zone: string;
  scanned: number;
  done: boolean;
}

/** Open counting sessions — pick one to start walking shelves. */
function CountList({ onPick }: { onPick: (c: StockCountRow) => void }) {
  const { t } = useT();
  const [counts, setCounts] = useState<StockCountRow[] | null>(null);
  useEffect(() => {
    void api
      .get<{ counts: StockCountRow[] }>("/api/stock-counts")
      .then((r) => setCounts(r.counts.filter((c) => c.status === "open")))
      .catch(() => setCounts([]));
  }, []);
  if (counts === null) return <div style={{ ...S.card, color: AT.inkSoft }}>{t("wh.loading")}</div>;
  if (counts.length === 0) {
    return (
      <div style={{ ...S.card, display: "grid", gap: 6 }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>{t("wh.cnt.noneOpen")}</div>
        <div style={{ fontSize: 13, color: AT.inkSoft, lineHeight: 1.5 }}>{t("wh.cnt.noneOpenHint")}</div>
      </div>
    );
  }
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={S.label}>{t("wh.cnt.pickSession")}</div>
      {counts.map((c) => (
        <button key={c.id} onClick={() => onPick(c)} style={{ ...S.btn, ...S.btnGhost, justifyContent: "space-between", minHeight: 64 }}>
          <span style={{ textAlign: "left", minWidth: 0, flex: 1 }}>
            <span style={{ display: "block", fontSize: 15, fontWeight: 800, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
            <span style={{ display: "block", fontSize: 12, color: AT.inkSoft, fontWeight: 600 }}>
              {c.doneCount} / {c.binCount} {t("wh.cnt.shelves")} · {c.scanCount} {t("wh.cnt.scans")}
            </span>
          </span>
          <span style={{ fontSize: 20, color: AT.inkSoft }}>›</span>
        </button>
      ))}
    </div>
  );
}

/** One session: its bins sorted by label — pick a shelf to count. */
function CountSessionView({ id, onBin }: { id: string; onBin: (locationId: string, binLabel: string) => void }) {
  const { t } = useT();
  const [data, setData] = useState<{ count: StockCountRow; bins: StockCountBin[]; scanCount: number } | null>(null);
  useEffect(() => {
    void api.get<{ count: StockCountRow; bins: StockCountBin[]; scanCount: number }>(`/api/stock-counts/${id}`).then((r) => setData(r)).catch(() => undefined);
  }, [id]);
  if (!data) return <div style={{ ...S.card, color: AT.inkSoft }}>{t("wh.loading")}</div>;
  const bins = [...data.bins].sort((a, b) => a.label.localeCompare(b.label));
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ ...S.card, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={S.label}>{t("wh.cnt.progress")}</span>
        <span style={{ fontSize: 14, fontWeight: 800 }}>
          {data.count.doneCount} / {data.count.binCount} {t("wh.cnt.shelves")} · {data.scanCount} {t("wh.cnt.scans")}
        </span>
      </div>
      <div style={S.label}>{t("wh.cnt.pickBin")}</div>
      {bins.map((b) => (
        <button
          key={b.id}
          onClick={() => onBin(b.id, b.label)}
          style={{ ...S.btn, ...S.btnGhost, justifyContent: "space-between", minHeight: 58, ...(b.done ? { opacity: 0.55 } : {}) }}
        >
          <span style={{ textAlign: "left" }}>
            <span style={{ display: "block", fontFamily: AT.mono, fontSize: 15 }}>{b.label}</span>
            <span style={{ display: "block", fontSize: 11.5, color: AT.inkSoft, fontWeight: 600 }}>{b.zone}</span>
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <span style={{
              fontSize: 12.5, fontWeight: 800, borderRadius: 999, padding: "3px 11px",
              background: b.scanned > 0 ? AT.accentSoft : AT.surfaceAlt,
              color: b.scanned > 0 ? AT.accent : AT.inkSoft,
            }}>
              {b.scanned} {t("wh.cnt.scans")}
            </span>
            {b.done && <span style={{ color: AT.ok, fontSize: 17, fontWeight: 800 }}>✓</span>}
          </span>
        </button>
      ))}
    </div>
  );
}

type CountScanResult = { known: false } | { known: true; sku: string; title: string; samePlace: boolean };

interface CountScanEntry {
  key: number;
  code: string;
  sku: string | null;
  title: string | null;
  kind: "ok" | "other" | "unknown";
}

/**
 * The counting screen — BLIND by design: it never shows what the shelf is
 * supposed to hold, only what this device has scanned so far.
 */
function CountBinView({ countId, countName, locationId, binLabel, toast, onDone, onClosed }: {
  countId: string;
  countName: string;
  locationId: string;
  binLabel: string;
  toast: (t: string, tone?: "ok" | "danger") => void;
  onDone: () => void;
  onClosed: () => void;
}) {
  const { t } = useT();
  const [scans, setScans] = useState<CountScanEntry[]>([]);
  const [code, setCode] = useState("");
  const [camera, setCamera] = useState(false);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  const submit = async (raw: string) => {
    const c = raw.trim();
    if (c.length < 3 || busy) return;
    setBusy(true);
    try {
      const r = await api.post<CountScanResult>(`/api/stock-counts/${countId}/scan`, { code: c, locationId });
      const entry: CountScanEntry = r.known
        ? { key: ++seq.current, code: c, sku: r.sku, title: r.title, kind: r.samePlace ? "ok" : "other" }
        : { key: ++seq.current, code: c, sku: null, title: null, kind: "unknown" };
      setScans((list) => [entry, ...list]);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        toast(t("wh.cnt.closed"), "danger");
        onClosed();
      } else {
        toast(err instanceof ApiError ? err.message : t("wh.cnt.scanFailed"), "danger");
      }
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.post(`/api/stock-counts/${countId}/bin-done`, { locationId });
      toast(t("wh.cnt.binDoneOk"));
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        toast(t("wh.cnt.closed"), "danger");
        onClosed();
      } else {
        toast(err instanceof ApiError ? err.message : t("wh.actionFailed"), "danger");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ ...S.card, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <span style={{ fontFamily: AT.mono, fontSize: 19, fontWeight: 800 }}>{binLabel}</span>
        <span style={{ fontSize: 12.5, color: AT.inkSoft, fontWeight: 600, textAlign: "right", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{countName}</span>
      </div>

      <button style={{ ...S.btn, ...S.btnAccent, minHeight: 64, fontSize: 17 }} onClick={() => setCamera(true)}>{t("wh.scanCamera")}</button>
      {camera && (
        <CameraScanner
          hint={t("wh.aimItem")}
          onCode={(raw) => { setCamera(false); void submit(normalizeScan(raw)); }}
          onClose={() => setCamera(false)}
        />
      )}
      <form
        onSubmit={(e) => { e.preventDefault(); void submit(code); setCode(""); }}
        style={{ display: "grid", gap: 8 }}
      >
        <div style={S.label}>{t("wh.scanOrType")}</div>
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="LOT-000123" autoCapitalize="characters" style={{ ...S.input, fontFamily: AT.mono, fontSize: 18, textAlign: "center" }} />
      </form>

      <div style={{ ...S.card, display: "grid", gap: 4 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={S.label}>{t("wh.cnt.scannedHere")}</span>
          <span style={{ fontSize: 14, fontWeight: 800 }}>{scans.length}</span>
        </div>
        {scans.length === 0 ? (
          <div style={{ color: AT.inkSoft, fontSize: 13.5, lineHeight: 1.5, paddingTop: 4 }}>{t("wh.cnt.blindHint")}</div>
        ) : (
          scans.map((s, i) => (
            <div key={s.key} style={{
              display: "flex", alignItems: "center", gap: 10, padding: "8px 0",
              borderBottom: i === scans.length - 1 ? "none" : `1px solid ${AT.ruleSoft}`,
            }}>
              <span style={{
                fontSize: 17, width: 22, textAlign: "center", fontWeight: 800, flexShrink: 0,
                color: s.kind === "ok" ? AT.ok : s.kind === "other" ? AT.warn : AT.danger,
              }}>
                {s.kind === "ok" ? "✓" : s.kind === "other" ? "→" : "?"}
              </span>
              <span style={{ minWidth: 0, flex: 1 }}>
                <span style={{ display: "block", fontFamily: AT.mono, fontSize: 14, fontWeight: 700 }}>{s.sku ?? s.code}</span>
                {s.title && <span style={{ display: "block", fontSize: 12, color: AT.inkSoft, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.title}</span>}
              </span>
              {s.kind !== "ok" && (
                <Pill text={t(s.kind === "other" ? "wh.cnt.otherBin" : "wh.cnt.unknown")} tone={s.kind === "other" ? "warn" : "danger"} />
              )}
            </div>
          ))
        )}
      </div>

      <button style={{ ...S.btn, minHeight: 60, fontSize: 17, ...(busy ? { opacity: 0.6 } : {}) }} disabled={busy} onClick={() => void finish()}>
        ✅ {t("wh.cnt.binDone")}
      </button>
    </div>
  );
}
