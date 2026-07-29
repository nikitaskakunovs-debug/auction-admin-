import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import type { Nav } from "../App.js";
import { useAuth } from "../auth.js";
import { formatDate } from "../format.js";
import { AT } from "../theme.js";
import { AAvatar, ABadge, ABtn, ACard, ADrawer, AEmpty, AField, AIcon, AInput, ATable, ATd, ATr, useConfirm, useToast } from "../ui.js";
import { useAuctionEvents } from "../useAuctionEvents.js";

/**
 * Pickup desk: the warehouse-side view of the waiting room. Check clients
 * in, claim tickets, work the pick list (sorted by walking path), flip to
 * Delivering, verify the client's code at handover. Mirrors the two TV
 * boards the clients see.
 */

interface PickLine {
  id: string;
  status: "pending" | "picked" | "missing" | "damaged";
  orderId: string;
  itemId: string;
  sku: string;
  title: string;
  legacyLocation: string;
  zone: string | null;
  aisle: string | null;
  rack: string | null;
  shelf: string | null;
  locationLabel: string | null;
  orderRef: string;
}

interface Ticket {
  id: string;
  number: number;
  status: "waiting" | "picking" | "delivering" | "completed" | "cancelled";
  checkedInVia: string;
  checkedInAt: string;
  customerAlias: string;
  customerEmail: string;
  claimedByName: string | null;
  pickingStartedAt: string | null;
  passToId: string | null;
  passToName: string | null;
  passReason: string | null;
  lines: PickLine[];
}

interface WorkerToday {
  userId: string;
  name: string;
  status: "working" | "coffee" | "lunch" | "done";
  sinceAt: string;
  currentTicketNumber: number | null;
}

const STATUS_TONE: Record<Ticket["status"], "ok" | "warn" | "danger" | "neutral"> = {
  waiting: "warn",
  picking: "neutral",
  delivering: "ok",
  completed: "ok",
  cancelled: "danger",
};

const LINE_TONE: Record<PickLine["status"], "ok" | "warn" | "danger" | "neutral"> = {
  pending: "neutral",
  picked: "ok",
  missing: "danger",
  damaged: "warn",
};

/** Short beep via WebAudio — no audio files. Context is created lazily and reused. */
function beep(holder: { current: AudioContext | null }): void {
  try {
    const ctx = holder.current ?? new AudioContext();
    holder.current = ctx;
    if (ctx.state === "suspended") void ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  } catch {
    // audio unavailable — the visual bell counter still works
  }
}

function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

const readTarget = (): number => {
  try {
    const v = Number(localStorage.getItem("pickTarget"));
    return Number.isFinite(v) && v >= 1 ? v : 6;
  } catch {
    return 6;
  }
};

/** Walking-path order: FRONT first, then BACK, unlocated last. */
function sortLines(lines: PickLine[]): PickLine[] {
  const rank = (l: PickLine) => (l.zone === "FRONT" ? 0 : l.zone === "BACK" ? 1 : l.zone ? 2 : 3);
  return [...lines].sort((a, b) => rank(a) - rank(b) || (a.locationLabel ?? "~").localeCompare(b.locationLabel ?? "~", undefined, { numeric: true }));
}

