"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PUBLIC_API_URL } from "@/lib/config";

/**
 * Warehouse check-in kiosk (a wall-mounted tablet). The client types their
 * 6-digit pickup code on the keypad — or scans the QR from their pass with a
 * USB scanner, which emulates a keyboard into the same buffer. On success the
 * screen shows the big ticket number that the waiting-room boards track.
 *
 * The code itself is the credential; the API rate-limits this endpoint hard.
 */

type Phase = { kind: "idle" } | { kind: "busy" } | { kind: "ok"; ticket: number; already: boolean } | { kind: "error"; message: string };

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"];

export default function KioskPage() {
  const [code, setCode] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reset = useCallback(() => {
    setCode("");
    setPhase({ kind: "idle" });
  }, []);

  const submit = useCallback(
    async (value: string) => {
      setPhase({ kind: "busy" });
      try {
        const res = await fetch(`${PUBLIC_API_URL}/api/public/pickup/checkin`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: value }),
        });
        if (res.ok) {
          const body = (await res.json()) as { ticketNumber: number; alreadyCheckedIn: boolean };
          setPhase({ kind: "ok", ticket: body.ticketNumber, already: body.alreadyCheckedIn });
        } else if (res.status === 404) {
          setPhase({ kind: "error", message: "Code not found / Kods nav atrasts" });
        } else if (res.status === 409) {
          setPhase({ kind: "error", message: "Nothing to collect / Nav ko saņemt" });
        } else {
          setPhase({ kind: "error", message: "Please ask at the desk / Lūdzu, vērsieties pie darbinieka" });
        }
      } catch {
        setPhase({ kind: "error", message: "Connection lost — ask at the desk" });
      }
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(reset, 12_000);
      setCode("");
    },
    [reset],
  );

  const press = useCallback(
    (d: string) => {
      if (phase.kind === "busy") return;
      if (phase.kind === "ok" || phase.kind === "error") reset();
      if (d === "⌫") return setCode((c) => c.slice(0, -1));
      if (!/^\d$/.test(d)) return;
      setCode((c) => {
        const next = (c + d).slice(0, 6);
        if (next.length === 6) void submit(next);
        return next;
      });
    },
    [phase.kind, reset, submit],
  );

  // USB QR/barcode scanners type the code as keystrokes — capture globally.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === "Backspace") press("⌫");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [press]);

  const mono = '"Geist Mono", ui-monospace, monospace';

  return (
    <div style={{ position: "fixed", inset: 0, background: "#0F0F0E", color: "#fff", display: "grid", placeItems: "center", zIndex: 50 }}>
      <div style={{ width: 380, maxWidth: "94vw", textAlign: "center", display: "grid", gap: 22 }}>
        {phase.kind === "ok" ? (
          <>
            <div style={{ fontSize: 17, fontWeight: 600, color: "rgba(255,255,255,0.75)" }}>
              {phase.already ? "You are already checked in / Jūs jau esat reģistrēts" : "Welcome! Your ticket / Jūsu talons"}
            </div>
            <div style={{ fontFamily: mono, fontSize: 120, fontWeight: 700, lineHeight: 1, background: "#fff", color: "#0F0F0E", borderRadius: 20, padding: "28px 0" }}>
              {phase.ticket}
            </div>
            <div style={{ fontSize: 15, color: "rgba(255,255,255,0.65)" }}>Watch the screen — we are picking your items.</div>
          </>
        ) : (
          <>
            <div>
              <div style={{ fontSize: 20, fontWeight: 700 }}>Check in / Reģistrēties</div>
              <div style={{ fontSize: 13.5, color: "rgba(255,255,255,0.6)", marginTop: 6 }}>
                Enter or scan your 6-digit pickup code
              </div>
            </div>
            <div
              style={{
                fontFamily: mono, fontSize: 44, letterSpacing: "0.35em", fontWeight: 700, height: 66,
                display: "flex", alignItems: "center", justifyContent: "center",
                background: "rgba(255,255,255,0.08)", borderRadius: 14,
                color: phase.kind === "error" ? "#FF8A8A" : "#fff",
              }}
            >
              {phase.kind === "error" ? <span style={{ fontSize: 15, letterSpacing: 0, fontFamily: "inherit" }}>{phase.message}</span> : code.padEnd(6, "·")}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
              {DIGITS.map((d, i) =>
                d === "" ? (
                  <span key={i} />
                ) : (
                  <button
                    key={i}
                    onClick={() => press(d)}
                    style={{
                      all: "unset", cursor: "pointer", fontFamily: mono, fontSize: 26, fontWeight: 700,
                      padding: "16px 0", borderRadius: 12, background: "rgba(255,255,255,0.10)", textAlign: "center",
                    }}
                  >
                    {d}
                  </button>
                ),
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
