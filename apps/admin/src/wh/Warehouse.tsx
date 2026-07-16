import { CONDITIONS, conditionByCode, conditionRequiresNotes } from "@auction/domain/conditions";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Item } from "../api.js";
import { useAuth } from "../auth.js";
import { adminOrigin, isWarehouseHost } from "../host.js";
import { useT, type TKey } from "../i18n.js";
import { LangSwitch } from "../LangSwitch.js";
import { openLabelWindow } from "../labels.js";
import { AT, ITEM_STATUS_TONE, toneColors, type Tone } from "../theme.js";
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

interface ActivityEvent {
  at: string;
  actor: string;
  kind: "audit" | "move";
  action: string;
  detail: Record<string, unknown> | null;
  fromLabel: string | null;
  toLabel: string | null;
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
  lines: TicketLine[];
}

type View =
  | { v: "home" }
  | { v: "scan"; forPutaway?: boolean }
  | { v: "item"; data: LookupResult }
  | { v: "receive" }
  | { v: "receive-into"; con: Consignment }
  | { v: "pick" }
  | { v: "ticket"; id: string };

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

const LOCALE: Record<string, string> = { lv: "lv-LV", ru: "ru-RU", en: "en-GB" };

export function WarehouseMode() {
  const { user, can, logout } = useAuth();
  const { t } = useT();
  const [view, setView] = useState<View>({ v: "home" });
  const [flash, setFlash] = useState<{ text: string; tone: "ok" | "danger" } | null>(null);

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
    view.v === "pick" ? t("wh.pickQueue") : t("wh.ticket");

  const back = () => {
    if (view.v === "item" || view.v === "scan" || view.v === "receive" || view.v === "pick") setView({ v: "home" });
    else if (view.v === "receive-into") setView({ v: "receive" });
    else if (view.v === "ticket") setView({ v: "pick" });
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
        {view.v === "pick" && <PickQueue onOpen={(id) => setView({ v: "ticket", id })} />}
        {view.v === "ticket" && <TicketView id={view.id} toast={toast} onDone={() => setView({ v: "pick" })} />}
      </main>
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

function ItemView({ data, canEdit, canBin, toast, refresh, scanNext }: {
  data: LookupResult;
  canEdit: boolean;
  canBin: boolean;
  toast: (t: string, tone?: "ok" | "danger") => void;
  refresh: () => void;
  scanNext: () => void;
}) {
  const { t } = useT();
  const { item, binLabel, consignmentRef } = data;
  const [grading, setGrading] = useState(false);
  const [binPick, setBinPick] = useState(false);
  const [condition, setCondition] = useState(item.condition);
  const [notes, setNotes] = useState((item as { conditionNotes?: string }).conditionNotes ?? "");
  const [busy, setBusy] = useState(false);
  const [viewer, setViewer] = useState<number | null>(null);
  const needsNotes = conditionRequiresNotes(condition);
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
    if (needsNotes && notes.trim().length < 3) return;
    setBusy(true);
    try {
      await api.patch(`/api/items/${item.id}`, { condition, conditionNotes: notes });
      toast(t("wh.gradeSaved"));
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
          <div style={S.label}>{needsNotes ? t("wh.notesRequired") : t("wh.notes")}</div>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} style={{ ...S.input, minHeight: 80, padding: 12, borderColor: needsNotes && notes.trim().length < 3 ? "#C24" : AT.rule }} />
          <div style={{ display: "flex", gap: 8 }}>
            <button style={{ ...S.btn, flex: 1, ...(needsNotes && notes.trim().length < 3 ? { opacity: 0.5 } : {}) }} onClick={() => void saveGrade()} disabled={busy || (needsNotes && notes.trim().length < 3)}>{t("wh.saveGrade")}</button>
            <button style={{ ...S.btn, ...S.btnGhost, flex: 1 }} onClick={() => setGrading(false)}>{t("wh.cancel")}</button>
          </div>
        </div>
      )}

      {canBin && !binPick && (
        <button style={{ ...S.btn, ...S.btnGhost }} onClick={() => setBinPick(true)}>{t("wh.putawayMove")}</button>
      )}
      {canBin && binPick && <BinPicker itemId={item.id} current={item.locationId} toast={toast} done={() => { setBinPick(false); refresh(); }} />}

      <button style={{ ...S.btn, ...S.btnGhost }} onClick={() => void openLabelWindow(`/api/items/${item.id}/label`, (m) => toast(m, "danger"))}>{t("wh.printLabel")}</button>

      <ItemHistory itemId={item.id} />

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

/** "Who did what" — audit + movement timeline for one item. */
function ItemHistory({ itemId }: { itemId: string }) {
  const { t, lang } = useT();
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  useEffect(() => {
    setEvents(null);
    void api.get<{ events: ActivityEvent[] }>(`/api/items/${itemId}/activity`).then((r) => setEvents(r.events)).catch(() => setEvents([]));
  }, [itemId]);

  const verb = (e: ActivityEvent): string => {
    const key = `act.${e.action}` as TKey;
    try {
      return t(key);
    } catch {
      return e.action.replace(/_/g, " ");
    }
  };

  const extra = (e: ActivityEvent): string => {
    if (e.kind === "move" && (e.fromLabel || e.toLabel)) return ` ${e.fromLabel ?? "—"} → ${e.toLabel ?? "—"}`;
    if (e.action === "transition" && e.detail) return ` ${String(e.detail.from ?? "")} → ${String(e.detail.to ?? "")}`;
    if (e.action === "photos_added" && e.detail?.count) return ` (${String(e.detail.count)})`;
    return "";
  };

  const fmt = (iso: string) => new Date(iso).toLocaleString(LOCALE[lang], { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

  return (
    <div style={{ ...S.card, display: "grid", gap: 10 }}>
      <div style={S.label}>{t("wh.history")}</div>
      {events === null && <div style={{ color: AT.inkSoft, fontSize: 13.5 }}>…</div>}
      {events !== null && events.length === 0 && <div style={{ color: AT.inkSoft, fontSize: 13.5 }}>{t("wh.historyEmpty")}</div>}
      {events !== null && events.length > 0 && (
        <div style={{ display: "grid", gap: 0 }}>
          {events.slice(0, 20).map((e, i) => (
            <div key={`${e.at}-${i}`} style={{
              display: "flex", gap: 10, alignItems: "baseline", padding: "8px 0",
              borderTop: i === 0 ? "none" : `1px solid ${AT.ruleSoft}`,
            }}>
              <span style={{ fontFamily: AT.mono, fontSize: 11.5, color: AT.inkSoft, flexShrink: 0 }}>{fmt(e.at)}</span>
              <span style={{ fontSize: 13, lineHeight: 1.4 }}>
                <b>{e.actor}</b> {verb(e)}<span style={{ fontFamily: AT.mono, fontSize: 12 }}>{extra(e)}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
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

function PickQueue({ onOpen }: { onOpen: (id: string) => void }) {
  const { t } = useT();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const load = () => {
    void api.get<{ tickets: Ticket[] }>("/api/pickup/queue").then((r) => setTickets(r.tickets.filter((x) => x.status === "waiting" || x.status === "picking"))).catch(() => undefined);
  };
  useEffect(() => {
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div style={{ display: "grid", gap: 10 }}>
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

function TicketView({ id, toast, onDone }: {
  id: string;
  toast: (t: string, tone?: "ok" | "danger") => void;
  onDone: () => void;
}) {
  const { t } = useT();
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [code, setCode] = useState("");
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

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ ...S.card, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontFamily: AT.mono, fontSize: 32, fontWeight: 800 }}>{ticket.number}</span>
        <Pill text={statusText(t, ticket.status)} tone={ticketTone(ticket.status)} />
      </div>

      {ticket.status === "waiting" && (
        <button style={{ ...S.btn, ...S.btnAccent }} onClick={() => void act(() => api.post(`/api/pickup/tickets/${ticket.id}/claim`), t("wh.claimed"))}>{t("wh.claim")}</button>
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
