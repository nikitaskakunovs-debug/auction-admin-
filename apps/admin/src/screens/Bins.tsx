import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api.js";
import type { Nav } from "../App.js";
import { useAuth } from "../auth.js";
import { itemStatusLabel, t as tStatic, useT, type TKey } from "../i18n.js";
import { openLabelWindow as openLabel } from "../labels.js";
import { AT, ITEM_STATUS_TONE, toneColors, type Tone } from "../theme.js";
import { ABadge, ABtn, ACard, ADrawer, AEmpty, AField, AInput, APills, useConfirm, useToast } from "../ui.js";

/**
 * W3 — bin browser: every bin by zone with live item count, capacity fill,
 * and last activity from the movement ledger; a drawer per bin with contents
 * and in/out history. Rendered as the third tab on Receiving.
 */

interface BinRow {
  id: string;
  zone: string;
  aisle: string;
  rack: string;
  shelf: string;
  label: string;
  notes: string;
  capacity: number | null;
  active: boolean;
  itemCount: number;
  lastActivity: { type: string; actorLabel: string; at: string } | null;
}

interface BinContents {
  bin: BinRow;
  contents: Array<{ id: string; sku: string; title: string; status: string; photos: string[]; sinceAt: string }>;
  activity: Array<{ at: string; type: string; actorLabel: string; sku: string; inbound: boolean }>;
}

type Fill = "all" | "empty" | "over";

const thumbOf = (u: string) => (u.includes("-web.webp") ? u.replace("-web.webp", "-thumb.webp") : u);

/** "2 h ago", "3 d ago" — coarse on purpose; the drawer has exact times. */
function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return tStatic("rcv.agoJustNow");
  if (s < 5400) return tStatic("rcv.agoMin").replace("{n}", String(Math.round(s / 60)));
  if (s < 129_600) return tStatic("rcv.agoH").replace("{n}", String(Math.round(s / 3600)));
  return tStatic("rcv.agoD").replace("{n}", String(Math.round(s / 86_400)));
}

/** Movement-ledger verbs reuse the act.* history keys; unknown types show raw. */
const MOVE_KEY: Record<string, TKey> = {
  intake: "act.intake",
  putaway: "act.putaway",
  move: "act.move",
  pick: "act.pick",
  restock: "act.restock",
  handover: "act.handover",
  adjust: "act.adjust",
};
const moveLabel = (ty: string): string => {
  const k = MOVE_KEY[ty];
  return k ? tStatic(k) : ty;
};

const emptyNewBin = { zone: "FRONT", aisle: "", rack: "", shelf: "", notes: "", capacity: "" };

