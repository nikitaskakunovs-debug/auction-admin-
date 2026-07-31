# 02 — Domain & database

## `packages/domain` — pure business logic

Dependency-free TypeScript (only `node:crypto`). Every module has a colocated
`*.test.ts` (vitest). Barrel `src/index.ts` re-exports everything; subpath
exports `./conditions` and `./categories`.

### `money.ts`
`Cents` (integer euro cents) and `BasisPoints` (10000 bp = 100%).
`assertCents` throws on non-integers/negatives. `applyBasisPoints(value, bp)`
= `floor((value*bp + 5000)/10000)` — **half-up rounding in pure integer
arithmetic**, the single rounding convention for all invoice and fee math.
`formatEur(cents)` → `€1,234.56`.

### `increments.ts`
`DEFAULT_INCREMENT_TABLE`: €0→€1, €50→€5, €200→€10, €500→€25, €1000→€50,
€5000→€100. `incrementAt(price, table)` picks the last tier whose `fromCents ≤
price`. Tables are per-market config (`markets.increment_table` jsonb);
`validateIncrementTable` enforces start-at-0, ascending, positive.

### `proxy.ts` — proxy-bid resolution ★ the core
`resolveBid(state, incoming, table)` is a **pure function** so the API can run
it inside a DB transaction and unit-test it exhaustively. eBay-style hidden
maximums; four branches:

1. **First bid** — must be ≥ start price; price opens at start, jumping to the
   reserve if the max covers it.
2. **Leader raising own max** — must exceed their current max
   (`NOT_ABOVE_OWN_MAX` otherwise); the visible price only moves if a reserve
   becomes covered.
