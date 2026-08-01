/**
 * State machines for auctions and warehouse items. Transition maps are the
 * single source of truth; the API layer must go through assertTransition.
 */

// ── Auction lifecycle ────────────────────────────────────────────────────────

export const AUCTION_STATUSES = [
  "scheduled",
  "live",
  "ended_won",
  "ended_reserve_not_met",
  "ended_no_bids",
  "cancelled",
] as const;
export type AuctionStatus = (typeof AUCTION_STATUSES)[number];

const AUCTION_TRANSITIONS: Record<AuctionStatus, readonly AuctionStatus[]> = {
  scheduled: ["live", "cancelled"],
  live: ["ended_won", "ended_reserve_not_met", "ended_no_bids", "cancelled"],
  ended_won: [],
  ended_reserve_not_met: [],
  ended_no_bids: [],
  cancelled: [],
};

// ── Item (warehouse) lifecycle — per design doc ─────────────────────────────
// Draft → Listed → Live → Won → Awaiting payment → Paid → Picking → Packed →
// Shipped → Delivered → Closed, plus Unsold → Relist and Unpaid → Cancel/Relist.

export const ITEM_STATUSES = [
  "draft",
  "listed",
  "live",
  "won",
  "awaiting_payment",
  "paid",
  "picking",
  "packed",
  "shipped",
  "delivered",
  "closed",
  "unsold",
  "unpaid_cancelled",
  "no_pickup_cancelled",
  /** R2 — came back from a buyer after handover, awaiting re-grading. */
  "returned",
] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

const ITEM_TRANSITIONS: Record<ItemStatus, readonly ItemStatus[]> = {
  draft: ["listed"],
  // listed → won is the fixed-price "buy it now" sale (no auction run);
  // listed → live is the auction path.
  listed: ["live", "won", "draft"],
  live: ["won", "unsold", "listed"], // → listed when an admin cancels the auction
  // won → unpaid_cancelled: the buyer never paid. Normally the order moves the
  // item to awaiting_payment first, but if that step was ever missed the lot
  // would be stranded in `won` forever — and the scheduler's auto-cancel would
  // throw on it every tick.
  won: ["awaiting_payment", "unpaid_cancelled"],
  awaiting_payment: ["paid", "unpaid_cancelled"],
  // paid → no_pickup_cancelled is the scheduler's no-show cancel (design:
  // deadline → 5% restock fee retained → strike → restock queue).
  paid: ["picking", "no_pickup_cancelled"],
  // picking → delivered is the in-person pickup handover (no pack/ship legs);
  // picking → paid rolls back when a pickup ticket is cancelled mid-pick.
  picking: ["packed", "delivered", "paid"],
  packed: ["shipped"],
  shipped: ["delivered"],
  // R2: a sold lot can come back. Handover used to be the end of the line,
  // which left an accepted return with nowhere to put the goods.
  delivered: ["closed", "returned"],
  closed: ["returned"],
  unsold: ["listed", "draft"], // relist or pull back
  unpaid_cancelled: ["listed", "draft"], // relist (with strike issued) or pull back
  no_pickup_cancelled: ["listed", "draft"], // manual restock review, then relist
  // A returned lot is re-graded before it goes anywhere: back to draft for a
  // fresh look, or closed when it is written off rather than resold.
  returned: ["draft", "listed", "closed"],
};

// ── Shared helpers ───────────────────────────────────────────────────────────

export class IllegalTransitionError extends Error {
  constructor(
    public readonly kind: "auction" | "item",
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`illegal ${kind} transition: ${from} → ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function canTransitionAuction(from: AuctionStatus, to: AuctionStatus): boolean {
  return AUCTION_TRANSITIONS[from].includes(to);
}

export function assertAuctionTransition(from: AuctionStatus, to: AuctionStatus): void {
  if (!canTransitionAuction(from, to)) throw new IllegalTransitionError("auction", from, to);
}

export function canTransitionItem(from: ItemStatus, to: ItemStatus): boolean {
  return ITEM_TRANSITIONS[from].includes(to);
}

export function assertItemTransition(from: ItemStatus, to: ItemStatus): void {
  if (!canTransitionItem(from, to)) throw new IllegalTransitionError("item", from, to);
}
