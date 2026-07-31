# 04 — Frontends

## `apps/admin` — Vite + React 19 operator SPA

No router library, no state library, no CSS framework: hash routes, local
`useState` + `load()` per screen, inline style objects over the `AT` token set
(`src/theme.ts`, dark sidebar / light workspace, ported from the "Shhh"
admin). Entry: `main.tsx` → `AuthProvider → ToastProvider → ConfirmProvider →
App`.

### Routing & shell (`App.tsx`)

`location.hash` → `{screen, param}`. Gates in order: warehouse host check →
`#/board` (renders **before** login) → login → warehouse mode (`#/wh`) → full
shell. The shell is browser-style **tabs** (drag-reorder, middle-click close,
persisted in `localStorage["adminShell.v1"]`) with **split view** (two panes,
focused pane outlined) and a **⌘K palette** (`shell/SearchPalette.tsx`,
180 ms-debounced `GET /api/search`, results open in new tabs). The sidebar
shows permission-filtered nav with live count pills (`useBadges` —
`GET /api/badges` on mount/5 min/WS events), a Warehouse-mode link, and the
🐞 report button with an unread-reply dot.

### Hash routes

| Route | Screen | Permission |
|---|---|---|
| `#/dashboard` | KPI tiles + live table (refreshes on any admin WS event) | — |
| `#/auctions` · `#/auctions/<id>` | List · live monitor (ledger, extend/cancel/void/relist, mandatory reasons) | `auctions.view` (+action perms) |
| `#/listings` | Power list, pricing (`listings.set_pricing`), bulk publish/archive, ready-to-list queue | `listings.view` |
| `#/inventory` · `#/inventory/<itemId>` | Lot catalogue by lifecycle group; drawer with photos, condition presets, chat + history, labels | `items.view` |
| `#/receiving` | Deliveries · Grading review (`grading.review`) · Bins tabs | `warehouse.manage` |
| `#/orders` · `#/orders/<id>` | Power list · full-page detail (mark paid, refund, cancel, shipping, invoice) | `orders.view` |
| `#/pickup` | Desk: check-in, claim, pick path, handover by code, NOW PICKING strip | `pickup.view` |
| `#/whstats` | W3 productivity: totals, per-day chart, per-worker table + timeline, CSV | `stats.view` |
| `#/customers` | Bidder power list: strikes, block, VIES, tags, fees, GDPR erase | `customers.view` |
| `#/finance` | Payments · Invoices (printable) · VAT report tabs | `invoices.view` |
| `#/content` | CMS editor (lv/ru/en block pages, SEO, draft→publish) | `content.view` |
| `#/settings` | Markets · Team · Roles matrix · Conditions · Tags | `settings.view` |
| `#/notifications` | Email outbox log | `audit.view` |
| `#/activity` | Audit trail + **Bugs tab** (Jira-mirrored reports) | `audit.view` |
| `#/security` | Own password + recovery codes | — |
| `#/wh` | Warehouse phone mode (below) | session |
| `#/board` · `#/board/delivering` | Waiting-room TVs — **no login**, polls the public board every 3 s | — |
| `#/reset?token=` | Emailed password-reset landing | logged-out |

### Shared kit

`ui.tsx` (buttons, badges, tables, drawer, **ConfirmProvider** with
type-to-confirm + required reason, toasts) · `powerkit.tsx` (A3 power-list
kit: stored filters, saved views via `/api/views`, chips, bulk bar, export
menu) · `exporters.ts` (CSV/XLS/print-PDF, dependency-free) ·
`itemPanels.tsx` (chat + history threads) · `paymentLabels.ts` ·
`i18n.ts` (lv/ru/en, default lv; warehouse + login fully translated) ·
`bugCapture.ts` (50-line console/error/failed-API ring buffer attached to
bug reports) · `api.ts` (singleton client: in-memory access token, cookie
refresh with one retry on 401, typed DTOs) · `useAuctionEvents.ts`
(WS client, backoff ≤10 s, admin firehose or per-auction).

### Warehouse PWA (`#/wh`, `src/wh/`)

