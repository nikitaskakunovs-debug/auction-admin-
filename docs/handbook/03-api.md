# 03 — API (`apps/api`)

Fastify 5, TypeScript ESM. Entry `src/index.ts` (Sentry `instrument.ts` is the
first import) builds an `AppContext` — db/pool/redis/email/storage/klix/
inbank/omniva/dpd/jira/`now()` — then starts the server and the scheduler.
`src/server.ts` registers cookie/helmet/cors/rate-limit/multipart plugins, a
Bearer-parsing `onRequest` hook, `/api/health`, and every route module + WS.

## Module map (`src/`)

| Area | Files |
|---|---|
| Auth | `auth/jwt.ts` (HS256 sign/verify, token kinds), `auth/routes.ts` (login/2FA/refresh/reset), `auth/rbac.ts` (PermissionService + `requirePermission`), `auth/cookies.ts`, `auth/lockout.ts`, `auth/trustedDevice.ts`, `auth/twofa.ts`, `auth/passwordReset.ts`, `auth/session.ts` |
| Routes | `routes/` — admin, auctions, badges, bugs, cms, customers, dashboard, finance, grading, itemComments, items, listings, orders, payments, pickup, public, receiving, search, shipping, views, warehouseOps, warehouseStats |
| Engine | `engine/` — bids, close, scheduler, notifications, invoices, fees, noShow, settlement, purchase, fulfilment, payLink, pickup, bugSync, jira, klix, inbank, omniva, dpd |
| Infra | `config.ts`, `context.ts` (Redis channels + event types), `audit.ts`, `email.ts` (adapter seam), `storage.ts` (local/S3 seam), `ws.ts` |

## Route inventory

Admin routes use `guard(permission)` = `requirePermission` preHandler.
*(admin)* = signed-in admin, no specific permission. *(public)* =
unauthenticated. *(bidder)* = `kind:"bidder"` token.

### Auth — `/api/auth/*`
| Method & path | Guard | Purpose |
|---|---|---|
| POST `/login` | public | Step 1 password → challenge token (or full session on a trusted device). |
| POST `/login/2fa` | challenge | Step 2 TOTP or recovery code; optional `rememberDevice`. |
| POST `/2fa/setup` · `/2fa/enable` | challenge/session | TOTP enrollment: pending secret in Redis → verify → enable + recovery codes. |
| POST `/2fa/recovery-codes` | admin + password | Regenerate the 10 codes. |
| GET `/2fa/status` · GET `/me` | admin | Status / current user + permissions. |
| POST `/change-password` | admin + current pw | Change + revoke all sessions/devices. |
| POST `/forgot-password` · `/reset-password` | public / token | Single-use emailed reset (existence never leaks). |
| POST `/refresh` · `/logout` | `admin_rt` cookie | Rotate (theft detection) / revoke. |

### Admin config & audit
GET/PATCH `/api/markets[/:code]` (`markets.view`/`.edit`) · GET/POST/PATCH
`/api/team[/:id]` (`team.view`/`.manage`) · GET `/api/roles` (`team.view`) ·
PUT `/api/roles/:roleId/permissions` (`roles.manage`) · GET `/api/audit`
(`audit.view`) · GET `/api/notifications` (`audit.view`).

### Auctions
GET `/api/auctions[/:id]` (`auctions.view`) · POST `/api/auctions`
(`listings.publish`, schedules a run) · POST `/:id/extend` / `/:id/cancel` /
`/:id/relist` (`auctions.extend/cancel/relist`) · POST `/:id/bids` (dev-only
simulation, 403 in production) · POST `/:id/bids/:bidId/void`
(`auctions.void_bid`, reason required, ledger replayed).

### Items / warehouse
GET `/api/items[/:id]`, `/:id/activity`, `/:id/movements` (`items.view`) ·
POST/PATCH/DELETE items (`items.create/edit/delete`) · photos
POST/DELETE/cover (`items.edit`, sharp → webp 1600px + 400px thumb) ·
POST `/:id/transition` (`items.transition`) · POST `/:id/putaway` and
`/:id/pull` (+quarantine) (`warehouse.manage`) · bins GET/POST/PATCH
`/api/warehouse/locations` · consignments POST/GET/close/receive
(`warehouse.manage`) · `GET /api/items/lookup?code=` (scan → item) · thermal
label pages for items, consignments, bins.

