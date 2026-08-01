import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import type { Nav } from "../App.js";
import { useAuth } from "../auth.js";
import { formatDate } from "../format.js";
import { useT, type TKey } from "../i18n.js";
import { AT } from "../theme.js";
import { AAvatar, ABadge, ABtn, ACard, ADrawer, AEmpty, AField, AIcon, AInput, ATable, ATd, ATr, useConfirm, useToast } from "../ui.js";
import { useIsMobile } from "../useMobile.js";
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

/** Paid and still on the shelf, owner not here yet — a ticket waiting to happen. */
interface AwaitingCustomer {
  customerId: string;
  alias: string;
  email: string;
  waitingSince: string | null;
  units: number;
  lines: Array<{ itemId: string; sku: string; title: string; orderRef: string; locationLabel: string | null }>;
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

/** Ticket statuses reuse the wh.status.* keys; completed/cancelled are pick.* */
const STATUS_KEY: Record<Ticket["status"], TKey> = {
  waiting: "wh.status.waiting",
  picking: "wh.status.picking",
  delivering: "wh.status.delivering",
  completed: "pick.st.completed",
  cancelled: "pick.st.cancelled",
};

const LINE_TONE: Record<PickLine["status"], "ok" | "warn" | "danger" | "neutral"> = {
  pending: "neutral",
  picked: "ok",
  missing: "danger",
  damaged: "warn",
};

const LINE_KEY: Record<PickLine["status"], TKey> = {
  pending: "wh.status.pending",
  picked: "wh.status.picked",
  missing: "wh.status.missing",
  damaged: "wh.status.damaged",
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
  const { t } = useT();
  const confirm = useConfirm();
  const toast = useToast();
  const mobile = useIsMobile();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [awaiting, setAwaiting] = useState<AwaitingCustomer[]>([]);
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
        const waiting = new Set(r.tickets.filter((tk) => tk.status === "waiting").map((tk) => tk.id));
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
    void api.get<{ customers: AwaitingCustomer[] }>("/api/pickup/awaiting").then((r) => setAwaiting(r.customers)).catch(() => undefined);
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
  const open = tickets.find((tk) => tk.id === openId) ?? null;
  const active = tickets.filter((tk) => tk.status === "waiting" || tk.status === "picking" || tk.status === "delivering");
  const finished = tickets.filter((tk) => tk.status === "completed" || tk.status === "cancelled");

  const act = async (fn: () => Promise<unknown>, okMsg: string) => {
    try {
      await fn();
      toast(okMsg, "ok");
      load();
    } catch (err) {
      toast((err as Error).message || t("wh.actionFailed"), "danger");
    }
  };

  const deskCheckin = () =>
    act(async () => {
      const r = await api.post<{ ticketNumber: number; alreadyCheckedIn: boolean }>("/api/pickup/checkin", { query: checkinQuery.trim() });
      setCheckinQuery("");
      toast(r.alreadyCheckedIn ? `${t("pick.alreadyIn")} #${r.ticketNumber}` : `${t("wh.ticket")} #${r.ticketNumber} ${t("pick.tCreated")}`, "ok");
    }, t("pick.checkedIn"));

  /** The same check-in, reached from the expected-arrivals list rather than
   * the search box: the client is standing here, so raise their ticket. */
  const arrive = (c: AwaitingCustomer) =>
    act(async () => {
      const r = await api.post<{ ticketNumber: number; alreadyCheckedIn: boolean }>("/api/pickup/checkin", {
        customerId: c.customerId,
      });
      toast(`${t("wh.ticket")} #${r.ticketNumber} — ${c.alias}`, "ok");
    }, t("pick.checkedIn"));

  const setLine = (tk: Ticket, line: PickLine, status: "picked" | "missing" | "damaged") =>
    act(
      () => api.post(`/api/pickup/tickets/${tk.id}/lines/${line.id}`, { status }),
      status === "picked" ? `${line.sku} ${t("pick.tPicked")}` : `${line.sku}: ${t(LINE_KEY[status])}`,
    );

  const complete = (tk: Ticket) =>
    act(async () => {
      await api.post(`/api/pickup/tickets/${tk.id}/complete`, { pickupCode: handoverCode.trim() });
      setHandoverCode("");
      setOpenId(null);
    }, `${t("wh.ticket")} #${tk.number}: ${t("wh.handedOver")}`);

  const cancel = async (tk: Ticket) => {
    const res = await confirm({
      title: `${t("pick.cancelTicket")} #${tk.number}`,
      body: t("pick.cancelBody"),
      requireReason: true,
      danger: true,
      confirmLabel: t("pick.cancelTicket"),
    });
    if (!res.ok) return;
    await act(async () => {
      await api.post(`/api/pickup/tickets/${tk.id}/cancel`, { reason: res.reason });
      setOpenId(null);
    }, t("pick.tCancelled"));
  };

  const doneCount = (tk: Ticket) => tk.lines.filter((l) => l.status !== "pending").length;

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ fontFamily: AT.body, fontSize: 20, fontWeight: 700, color: AT.ink }}>{t("pick.title")}</h1>
        <div style={{ display: "flex", gap: 8 }}>
          <ABtn kind="ghost" size="sm" onClick={() => window.open("#/board", "_blank")}><AIcon name="activity" size={13} /> {t("pick.openBoard")}</ABtn>
          <ABtn kind="ghost" size="sm" onClick={load}><AIcon name="refund" size={13} /> {t("c.refresh")}</ABtn>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr" : "minmax(0, 1fr) 300px", gap: 14, alignItems: "start" }}>
        <ACard
          title={t("pick.nowPicking")}
          actions={
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: AT.inkSoft, fontFamily: AT.body }}>
                {t("pick.target")}
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
                {t("pick.min")}
              </label>
              <button
                onClick={() => setBell(0)}
                title={t("pick.bellTitle")}
                style={{
                  all: "unset", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6,
                  padding: "3px 9px", borderRadius: 999, fontFamily: AT.body, fontSize: 11.5, fontWeight: 700,
                  background: bell > 0 ? AT.warnSoft : AT.surfaceAlt, color: bell > 0 ? AT.warn : AT.inkSoft,
                }}
              >
                <AIcon name="activity" size={12} /> {bell} {t("pick.bellNew")}
              </button>
              <ABtn kind="ghost" size="sm" onClick={toggleSound}>{soundOn ? t("pick.soundOn") : t("pick.soundOff")}</ABtn>
            </div>
          }
        >
          {(() => {
            const live = tickets.filter((tk) => tk.status === "waiting" || tk.status === "picking");
            if (live.length === 0) return <div style={{ fontSize: 13, color: AT.inkSoft, fontFamily: AT.body }}>{t("pick.noLive")}</div>;
            return (
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                {live.map((tk) => {
                  const startIso = tk.status === "picking" ? (tk.pickingStartedAt ?? tk.checkedInAt) : tk.checkedInAt;
                  const elapsedMs = Math.max(0, now - new Date(startIso).getTime());
                  const min = elapsedMs / 60_000;
                  const timerColor = min < target ? AT.ok : min < target * 2 ? AT.warn : AT.danger;
                  const over = min >= target;
                  const picked = tk.lines.filter((l) => l.status !== "pending").length;
                  return (
                    <div
                      key={tk.id}
                      onClick={() => setOpenId(tk.id)}
                      style={{
                        flex: "1 1 200px", minWidth: 200, maxWidth: 280, cursor: "pointer",
                        background: AT.panel, borderRadius: 12, padding: "10px 12px",
                        border: `2px solid ${over ? (min >= target * 2 ? AT.danger : AT.warn) : AT.rule}`,
                        display: "grid", gap: 8,
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        {tk.claimedByName ? (
                          <AAvatar name={tk.claimedByName} size={24} />
                        ) : (
                          <span style={{
                            width: 24, height: 24, borderRadius: 999, background: AT.surfaceAlt, color: AT.inkSoft,
                            display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800, fontFamily: AT.body,
                          }}>?</span>
                        )}
                        <span style={{
                          flex: 1, fontFamily: AT.body, fontSize: 12.5, fontWeight: 700,
                          color: tk.claimedByName ? AT.ink : AT.inkSoft,
                          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                        }}>
                          {tk.claimedByName ?? t("pick.unclaimed")}
                        </span>
                        <ABadge tone={STATUS_TONE[tk.status]}>{t(STATUS_KEY[tk.status])}</ABadge>
                      </div>
                      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
                        <span style={{ fontFamily: AT.mono, fontSize: 28, fontWeight: 800, color: AT.ink }}>#{tk.number}</span>
                        <span style={{ fontFamily: AT.mono, fontSize: 19, fontWeight: 800, color: timerColor }}>{fmtElapsed(elapsedMs)}</span>
                      </div>
                      <div style={{ fontFamily: AT.body, fontSize: 12, color: AT.inkSoft }}>
                        {picked} {t("c.of")} {tk.lines.length} {t("pick.pickedSuffix")}
                        {tk.passToName ? ` · ${t("pick.offeredTo")} ${tk.passToName}` : ""}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </ACard>

        <ACard title={t("pick.workersToday")} pad={false}>
          {workers.length === 0 ? (
            <div style={{ padding: "14px 16px", fontSize: 13, color: AT.inkSoft, fontFamily: AT.body }}>{t("pick.noWorkers")}</div>
          ) : (
            <div>
              {workers.map((w, i) => {
                const mins = Math.max(0, Math.floor((now - new Date(w.sinceAt).getTime()) / 60_000));
                const badge =
                  w.status === "working" ? (
                    <ABadge tone="ok">{w.currentTicketNumber !== null ? `${t("wh.st.working")} · #${w.currentTicketNumber}` : t("wh.st.working")}</ABadge>
                  ) : w.status === "coffee" ? (
                    <ABadge tone="warn">{t("wh.st.coffee")} · {mins}m</ABadge>
                  ) : w.status === "lunch" ? (
                    <ABadge tone="warn">{t("wh.st.lunch")} · {mins}m</ABadge>
                  ) : (
                    <ABadge tone="neutral">{t("wh.st.done")}</ABadge>
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
        <ACard title={t("pick.checkinTitle")}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 280px" }}>
              <AInput value={checkinQuery} onChange={setCheckinQuery} placeholder={t("pick.checkinPh")} />
            </div>
            <ABtn onClick={deskCheckin} disabled={checkinQuery.trim().length < 2}>{t("pick.checkinBtn")}</ABtn>
          </div>
        </ACard>
      )}

      {/* The missing half of the story: paid orders do not join the queue on
          their own — this is who would, the moment they walk in. */}
      <ACard
        title={`${t("pick.awaitingTitle")} (${awaiting.length})`}
        actions={<span style={{ fontSize: 12, color: AT.inkSoft, fontFamily: AT.body }}>{t("pick.awaitingHint")}</span>}
        pad={false}
      >
        {awaiting.length === 0 ? (
          <AEmpty text={t("pick.awaitingEmpty")} />
        ) : (
          <ATable head={[t("pick.client"), t("pick.awaitingUnits"), t("pick.awaitingWhat"), t("pick.awaitingSince"), ""]}>
            {awaiting.map((c) => {
              const days = c.waitingSince ? Math.floor((now - new Date(c.waitingSince).getTime()) / 86_400_000) : null;
              return (
                <ATr key={c.customerId}>
                  <ATd>
                    <div style={{ fontWeight: 600 }}>{c.alias}</div>
                    <div style={{ fontSize: 12, color: AT.inkSoft }}>{c.email}</div>
                  </ATd>
                  <ATd mono>{c.units}</ATd>
                  <ATd>
                    <span style={{ fontSize: 12.5 }}>
                      {c.lines.slice(0, 2).map((l) => l.title).join(" · ")}
                      {c.lines.length > 2 ? ` +${c.lines.length - 2}` : ""}
                    </span>
                  </ATd>
                  <ATd>
                    {c.waitingSince ? (
                      <span style={{ color: days !== null && days >= 14 ? AT.danger : days !== null && days >= 7 ? AT.warn : AT.inkSoft }}>
                        {formatDate(c.waitingSince)}
                        {days !== null ? ` · ${days} ${t("pick.awaitingDays")}` : ""}
                      </span>
                    ) : (
                      "—"
                    )}
                  </ATd>
                  <ATd right>
                    {operate && <ABtn size="sm" onClick={() => void arrive(c)}>{t("pick.awaitingArrived")}</ABtn>}
                  </ATd>
                </ATr>
              );
            })}
          </ATable>
        )}
      </ACard>

      <ACard title={`${t("pick.todaysQueue")} (${active.length})`} pad={false}>
        {active.length === 0 ? (
          <AEmpty text={t("pick.queueEmpty")} />
        ) : (
          <ATable head={[t("wh.ticket"), t("c.status"), t("pick.client"), t("pick.progress"), t("pick.checkedInCol"), ""]}>
            {active.map((tk) => (
              <ATr key={tk.id} onClick={() => setOpenId(tk.id)}>
                <ATd mono style={{ fontWeight: 700, fontSize: 16 }}>#{tk.number}</ATd>
                <ATd><ABadge tone={STATUS_TONE[tk.status]}>{t(STATUS_KEY[tk.status])}</ABadge></ATd>
                <ATd>{tk.customerAlias}</ATd>
                <ATd mono>{doneCount(tk)}/{tk.lines.length}</ATd>
                <ATd>{formatDate(tk.checkedInAt)}</ATd>
                <ATd right>
                  {operate && tk.status === "waiting" && (
                    <ABtn size="sm" onClick={() => void act(() => api.post(`/api/pickup/tickets/${tk.id}/claim`), `${t("pick.tClaimed")} #${tk.number}`)}>{t("pick.claim")}</ABtn>
                  )}
                </ATd>
              </ATr>
            ))}
          </ATable>
        )}
      </ACard>

      {finished.length > 0 && (
        <ACard title={`${t("pick.finishedToday")} (${finished.length})`} pad={false}>
          <ATable head={[t("wh.ticket"), t("c.status"), t("pick.client"), t("pick.lines")]}>
            {finished.map((tk) => (
              <ATr key={tk.id}>
                <ATd mono>#{tk.number}</ATd>
                <ATd><ABadge tone={STATUS_TONE[tk.status]}>{t(STATUS_KEY[tk.status])}</ABadge></ATd>
                <ATd>{tk.customerAlias}</ATd>
                <ATd mono>{tk.lines.length}</ATd>
              </ATr>
            ))}
          </ATable>
        </ACard>
      )}

      {open && (
        <ADrawer
          title={`${t("wh.ticket")} #${open.number} — ${open.customerAlias}`}
          onClose={() => setOpenId(null)}
          width={640}
          footer={
            operate ? (
              <div style={{ display: "flex", gap: 8, alignItems: "center", width: "100%", flexWrap: "wrap" }}>
                {open.status === "waiting" && (
                  <ABtn onClick={() => void act(() => api.post(`/api/pickup/tickets/${open.id}/claim`), `${t("pick.tClaimed")} #${open.number}`)}>{t("wh.claim")}</ABtn>
                )}
                {open.status === "picking" && (
                  <ABtn
                    disabled={open.lines.some((l) => l.status === "pending")}
                    onClick={() => void act(() => api.post(`/api/pickup/tickets/${open.id}/delivering`), t("wh.onBoard"))}
                  >
                    {t("pick.allPicked")}
                  </ABtn>
                )}
                {open.status === "delivering" && (
                  <>
                    <div style={{ width: 140 }}>
                      <AInput value={handoverCode} onChange={setHandoverCode} placeholder={t("pick.clientCode")} />
                    </div>
                    <ABtn disabled={!/^\d{6}$/.test(handoverCode.trim())} onClick={() => void complete(open)}>{t("pick.verifyHandOver")}</ABtn>
                  </>
                )}
                <span style={{ flex: 1 }} />
                {open.status !== "completed" && open.status !== "cancelled" && (
                  <ABtn kind="danger" onClick={() => void cancel(open)}>{t("pick.cancelTicket")}</ABtn>
                )}
              </div>
            ) : undefined
          }
        >
          <div style={{ display: "grid", gap: 12 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <ABadge tone={STATUS_TONE[open.status]}>{t(STATUS_KEY[open.status])}</ABadge>
              <span style={{ fontSize: 12.5, color: AT.inkSoft }}>
                {t("pick.via")} {open.checkedInVia} · {open.customerEmail}
              </span>
            </div>
            <AField label={`${t("pick.pickList")} (${doneCount(open)}/${open.lines.length}) — ${t("pick.walkingOrder")}`}>
              <div style={{ display: "grid", gap: 6 }}>
                {sortLines(open.lines).map((l) => (
                  <div
                    key={l.id}
                    style={{
                      display: "flex", alignItems: "center", gap: 10, padding: "8px 10px",
                      border: `1px solid ${AT.rule}`, borderRadius: 10, background: l.status === "picked" ? "rgba(46,160,67,0.06)" : AT.panel,
                    }}
                  >
                    <ABadge tone={LINE_TONE[l.status]}>{t(LINE_KEY[l.status])}</ABadge>
                    <span style={{ fontFamily: AT.mono, fontSize: 12.5, minWidth: 130, fontWeight: 700 }}>
                      {l.locationLabel ?? l.legacyLocation ?? t("pick.noBin")}
                    </span>
                    <span style={{ flex: 1, fontSize: 13 }}>
                      <span style={{ fontFamily: AT.mono, color: AT.inkSoft }}>{l.sku}</span> {l.title}
                      <span style={{ color: AT.inkSoft }}> · {l.orderRef}</span>
                    </span>
                    {operate && open.status === "picking" && l.status === "pending" && (
                      <span style={{ display: "inline-flex", gap: 6 }}>
                        <ABtn size="sm" onClick={() => void setLine(open, l, "picked")}>{t("wh.picked")}</ABtn>
                        <ABtn size="sm" kind="ghost" onClick={() => void setLine(open, l, "missing")}>{t("wh.missing")}</ABtn>
                        <ABtn size="sm" kind="ghost" onClick={() => void setLine(open, l, "damaged")}>{t("wh.damaged")}</ABtn>
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