Same login/RBAC, phone-first. Served identically on `wh.<domain>` where
`host.ts` locks the app to warehouse mode. Home tiles (permission-gated):
Scan/lookup · Receive · Putaway · Pick queue · Bins, plus worker status
(working/coffee/lunch/done), grading notices, ticket pass offers, report a
problem, language switch. `CameraScanner.tsx`: native `BarcodeDetector` with
bundled `jsqr` fallback; HID type-and-Enter scanners work in every input.
Installable PWA (`manifest.webmanifest`, `start_url: "/#/wh"`); no service
worker — online-only by design.

## `apps/web` — Next.js 15 storefront

App Router, `src/` layout. SSR pages fetch with `cache: "no-store"` inside
try/catch — an API outage renders empty states, never a 500. Browser calls go
through `lib/api.ts` (bidder tokens in localStorage, transparent refresh).

### Routes

| Route | Purpose |
|---|---|
| `/` | Home: search (300 ms debounce), category chips, auctions + buy-now sections, paging (48/page). |
| `/auction/[id]` | Live lot: WS-driven (any message → full re-fetch), proxy-bid box with exact minimum, sanitized ledger, countdown, reserve chip, gallery, Klix Pay-Later calculator, JSON-LD. |
| `/listing/[id]` | Fixed-price lot: buy-now (→ `/account`), sold-out state, JSON-LD. |
| `/account` | My bids/orders, payment return handling, delivery picker (pickup vs parcel machine, repriced server-side), tracking, fees notice, pickup pass (6-digit code + QR). |
| `/login` · `/register` · `/forgot-password` · `/reset-password` | Bidder auth (no 2FA; no account enumeration). |
| `/kiosk` | Wall-tablet check-in: dark keypad, USB scanner capture, auto-submit at 6 digits, huge ticket number, 12 s reset. |
| `/conditions` | Public 16-grade condition reference. |
| `/p/[slug]` | CMS pages; footer nav from published pages (ISR 120 s — the only ISR). |
| `/sitemap.xml` · `/robots.txt` | Host-aware, self-referencing. |

### i18n & ccTLD SEO

Country resolved from the request `Host` (`.lv/.ee/.lt`, unknown → LV) —
drives `<html lang>`, default language, offered set (national + ru + en; UI
strings ship in all five). Every page emits canonical + hreflang alternates
cross-linking the ccTLD siblings (`x-default` → .lv). JSON-LD is serialized
through `jsonld.ts` which escapes `<>&` so admin-entered text can't break out
of the script tag. Origins configurable via `NEXT_PUBLIC_ORIGIN_LV/EE/LT`.

## `apps/e2e` — Playwright

`playwright.config.ts`: serial (1 worker — shared DB + live scheduler),
`globalSetup` migrates + seeds, then **`webServer` boots the real stack**:
built API (`node dist/index.js`, `NODE_ENV=test`, scheduler ON) and
`next start`. Local runs use the system Chromium via `PW_EXECUTABLE_PATH`.

`tests/fixtures.ts`: `seedTotp()` (note the `base32Decode`), `adminToken()`
(full two-step login), `createLiveAuction()` (item → listing → publish →
auction → poll until the scheduler opens it), `registerBidderApi`,
`placeBidApi`, `createFixedListing`, `markOrderPaid`.

Specs: `storefront.spec.ts` (register→bid→lead; **live outbid over WS with
no reload**; minimum-bid sad path), `buy-now.spec.ts` (full purchase →
sold-out), `win-pay.spec.ts` (8-second auction closed by the real scheduler
→ order → ops marks paid → bidder sees it), `seo.spec.ts` (host-spoofed
hreflang/lang/robots assertions).

## Build tooling

- Vite dev server :5173 proxies `/api` and `/ws` to :4000 — dev is
  same-origin, matching production Caddy.
- Next has **no dev proxy** — the browser talks to the API cross-origin via
  `NEXT_PUBLIC_API_URL` (CORS allowlists localhost:3000 in dev).
- All `NEXT_PUBLIC_*` and `VITE_*` values are **inlined at build time** —
  changing them in production requires `up -d --build`, not a restart.
