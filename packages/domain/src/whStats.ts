/**
 * W3 warehouse productivity math — pure functions over the records the system
 * already keeps (worker-status change log, action timestamps). The API
 * aggregates rows; the judgement calls (what counts as a break, when a rate
 * is meaningful) live here where they can be unit-tested.
 */

/** One worker-status change, from the audit log (chronological). */
export interface StatusChange {
  status: string;
  at: Date;
}

/** Statuses that pause the productivity clock. `done` ends the day instead. */
export const BREAK_STATUSES: readonly string[] = ["coffee", "lunch"];

/**
 * Seconds spent on break: each break status runs until the next change, or
 * until `until` (end of the window / "now") when it was never switched back.
 */
export function breakSeconds(changes: readonly StatusChange[], until: Date): number {
  let total = 0;
  for (let i = 0; i < changes.length; i++) {
    const cur = changes[i]!;
    if (!BREAK_STATUSES.includes(cur.status)) continue;
    const end = changes[i + 1]?.at ?? until;
    const span = (end.getTime() - cur.at.getTime()) / 1000;
    if (span > 0) total += span;
  }
  return Math.round(total);
}

/**
 * Active seconds = first-to-last action span minus breaks. A worker with a
 * single action (or none) has no measurable span → null, not zero, so rates
 * downstream show "—" instead of dividing by nothing.
 */
export function activeSeconds(
  firstActionAt: Date | null,
  lastActionAt: Date | null,
  breakSec: number,
): number | null {
  if (!firstActionAt || !lastActionAt) return null;
  const span = (lastActionAt.getTime() - firstActionAt.getTime()) / 1000;
  if (span <= 0) return null;
  return Math.max(0, Math.round(span - breakSec));
}

/**
 * Picks per active hour, one decimal. Requires at least 30 active minutes —
 * two picks in five minutes extrapolates to a silly 24/hr, so short spans
 * report null and the UI shows "—".
 */
export function picksPerHour(picks: number, activeSec: number | null): number | null {
  if (activeSec === null || activeSec < 1800) return null;
  return Math.round((picks / (activeSec / 3600)) * 10) / 10;
}

/** Whole-percent change vs the previous period; null when there is no base. */
export function pctDelta(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}
