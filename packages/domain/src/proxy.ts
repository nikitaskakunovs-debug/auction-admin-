import { assertCents, type Cents } from "./money.js";
import { incrementAt, type IncrementTable, DEFAULT_INCREMENT_TABLE } from "./increments.js";

/**
 * eBay-style proxy bidding for an English ascending auction.
 *
 * Each bidder submits a hidden maximum. The system bids on their behalf by
 * the table increment, only as far as needed to stay in the lead. All
 * resolution is a pure function so it can be exhaustively unit-tested and
 * executed inside a database transaction by the API layer.
 */

export interface MaxBid {
  bidderId: string;
  maxCents: Cents;
  /** Monotonic sequence for tie-breaking: earlier bid wins a tie. */
  seq: number;
}

export interface BidState {
  startPriceCents: Cents;
  /** Hidden reserve; null = no reserve. */
  reserveCents: Cents | null;
  /** Displayed current price; null until the first bid. */
  currentPriceCents: Cents | null;
  /** The leading proxy bid; null until the first bid. */
  leader: MaxBid | null;
}

export interface IncomingBid {
  bidderId: string;
  maxCents: Cents;
  seq: number;
}

/** A row for the public bid ledger produced by one resolution. */
export interface LedgerEntry {
  bidderId: string;
  /** The visible amount for this row. */
  amountCents: Cents;
  /** True when the system placed this bid on the bidder's behalf. */
  auto: boolean;
  /** True when this row is immediately outbid within the same resolution. */
  outbid: boolean;
}

export type RejectCode =
  | "BELOW_START_PRICE"
  | "BELOW_MINIMUM"
  | "NOT_ABOVE_OWN_MAX"
  | "INVALID_AMOUNT";

export interface Accepted {
  ok: true;
  state: BidState;
  ledger: LedgerEntry[];
  priceChanged: boolean;
  leaderChanged: boolean;
  reserveMet: boolean;
}

export interface Rejected {
  ok: false;
  code: RejectCode;
  /** Smallest max the bidder could submit right now. */
  minAcceptableCents: Cents;
}

export type BidResolution = Accepted | Rejected;

export function reserveMet(state: BidState): boolean {
  if (state.reserveCents === null) return true;
  if (state.leader === null) return false;
  return state.leader.maxCents >= state.reserveCents;
}

/**
 * Minimum acceptable NEW max bid for a challenger (or first bidder).
 * First bid: the start price. Later: current price + one increment.
 * (The current leader raising their own max has a different rule:
 * strictly above their existing max.)
 */
export function minNextBidCents(state: BidState, table: IncrementTable = DEFAULT_INCREMENT_TABLE): Cents {
  if (state.currentPriceCents === null || state.leader === null) {
    return state.startPriceCents;
  }
  return state.currentPriceCents + incrementAt(state.currentPriceCents, table);
}

/**
 * Price the winner pays given the runner-up pressure, before reserve.
 * Standard proxy rule: one increment above the runner-up's max, capped at
 * the winner's own max.
 */
function priceOver(runnerUpMax: Cents, winnerMax: Cents, table: IncrementTable): Cents {
  return Math.min(winnerMax, runnerUpMax + incrementAt(runnerUpMax, table));
}

/** Lift a computed price to the reserve when the winner's max covers it. */
function applyReserve(price: Cents, winnerMax: Cents, reserve: Cents | null): Cents {
  if (reserve !== null && winnerMax >= reserve && price < reserve) return reserve;
  return price;
}

