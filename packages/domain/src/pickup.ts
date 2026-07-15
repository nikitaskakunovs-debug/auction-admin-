import type { Cents, BasisPoints } from "./money.js";

/**
 * Pickup domain logic — pure functions and the pickup-ticket state machine.
 * A ticket is one customer's warehouse visit: it bundles every paid,
 * uncollected order they have and drives the two waiting-room boards
 * (picking progress + NOW DELIVERING).
 */

// ── Ticket state machine ─────────────────────────────────────────────────────

export const TICKET_STATUSES = ["waiting", "picking", "delivering", "completed", "cancelled"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

const TICKET_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  waiting: ["picking", "cancelled"],
  picking: ["delivering", "cancelled"],
  delivering: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

export class IllegalTicketTransitionError extends Error {
  constructor(
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`illegal ticket transition: ${from} → ${to}`);
    this.name = "IllegalTicketTransitionError";
  }
}

export function canTransitionTicket(from: TicketStatus, to: TicketStatus): boolean {
  return TICKET_TRANSITIONS[from].includes(to);
}

export function assertTicketTransition(from: TicketStatus, to: TicketStatus): void {
  if (!canTransitionTicket(from, to)) throw new IllegalTicketTransitionError(from, to);
}

// ── Pick-line statuses ───────────────────────────────────────────────────────

/** Per-item line on a ticket. missing/damaged are terminal exceptions the
 * ticket can continue past; support resolves them afterwards. */
export const PICK_LINE_STATUSES = ["pending", "picked", "missing", "damaged"] as const;
export type PickLineStatus = (typeof PICK_LINE_STATUSES)[number];

export const isTerminalPickLine = (s: PickLineStatus): boolean => s !== "pending";

// ── No-show settlement (5% restock fee of the FULL paid total) ───────────────

export interface NoShowSettlement {
  /** Retained by the house. */
  feeCents: Cents;
  /** Recorded as a refund back to the client. */
  refundCents: Cents;
}

/** Half-up rounding, same convention as the invoice math. */
export function computeNoShowSettlement(totalCents: Cents, feeBp: BasisPoints): NoShowSettlement {
  if (!Number.isInteger(totalCents) || totalCents < 0) throw new Error("totalCents must be a non-negative integer");
  if (!Number.isInteger(feeBp) || feeBp < 0 || feeBp > 10_000) throw new Error("feeBp must be 0..10000");
  const feeCents = Math.round((totalCents * feeBp) / 10_000);
  return { feeCents, refundCents: totalCents - feeCents };
}

// ── Ticket numbering ─────────────────────────────────────────────────────────

/**
 * Board-friendly 3-digit ticket numbers that reset daily: counter value n
 * (1-based) → 100..999, wrapping after 900 tickets/day. Collisions after a
 * wrap are prevented by the (day, number) unique index at the DB layer.
 */
export function ticketNumberFromCounter(counterValue: number): number {
  if (!Number.isInteger(counterValue) || counterValue < 1) throw new Error("counterValue must be >= 1");
  return 100 + ((counterValue - 1) % 900);
}

/** UTC day key used to partition daily ticket numbers, e.g. "2026-07-14". */
export function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

// ── Progress + ETA for the boards ────────────────────────────────────────────

export interface PickProgress {
  total: number;
  done: number;
  /** 0..100, whole percent. */
  pct: number;
  /** Seconds until the ticket should be ready; 0 once nothing is pending. */
  etaSec: number;
}

export const DEFAULT_PICK_SECONDS_PER_LINE = 90;

/** EWMA update for the rolling average pick time (alpha 0.2). */
export function updateAvgPickSeconds(currentAvg: number, observedSec: number): number {
  if (observedSec <= 0 || !Number.isFinite(observedSec)) return currentAvg;
  return Math.round((currentAvg * 0.8 + observedSec * 0.2) * 100) / 100;
}

export function computePickProgress(
  lines: readonly PickLineStatus[],
  avgSecPerLine = DEFAULT_PICK_SECONDS_PER_LINE,
): PickProgress {
  const total = lines.length;
  const done = lines.filter(isTerminalPickLine).length;
  const pending = total - done;
  const pct = total === 0 ? 100 : Math.round((done / total) * 100);
  return { total, done, pct, etaSec: pending * Math.max(1, avgSecPerLine) };
}

// ── Pick-path sorting ────────────────────────────────────────────────────────

export interface PickLocation {
  zone: string;
  aisle: string;
  rack: string;
  shelf: string;
}

/**
 * Walking-path comparator: FRONT zone before BACK, then aisle/rack/shelf in
 * natural order. Items without a location sort last (staff must search).
 */
export function comparePickPath(a: PickLocation | null, b: PickLocation | null): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const zoneRank = (z: string) => (z === "FRONT" ? 0 : z === "BACK" ? 1 : 2);
  return (
    zoneRank(a.zone) - zoneRank(b.zone) ||
    a.zone.localeCompare(b.zone) ||
    a.aisle.localeCompare(b.aisle, undefined, { numeric: true }) ||
    a.rack.localeCompare(b.rack, undefined, { numeric: true }) ||
    a.shelf.localeCompare(b.shelf, undefined, { numeric: true })
  );
}

/** Human label for a location, e.g. "FRONT-A1-R2-S3". */
export function locationLabel(loc: PickLocation): string {
  return [loc.zone, loc.aisle, loc.rack, loc.shelf].filter(Boolean).join("-");
}