### Grading (W2)
Condition presets CRUD (`grading.review`) · review queue GET +
approve/edit/reject per item · worker notices + ack · `grading.reviewAll`
setting.

### Listings & orders
Listings CRUD + publish + bulk publish/archive (`listings.*`; pricing fields
gated by `listings.set_pricing`) · Orders GET (`orders.view`), mark-paid,
refund, cancel-unpaid (`orders.mark_paid/refund/cancel_unpaid`) ·
GET `/api/payments` (checkout attempts + money tiles).

### Finance
GET `/api/invoices` + printable `/:id/html` (Bearer or `?token=`) ·
POST `/api/orders/:id/issue-invoice` (backfill) · GET `/api/reports/vat` ·
POST `/api/customers/:id/vies-check` (server-side VIES).

### Customers
List/detail (`customers.view`, password hash never projected) · create/PATCH
(`customers.edit`; cannot flip `blocked`) · block/unblock/strike
(`customers.strike`, audited) · GDPR erase (`customers.erase`) · tags CRUD +
per-customer + bulk · fee settle/waive (`customers.strike`).

### Pickup
Queue (`pickup.view`) · desk check-in, claim, pick lines, delivering,
complete (6-digit code), cancel, pass/accept/decline (`pickup.operate`) ·
worker status (`/api/warehouse/status`) · public kiosk
`POST /api/public/pickup/checkin` (rate-limited 30/min) · public PII-free
TV board `GET /api/public/pickup/board`.

### Public storefront — `/api/public/*`
Bidder auth (register/login/refresh/me/forgot/reset — no 2FA, tokens in JSON
body) · catalog `GET /auctions` + `/auctions/:id` (with `minNextBidCents`,
`estimatedTotalCents`, ledger with `isYou`) · **the real bid path**
`POST /auctions/:id/bids` → `placeBid` · `GET /me/bids|orders|fees|pickup` ·
fixed listings + `POST /listings/:id/buy` → `buyNow` · CMS pages · shipping
options/locations/fulfilment choice · payments (below).

### Payments
`GET /api/public/payments/config` (public Klix brand id for the widget) ·
`POST /api/public/orders/:ref/pay` (one open checkout per order across both
providers; 30-min reuse window) · `GET /api/public/pay/:ref?t=` (signed
email pay-link) · Klix + Inbank callbacks (**hints only** — settlement
re-fetches the purchase; Klix settles on `paid`, Inbank only on `completed`)
· `GET /api/public/orders/:ref/payment` (poll/reconcile fallback).

### Misc
`GET /api/badges` (permission-filtered sidebar counters) ·
`GET /api/search?q=` (⌘K, accent-folded, permission-filtered groups) ·
saved views CRUD (`/api/views`, max 20/screen) · warehouse stats + bins
(`stats.view` / `items.view`) · bug reports + Jira webhook (chapter 06).

## Auth architecture