export function resolveBid(
  state: BidState,
  incoming: IncomingBid,
  table: IncrementTable = DEFAULT_INCREMENT_TABLE,
): BidResolution {
  try {
    assertCents(incoming.maxCents, "bid max");
  } catch {
    return { ok: false, code: "INVALID_AMOUNT", minAcceptableCents: minNextBidCents(state, table) };
  }
  if (incoming.maxCents === 0) {
    return { ok: false, code: "INVALID_AMOUNT", minAcceptableCents: minNextBidCents(state, table) };
  }

  const { reserveCents } = state;

  // ── First bid ────────────────────────────────────────────────────────────
  if (state.leader === null || state.currentPriceCents === null) {
    if (incoming.maxCents < state.startPriceCents) {
      return { ok: false, code: "BELOW_START_PRICE", minAcceptableCents: state.startPriceCents };
    }
    const leader: MaxBid = { bidderId: incoming.bidderId, maxCents: incoming.maxCents, seq: incoming.seq };
    // Price opens at the start price; jumps to the reserve if the max covers it.
    const price = applyReserve(state.startPriceCents, incoming.maxCents, reserveCents);
    const next: BidState = { ...state, currentPriceCents: price, leader };
    return {
      ok: true,
      state: next,
      ledger: [{ bidderId: incoming.bidderId, amountCents: price, auto: false, outbid: false }],
      priceChanged: true,
      leaderChanged: true,
      reserveMet: reserveMet(next),
    };
  }

  const leader = state.leader;
  const current = state.currentPriceCents;

  // ── Leader raising their own maximum ────────────────────────────────────
  if (incoming.bidderId === leader.bidderId) {
    if (incoming.maxCents <= leader.maxCents) {
      return { ok: false, code: "NOT_ABOVE_OWN_MAX", minAcceptableCents: leader.maxCents + 1 };
    }
    const newLeader: MaxBid = { ...leader, maxCents: incoming.maxCents, seq: incoming.seq };
    // Raising your own max never raises the price — except to meet the reserve.
    const price = applyReserve(current, incoming.maxCents, reserveCents);
    const next: BidState = { ...state, currentPriceCents: price, leader: newLeader };
    const priceChanged = price !== current;
    return {
      ok: true,
      state: next,
      ledger: priceChanged
        ? [{ bidderId: incoming.bidderId, amountCents: price, auto: false, outbid: false }]
        : [],
      priceChanged,
      leaderChanged: false,
      reserveMet: reserveMet(next),
    };
  }

  // ── Challenger ───────────────────────────────────────────────────────────
  const minNext = minNextBidCents(state, table);
  if (incoming.maxCents < minNext) {
    return { ok: false, code: "BELOW_MINIMUM", minAcceptableCents: minNext };
  }

  if (incoming.maxCents <= leader.maxCents) {
    // Leader's proxy defends: price rises to one increment over the
    // challenger's max, capped at the leader's max. On an exact tie the
    // earlier bid wins at the tied amount.
    const defended = priceOver(incoming.maxCents, leader.maxCents, table);
    const price = applyReserve(Math.max(current, defended), leader.maxCents, reserveCents);
    const next: BidState = { ...state, currentPriceCents: price };
    return {
      ok: true,
      state: next,
      ledger: [
        { bidderId: incoming.bidderId, amountCents: incoming.maxCents, auto: false, outbid: true },
        { bidderId: leader.bidderId, amountCents: price, auto: true, outbid: false },
      ],
      priceChanged: price !== current,
      leaderChanged: false,
      reserveMet: reserveMet(next),
    };
  }

  // Challenger overtakes: old leader is pushed to their full max first,
  // then the challenger takes the lead one increment above it (capped at
  // the challenger's max, lifted to the reserve when covered).
  const overtaken = priceOver(leader.maxCents, incoming.maxCents, table);
  const price = applyReserve(Math.max(current, overtaken), incoming.maxCents, reserveCents);
  const newLeader: MaxBid = { bidderId: incoming.bidderId, maxCents: incoming.maxCents, seq: incoming.seq };
  const next: BidState = { ...state, currentPriceCents: price, leader: newLeader };
  return {
    ok: true,
    state: next,
    ledger: [
      { bidderId: leader.bidderId, amountCents: leader.maxCents, auto: true, outbid: true },
      { bidderId: incoming.bidderId, amountCents: price, auto: false, outbid: false },
    ],
    priceChanged: price !== current,
    leaderChanged: true,
    reserveMet: reserveMet(next),
  };
}