export function BinsBrowser({ nav }: { nav: Nav }) {
  const { can } = useAuth();
  const { t } = useT();
  const toast = useToast();
  const [bins, setBins] = useState<BinRow[]>([]);
  const [q, setQ] = useState("");
  const [zone, setZone] = useState("all");
  const [fill, setFill] = useState<Fill>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newBin, setNewBin] = useState(emptyNewBin);

  const load = useCallback(() => {
    void api.get<{ bins: BinRow[] }>("/api/warehouse/bins").then((r) => setBins(r.bins)).catch(() => undefined);
  }, []);
  useEffect(load, [load]);

  const zones = useMemo(() => [...new Set(bins.map((b) => b.zone))].sort(), [bins]);

  const visible = bins.filter((b) => {
    if (zone !== "all" && b.zone !== zone) return false;
    if (fill === "empty" && (b.itemCount > 0 || !b.active)) return false;
    if (fill === "over" && (b.capacity === null || b.itemCount <= b.capacity)) return false;
    if (q && !b.label.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });
  const byZone = useMemo(() => {
    const m = new Map<string, BinRow[]>();
    for (const b of visible) m.set(b.zone, [...(m.get(b.zone) ?? []), b]);
    return [...m.entries()];
  }, [visible]);

  const create = async () => {
    try {
      const r = await api.post<{ location: { label: string } }>("/api/warehouse/locations", {
        zone: newBin.zone.trim(),
        aisle: newBin.aisle.trim(),
        rack: newBin.rack.trim(),
        shelf: newBin.shelf.trim(),
        notes: newBin.notes,
        capacity: newBin.capacity === "" ? null : Number(newBin.capacity),
      });
      toast(`${r.location.label} ${t("rcv.tBinCreated")}`, "ok");
      setCreating(false);
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("rcv.createFailed"), "danger");
    }
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <AInput value={q} onChange={setQ} placeholder={t("wh.filterBins")} style={{ width: 220 }} />
        <APills options={[{ id: "all", label: t("rcv.allZones") }, ...zones.map((z) => ({ id: z, label: z }))]} value={zone} onChange={setZone} />
        <APills
          options={[
            { id: "all" as const, label: t("c.all") },
            { id: "empty" as const, label: t("wh.emptyBin") },
            { id: "over" as const, label: t("rcv.overCapacity"), count: bins.filter((b) => b.capacity !== null && b.itemCount > b.capacity).length },
          ]}
          value={fill}
          onChange={setFill}
        />
        {can("warehouse.manage") && (
          <div style={{ marginLeft: "auto" }}>
            <ABtn size="sm" onClick={() => { setNewBin(emptyNewBin); setCreating(true); }}>{t("rcv.newBin")}</ABtn>
          </div>
        )}
      </div>

      {byZone.length === 0 && <ACard pad={false}><AEmpty text={t("rcv.noBinsMatch")} /></ACard>}

      {byZone.map(([z, list]) => (
        <div key={z} style={{ display: "grid", gap: 8 }}>
          <div style={{ fontFamily: AT.body, fontSize: 11, fontWeight: 700, letterSpacing: "0.09em", textTransform: "uppercase", color: AT.inkSoft }}>
            {z} · {list.length} {t("rcv.binsWord")} · {list.reduce((a, b) => a + b.itemCount, 0)} {t("wh.pieces")}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 8 }}>
            {list.map((b) => {
              const over = b.capacity !== null && b.itemCount > b.capacity;
              const pct = b.capacity === null || b.capacity === 0 ? null : Math.min(100, (b.itemCount / b.capacity) * 100);
              return (
                <button
                  key={b.id}
                  onClick={() => setOpenId(b.id)}
                  style={{
                    all: "unset", boxSizing: "border-box", cursor: "pointer",
                    background: AT.panel, border: `1px solid ${AT.ruleSoft}`, borderRadius: AT.radius,
                    padding: "10px 12px", opacity: b.active ? 1 : 0.5, display: "grid", gap: 5,
                  }}
                >
                  <span style={{ fontFamily: AT.mono, fontSize: 13, fontWeight: 700, color: AT.ink }}>{b.label}</span>
                  <span style={{ fontFamily: AT.body, fontSize: 12, color: over ? AT.warn : AT.inkSoft, fontWeight: over ? 700 : 400 }}>
                    {b.active
                      ? `${b.itemCount} ${t("wh.pieces")}${b.capacity !== null ? ` · ${t("rcv.cap")} ${b.capacity}` : ""}${over ? ` · ${t("rcv.overBang")}` : ""}`
                      : `${t("rcv.retired")} · ${b.itemCount} ${t("wh.pieces")}`}
                  </span>
                  <span style={{ height: 5, borderRadius: 3, background: AT.surfaceAlt, overflow: "hidden" }}>
                    <span style={{
                      display: "block", height: "100%",
                      width: `${pct ?? Math.min(100, b.itemCount * 8)}%`,
                      background: over ? AT.warn : pct === null ? "#B9B9B4" : AT.accent,
                    }} />
                  </span>
                  <span style={{ fontFamily: AT.body, fontSize: 11, color: AT.inkSoft }}>
                    {b.lastActivity ? `${ago(b.lastActivity.at)} — ${moveLabel(b.lastActivity.type)} · ${b.lastActivity.actorLabel}` : t("rcv.noActivity")}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}

      {openId && <BinDrawer id={openId} nav={nav} onClose={() => setOpenId(null)} onChanged={load} />}

      {creating && (
        <ADrawer
          title={t("rcv.newBin")}
          onClose={() => setCreating(false)}
          footer={
            <>
              <ABtn kind="ghost" onClick={() => setCreating(false)}>{t("c.cancel")}</ABtn>
              <ABtn onClick={() => void create()} disabled={newBin.zone.trim().length === 0}>{t("rcv.createBin")}</ABtn>
            </>
          }
        >
          <div style={{ display: "grid", gap: 14 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <AField label={t("rcv.zone")}><AInput value={newBin.zone} onChange={(v) => setNewBin({ ...newBin, zone: v.toUpperCase() })} placeholder="FRONT" /></AField>
              <AField label={t("rcv.aisle")}><AInput value={newBin.aisle} onChange={(v) => setNewBin({ ...newBin, aisle: v.toUpperCase() })} placeholder="A1" /></AField>
              <AField label={t("rcv.rack")}><AInput value={newBin.rack} onChange={(v) => setNewBin({ ...newBin, rack: v.toUpperCase() })} placeholder="R2" /></AField>
              <AField label={t("rcv.shelf")}><AInput value={newBin.shelf} onChange={(v) => setNewBin({ ...newBin, shelf: v.toUpperCase() })} placeholder="S3" /></AField>
            </div>
            <AField label={t("rcv.capacity")} hint={t("rcv.capacityHint")}>
              <AInput value={newBin.capacity} onChange={(v) => setNewBin({ ...newBin, capacity: v.replace(/\D/g, "") })} placeholder="10" style={{ width: 120 }} />
            </AField>
            <AField label={t("c.notes")}>
              <AInput value={newBin.notes} onChange={(v) => setNewBin({ ...newBin, notes: v })} placeholder={t("rcv.binNotesPh")} />
            </AField>
          </div>
        </ADrawer>
      )}
    </div>
  );
}

function BinDrawer({ id, nav, onClose, onChanged }: { id: string; nav: Nav; onClose: () => void; onChanged: () => void }) {
  const { can } = useAuth();
  const { t } = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const [data, setData] = useState<BinContents | null>(null);
  const [capacity, setCapacity] = useState("");
  const [notes, setNotes] = useState("");

  const load = useCallback(() => {
    void api.get<BinContents>(`/api/warehouse/bins/${id}`).then((r) => {
      setData(r);
      setCapacity(r.bin.capacity === null ? "" : String(r.bin.capacity));
      setNotes(r.bin.notes);
    }).catch(() => undefined);
  }, [id]);
  useEffect(load, [load]);

  const patch = async (body: Record<string, unknown>, okMsg: string) => {
    try {
      await api.patch(`/api/warehouse/locations/${id}`, body);
      toast(okMsg, "ok");
      load();
      onChanged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : t("wh.saveFailed"), "danger");
    }
  };

  const toggleActive = async () => {
    if (!data) return;
    if (data.bin.active && data.contents.length > 0) {
      const r = await confirm({
        title: `${t("rcv.retire")} ${data.bin.label}?`,
        body: `${data.contents.length} ${t("rcv.retireBody")}`,
        confirmLabel: t("rcv.retireBin"),
        danger: true,
      });
      if (!r.ok) return;
    }
    await patch({ active: !data.bin.active }, data.bin.active ? t("rcv.binRetired") : t("rcv.binReactivated"));
  };

  const capDirty = data !== null && capacity !== (data.bin.capacity === null ? "" : String(data.bin.capacity));
  const notesDirty = data !== null && notes !== data.bin.notes;

  if (!data) return null;
  const b = data.bin;
  return (
    <ADrawer
      title={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontFamily: AT.mono }}>{b.label}</span>
          <ABadge tone={b.active ? "ok" : "neutral"}>{b.active ? t("rcv.active") : t("rcv.retired")}</ABadge>
        </span>
      }
      onClose={onClose}
      width={480}
      footer={
        can("warehouse.manage") ? (
          <>
            <ABtn kind="ghost" onClick={() => void openLabel(`/api/warehouse/locations/${id}/label`, (m) => toast(m, "danger"))}>{t("rcv.qrLabel")}</ABtn>
            <ABtn kind={b.active ? "danger" : "primary"} onClick={() => void toggleActive()}>{b.active ? t("rcv.retire") : t("rcv.reactivate")}</ABtn>
          </>
        ) : undefined
      }
    >
      <div style={{ display: "grid", gap: 16 }}>
        {can("warehouse.manage") && (
          <div style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: 12, alignItems: "end" }}>
            <AField label={t("rcv.capacity")} hint={capDirty ? " " : undefined}>
              <span style={{ display: "flex", gap: 6 }}>
                <AInput value={capacity} onChange={(v) => setCapacity(v.replace(/\D/g, ""))} placeholder="—" style={{ width: 70 }} />
                {capDirty && <ABtn size="sm" onClick={() => void patch({ capacity: capacity === "" ? null : Number(capacity) }, t("rcv.capacitySaved"))}>{t("c.save")}</ABtn>}
              </span>
            </AField>
            <AField label={t("c.notes")}>
              <span style={{ display: "flex", gap: 6 }}>
                <AInput value={notes} onChange={setNotes} placeholder={t("rcv.binNotesPh")} />
                {notesDirty && <ABtn size="sm" onClick={() => void patch({ notes }, t("rcv.notesSaved"))}>{t("c.save")}</ABtn>}
              </span>
            </AField>
          </div>
        )}

        <div>
          <div style={sectionLabel}>{t("wh.binContents")} · {data.contents.length}{b.capacity !== null ? ` / ${b.capacity}` : ""}</div>
          {data.contents.length === 0 ? (
            <div style={{ fontFamily: AT.body, fontSize: 13, color: AT.inkSoft }}>{t("wh.emptyBin")}.</div>
          ) : (
            data.contents.map((c) => {
              const tone = ITEM_STATUS_TONE[c.status]?.tone ?? ("neutral" as Tone);
              const tc = toneColors[tone];
              return (
                <button
                  key={c.id}
                  onClick={() => nav.openTab?.("inventory", c.id)}
                  title={t("rcv.openInventory")}
                  style={{
                    all: "unset", boxSizing: "border-box", cursor: "pointer", display: "flex", alignItems: "center",
                    gap: 10, padding: "7px 0", borderBottom: `1px solid ${AT.ruleSoft}`, width: "100%",
                  }}
                >
                  {c.photos[0] ? (
                    <img src={thumbOf(c.photos[0])} alt="" style={{ width: 34, height: 34, objectFit: "cover", borderRadius: 7, border: `1px solid ${AT.ruleSoft}` }} />
                  ) : (
                    <span style={{ width: 34, height: 34, borderRadius: 7, background: AT.surfaceAlt, display: "grid", placeItems: "center", fontSize: 13 }}>📷</span>
                  )}
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontFamily: AT.body, fontSize: 13, fontWeight: 600, color: AT.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.title}</span>
                    <span style={{ fontFamily: AT.mono, fontSize: 11, color: AT.inkSoft }}>{c.sku} · {ago(c.sinceAt)}</span>
                  </span>
                  <span style={{ background: tc.bg, color: tc.fg, borderRadius: 999, padding: "2px 9px", fontFamily: AT.body, fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" }}>{itemStatusLabel(c.status)}</span>
                </button>
              );
            })
          )}
        </div>

        <div>
          <div style={sectionLabel}>{t("rcv.binActivity")}</div>
          {data.activity.length === 0 ? (
            <div style={{ fontFamily: AT.body, fontSize: 13, color: AT.inkSoft }}>{t("rcv.noMovements")}</div>
          ) : (
            data.activity.map((a, i) => (
              <div key={i} style={{ display: "flex", alignItems: "baseline", gap: 9, padding: "6px 0", borderBottom: `1px solid ${AT.ruleSoft}`, fontFamily: AT.body, fontSize: 12.5 }}>
                <span style={{
                  background: a.inbound ? AT.accentSoft : AT.okSoft, color: a.inbound ? AT.accent : AT.ok,
                  borderRadius: 999, padding: "1px 8px", fontSize: 10.5, fontWeight: 800, flexShrink: 0,
                }}>{a.inbound ? t("rcv.in") : t("rcv.out")}</span>
                <span style={{ fontFamily: AT.mono, fontSize: 11.5, fontWeight: 700 }}>{a.sku}</span>
                <span style={{ color: AT.inkSoft }}>{moveLabel(a.type)} · {a.actorLabel}</span>
                <span style={{ marginLeft: "auto", color: AT.inkSoft, fontSize: 11.5, flexShrink: 0 }}>{ago(a.at)}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </ADrawer>
  );
}

const sectionLabel: React.CSSProperties = {
  fontFamily: AT.body, fontSize: 10.5, fontWeight: 700, textTransform: "uppercase",
  letterSpacing: "0.08em", color: AT.inkSoft, marginBottom: 6,
};
