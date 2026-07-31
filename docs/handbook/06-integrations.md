# 06 — Integrations

Shared pattern (`src/config.ts` + `src/index.ts`): every provider has
`<X>_MODE = off | live | simulate`. `create<X>Client(config)` returns `null`
when off (routes/UI hide the feature), an in-memory simulator for tests, or
the live HTTP client, threaded through `AppContext`.

## Jira bug-report sync (Phase E)

Code: `engine/jira.ts` (client), `engine/bugSync.ts` (glue),
`routes/bugs.ts`, scheduler `syncBugs`; admin `ReportModal.tsx`,
`bugCapture.ts`, `screens/Activity.tsx` (Bugs tab + connection card),
`wh/Warehouse.tsx`.

- **Env:** `JIRA_MODE`, `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`,
  `JIRA_PROJECT` (IZS), `JIRA_WEBHOOK_SECRET`. Auth: Basic
  `email:apiToken` against `<base>/rest/api/3`.
- **Outbound:** reports insert locally first (`open`), then
  `sendReportToJira` creates the issue — ADF description (steps, context
  lines, last 30 console lines as a code block, deep link back to the
  panel), type Bug/Task, labels `izsoli-admin` + type, severity→priority
  map, native attachments (`x-atlassian-token: no-check`). Jira outage →
  report stays queued; the scheduler retries and backfills chat written
  meanwhile (each `jiraCommentId` stored for dedupe).
- **Inbound:** `adfToText` preserves `mention`/`emoji`/`hardBreak`/
  `inlineCard` (dropping them used to mangle replies). `syncOneReport`
  inserts IT comments (`side:"it"`), maps status category → `sent |
  in_progress | done`; on done stores the newest comment as
  `resolutionNote`, emails the reporter ("IT atbildēja — IZS-n" /
  "✓ Salabots"), publishes `bug_reply` WS event (instant 🐞 badge).
- **Cadence:** webhook (instant) → chat-open pull (10 s throttle) → open
  chat polls every 5 s → 5-min scheduler sweep (fallback).
- **Webhook:** `POST /api/jira/webhook?secret=<v>` — 404 while unset, 401 on
  mismatch, 204 otherwise; rate limit 120/min. Register in Jira (Settings →
  System → WebHooks) for *Issue updated* + *Comment created*, optional JQL
  `project = IZS`.

## Klix payments

Code: `engine/klix.ts`, `routes/payments.ts`, `engine/payLink.ts`;
storefront `KlixPayLater.tsx`.

- **Env:** `KLIX_MODE` (test credentials also use `live` — the test brand is
  just a different key pair), `KLIX_BRAND_ID` (public), `KLIX_SECRET_KEY`
  (server-only), `KLIX_METHODS` whitelist.
- **Flow:** `POST /api/public/orders/:ref/pay` → create purchase (with
  `due` = payment deadline + `due_strict`, so stale links can't collect) →
  redirect to `checkout_url` → server-to-server callback
  `?payment=<uuid>` → **re-fetch the purchase by id** and settle only on
  `paid`. Lost callback → the account-page poll reconciles.
- One open checkout per order across both providers; a `created` payment is
  reused only same-provider/same-amount/<30 min, otherwise reconciled,
  cancelled at Klix and expired. Pay-by-email links are signed, order-scoped,
  die with the deadline, and are `null` when providers are off.
- Pay Later widget: brand id via `GET /api/public/payments/config`;
  representative example fetched server-side and Redis-cached 24 h.
- Refunds: partial/full via API; "Record only" for portal/cash refunds.

## Inbank BNPL

Code: `engine/inbank.ts`, `routes/payments.ts`.

- **Env:** `INBANK_MODE`, `INBANK_API_URL` (demo-api for partner testing),
  `INBANK_SHOP_UUID`, `INBANK_API_KEY`, `INBANK_PRODUCT_CODE?`.
- e-POS session → hosted credit application → callback (GET or POST) →
  direct status check. **Only `completed` counts as paid** — `granted` is
  credit approval and stays in flight. Refunds are manual in the partner
  portal (+ "Record only"); sessions can't be cancelled remotely — a late
  `completed` still settles idempotently.
- Onboarding caveat (documented in `createSession()`): verify request-body
  field casing against partner docs / one demo-api call.

## Omniva OMX (+ DPD seam)

Code: `engine/omniva.ts`, `engine/dpd.ts` (same interface),
`engine/fulfilment.ts`, `routes/shipping.ts`.

- **Env:** `OMNIVA_MODE`, `OMNIVA_API_URL` (test-omx sandbox),
  `OMNIVA_USERNAME` (customer code = Basic user), `OMNIVA_PASSWORD`;
  DPD: `DPD_MODE/API_URL/API_TOKEN/SERVICE_ALIAS`; shared `SHIP_SENDER_*`.
- Customer picks delivery **before paying**: options (pickup always;
  `omniva_pm`/`dpd_pm` when client exists; €3.99 + per-market handling fee) →
  locker search (public locations JSON, Redis-cached daily) → fulfilment
  choice reprices the order, kills stale checkouts, reissues the invoice.
  Shipping/handling never enter the 10% premium.
- Admin: register shipment (barcode + tracking email, item paid→picking→
  packed), label PDF proxy, tracking refresh. Scheduler polls active
  shipments behind a 30-min Redis marker (≤200 rows ≈ 50 polls/day).

## Email (SMTP)

`src/email.ts`: one `EmailAdapter` interface — Console (dev), Capturing
(tests, `failNext` for retry paths), SMTP (nodemailer, lazy; auth skipped
when `SMTP_USER` empty). Delivery is outbox-driven (`engine/notifications.ts`,
dedupe keys, 5 attempts) at the end of every scheduler tick.
Ops guidance: don't run Postfix on the droplet (DO blocks port 25) — use a
relay (Resend/Brevo) with the domain's DKIM/SPF; switching providers is an
env change.

## Sentry

Three projects, all no-ops without a DSN. API: `@sentry/node` in
`instrument.ts` (first import, errors only, `tracesSampleRate: 0`), runtime
env. Storefront: `@sentry/nextjs` via `instrumentation.ts` +
`instrumentation-client.ts` + `global-error.tsx`, DSN **inlined at build**
from `SENTRY_DSN_WEB`. Admin: `@sentry/react` (`sentry.ts`), DSN inlined
from `SENTRY_DSN_ADMIN`. Web + admin need `up -d --build` to change; API
only a restart. Route alerts to Slack in Sentry's UI.

## VIES VAT validation

Domain logic (formats, 90-day staleness, reverse-charge qualification) in
`packages/domain/src/vies.ts`; the only network call in
`routes/finance.ts::viesLookup` — EU REST check-vat endpoint, 8 s timeout,
stores `{valid, checkedAt, consult}` (consultation number = zero-rating
audit proof). `VIES_MODE=simulate` outside production stamps synthetic
consultations. Endpoint: `POST /api/customers/:id/vies-check`
(`customers.vies_check`), audited. Consumed by `close.ts`/`purchase.ts`
for Art. 196 reverse charge.
