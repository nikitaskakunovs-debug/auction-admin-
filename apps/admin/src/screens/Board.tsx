import { useEffect, useState } from "react";

/**
 * Waiting-room TV boards, modeled on the reference photos. Rendered WITHOUT
 * admin auth (App.tsx bypasses the login gate for #/board): the payload is
 * PII-free by construction — ticket numbers, progress, zone counts only.
 *
 *   #/board             → picking-progress board
 *   #/board/delivering  → "NOW DELIVERING" board
 *
 * Plain fetch + 3 s polling: TVs must survive API restarts and flaky Wi-Fi,
 * so the dumbest transport wins.
 */

interface BoardTicket {
  number: number;
  status: "waiting" | "picking" | "delivering" | "completed" | "cancelled";
  pct: number;
  etaSec: number;
  front: number;
  back: number;
}

const FONT = '"Geist", system-ui, sans-serif';

function useBoard(): { tickets: BoardTicket[]; clock: string } {
  const [tickets, setTickets] = useState<BoardTicket[]>([]);
  const [clock, setClock] = useState("");
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch("/api/public/pickup/board");
        if (!res.ok) return;
        const body = (await res.json()) as { tickets: BoardTicket[] };
        if (alive) setTickets(body.tickets);
      } catch {
        // keep the last known state on a blip; TVs must not blank out
      }
    };
    const tick = () => setClock(new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
    void poll();
    tick();
    const p = setInterval(poll, 3_000);
    const c = setInterval(tick, 1_000);
    return () => {
      alive = false;
      clearInterval(p);
      clearInterval(c);
    };
  }, []);
  return { tickets, clock };
}

function eta(sec: number): string {
  const min = Math.max(1, Math.round(sec / 60));
  return `Estimated ${min} minute${min === 1 ? "" : "s"} remaining`;
}

const numberChip: React.CSSProperties = {
  background: "#1A1A1A",
  color: "#fff",
  fontFamily: FONT,
  fontWeight: 700,
  borderRadius: 6,
  padding: "10px 18px",
  fontSize: 30,
  letterSpacing: "0.02em",
};

export function BoardScreen({ view }: { view: string | null }) {
  const { tickets, clock } = useBoard();

  if (view === "delivering") {
    const delivering = tickets.filter((t) => t.status === "delivering");
    return (
      <div style={{ minHeight: "100vh", background: "#FBFBFA", fontFamily: FONT, padding: "28px 40px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ width: 60 }} />
          <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "0.12em", color: "#111" }}>NOW DELIVERING</h1>
          <span style={{ fontSize: 18, color: "#555" }}>{clock}</span>
        </div>
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginTop: 30 }}>
          {delivering.length === 0 ? (
            <span style={{ fontSize: 18, color: "#999" }}>—</span>
          ) : (
            delivering.map((t) => (
              <span key={t.number} style={{ ...numberChip, fontSize: 44, padding: "14px 26px" }}>{t.number}</span>
            ))
          )}
        </div>
      </div>
    );
  }

  const visible = tickets.filter((t) => t.status === "waiting" || t.status === "picking" || t.status === "delivering");
  return (
    <div style={{ minHeight: "100vh", background: "#FBFBFA", fontFamily: FONT, padding: "26px 34px" }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "110px 150px 1fr 70px 70px 80px",
          gap: "0 18px",
          alignItems: "center",
          fontSize: 12.5,
          fontWeight: 700,
          letterSpacing: "0.08em",
          color: "#666",
          padding: "0 8px 10px",
        }}
      >
        <span>TICKET</span>
        <span>STATUS</span>
        <span style={{ textAlign: "center" }}>PICKING PROGRESS</span>
        <span style={{ textAlign: "right" }}>FRONT</span>
        <span style={{ textAlign: "right" }}>BACK</span>
        <span style={{ textAlign: "right", fontSize: 16, color: "#333" }}>{clock}</span>
      </div>
      <div style={{ display: "grid", gap: 10 }}>
        {visible.map((t) => {
          const delivering = t.status === "delivering";
          const pct = delivering ? 100 : t.pct;
          return (
            <div
              key={t.number}
              style={{
                display: "grid",
                gridTemplateColumns: "110px 150px 1fr 70px 70px 80px",
                gap: "0 18px",
                alignItems: "center",
                background: "#fff",
                borderRadius: 8,
                padding: "10px 8px",
                boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
              }}
            >
              <span style={numberChip}>{t.number}</span>
              <span style={{ fontSize: 19, color: "#222" }}>
                {delivering ? "Delivering" : t.status === "waiting" ? "Waiting" : "Picking"}
              </span>
              <span>
                <span style={{ display: "flex", alignItems: "baseline", gap: 12, fontSize: 16, color: "#333" }}>
                  <strong>{pct}%</strong>
                  <span>{delivering ? "On our way!" : t.status === "waiting" ? "In queue" : eta(t.etaSec)}</span>
                </span>
                <span style={{ display: "block", marginTop: 6, height: 5, borderRadius: 3, background: "#E7E7E3", overflow: "hidden" }}>
                  <span style={{ display: "block", height: "100%", width: `${pct}%`, background: "#63A32A", transition: "width 600ms ease" }} />
                </span>
              </span>
              <span style={{ textAlign: "right", fontSize: 19, color: "#333" }}>{t.front}</span>
              <span style={{ textAlign: "right", fontSize: 19, color: "#999" }}>{t.back}</span>
              <span />
            </div>
          );
        })}
        {visible.length === 0 && (
          <div style={{ textAlign: "center", padding: 60, color: "#999", fontSize: 20 }}>No active tickets</div>
        )}
      </div>
    </div>
  );
}
