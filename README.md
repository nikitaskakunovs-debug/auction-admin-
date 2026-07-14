# Baltic Auction Platform — Engine + Admin

Single-seller auction house for **Latvia / Estonia / Lithuania**. This repository implements
**build-order steps 1 + 5** of the platform design (V1.8_Green): the custom TypeScript
**auction engine** and the **admin panel with 7 permissioned roles**, on PostgreSQL + Redis.

The admin panel's functionality and design system are ported from the `ADMIN---Shhh`
admin (UI kit, screen patterns, confirm-with-reason dialogs, audit log, role matrix),
rebuilt as a typed Vite/React app against a real API.

## Stack

| Piece | Tech |
|---|---|
| `packages/domain` | Pure TypeScript auction logic — zero I/O, exhaustively unit-tested |
| `packages/db` | Drizzle ORM schema, SQL migrations, seed (bids replayed through the real resolver) |
| `apps/api` | Fastify 5 — REST + WebSocket, auction engine runtime, JWT auth, action-level RBAC |
| `apps/admin` | Vite + React 19 admin panel (dark-sidebar operator UI) |
| `apps/web` | Next.js 15 public storefront — SSR, live bidding, lv/ru/en |
| Data | PostgreSQL 16 (source of truth) + Redis 7 (locks, scheduler, pub/sub) |

## Engine features (per design doc)

- English ascending auctions with **eBay-style proxy bidding** (hidden maximums, table increments)
- **Bid increment table**: €1 / €5 / €10 / €25 / €50 / €100 tiers — config-driven per market
- **Anti-snipe**: bid in the last 60s (configurable per listing) pushes the close out
- **Reserve price**: hidden from bidders; "reserve not met" is all they see
- **Concurrency-safe bids**: auction row `FOR UPDATE` + pure resolver in one transaction —
  verified by a 60-simultaneous-bidders test (gap-free ledger, replay-consistent state)
- **Scheduler** (Redis-locked 1s tick): opens/closes auctions, creates winner orders,
  auto-cancels unpaid winners past the deadline (+ strike)
- **Orders**: hammer + 10% buyer premium + VAT on both (LV/LT 21%, EE 24% — confirm with
  accountant), EU **reverse charge** with VIES validation machinery
- **Item lifecycle**: Draft → Listed → Live → Won → Awaiting payment → Paid → Picking →
  Packed → Shipped → Delivered → Closed, plus Unsold→Relist and Unpaid→Cancel/Relist
- **Live updates**: Redis pub/sub → WebSocket; payloads never leak reserves or proxy maxima
- **Invoicing**: issued atomically with the winner's order — gap-free sequential numbers per
  market legal-entity series (`LV-2026-00001`), snapshot data, printable HTML document
  (browser print → PDF), backfill endpoint for older orders
- **VIES**: server-side EU VAT-number consultation (`VIES_MODE=live|simulate`), stamped on
  the bidder with the consultation number as zero-rating proof
- **VAT report**: per-market accrual report (invoices issued in period) with reverse-charge
  split, CSV export from the Finance screen

## Admin panel

Dashboard (live KPIs) · Auctions · **Live auction monitor** (real-time bid feed, extend /
cancel / void-bid / relist with mandatory audited reasons) · Listings (commercial pricing
split from operational editing) · Inventory (warehouse lifecycle) · Orders (invoice
breakdown, refunds, cancel+strike) · Bidders (strikes, GDPR erase, VIES validation) ·
Finance (invoice register with printable documents, VAT report + CSV) · Settings (per-country
VAT / premium / increments / anti-snipe, team management, editable **7-role permission
matrix**) · Activity (append-only audit log).

The 7 roles: Super Admin, Listing Manager, Sales Manager, Operations, Content Editor,
Support, Finance — enforced **per action** at the API, mirrored in the UI.

## Quickstart

```bash
docker compose up -d          # Postgres 16 + Redis 7
pnpm install
pnpm build                    # builds domain + db first
pnpm db:migrate
pnpm db:seed                  # markets, roles, demo admins, demo lots + live auctions

pnpm dev:api                  # Fastify on :4000 (scheduler on)
pnpm dev:admin                # Vite on :5173 (proxies /api and /ws to :4000)
pnpm --filter @auction/web dev  # Next.js storefront on :3000
```

Sign in at http://localhost:5173 — one demo user per role, password **`Admin123!`**:

`super@auction.test` · `listings@auction.test` · `sales@auction.test` · `ops@auction.test`
· `content@auction.test` · `support@auction.test` · `finance@auction.test`

