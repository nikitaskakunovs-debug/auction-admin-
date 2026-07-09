"use client";

import { useEffect, useState } from "react";

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function formatLeft(msLeft: number): string {
  if (msLeft <= 0) return "0s";
  const s = Math.floor(msLeft / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function Countdown({ endsAt, danger }: { endsAt: string; danger?: boolean }) {
  const now = useNow();
  const left = new Date(endsAt).getTime() - now;
  const critical = danger !== false && left < 120_000 && left > 0;
  return (
    <span
      suppressHydrationWarning
      style={{
        fontFamily: '"Geist Mono", ui-monospace, monospace',
        fontWeight: 700,
        color: critical ? "#D0282E" : undefined,
      }}
    >
      {formatLeft(left)}
    </span>
  );
}
