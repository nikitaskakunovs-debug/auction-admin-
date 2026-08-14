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

/** Латышский формат: «3 dienas» → «1 diena 5 h» → «6:59:12» → «11:54» → «Beidzies».
 *  Часы и минуты показываем как таймер, чтобы последние минуты читались точно. */
export function formatLeft(msLeft: number): string {
  if (msLeft <= 0) return "Beidzies";
  const s = Math.floor(msLeft / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  if (d >= 2) return `${d} dienas`;
  if (d === 1) return `1 diena ${h} h`;
  if (h >= 1) return `${h}:${p(m)}:${p(sec)}`;
  return `${p(m)}:${p(sec)}`;
}

export function Countdown({ endsAt, danger }: { endsAt: string; danger?: boolean }) {
  const now = useNow();
  const left = new Date(endsAt).getTime() - now;
  // 10 минут — порог, после которого лот считается «горящим»
  const critical = danger !== false && left < 600_000 && left > 0;
  return (
    <time
      suppressHydrationWarning
      dateTime={endsAt}
      className={`tnum${critical ? " soon" : ""}`}
    >
      {formatLeft(left)}
    </time>
  );
}