3. **Challenger loses** (max ≤ leader's max) — leader's proxy defends: price =
   `min(leaderMax, challengerMax + increment)`; two ledger rows (challenger
   `outbid:true`, leader `auto:true`). **Ties go to the earlier bid.**
4. **Challenger overtakes** — old leader pushed to their full max
   (`auto+outbid` row), challenger leads at
   `min(challengerMax, leaderMax + increment)`, lifted to reserve when covered.

Reject codes: `BELOW_START_PRICE`, `BELOW_MINIMUM` (with
`minAcceptableCents` hint), `NOT_ABOVE_OWN_MAX`, `INVALID_AMOUNT`.
`minNextBidCents(state)` = current price + increment (or start price).
`reserveMet(state)` keys off the **leader's max**, not the visible price.

### `antiSnipe.ts`
`applyAntiSnipe({endsAtMs, bidAtMs, windowSec, maxExtensions?, extensionsSoFar?})`
— a bid inside the closing window pushes the close to a **full window after
the bid**. No-ops when the feature is off, the bid is outside the window, or
the extension cap is reached. Default 60 s from `markets.anti_snipe_sec`,
overridable per listing.

### `states.ts`
- Auction: `scheduled → live|cancelled`; `live → ended_won |
  ended_reserve_not_met | ended_no_bids | cancelled`; ended states terminal.
- Item (14 statuses): `draft → listed → live → won → awaiting_payment → paid →
  picking → packed → shipped → delivered → closed`, plus `unsold`,
  `unpaid_cancelled`, `no_pickup_cancelled` (all relistable), `listed → won`
  (buy-now), `picking → delivered` (in-person handover).
- Guards `assertAuctionTransition` / `assertItemTransition` throw
  `IllegalTransitionError` — the single source of truth.

### `invoice.ts`
`computeInvoice({hammerCents, buyerPremiumBp, vatRateBp, shippingCents?,
reverseCharge?})`: premium = 10% of hammer → net = hammer + premium (VAT
applies to **both**) → VAT → total = net + VAT + shipping. Shipping is added
after VAT and never premium-bearing. Reverse charge (intra-EU B2B with
validated VAT number) zeroes VAT and stamps the Art. 196 note.

### `vies.ts`
Per-member-state format regexes (27 states), `VIES_STALE_DAYS = 90`,
`viesAssess` → `valid | stale | unchecked | invalid | badformat`,
`qualifiesForReverseCharge` (different EU state + currently-valid
consultation). The network call lives in the API, not here.

### `config.ts` — markets, roles, permissions
- `DEFAULT_MARKETS`: LV (VAT 21%, lv/ru/en), EE (VAT **24%**, et/ru/en),
  LT (21%, lt/ru/en); all 10% premium, 60 s anti-snipe, 14-day pickup,
  5% restock fee. Seeds the `markets` table; runtime edits in Settings.
- 7 roles (`super_admin, listing_manager, sales_manager, operations,
  content_editor, support, finance`) and ~45 action-level `PERMISSIONS`.
  `DEFAULT_ROLE_PERMISSIONS` is the seed; the live matrix is the
  `role_permissions` table.

### Other modules
- `categories.ts` — 12 stable category codes stored on `items.category`.
- `conditions.ts` — 16-grade condition taxonomy; `requiresNotes` grades
  ("SEE NOTES") refuse to save without a written issue;
  `isDamagedFamilyCondition` drives the grading review queue.
- `intake.ts` — `formatSku` (`LOT-000123`), `formatConsignmentRef` (`CON-0042`).
- `pickup.ts` — ticket state machine (`waiting → picking → delivering →
  completed`), pick-line statuses, `computeNoShowSettlement` (5% fee),
  3-digit daily ticket numbers, board progress/ETA math (EWMA pick pace),
  `comparePickPath` (FRONT before BACK, natural aisle/rack/shelf order).
- `whStats.ts` — worker productivity: active seconds minus breaks
  (`coffee`/`lunch`), picks/hour (null below 30 active minutes).
- `totp.ts` — RFC 6238/4226: `base32Encode/Decode`, `hotp`, `totp`,
  `verifyTotp` (±window, constant-time), `otpauthUri`.
- `passwordPolicy.ts` — ≥12 chars, ≥3 of 4 character classes, blocklist,
  no email/name echo.

## `packages/db`

- `client.ts` — `createDb()` → `pg.Pool({max:20})` + drizzle. Default URL
  `postgres://auction:auction@localhost:5432/auction`.
- `password.ts` — scrypt (N=2^15, r=8, p=1), format
  `scrypt$N$r$p$salt$hash`, `timingSafeEqual` verify. No native deps.

### Schema (39 tables, `src/schema.ts`)

UUID PKs (`defaultRandom`), timestamptz, integer-cent money, text statuses
validated by domain state machines (no pg enums).

**Settings / counters**
| Table | Purpose |
|---|---|
| `markets` | Per-country config: VAT bp, premium bp, anti-snipe, increment table (jsonb), pickup deadline, restock fee bp, carrier prices, handling fee. |
| `app_settings` | Small KV jsonb store (grading review scope, pick targets). |
| `counters` | Named sequences incremented under a row lock: `order_ref`, `sku`, `consignment_ref`, invoice series, daily ticket numbers. |
| `condition_presets` | Standardized condition-note chips per grade (lv/ru/en). |

**Auth / admin / RBAC**
| Table | Purpose |
|---|---|
| `admin_roles` / `role_permissions` | The 7 roles and the live, runtime-editable permission matrix. |
| `admin_users` | Email (unique), scrypt hash, role, `totp_secret` + `totp_enabled`. |
| `admin_recovery_codes` | SHA-256 of one-time 2FA recovery codes, burned on use. |
| `refresh_tokens` / `trusted_devices` | Hashed rotating refresh tokens; hashed "trust this device" tokens (skip TOTP). |
| `password_resets` | Single-use hashed reset tokens for admins *and* customers. |
| `worker_status` | One row per admin per day: `working|coffee|lunch|done` + since. |
| `saved_views` | Per-admin named filter presets per screen. |
| `audit_log` | Append-only audit trail (actor snapshot label, type, action, target, jsonb detail). |

**Customers**
| Table | Purpose |
|---|---|
| `customers` | Bidders: unique email, public `alias`, GDPR-erasable PII, `vies` jsonb, strikes, `blocked` + reason, `tags`, `erased_at`. |
| `customer_tag_defs` | Managed tag vocabulary (VIP, Dealer, Risk…). |
| `customer_refresh_tokens` | Storefront session refresh tokens. |
| `customer_fees` | Restock-fee ledger: `unpaid_restock` born `outstanding` (blocks bidding/buying), `no_pickup_restock` born `settled`. |

**Catalog / warehouse**
| Table | Purpose |
|---|---|
| `items` | The physical unit: unique SKU, condition + notes + preset ids, grading review block, category, `location_id`, photos jsonb, consignment link, domain status, market. |
| `warehouse_locations` | Structured bins `zone/aisle/rack/shelf` with unique label (`FRONT-A1-R2-S3`), optional capacity. |
| `stock_movements` | Append-only custody ledger: `intake|putaway|move|pick|restock|handover|adjust` + actor + reason. |
| `consignments` | Inbound deliveries (`CON-0042`), expected count, open/closed. |
| `item_comments` / `item_comment_reads` | Per-item chat + per-user read cursors. |

**Listings / auctions / bids**
| Table | Purpose |
|---|---|
| `listings` | Sale offer over an item: `auction|fixed`, start price, **hidden `reserve_cents`**, fixed `price_cents`, per-listing anti-snipe override. |
| `auctions` | One run: status, window, current price, leader, **hidden `leader_max_cents`**, bid count, extensions, `reserve_met`. Index `(status, ends_at)` is the scheduler's close query. |
| `bids` | Append-only ledger straight from `resolveBid`: visible amount, hidden max, `auto`, `outbid`, per-auction `seq`, voidable. |

**Orders / money / shipping**
| Table | Purpose |
|---|---|
| `orders` | Financial record: unique `ref` (`A-1042`), snapshots of alias/email, full money block (hammer/premium/VAT/shipping/handling/total/reverse-charge), payment + pickup deadlines, 6-digit `pickup_code`, fulfilment + parcel-machine snapshot, cancel reason, restock fee. |
| `payments` | Klix/Inbank checkout attempts; flips `paid` only after re-fetching from the provider. |
| `invoices` | Sequential per-series numbers (`LV-2026-00042`), full jsonb snapshot at issue, voidable (number stays in sequence). |
| `refunds` | Refund ledger. |
| `shipments` | Carrier shipments: barcode, status, full event history jsonb. |

**Pickup / CMS / notifications / bugs**
| Table | Purpose |
|---|---|
| `pickup_tickets` / `pickup_ticket_items` | One warehouse visit bundling paid orders; unique `(day_key, number)`; pick lines with `pending|picked|missing|damaged`. |
| `cms_pages` | Localized `{lv,ru,en}` block pages (heading/text/image/faq/divider), draft/published, footer placement. |
| `notifications` | Durable outbox: type, snapshotted `to_email`, language, unique `dedupe_key`, `pending|sent|failed` + attempts. |
| `bug_reports` / `bug_report_comments` / `bug_report_reads` | In-app problem reports mirrored to Jira; two-way chat (`side: panel|it`, `jira_comment_id` dedupe); read cursors. |

**Cross-cutting patterns:** snapshot columns for GDPR-safe history;
append-only ledgers; hidden columns never projected into public APIs;
text statuses validated in the domain layer.

## Migrations

- Generated by **drizzle-kit**: `pnpm --filter @auction/db generate` diffs
  `src/schema.ts` and emits a numbered SQL file into
  `packages/db/migrations/` (currently `0000`…`0023`). Never hand-write
  migrations; commit both the SQL and `migrations/meta/`.
- Runner: `applyMigrations(db)` (`src/migrateFn.ts`), CLI `src/migrate.ts`.
- Commands: dev `pnpm db:migrate`; production
  `docker compose -f docker-compose.prod.yml exec api node packages/db/dist/migrate.js`;
  CI runs migrate before tests; the E2E global-setup imports
  `applyMigrations` directly.

## Seed (`src/seedData.ts`)

Idempotent baseline always ensured: 3 markets, 8 starter bins, 7 roles +
permission matrix, counters (`order_ref=1000`, `sku=100`), bidder-tag and
condition-preset starter sets (only when empty, so admin edits survive).

- **Dev/staging** (`pnpm db:seed`): plus demo admins (one per role,
  `Admin123!`, pre-enrolled TOTP) and demo data — 6 bidders, 10 lots, CMS
  pages, and auctions whose bids are **replayed through the real
  `resolveBid`**, so seeded ledgers match what the live engine would produce.
  The demo block bails if any item already exists.
- **Production** (`NODE_ENV=production`): baseline only + real starter CMS
  content (terms/privacy seeded as drafts flagged for legal review) +
  `bootstrapAdmin(INITIAL_ADMIN_EMAIL, INITIAL_ADMIN_PASSWORD)` — a
  `super_admin` with 2FA unenrolled; the mandatory-2FA flow forces enrollment
  on first sign-in.