Place simulated bids against a live auction (dev/staging only — disabled in production;
admins never bid on behalf of customers):

```bash
TOKEN=$(curl -s -X POST localhost:4000/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"super@auction.test","password":"Admin123!"}' | jq -r .accessToken)
curl -s localhost:4000/api/auctions?status=live -H "Authorization: Bearer $TOKEN" | jq '.auctions[0].id'
curl -s -X POST localhost:4000/api/auctions/<id>/bids -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"customerId":"<customer-uuid>","maxCents":150000}'
```

## Tests

```bash
pnpm test:unit          # domain: 94 tests — increments, proxy battles, reserve, VAT, VIES, state machines
pnpm test:integration   # api: 60 tests vs real Postgres/Redis — RBAC per role, bid placement,
                        # anti-snipe, void+replay, 60-bidder concurrency, scheduler close paths,
                        # unpaid auto-cancel, invoicing, VIES, CMS, notifications, WS + payload hygiene
pnpm test:e2e           # apps/e2e: Playwright drives the built API + Next.js storefront —
                        # register→bid→lead, live outbid over WebSocket, sad paths, and the full
                        # register→bid→win→pay→track journey (scheduler closes a real short auction)
pnpm typecheck && pnpm build
```

CI (GitHub Actions) has two jobs, both against Postgres/Redis services on every push:
`ci` (build → typecheck → migrate → unit + integration) and `e2e` (build → install
Chromium → Playwright drives the full stack). The Playwright HTML report uploads as an
artifact on failure.

## Configuration

Per-country config lives in the `markets` table (seeded from `packages/domain/src/config.ts`):
languages, VAT rate, buyer premium, anti-snipe default, increment table. Changing VAT is a
one-field edit in Settings → Markets — never a code change. Klix credentials and carrier
config fields are reserved for their build phases.

Environment variables (`apps/api`): `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET` (required and
≥32 chars in production), `CORS_ORIGINS` (comma-separated admin + storefront origins;
required in production), `PORT`, `PAYMENT_DEADLINE_HOURS` (72), `ALLOW_BID_SIMULATION`
(auto-off in production), `SCHEDULER_ENABLED`, plus security knobs
`ACCESS_TOKEN_TTL_SEC` (900), `REFRESH_TOKEN_TTL_SEC` (7 days), `LOGIN_MAX_ATTEMPTS` (8),
`LOGIN_LOCKOUT_SEC` (900), `RATE_LIMIT_MAX` (300/min per IP), `TOTP_ISSUER`.
Photo storage: `STORAGE_DRIVER` (`local` default — files under `UPLOAD_DIR`, served at
`/uploads` with `PUBLIC_BASE_URL` minting the URLs; or `s3` for DigitalOcean
Spaces/any S3 endpoint with `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`,
`S3_SECRET_KEY`, `S3_PUBLIC_URL`), `MAX_PHOTO_BYTES` (15 MB/file).

**Signing in (dev):** every admin uses **mandatory TOTP two-factor**. The seeded demo
admins are pre-enrolled with a fixed dev secret (`SEED_ADMIN_TOTP_SECRET` in
`packages/db`) so you can add it to an authenticator (or compute the code) — real admins
created through the panel enroll their own unique secret on first sign-in.

## Security

The admin panel is hardened in depth — mandatory TOTP 2FA with recovery codes,
httpOnly/SameSite cookie refresh tokens with rotation + theft detection, in-memory
access tokens, per-account brute-force lockout, constant-time login, strong password
policy, action-level deny-by-default RBAC, helmet security headers, a CORS allowlist,
and production secret guards. The full model is documented in
[`SECURITY.md`](./SECURITY.md).

## Public storefront (`apps/web`)

Bidder registration/login (separate `kind="bidder"` tokens that admin routes reject
by construction), SSR auction browsing, and the **live auction page**: WebSocket
price updates (anonymous viewers included), proxy-bid box with exact minimum-next-bid,
sanitized public ledger (aliases only — reserve amounts, maxima, and emails never
leave the server), "reserve not met" state, account page with my-bids/my-orders.
SEO: JSON-LD Product/Offer, sitemap.xml, robots.txt, hreflang alternates.