export function PickupScreen({ nav: _nav }: { nav: Nav }) {
  const { can } = useAuth();
  const confirm = useConfirm();
  const toast = useToast();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [workers, setWorkers] = useState<WorkerToday[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [checkinQuery, setCheckinQuery] = useState("");
  const [handoverCode, setHandoverCode] = useState("");
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── NOW PICKING live strip state ──────────────────────────────────────────
  const [now, setNow] = useState(() => Date.now()); // 1 s client-side tick for the timers
  const [target, setTarget] = useState<number>(readTarget); // minutes, persisted per device
  const [soundOn, setSoundOn] = useState<boolean>(() => {
    try {
      return localStorage.getItem("pickupSoundOn") === "1";
    } catch {
      return false;
    }
  });
  const [bell, setBell] = useState(0); // new check-ins since last cleared
  const knownWaiting = useRef<Set<string> | null>(null); // null until first load — no alert on boot
  const soundRef = useRef(soundOn);
  soundRef.current = soundOn;
  const audioHolder = useRef<AudioContext | null>(null);

  const load = useCallback(() => {
    void api
      .get<{ tickets: Ticket[] }>("/api/pickup/queue")
      .then((r) => {
        setTickets(r.tickets);
        // New-pick alert: the ticket list gained a waiting ticket between refreshes.
        const waiting = new Set(r.tickets.filter((t) => t.status === "waiting").map((t) => t.id));
        const prev = knownWaiting.current;
        if (prev) {
          let fresh = 0;
          waiting.forEach((id) => {
            if (!prev.has(id)) fresh += 1;
          });
          if (fresh > 0) {
            setBell((b) => b + fresh);
            if (soundRef.current) beep(audioHolder);
          }
        }
        knownWaiting.current = waiting;
      })
      .catch(() => undefined);
    void api.get<{ workers: WorkerToday[] }>("/api/warehouse/status/today").then((r) => setWorkers(r.workers)).catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
    timer.current = setInterval(load, 5_000); // live-ish; WS feeds the TVs
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      if (timer.current) clearInterval(timer.current);
      clearInterval(tick);
    };
  }, [load]);

  // Any admin token may join the admin room; a pickup_checkin push refreshes
  // immediately instead of waiting out the 5 s poll.
  useAuctionEvents("admin", (ev) => {
    if (ev.type === "pickup_checkin") load();
  });

  const setTargetPersist = (v: number) => {
    setTarget(v);
    try {
      localStorage.setItem("pickTarget", String(v));
    } catch {
      /* private mode */
    }
  };
  const toggleSound = () => {
    const next = !soundOn;
    setSoundOn(next);
    try {
      localStorage.setItem("pickupSoundOn", next ? "1" : "0");
    } catch {
      /* private mode */
    }
    if (next) beep(audioHolder); // user gesture — unlocks the AudioContext and confirms audibly
  };

  const operate = can("pickup.operate");
  const open = tickets.find((t) => t.id === openId) ?? null;
  const active = tickets.filter((t) => t.status === "waiting" || t.status === "picking" || t.status === "delivering");
  const finished = tickets.filter((t) => t.status === "completed" || t.status === "cancelled");

  const act = async (fn: () => Promise<unknown>, okMsg: string) => {
    try {
      await fn();
      toast(okMsg, "ok");
      load();
    } catch (err) {
      toast((err as Error).message || "Action failed", "danger");
    }
  };

  const deskCheckin = () =>
    act(async () => {
      const r = await api.post<{ ticketNumber: number; alreadyCheckedIn: boolean }>("/api/pickup/checkin", { query: checkinQuery.trim() });
      setCheckinQuery("");
      toast(r.alreadyCheckedIn ? `Already checked in — ticket #${r.ticketNumber}` : `Ticket #${r.ticketNumber} created`, "ok");
    }, "Checked in");

  const setLine = (t: Ticket, line: PickLine, status: "picked" | "missing" | "damaged") =>
    act(() => api.post(`/api/pickup/tickets/${t.id}/lines/${line.id}`, { status }), status === "picked" ? `Picked ${line.sku}` : `${line.sku} flagged ${status}`);

  const complete = (t: Ticket) =>
    act(async () => {
      await api.post(`/api/pickup/tickets/${t.id}/complete`, { pickupCode: handoverCode.trim() });
      setHandoverCode("");
      setOpenId(null);
    }, `Ticket #${t.number} handed over`);

  const cancel = async (t: Ticket) => {
    const res = await confirm({
      title: `Cancel ticket #${t.number}`,
      body: "Items roll back to Paid; the pickup deadline keeps running.",
      requireReason: true,
      danger: true,
      confirmLabel: "Cancel ticket",
    });
    if (!res.ok) return;
    await act(async () => {
      await api.post(`/api/pickup/tickets/${t.id}/cancel`, { reason: res.reason });
      setOpenId(null);
    }, "Ticket cancelled");
  };

  const doneCount = (t: Ticket) => t.lines.filter((l) => l.status !== "pending").length;

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ fontFamily: AT.body, fontSize: 20, fontWeight: 700, color: AT.ink }}>Pickup desk</h1>
        <div style={{ display: "flex", gap: 8 }}>
          <ABtn kind="ghost" size="sm" onClick={() => window.open("#/board", "_blank")}><AIcon name="activity" size={13} /> Open TV board</ABtn>
          <ABtn kind="ghost" size="sm" onClick={load}><AIcon name="refund" size={13} /> Refresh</ABtn>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 300px", gap: 14, alignItems: "start" }}>
        <ACard
          title="Now picking"
          actions={
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: AT.inkSoft, fontFamily: AT.body }}>
                Target
                <input
                  type="number"
                  min={1}
                  max={120}
                  value={target}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setTargetPersist(Number.isFinite(v) && v >= 1 ? Math.min(120, Math.floor(v)) : 6);
                  }}
                  style={{
                    width: 52, height: 26, border: `1px solid ${AT.rule}`, borderRadius: 7, padding: "0 6px",
                    fontFamily: AT.mono, fontSize: 12.5, color: AT.ink, outline: "none", background: AT.panel,
                  }}
                />
                min
              </label>
              <button
                onClick={() => setBell(0)}
                title="New check-ins since last cleared — click to clear"
                style={{
                  all: "unset", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6,
                  padding: "3px 9px", borderRadius: 999, fontFamily: AT.body, fontSize: 11.5, fontWeight: 700,
                  background: bell > 0 ? AT.warnSoft : AT.surfaceAlt, color: bell > 0 ? AT.warn : AT.inkSoft,
                }}
              >
                <AIcon name="activity" size={12} /> {bell} new
              </button>
              <ABtn kind="ghost" size="sm" onClick={toggleSound}>Sound: {soundOn ? "on" : "off"}</ABtn>
            </div>
          }
        >
          {(() => {
            const live = tickets.filter((t) => t.status === "waiting" || t.status === "picking");
            if (live.length === 0) return <div style={{ fontSize: 13, color: AT.inkSoft, fontFamily: AT.body }}>No one is waiting or picking right now.</div>;
            return (
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                {live.map((t) => {
                  const startIso = t.status === "picking" ? (t.pickingStartedAt ?? t.checkedInAt) : t.checkedInAt;
                  const elapsedMs = Math.max(0, now - new Date(startIso).getTime());
                  const min = elapsedMs / 60_000;
                  const timerColor = min < target ? AT.ok : min < target * 2 ? AT.warn : AT.danger;
                  const over = min >= target;
                  const picked = t.lines.filter((l) => l.status !== "pending").length;
                  return (
                    <div
                      key={t.id}
                      onClick={() => setOpenId(t.id)}
                      style={{
                        flex: "1 1 200px", minWidth: 200, maxWidth: 280, cursor: "pointer",
                        background: AT.panel, borderRadius: 12, padding: "10px 12px",
                        border: `2px solid ${over ? (min >= target * 2 ? AT.danger : AT.warn) : AT.rule}`,
                        display: "grid", gap: 8,
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        {t.claimedByName ? (
                          <AAvatar name={t.claimedByName} size={24} />
                        ) : (
                          <span style={{
                            width: 24, height: 24, borderRadius: 999, background: AT.surfaceAlt, color: AT.inkSoft,
                            display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800, fontFamily: AT.body,
                          }}>?</span>
                        )}
                        <span style={{
                          flex: 1, fontFamily: AT.body, fontSize: 12.5, fontWeight: 700,
                          color: t.claimedByName ? AT.ink : AT.inkSoft,
                          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                        }}>
                          {t.claimedByName ?? "Unclaimed"}
                        </span>
                        <ABadge tone={STATUS_TONE[t.status]}>{t.status}</ABadge>
                      </div>
                      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
                        <span style={{ fontFamily: AT.mono, fontSize: 28, fontWeight: 800, color: AT.ink }}>#{t.number}</span>
                        <span style={{ fontFamily: AT.mono, fontSize: 19, fontWeight: 800, color: timerColor }}>{fmtElapsed(elapsedMs)}</span>
                      </div>
                      <div style={{ fontFamily: AT.body, fontSize: 12, color: AT.inkSoft }}>
                        {picked} of {t.lines.length} picked
                        {t.passToName ? ` · offered to ${t.passToName}` : ""}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </ACard>

        <ACard title="Workers today" pad={false}>
          {workers.length === 0 ? (
            <div style={{ padding: "14px 16px", fontSize: 13, color: AT.inkSoft, fontFamily: AT.body }}>No worker statuses yet today.</div>
          ) : (
            <div>
              {workers.map((w, i) => {
                const mins = Math.max(0, Math.floor((now - new Date(w.sinceAt).getTime()) / 60_000));
                const badge =
                  w.status === "working" ? (
                    <ABadge tone="ok">{w.currentTicketNumber !== null ? `Working · #${w.currentTicketNumber}` : "Working"}</ABadge>
                  ) : w.status === "coffee" ? (
                    <ABadge tone="warn">Coffee · {mins}m</ABadge>
                  ) : w.status === "lunch" ? (
                    <ABadge tone="warn">Lunch · {mins}m</ABadge>
                  ) : (
                    <ABadge tone="neutral">Shift done</ABadge>
                  );
                return (
                  <div
                    key={w.userId}
                    style={{
                      display: "flex", alignItems: "center", gap: 8, padding: "9px 14px",
                      borderTop: i === 0 ? "none" : `1px solid ${AT.ruleSoft}`,
                      opacity: w.status === "done" ? 0.5 : 1,
                    }}
                  >
                    <AAvatar name={w.name} size={24} />
                    <span style={{ flex: 1, fontFamily: AT.body, fontSize: 13, fontWeight: 600, color: AT.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {w.name}
                    </span>
                    {badge}
                  </div>
                );
              })}
            </div>
          )}
        </ACard>
      </div>

      {operate && (
        <ACard title="Front-desk check-in">
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 280px" }}>
              <AInput value={checkinQuery} onChange={setCheckinQuery} placeholder="Order ref (A-1042), 6-digit pickup code, or email…" />
            </div>
            <ABtn onClick={deskCheckin} disabled={checkinQuery.trim().length < 2}>Check in</ABtn>
          </div>
        </ACard>
      )}

      <ACard title={`Today's queue (${active.length})`} pad={false}>
        {active.length === 0 ? (
          <AEmpty text="No one is waiting. The kiosk and this desk both create tickets." />
        ) : (
          <ATable head={["Ticket", "Status", "Client", "Progress", "Checked in", ""]}>
            {active.map((t) => (
              <ATr key={t.id} onClick={() => setOpenId(t.id)}>
                <ATd mono style={{ fontWeight: 700, fontSize: 16 }}>#{t.number}</ATd>
                <ATd><ABadge tone={STATUS_TONE[t.status]}>{t.status}</ABadge></ATd>
                <ATd>{t.customerAlias}</ATd>
                <ATd mono>{doneCount(t)}/{t.lines.length}</ATd>
                <ATd>{formatDate(t.checkedInAt)}</ATd>
                <ATd right>
                  {operate && t.status === "waiting" && (
                    <ABtn size="sm" onClick={() => void act(() => api.post(`/api/pickup/tickets/${t.id}/claim`), `Claimed #${t.number}`)}>Claim</ABtn>
                  )}
                </ATd>
              </ATr>
            ))}
          </ATable>
        )}
      </ACard>

      {finished.length > 0 && (
        <ACard title={`Finished today (${finished.length})`} pad={false}>
          <ATable head={["Ticket", "Status", "Client", "Lines"]}>
            {finished.map((t) => (
              <ATr key={t.id}>
                <ATd mono>#{t.number}</ATd>
                <ATd><ABadge tone={STATUS_TONE[t.status]}>{t.status}</ABadge></ATd>
                <ATd>{t.customerAlias}</ATd>
                <ATd mono>{t.lines.length}</ATd>
              </ATr>
            ))}
          </ATable>
        </ACard>
      )}

      {open && (
        <ADrawer
          title={`Ticket #${open.number} — ${open.customerAlias}`}
          onClose={() => setOpenId(null)}
          width={640}
          footer={
            operate ? (
              <div style={{ display: "flex", gap: 8, alignItems: "center", width: "100%", flexWrap: "wrap" }}>
                {open.status === "waiting" && (
                  <ABtn onClick={() => void act(() => api.post(`/api/pickup/tickets/${open.id}/claim`), `Claimed #${open.number}`)}>Claim & start picking</ABtn>
                )}
                {open.status === "picking" && (
                  <ABtn
                    disabled={open.lines.some((l) => l.status === "pending")}
                    onClick={() => void act(() => api.post(`/api/pickup/tickets/${open.id}/delivering`), "On the way to the counter")}
                  >
                    All picked → Delivering
                  </ABtn>
                )}
                {open.status === "delivering" && (
                  <>
                    <div style={{ width: 140 }}>
                      <AInput value={handoverCode} onChange={setHandoverCode} placeholder="Client code" />
                    </div>
                    <ABtn disabled={!/^\d{6}$/.test(handoverCode.trim())} onClick={() => void complete(open)}>Verify & hand over</ABtn>
                  </>
                )}
                <span style={{ flex: 1 }} />
                {open.status !== "completed" && open.status !== "cancelled" && (
                  <ABtn kind="danger" onClick={() => void cancel(open)}>Cancel ticket</ABtn>
                )}
              </div>
            ) : undefined
          }
        >
          <div style={{ display: "grid", gap: 12 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <ABadge tone={STATUS_TONE[open.status]}>{open.status}</ABadge>
              <span style={{ fontSize: 12.5, color: AT.inkSoft }}>
                via {open.checkedInVia} · {open.customerEmail}
              </span>
            </div>
            <AField label={`Pick list (${doneCount(open)}/${open.lines.length}) — walking order`}>
              <div style={{ display: "grid", gap: 6 }}>
                {sortLines(open.lines).map((l) => (
                  <div
                    key={l.id}
                    style={{
                      display: "flex", alignItems: "center", gap: 10, padding: "8px 10px",
                      border: `1px solid ${AT.rule}`, borderRadius: 10, background: l.status === "picked" ? "rgba(46,160,67,0.06)" : AT.panel,
                    }}
                  >
                    <ABadge tone={LINE_TONE[l.status]}>{l.status}</ABadge>
                    <span style={{ fontFamily: AT.mono, fontSize: 12.5, minWidth: 130, fontWeight: 700 }}>
                      {l.locationLabel ?? l.legacyLocation ?? "— no bin —"}
                    </span>
                    <span style={{ flex: 1, fontSize: 13 }}>
                      <span style={{ fontFamily: AT.mono, color: AT.inkSoft }}>{l.sku}</span> {l.title}
                      <span style={{ color: AT.inkSoft }}> · {l.orderRef}</span>
                    </span>
                    {operate && open.status === "picking" && l.status === "pending" && (
                      <span style={{ display: "inline-flex", gap: 6 }}>
                        <ABtn size="sm" onClick={() => void setLine(open, l, "picked")}>Picked</ABtn>
                        <ABtn size="sm" kind="ghost" onClick={() => void setLine(open, l, "missing")}>Missing</ABtn>
                        <ABtn size="sm" kind="ghost" onClick={() => void setLine(open, l, "damaged")}>Damaged</ABtn>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </AField>
          </div>
        </ADrawer>
      )}
    </div>
  );
}
