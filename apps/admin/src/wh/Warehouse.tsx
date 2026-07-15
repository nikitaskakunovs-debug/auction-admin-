import { CONDITIONS, conditionByCode, conditionRequiresNotes } from "@auction/domain/conditions";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Item } from "../api.js";
import { useAuth } from "../auth.js";
import { openLabelWindow } from "../labels.js";
import { AT } from "../theme.js";

/**
 * Warehouse mode (#/wh) — the phone-first PWA shell for storage workers.
 * Reuses the normal admin session/RBAC and the existing API. Hardware
 * barcode/QR scanners act as keyboards (type + Enter), the same trick the
 * customer kiosk uses; the scan box is autofocused everywhere it appears.
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

const S = {
  btn: {
    all: "unset",
    boxSizing: "border-box",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    minHeight: 54,
    padding: "12px 16px",
    borderRadius: 14,
    background: AT.ink,
    color: "#fff",
    fontSize: 16,
    fontWeight: 700,
    cursor: "pointer",
    textAlign: "center",
    width: "100%",
  } as const,
  btnGhost: {
    background: "#fff",
    color: AT.ink,
    border: `1.5px solid ${AT.rule}`,
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
    border: `1px solid ${AT.rule}`,
    borderRadius: 14,
    padding: 14,
  } as const,
  label: { fontSize: 12, fontWeight: 700, color: AT.inkSoft, textTransform: "uppercase", letterSpacing: "0.05em" } as const,
};

const thumbOf = (u: string) => (u.includes("-web.webp") ? u.replace("-web.webp", "-thumb.webp") : u);

export function WarehouseMode() {
  const { user, can, logout } = useAuth();
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
      if (forPutaway) toast("Now pick the bin below");
    } catch (err) {
      toast(err instanceof ApiError && err.status === 404 ? "Nothing matches that code" : "Lookup failed", "danger");
    }
  };

  const refreshItem = async (id: string) => void openItem(id);

  const title =
    view.v === "home" ? "Warehouse" :
    view.v === "scan" ? "Scan" :
    view.v === "item" ? view.data.item.sku :
    view.v === "receive" ? "Receive" :
    view.v === "receive-into" ? view.con.ref :
    view.v === "pick" ? "Pick queue" : "Ticket";

  const back = () => {
    if (view.v === "item" || view.v === "scan" || view.v === "receive" || view.v === "pick") setView({ v: "home" });
    else if (view.v === "receive-into") setView({ v: "receive" });
    else if (view.v === "ticket") setView({ v: "pick" });
  };

  return (
    <div style={{ minHeight: "100%", background: AT.app, fontFamily: AT.body }}>
      <header style={{
        position: "sticky", top: 0, zIndex: 5, background: AT.side, color: "#fff",
        display: "flex", alignItems: "center", gap: 10, padding: "12px 14px",
      }}>
        {view.v !== "home" ? (
          <button onClick={back} style={{ all: "unset", cursor: "pointer", fontSize: 22, lineHeight: 1, padding: "2px 6px" }}>←</button>
        ) : (
          <span style={{ fontSize: 18 }}>📦</span>
        )}
        <div style={{ fontSize: 17, fontWeight: 800, flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</div>
        {view.v === "home" && (
          <button onClick={() => void logout()} style={{ all: "unset", cursor: "pointer", fontSize: 12.5, fontWeight: 700, color: "rgba(255,255,255,0.75)" }}>
            Sign out
          </button>
        )}
      </header>

      {flash && (
        <div style={{
          position: "fixed", top: 60, left: "50%", transform: "translateX(-50%)", zIndex: 20,
          background: flash.tone === "ok" ? "#123B22" : "#7A1B1E", color: "#fff",
          borderRadius: 12, padding: "10px 18px", fontSize: 14.5, fontWeight: 700, maxWidth: "90vw",
        }}>{flash.text}</div>
      )}

      <main style={{ maxWidth: 560, margin: "0 auto", padding: "16px 14px 90px", display: "grid", gap: 12 }}>
        {view.v === "home" && (
          <>
            <button style={S.btn} onClick={() => setView({ v: "scan" })}>🔍 Scan / look up item</button>
            {can("warehouse.manage") && (
              <button style={S.btn} onClick={() => setView({ v: "receive" })}>📥 Receive delivery</button>
            )}
            {can("warehouse.manage") && (
              <button style={{ ...S.btn, ...S.btnGhost }} onClick={() => setView({ v: "scan", forPutaway: true })}>🗄️ Putaway (scan first)</button>
            )}
            {can("pickup.operate") && (
              <button style={S.btn} onClick={() => setView({ v: "pick" })}>🛒 Pick queue</button>
            )}
            <div style={{ ...S.card, display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{user?.name}</div>
                <div style={{ fontSize: 12, color: AT.inkSoft }}>{user?.role.replace(/_/g, " ")}</div>
              </div>
              <a href="#/dashboard" style={{ fontSize: 12.5, fontWeight: 700, color: "#2D4BFF", textDecoration: "none" }}>Full admin →</a>
            </div>
            <div style={{ fontSize: 12, color: AT.inkSoft, textAlign: "center" }}>
              Bluetooth/USB scanners work in every scan box (they type + Enter).
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
  const [code, setCode] = useState("");
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); if (code.trim().length >= 3) onCode(code); setCode(""); }}
      style={{ display: "grid", gap: 12 }}
    >
      <div style={S.label}>Scan the label or type the SKU</div>
      <input ref={ref} value={code} onChange={(e) => setCode(e.target.value)} placeholder="LOT-000123" autoCapitalize="characters" style={{ ...S.input, fontFamily: AT.mono, fontSize: 20, textAlign: "center", minHeight: 60 }} />
      <button type="submit" style={S.btn} disabled={code.trim().length < 3}>Look up</button>
    </form>
  );
}

// ── Item card + grade/photos/putaway ─────────────────────────────────────────

function ItemView({ data, canEdit, canBin, toast, refresh, scanNext }: {
  data: LookupResult;
  canEdit: boolean;
  canBin: boolean;
  toast: (t: string, tone?: "ok" | "danger") => void;
  refresh: () => void;
  scanNext: () => void;
}) {
  const { item, binLabel, consignmentRef } = data;
  const [grading, setGrading] = useState(false);
  const [binPick, setBinPick] = useState(false);
  const [condition, setCondition] = useState(item.condition);
  const [notes, setNotes] = useState((item as { conditionNotes?: string }).conditionNotes ?? "");
  const [busy, setBusy] = useState(false);
  const needsNotes = conditionRequiresNotes(condition);

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const fd = new FormData();
    for (const f of Array.from(files)) fd.append("photos", f);
    setBusy(true);
    try {
      await api.postForm(`/api/items/${item.id}/photos`, fd);
      toast(files.length > 1 ? `${files.length} photos added` : "Photo added");
      refresh();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Upload failed", "danger");
    } finally {
      setBusy(false);
    }
  };

  const saveGrade = async () => {
    if (needsNotes && notes.trim().length < 3) return;
    setBusy(true);
    try {
      await api.patch(`/api/items/${item.id}`, { condition, conditionNotes: notes });
      toast("Grade saved");
      setGrading(false);
      refresh();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Save failed", "danger");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={S.card}>
        <div style={{ display: "flex", gap: 12 }}>
          {item.photos[0] ? (
            <img src={thumbOf(item.photos[0])} alt="" style={{ width: 86, height: 86, objectFit: "cover", borderRadius: 10, border: `1px solid ${AT.rule}` }} />
          ) : (
            <div style={{ width: 86, height: 86, borderRadius: 10, border: `1.5px dashed ${AT.rule}`, display: "grid", placeItems: "center", color: AT.inkSoft, fontSize: 11, textAlign: "center" }}>no photos</div>
          )}
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontFamily: AT.mono, fontSize: 18, fontWeight: 800 }}>{item.sku}</div>
            <div style={{ fontSize: 14.5, fontWeight: 600, lineHeight: 1.3, marginTop: 2 }}>{item.title}</div>
            <div style={{ fontSize: 12.5, color: AT.inkSoft, marginTop: 4 }}>
              {(conditionByCode(item.condition)?.label ?? item.condition)} · {item.status.replace(/_/g, " ")}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 14, marginTop: 12, flexWrap: "wrap" }}>
          <div><div style={S.label}>Bin</div><div style={{ fontFamily: AT.mono, fontSize: 15, fontWeight: 700 }}>{binLabel ?? item.location ?? "—"}</div></div>
          <div><div style={S.label}>Delivery</div><div style={{ fontFamily: AT.mono, fontSize: 15, fontWeight: 700 }}>{consignmentRef ?? "—"}</div></div>
          <div><div style={S.label}>Photos</div><div style={{ fontSize: 15, fontWeight: 700 }}>{item.photos.length}</div></div>
        </div>
      </div>

      {canEdit && (
        <label style={{ ...S.btn, ...(busy ? { opacity: 0.6 } : {}) }}>
          📷 Add photos
          <input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" multiple style={{ display: "none" }} onChange={(e) => { void upload(e.target.files); e.currentTarget.value = ""; }} />
        </label>
      )}

      {canEdit && !grading && (
        <button style={{ ...S.btn, ...S.btnGhost }} onClick={() => setGrading(true)}>🏷️ Grade condition</button>
      )}
      {canEdit && grading && (
        <div style={{ ...S.card, display: "grid", gap: 10 }}>
          <div style={S.label}>Condition</div>
          <select value={condition} onChange={(e) => setCondition(e.target.value)} style={{ ...S.input, minHeight: 52 }}>
            {!conditionByCode(item.condition) && <option value={item.condition}>{item.condition} (legacy)</option>}
            {CONDITIONS.map((c) => (
              <option key={c.code} value={c.code}>{c.requiresNotes ? `${c.label} — see notes` : c.label}</option>
            ))}
          </select>
          {conditionByCode(condition) && <div style={{ fontSize: 12.5, color: AT.inkSoft }}>{conditionByCode(condition)!.description}</div>}
          <div style={S.label}>{needsNotes ? "Notes (required)" : "Notes"}</div>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} style={{ ...S.input, minHeight: 80, padding: 12, borderColor: needsNotes && notes.trim().length < 3 ? "#C24" : AT.rule }} />
          <div style={{ display: "flex", gap: 8 }}>
            <button style={{ ...S.btn, flex: 1, ...(needsNotes && notes.trim().length < 3 ? { opacity: 0.5 } : {}) }} onClick={() => void saveGrade()} disabled={busy || (needsNotes && notes.trim().length < 3)}>Save grade</button>
            <button style={{ ...S.btn, ...S.btnGhost, flex: 1 }} onClick={() => setGrading(false)}>Cancel</button>
          </div>
        </div>
      )}

      {canBin && !binPick && (
        <button style={{ ...S.btn, ...S.btnGhost }} onClick={() => setBinPick(true)}>🗄️ Putaway / move bin</button>
      )}
      {canBin && binPick && <BinPicker itemId={item.id} current={item.locationId} toast={toast} done={() => { setBinPick(false); refresh(); }} />}

      <button style={{ ...S.btn, ...S.btnGhost }} onClick={() => void openLabelWindow(`/api/items/${item.id}/label`, (m) => toast(m, "danger"))}>🖨️ Print label</button>
      <button style={S.btn} onClick={scanNext}>Scan next →</button>
    </div>
  );
}

function BinPicker({ itemId, current, toast, done }: {
  itemId: string;
  current: string | null;
  toast: (t: string, tone?: "ok" | "danger") => void;
  done: () => void;
}) {
  const [bins, setBins] = useState<Bin[]>([]);
  const [q, setQ] = useState("");
  useEffect(() => {
    void api.get<{ locations: Bin[] }>("/api/warehouse/locations").then((r) => setBins(r.locations.filter((b) => b.active))).catch(() => undefined);
  }, []);
  const assign = async (locationId: string | null) => {
    try {
      await api.post(`/api/items/${itemId}/putaway`, { locationId, reason: "warehouse mode" });
      toast(locationId ? "Bin assigned" : "Bin cleared");
      done();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Putaway failed", "danger");
    }
  };
  const visible = bins.filter((b) => !q || b.label.toLowerCase().includes(q.toLowerCase()));
  return (
    <div style={{ ...S.card, display: "grid", gap: 8 }}>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter bins… (FRONT-A1)" autoFocus style={S.input} />
      <div style={{ maxHeight: 260, overflowY: "auto", display: "grid", gap: 6 }}>
        {current && (
          <button style={{ ...S.btn, ...S.btnGhost, minHeight: 46, color: "#B0282C" }} onClick={() => void assign(null)}>Clear bin</button>
        )}
        {visible.map((b) => (
          <button key={b.id} onClick={() => void assign(b.id)} style={{
            ...S.btn, ...S.btnGhost, minHeight: 46, justifyContent: "space-between", fontFamily: AT.mono, fontSize: 15,
            ...(b.id === current ? { borderColor: AT.ink, borderWidth: 2 } : {}),
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
  const [list, setList] = useState<Consignment[]>([]);
  useEffect(() => {
    void api.get<{ consignments: Consignment[] }>("/api/consignments?status=open").then((r) => setList(r.consignments)).catch(() => undefined);
  }, []);
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={S.label}>Open deliveries — tap one to receive into it</div>
      {list.length === 0 && <div style={{ ...S.card, color: AT.inkSoft, fontSize: 14 }}>No open deliveries. Create one in the admin → Receiving.</div>}
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
      toast(`${r.item.sku} received`);
      if (thenPhotos) onReceived(r.item);
      else titleRef.current?.focus();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Receive failed", "danger");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ ...S.card, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 13.5, fontWeight: 600 }}>{con.supplier}</span>
        <span style={{ fontSize: 13, color: AT.inkSoft }}>this session: <b>{count}</b>{lastSku ? ` · last ${lastSku}` : ""}</span>
      </div>
      <div style={S.label}>Title</div>
      <input ref={titleRef} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Bosch GSR 18V drill, boxed" autoFocus style={S.input} />
      <div style={S.label}>Condition</div>
      <select value={condition} onChange={(e) => setCondition(e.target.value)} style={S.input}>
        {CONDITIONS.map((c) => (
          <option key={c.code} value={c.code}>{c.requiresNotes ? `${c.label} — see notes` : c.label}</option>
        ))}
      </select>
      {conditionByCode(condition) && <div style={{ fontSize: 12.5, color: AT.inkSoft }}>{conditionByCode(condition)!.description}</div>}
      <div style={S.label}>{needsNotes ? "Condition notes (required)" : "Condition notes"}</div>
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} style={{ ...S.input, minHeight: 64, padding: 12, borderColor: needsNotes && notes.trim().length < 3 ? "#C24" : AT.rule }} />
      <button style={{ ...S.btn, ...(ok ? {} : { opacity: 0.5 }) }} onClick={() => void receive(true)} disabled={!ok || busy}>Receive → add photos</button>
      <button style={{ ...S.btn, ...S.btnGhost, ...(ok ? {} : { opacity: 0.5 }) }} onClick={() => void receive(false)} disabled={!ok || busy}>Receive → next unit</button>
    </div>
  );
}

// ── Pick ─────────────────────────────────────────────────────────────────────

function PickQueue({ onOpen }: { onOpen: (id: string) => void }) {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const load = () => {
    void api.get<{ tickets: Ticket[] }>("/api/pickup/queue").then((r) => setTickets(r.tickets.filter((t) => t.status === "waiting" || t.status === "picking"))).catch(() => undefined);
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {tickets.length === 0 && <div style={{ ...S.card, color: AT.inkSoft, fontSize: 14 }}>Queue is empty — no checked-in customers waiting.</div>}
      {tickets.map((t) => (
        <button key={t.id} onClick={() => onOpen(t.id)} style={{ ...S.btn, ...S.btnGhost, justifyContent: "space-between", minHeight: 62 }}>
          <span style={{ fontFamily: AT.mono, fontSize: 24, fontWeight: 800 }}>{t.number}</span>
          <span style={{ fontSize: 13, color: AT.inkSoft }}>{t.lines.length} item{t.lines.length === 1 ? "" : "s"}</span>
          <span style={{
            fontSize: 11.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.05em",
            color: t.status === "waiting" ? "#9A5B00" : "#1F8A4C",
          }}>{t.status}</span>
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
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [code, setCode] = useState("");
  const load = () => {
    void api.get<{ tickets: Ticket[] }>("/api/pickup/queue").then((r) => {
      const t = r.tickets.find((x) => x.id === id) ?? null;
      setTicket(t);
      if (!t) onDone(); // completed/cancelled elsewhere
    }).catch(() => undefined);
  };
  useEffect(load, [id]);

  const act = async (fn: () => Promise<unknown>, okMsg?: string) => {
    try {
      await fn();
      if (okMsg) toast(okMsg);
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Action failed", "danger");
    }
  };

  if (!ticket) return <div style={{ ...S.card, color: AT.inkSoft }}>Loading…</div>;
  const lines = [...ticket.lines].sort((a, b) => (a.locationLabel ?? "~").localeCompare(b.locationLabel ?? "~"));
  const allDone = lines.every((l) => l.status !== "pending");

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ ...S.card, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontFamily: AT.mono, fontSize: 30, fontWeight: 800 }}>{ticket.number}</span>
        <span style={{ fontSize: 13.5, fontWeight: 700, textTransform: "uppercase", color: ticket.status === "waiting" ? "#9A5B00" : "#1F8A4C" }}>{ticket.status}</span>
      </div>

      {ticket.status === "waiting" && (
        <button style={S.btn} onClick={() => void act(() => api.post(`/api/pickup/tickets/${ticket.id}/claim`), "Ticket claimed — start picking")}>Claim & start picking</button>
      )}

      {lines.map((l) => (
        <div key={l.id} style={{ ...S.card, display: "grid", gap: 8, opacity: l.status === "pending" ? 1 : 0.75 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
            <span style={{ fontFamily: AT.mono, fontWeight: 800, fontSize: 15 }}>{l.locationLabel ?? l.legacyLocation ?? "—"}</span>
            <span style={{ fontSize: 12, fontWeight: 800, textTransform: "uppercase", color: l.status === "picked" ? "#1F8A4C" : l.status === "pending" ? AT.inkSoft : "#B0282C" }}>{l.status}</span>
          </div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{l.title}</div>
          <div style={{ fontFamily: AT.mono, fontSize: 12, color: AT.inkSoft }}>{l.sku} · {l.orderRef}</div>
          {ticket.status === "picking" && l.status === "pending" && (
            <div style={{ display: "flex", gap: 6 }}>
              <button style={{ ...S.btn, minHeight: 46, flex: 2 }} onClick={() => void act(() => api.post(`/api/pickup/tickets/${ticket.id}/lines/${l.id}`, { status: "picked" }))}>✓ Picked</button>
              <button style={{ ...S.btn, ...S.btnGhost, minHeight: 46, flex: 1 }} onClick={() => void act(() => api.post(`/api/pickup/tickets/${ticket.id}/lines/${l.id}`, { status: "missing" }))}>Missing</button>
              <button style={{ ...S.btn, ...S.btnGhost, minHeight: 46, flex: 1 }} onClick={() => void act(() => api.post(`/api/pickup/tickets/${ticket.id}/lines/${l.id}`, { status: "damaged" }))}>Damaged</button>
            </div>
          )}
        </div>
      ))}

      {ticket.status === "picking" && allDone && (
        <button style={S.btn} onClick={() => void act(() => api.post(`/api/pickup/tickets/${ticket.id}/delivering`), "On the NOW DELIVERING board — bring it to the counter")}>
          🚚 To counter (delivering)
        </button>
      )}

      {ticket.status === "delivering" && (
        <div style={{ ...S.card, display: "grid", gap: 10 }}>
          <div style={S.label}>Client's 6-digit pickup code</div>
          <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" placeholder="••••••" style={{ ...S.input, fontFamily: AT.mono, fontSize: 26, textAlign: "center", letterSpacing: "0.3em" }} />
          <button
            style={{ ...S.btn, ...(code.length === 6 ? {} : { opacity: 0.5 }) }}
            disabled={code.length !== 6}
            onClick={() => void act(async () => { await api.post(`/api/pickup/tickets/${ticket.id}/complete`, { pickupCode: code }); onDone(); }, "Handed over ✓")}
          >Complete handover</button>
        </div>
      )}
    </div>
  );
}