**Per-country ccTLD SEO**: one deployment serves all three markets; the
country is resolved from the request `Host` (`.lv`/`.ee`/`.lt` → Latvia /
Estonia / Lithuania, unknown hosts fall back to Latvia — see
`apps/web/src/lib/country.ts`). The host drives the `<html lang>`, the
default UI language, and the offered language set (national + Russian +
English). Every page emits **canonical + hreflang alternates** that
self-reference the current domain and cross-link the two ccTLD siblings
(national language unqualified, `ru`/`en` region-qualified per domain, plus
`x-default` → the `.lv` origin) so Google treats the three domains as
localized siblings rather than duplicates. `sitemap.xml`/`robots.txt` are
host-aware, listing each domain's own-origin URLs. UI strings ship in
Latvian / Russian / English / **Estonian / Lithuanian** (the et/lt
translations are machine-drafted and flagged for native review before
launch, like the per-country VAT rates). Origins are configurable per
deployment via `NEXT_PUBLIC_ORIGIN_LV` / `_EE` / `_LT`.

**Fixed-price "buy it now"**: each fixed listing is backed by one unique warehouse
item, so it sells exactly once (the item's `listed` status is the availability gate).
`POST /api/public/listings/:id/buy` is stock-safe (listing + item row locks — concurrent
buyers serialize, one wins), reuses the order + sequential-invoice + item-lifecycle
machinery with **no buyer's premium** (VAT on top; reverse charge for validated EU-VAT
buyers), and emails a purchase confirmation. Storefront: a "Buy now" home section and a
`/listing/[id]` SSR page (JSON-LD, sold-out state); the purchase lands in the bidder's
account as awaiting-payment.

## CMS

Multilingual block pages (heading / text / image / FAQ / divider blocks with
lv/ru/en fields and LV fallback) stored in `cms_pages`, edited in the admin's
Content screen by the **Content Editor** role (language tabs, block reorder,
per-page SEO meta, draft→publish), rendered SSR at `/p/<slug>` on the
storefront with footer navigation built from published pages. Drafts are
invisible publicly. Built in-stack rather than as a separate Payload instance
to keep one auth, one RBAC, one audit trail; a Puck-style visual editor can be
layered on the same data later.

## Notifications & email

A durable notification outbox (`notifications` table) plus a pluggable email
adapter (`console` in dev, capturing adapter in tests, SMTP later — the same
seam Klix/carriers use). The engine enqueues, often inside the triggering
transaction so nothing is lost; the scheduler drains the outbox each tick.
Events wired: **outbid** (to the dethroned leader), **won** (order ref +
payment deadline), **payment reminder** (the design-doc unpaid flow is now
deadline → reminder → auto-cancel → strike, idempotent via a dedupe key), and
**order-paid** receipt. Templates are localized (lv/en; recipient's country
picks the language) and recipient email is snapshotted at enqueue time, so a
later GDPR erase never re-mails anyone. Operators see the outbox (status,
retries, last error) in the admin's read-only **Notifications** screen
(`audit.view`).

## Pickup & warehouse ERP

In-person collection is the default fulfilment (design: `docs/pickup-erp.md`).
After payment the order gets a **6-digit pickup code** (QR on the account
page + email) and a **14-day deadline** (per-market config). Clients check in
at the warehouse **kiosk** (`/kiosk` on the storefront — keypad or USB QR
scanner) or at the front desk (admin → Pickup); check-in mints a 3-digit
daily **ticket** bundling all their paid orders. Two TV boards (admin
`#/board` and `#/board/delivering`, PII-free public payloads, no login)
show picking progress %, ETA (rolling average pick pace) and FRONT/BACK zone
counts, then "NOW DELIVERING". Workers claim tickets, walk a pick-path-sorted
list, flag missing/damaged lines, and verify the client's code at handover.

**No-shows**: reminders 3 days and 1 day before the deadline; past it the
scheduler cancels the order, retains a **5% restock fee** of the paid total,
records the remainder as a refund, adds a strike, and sends the item to the
Inventory "Returned" queue for a manual, audited return-to-stock + relist.

**Warehouse ERP**: structured bins (`zone/aisle/rack/shelf`, unique labels),
an append-only `stock_movements` ledger (intake/putaway/move/pick/restock/
handover with actor + reason), bin assignment and per-item movement history
in the Inventory drawer.

**Unpaid winners** owe the same 5% as a *claim* (no funds are held to deduct
from): auto- and manual cancel-unpaid record an `outstanding` row in the
`customer_fees` ledger, the account is paused (bids and buy-now refuse with
`FEES_OUTSTANDING`, the account page shows the debt) until Operations
settles the fee (paid at the desk/by transfer) or waives it with an audited
reason. No-pickup fees mirror into the same ledger born `settled`, so every
restock fee is in one place. State the 5% unpaid-lot fee in the T&C.

