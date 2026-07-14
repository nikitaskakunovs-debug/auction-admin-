# Pickup & Warehouse ERP — design (Phase 10)

One warehouse per market, clients collect won/bought lots in person. Two TV
boards in the waiting room (modeled on the reference photos): a **picking
progress** board and a **NOW DELIVERING** board. Couriers stay a later,
credential-gated phase; pickup is the default fulfilment.

## Decisions (agreed 2026-07)

| Decision | Choice |
|---|---|
| Restock fee | **5% of the full paid order total** (hammer + premium + VAT); remainder recorded as a refund (manual payout until Klix) |
| Pickup deadline | **14 days** after payment; reminders 3 days and 1 day before; no-show earns a **strike** (same 3-strike regime as unpaid winners) |
| Check-in | **Kiosk + front desk.** Kiosk accepts the 6-digit pickup code typed or via USB QR/barcode scanner (scanners emulate keyboards); front desk can check anyone in from the admin |
| Relist after no-show | **Manual review queue** — item returns to `draft` via an audited "return to stock" action; a listing manager relists deliberately |

## Client flow

1. **Pay** → order gets a `pickupCode` (6 digits, unique among active paid
   orders) and `pickupDeadlineAt = paidAt + 14d` (per-market config). The
   account page and the `pickup_ready` email show the **pickup pass**: code,
   QR of the code, address, hours, deadline.
2. **Arrive & check in** — type/scan the code at the kiosk, or the front desk
   finds the customer. Check-in creates ONE **ticket** (3-digit daily number,
   e.g. `714`) covering *all* of that customer's paid, uncollected orders.
3. **Wait** — board 1 shows ticket · status (`Waiting/Picking/Delivering`) ·
   progress % · ETA · FRONT/BACK item counts (from warehouse zones).
4. **Collect** — board 2 lists tickets at the counter. Client shows the
   pickup code; worker verifies, hands over, ticket completes. Items →
   `delivered` (→ `closed` after the dispute window, existing transition).
5. **No-show** — past the deadline the scheduler cancels the order, retains
   the 5% restock fee, records the refund for the remainder, adds a strike,
   emails the client, and the item enters the restock queue.

## Worker flow (admin → Pickup screen, `pickup.operate`)

1. Queue of checked-in tickets, oldest first, with item + zone counts.
2. **Claim** a ticket → items flip to `picking`, board updates live (WS).
3. Pick list sorted by walking path (zone → aisle → rack → shelf). Check off
   each item (`picked`), or flag `missing`/`damaged` (ticket continues;
   support resolves the flagged line, audit-logged). Each pick clears the
   item's bin and writes a `pick` stock movement.
4. All lines terminal → **Delivering** (board 2), bring to counter.
5. **Complete** with the client's pickup code → items `delivered`,
   `handover` movements, audit. Cancel (client left) rolls items back to
   `paid`; already-picked items keep `location = null` and surface in the
   "needs putaway" filter.

## ERP layer

- `warehouse_locations`: zone (`FRONT`/`BACK`/…), aisle, rack, shelf; unique
  human label (e.g. `FRONT-A1-R2-S3`). Items reference a location; the legacy
  free-text field remains as display fallback.
- `stock_movements` (append-only): intake | putaway | move | pick | restock |
  handover, with from/to location, actor, reason. Every location change goes
  through it.
- Inventory screen: putaway/move dialog, per-item movement history,
  **Returned to stock** filter (`no_pickup_cancelled` / `unpaid_cancelled`)
  with the audited return-to-`draft` action, **needs putaway** filter
  (paid-flow leftovers without a bin).
- Boards' FRONT/BACK counts and the pick-path sort both derive from
  locations. ETA = remaining lines × rolling average pick seconds (EWMA per
  warehouse, seeded at 90 s/line).

## State machine changes (packages/domain)

- Item: `paid → no_pickup_cancelled` (scheduler), `no_pickup_cancelled →
  draft|listed` (restock/relist), `picking → delivered` (pickup handover
  skips packed/shipped), `picking → paid` (ticket cancelled).
- New ticket machine: `waiting → picking → delivering → completed`, any
  non-terminal → `cancelled`.
- `computeNoShowSettlement(totalCents, feeBp)` → `{ feeCents, refundCents }`,
  banker-free round-half-up like the invoice math.

## Data (packages/db, migration 0006)

`warehouse_locations`, `stock_movements`, `pickup_tickets` (daily number via
the existing `counters` row-lock pattern, unique `(day_key, number)`),
`pickup_ticket_items` (per-line status), `orders.pickup_code /
pickup_deadline_at / cancel_reason / restock_fee_cents`,
`items.location_id`, `markets.pickup_deadline_days / restock_fee_bp`.

## API

- Admin (`pickup.view` / `pickup.operate` / `warehouse.manage`): queue,
  desk check-in, claim, line status, delivering, complete, cancel; locations
  CRUD; item putaway/move; movement history.
- Public: `GET /api/public/me/pickup` (bidder's pass), `POST
  /api/public/pickup/checkin { code }` (kiosk; rate-limited, code is the
  credential), `GET /api/public/pickup/board` (PII-free: ticket numbers,
  status, progress, ETA, zone counts only).
- Live: engine publishes `board:pickup` via Redis pub/sub → WS room
  `subscribe_board`; boards also poll every 5 s as a fallback.
- Scheduler ticks: `remindPickupDue` (dedupe-keyed, 3d/1d), `cancelNoShowDue`
  (fee, refund row, strike, item transition, email — one transaction).

## Frontends

- **Admin**: Pickup screen (queue → pick view → handover), Inventory
  upgrades, Settings market fields (deadline days, restock fee bp).
- **Web**: account pickup pass (QR via local `qrcode` render, no network),
  `/kiosk` (fullscreen keypad + scanner input → big ticket number),
  `/pickup-board` + `/pickup-board/delivering` (TV pages, WS + polling).

## Restock fees for unpaid winners (added after review)

The paid/no-show fee is *retained* from held funds; an unpaid winner paid
nothing, so their 5% fee is a **claim**: a `customer_fees` row born
`outstanding` (5% of the order total, same basis) created by both the
scheduler auto-cancel and the manual cancel-unpaid action (opt-out flag for
goodwill cases). While any fee is outstanding the account is **paused** —
`placeBid` and `buyNow` refuse with `FEES_OUTSTANDING` — and the account
page shows the amount per order. Operations settles the fee when the client
pays (desk/transfer) or waives it with a mandatory reason; both audited,
both unblock instantly. No-pickup fees mirror into the same ledger born
`settled`, so Finance sees every restock fee in one place.

**Legal note**: charging a fee without holding funds is a contractual claim —
the T&C must state the 5% unpaid-lot fee explicitly, and enforceability of
actually collecting (vs. just gating the account) varies by jurisdiction.
Confirm wording with the lawyer; confirm VAT treatment of retained fees with
the accountant.

## Deliberately out of scope (noted for later)

Credit notes for retained fees (accountant to confirm treatment), booking
time slots, camera-based QR scanning, multi-warehouse per market, consignment
intake workflow (items are created via Inventory as today; intake movements
land when consignments arrive as a feature), partial handovers with automatic
refunds.
