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
pnpm test:integration   # api: 31 tests vs real Postgres/Redis — RBAC per role, bid placement,
                        # anti-snipe, void+replay, 60-bidder concurrency, scheduler close paths,
                        # unpaid auto-cancel, WebSocket payload hygiene
pnpm typecheck && pnpm build
```

CI (GitHub Actions) runs typecheck + build + migrations + the full suite against
Postgres/Redis services on every push.

## Configuration

Per-country config lives in the `markets` table (seeded from `packages/domain/src/config.ts`):
languages, VAT rate, buyer premium, anti-snipe default, increment table. Changing VAT is a
one-field edit in Settings → Markets — never a code change. Klix credentials and carrier
config fields are reserved for their build phases.

Environment variables (`apps/api`): `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET` (change in
production!), `PORT`, `PAYMENT_DEADLINE_HOURS` (72), `ALLOW_BID_SIMULATION` (auto-off in
production), `SCHEDULER_ENABLED`.

## Public storefront (`apps/web`)

Bidder registration/login (separate `kind="bidder"` tokens that admin routes reject
by construction), SSR auction browsing, and the **live auction page**: WebSocket
price updates (anonymous viewers included), proxy-bid box with exact minimum-next-bid,
sanitized public ledger (aliases only — reserve amounts, maxima, and emails never
leave the server), "reserve not met" state, account page with my-bids/my-orders.
SEO: JSON-LD Product/Offer, sitemap.xml, robots.txt, hreflang alternates.
UI strings in Latvian / Russian / English (per-country ccTLD routing lands in the
SEO polish phase).

## Out of scope so far (per design-doc build order)

Klix payments, carrier APIs (Omniva/DPD/Venipak) — both waiting on merchant
credentials (request early!), CMS (Payload/Puck), email notifications, Sentry
monitoring. The schema and config leave explicit room for each.
