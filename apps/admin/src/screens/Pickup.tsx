import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import type { Nav } from "../App.js";
import { useAuth } from "../auth.js";
import { formatDate } from "../format.js";
import { AT } from "../theme.js";
import { ABadge, ABtn, ACard, ADrawer, AEmpty, AField, AIcon, AInput, ATable, ATd, ATr, useConfirm, useToast } from "../ui.js";

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
  lines: PickLine[];
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
  const [openId, setOpenId] = useState<string | null>(null);
  const [checkinQuery, setCheckinQuery] = useState("");
  const [handoverCode, setHandoverCode] = useState("");
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(() => {
    void api.get<{ tickets: Ticket[] }>("/api/pickup/queue").then((r) => setTickets(r.tickets)).catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
    timer.current = setInterval(load, 5_000); // live-ish; WS feeds the TVs
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [load]);

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