## Receiving (inbound deliveries)

The inbound half of the ERP: when a truck arrives, warehouse staff
(`warehouse.manage`) create a **consignment** (supplier, market, expected
units — ref `CON-0042` from the counters row lock) in admin → **Receiving**,
then receive units one by one at the intake station: title + condition grade
(taxonomy with enforced SEE-NOTES), optional weight. Each receive mints an
auto-SKU (`LOT-000123`, same row-lock counter pattern as invoices, race-safe),
creates the item in `draft` linked to the consignment, and writes an `intake`
stock movement — so the movements ledger now covers the item's whole life:
intake → putaway → pick → handover.

**QR labels**: every receive can print a 57×32 mm thermal label (QR = item
uuid, plus SKU/title/grade) via server-rendered print pages — per item, whole
consignment, or all bin labels. `GET /api/items/lookup?code=` resolves a
scanned QR (uuid) or a typed SKU to the item + bin + consignment, which is
what the Phase-15 warehouse mobile screens will drive putaway/pick from.
Closing a consignment (audited, warns on count mismatch) stops receiving.

## Warehouse mode (phone PWA)

`#/wh` in the admin is a phone-first shell for storage workers — same login,
same RBAC, big touch targets, installable to the home screen (web manifest;
`start_url` opens straight into it). Bluetooth/USB barcode scanners work in
every scan box (HID scanners type + Enter — the kiosk trick). Flows:

- **Scan / look up** — scan a label QR (item uuid) or type a SKU → item card
  with cover photo, grade, bin, delivery, status.
- **Receive** — pick an open delivery, rapid-entry form, then either
  "next unit" or jump straight to photographing the just-received item.
- **Shoot & grade** — camera capture uploads photos on the spot; condition
  editor with the enforced SEE-NOTES rule. The `operations` role now holds
  `items.edit` so warehouse staff can grade and photograph.
- **Putaway / move** — filterable bin list writes the audited stock movement.
- **Pick queue** — claim a ticket, walk the bin-sorted lines
  (picked/missing/damaged), send to the NOW DELIVERING board, complete the
  handover with the client's 6-digit code.

## Item photos

Photos are captured at the warehouse (grading station phone/camera or the
Inventory drawer) and uploaded to `POST /api/items/:id/photos` (`items.edit`).
The server re-encodes every upload with sharp — EXIF-rotated, 1600px web size
plus a 400px thumbnail, both webp — so originals never hit the storefront.
Storage sits behind one interface: local disk in dev/tests (served by the API
at `/uploads`), DigitalOcean Spaces / any S3 endpoint in production
(`STORAGE_DRIVER=s3`); switching drivers never rewrites stored URLs. The first
photo is the cover: admin can reorder (set cover) and delete (removes the
stored files too, audit-logged). The storefront shows cover thumbnails on all
cards and a gallery with a thumbnail strip on auction and buy-now pages.

## Condition reference & account moderation

Items are graded with the warehouse's **16-grade condition taxonomy**
(`packages/domain/src/conditions.ts`, ported from the laminated CONDITION
REFERENCE sheet): brand new → open package → new/used *with issue* → as-is
(untested / salvage / expired). The five **SEE NOTES** grades refuse to save
without a written note describing the specific issue (enforced in the API and
the admin form). The storefront shows translated labels (lv/ru/en/et/lt), the
note in an amber callout on every lot page, and a public **`/conditions`**
reference page linked from each lot; items graded before the taxonomy keep
their legacy free-text label. Seed data demonstrates the new grades.

**Zero-tolerance suspensions**: swearing, threats or abuse toward staff gets
an account suspended on the spot — Customers → **Suspend account** (ops/sales
permission `customers.strike`), reason mandatory, audit-logged, effective
immediately (`BIDDER_BLOCKED` on bid/buy, banner on the account page).
Reinstating equally requires a reason. The generic customer PATCH deliberately
cannot flip the flag, so no ban ever bypasses the audit trail. GDPR-erase
also suspends with reason "GDPR erasure". This complements the restock-fee
pause (`FEES_OUTSTANDING`) above — settling fees unblocks that pause, but a
zero-tolerance suspension only ends by explicit reinstatement.

## Out of scope so far (per design-doc build order)

Klix payments, carrier APIs (Omniva/DPD/Venipak) — both waiting on merchant
credentials (request early!), a real SMTP/email provider (adapter seam is
ready), Sentry monitoring. The schema and config leave explicit room for each.