**Token kinds** (HS256, pinned `alg`, `iss`/`aud` checked,
`timingSafeEqual`): `admin` (15 min), `bidder` (15 min), `challenge`
(10 min, 2FA step only), `pay` (order-scoped email link). The `onRequest`
hook assigns `req.admin` only for `kind==="admin"` and `req.bidder` only for
`kind==="bidder"` — the surfaces can never cross. Two endpoints accept
`?token=` (browser tabs can't set headers) and re-check the kind: invoice
HTML and shipment label.

**Login flow:** password (constant-time, dummy hash for unknown accounts,
Redis per-email lockout — 8 fails → 15 min, IP rotation doesn't help) →
challenge token → TOTP (±1 window) or one-time recovery code → session.
Trusted-device cookie (`admin_td`, hashed, 30 d) skips the TOTP step.
First login of a new admin forces 2FA enrollment (pending secret lives in
Redis, never half-written to the DB).

**Sessions:** access token in SPA memory only; refresh token in an
httpOnly `SameSite=Strict` cookie scoped to `/api/auth`, hashed at rest,
rotated on every use. Reuse of a rotated token = theft → the whole family is
revoked + audited. Password/role/active changes revoke everything.

## RBAC

~45 compile-time-checked permissions (`Permission` union from the frozen
`PERMISSIONS` tuple). `PermissionService` caches role→set 15 s;
`requirePermission` → 401/403. JWTs carry only the role, so editing the
matrix (`PUT /api/roles/:roleId/permissions`) takes effect within 15 s
without reissuing tokens. Variants: `requireAny(...)` (warehouse ops),
signed-in-only routes (dashboard, views, badges, bugs, search), and
result-filtering (badges/search include only groups the role may see).

## Engine & scheduler

`AuctionScheduler` ticks every second (`SCHEDULER_ENABLED`), single-flight
across instances via `SET scheduler:lock NX PX 4000` + compare-and-delete
Lua. Per tick, in order: open due auctions → close due auctions → unpaid
payment reminders → auto-cancel unpaid (strike + outstanding 5% restock fee)
→ pickup reminders (3 d/1 d) → no-show cancels (retain fee, record refund,
strike) → shipment tracking poll (30-min Redis marker, ≤200 rows) → Jira bug
sweep (5-min marker) → drain the notification outbox.

`placeBid` and `closeAuction`/`openAuction` are described in chapter 01.
`voidBid` voids all rows of a bidder and replays survivors through
`resolveBid`. `settleOrderPaid` is idempotent, mints the pickup code +
deadline. `buyNow` locks listing + item `FOR UPDATE` — concurrent buyers
serialize, one wins, no premium. `issueInvoice` allocates per-series numbers
under a counter row lock; reissue voids and takes the next number.

### Redis usage (complete)
Locks/throttles: `scheduler:lock`, `shipments:poll` (30 min), `bugs:sync`
(5 min), `bugs:syncone:<id>` (10 s), `login:fail:<email>`,
`pwreset:req:<email>`, `2fa:pending:<userId>`. Caches:
`klix:pl_example:*` (24 h), `<carrier>:locations:<CC>` (daily),
`pickup:avg_sec_per_line`. Pub/sub: `auction:<id>`, `admin:events`,
`board:pickup`. Plus rate-limit buckets. **No job queue.**

## WebSocket layer (`src/ws.ts`)

One endpoint `GET /ws`. Client messages: `subscribe {auctionId}` (anonymous
OK), `subscribe_admin` (requires `?token=` with an admin JWT, else close
4003), `subscribe_board`, `unsubscribe_all`. A dedicated Redis subscriber
relays channels to in-process rooms.

Per-auction events: `bid` (price, leaderAlias, bidCount, endsAt, reserveMet,
extended), `extended`, `bid_voided`, `opened`, `closed`, `cancelled` — never
reserve amounts or proxy maxima. Admin-only events: `pickup_checkin`,
`bug_reply`, `item_comment`, `grade_review_pending`, `grade_edited`,
`grade_rejected`. Board events: ticket numbers + progress only, PII-free.

## Config (`src/config.ts`)

Full env-var table in [chapter 05](./05-deploy-operations.md#environment-variables).
Production boot guards: `JWT_SECRET` ≥32 chars, `CORS_ORIGINS` set, and
per-provider credential checks whenever a `<X>_MODE=live`.

## Tests (`apps/api/test`)

`pnpm --filter @auction/api test` → vitest, forks pool, single fork. 29 spec
files / 241 tests. `helpers.ts` provides `createWorld()` — per-worker DB
`auction_test_<id>` + per-worker Redis logical db, migrate + truncate +
baseline seed; injectable clock `setNow()`; `CapturingEmailAdapter` with
`failNext`; all providers in `simulate` mode. `loginAs()` drives the real
two-step 2FA flow. Highlights: `concurrency.test.ts` (60 simultaneous
bidders), `ws.test.ts` (payload hygiene + 4003), `payments.test.ts` (38 tests
across Klix/Inbank trust model), `auth-rbac.test.ts` (all 7 roles),
`bugReports.test.ts` (Jira sync/webhook/live chat).
