# Izsoli.lv — launch checklist & open threads

State as of 2026-07-15: platform deployed and hardened on the FRA1 droplet
(165.232.113.239), backups nightly, code merged to `main`, DO DNS zone ready.
**Blocked on: nano.lv accepting the DigitalOcean nameservers.**

## 1. The moment https://izsoli.lv loads (do together, ~10 min)

- [ ] Open `https://admin.izsoli.lv` → first login with the bootstrap
      credentials → enroll 2FA in an authenticator app
- [ ] Remove the bootstrap password from the server:
      `sed -i "s|^INITIAL_ADMIN_PASSWORD=.*|INITIAL_ADMIN_PASSWORD=|" /opt/auction/deploy/.env`
- [ ] Upload a test photo to an item → URL must point at
      `izsoli-photos.fra1.cdn.digitaloceanspaces.com`
- [ ] Phone: `https://admin.izsoli.lv/#/wh` → add to home screen → scan/receive flow
- [ ] One end-to-end test auction: Receiving → photo → grade → Ready to list →
      publish & schedule → bid from a second browser → win → mark paid →
      pickup code → kiosk check-in → pick → hand over
- [ ] Storefront: footer pages (Par mums / Kā solīt) + `/conditions` in lv/ru/en
- [ ] Delete the mistyped first Spaces key (`izsoli-api`) in the DO panel if
      still present

## 2. Business threads (owner, can run in parallel)

- [ ] **Klix** merchant application (weeks of lead time — apply early).
      The integration is already built and env-gated: when the Brand ID +
      Secret key arrive, set `KLIX_MODE=live` + the two keys in
      `deploy/.env`, restart the api container, and test with a Klix test
      card first (see docs/deploy.md → "Klix payments")
- [ ] **Inbank** partner application (BNPL/installments — also built and
      env-gated): when the shop UUID + API key arrive, test against
      `demo-api.inbank.eu` first, verify the pos-session field names with
      their docs, then `INBANK_MODE=live` (see docs/deploy.md → "Inbank
      BNPL")
- [ ] **Omniva** business contract (parcel machines — built and env-gated):
      when the customer code + password arrive, test against
      `test-omx.omniva.eu` first, fill the `SHIP_SENDER_*` warehouse address,
      then `OMNIVA_MODE=live`; set the delivery price per market in
      Settings → Markets (see docs/deploy.md → "Omniva parcel shipping")
- [ ] **DPD** business contract (lockers — built and env-gated): when the
      API token arrives, test against `sandbox-eserviss.dpd.lv`, confirm the
      locker service alias via GET /services, then `DPD_MODE=live`; price per
      market in Settings → Markets (see docs/deploy.md → "DPD parcel lockers")
- [ ] **Hardware**: thermal label printer (labels ≈57×32 mm), one or two **2D**
      barcode scanners (must read QR), photo-station lamp, 2 TVs for the
      pickup boards
- [ ] **Lawyer**: review the seeded **Terms** + **Privacy** drafts
      (admin → Content), esp. the 5% restock-fee clause; publish after approval
- [ ] **Accountant**: confirm EE VAT 24% (Settings → Markets) and the VAT
      treatment of retained restock fees
- [ ] **Mailbox**: make `info@izsoli.lv` real (referenced in the privacy page)
- [ ] **Email sending**: create a relay account (Resend/Brevo), add its
      DKIM/SPF records in the DO DNS zone, set `EMAIL_MODE=smtp` + SMTP vars
      in `deploy/.env`, restart api — mail then goes out as @izsoli.lv
- [ ] Consider registering **izsoli.ee / izsoli.lt** (brand protection; the
      code already supports the ccTLD trio via `ORIGIN_EE/LT`)

## 3. When real bidders arrive (dev workflow upgrade)

The pipeline today: Claude's sandbox (dev) → GitHub CI (258 automated tests
on every push; nothing merges red) → production via `git pull` + rebuild.
The missing tier is human preview. At launch, add:

- [ ] **Staging droplet** (~$14): same deploy pack, `.env` with
      `DOMAIN=staging.izsoli.lv`, demo-data seeding ON, Caddy basicauth gate,
      3 extra A records → flow becomes *CI green → merge → staging → owner
      approves → production*
- [ ] **Release tags**: production deploys pinned tags (`v1.0`, `v1.1`…)
      instead of `main` tip; rollback = checkout the previous tag
- [ ] **Staff accounts**: one per person in Settings → Team, least-privilege
      roles (never share the super admin)

## 4. Later / roadmap

- [x] Klix payment integration — built (BNPL + banklinks + cards via hosted
      checkout); switches on via `KLIX_MODE=live` once keys arrive (§2)
- [x] Carrier APIs — built (Omniva parcel machines + DPD lockers, labels,
      tracking); switch on via `OMNIVA_MODE` / `DPD_MODE` once contracts
      arrive (§2)
- [x] Error monitoring (Sentry) — built (Fastify + Next.js + admin SPA);
      switches on via the three DSN vars once set (see "Sentry error
      monitoring" below). Still open: an uptime check on `/api/health`
- [ ] Managed PostgreSQL migration when scale demands (change `DATABASE_URL`,
      restore a dump — nothing else changes)

## Slack notifications (CI test results)

The CI workflow posts every run's verdict to Slack once a webhook is
configured (until then the step is a silent no-op):

1. https://api.slack.com/apps → Create New App → From scratch → workspace
   `auctionmvp` → Features → **Incoming Webhooks** → activate → **Add New
   Webhook to Workspace** → pick the channel → copy the
   `https://hooks.slack.com/services/…` URL
2. GitHub → repo → Settings → Secrets and variables → Actions →
   **New repository secret** → name `SLACK_WEBHOOK_URL`, value = that URL

Every push then reports ✅/❌ with branch, commit, author, and a link to the
run. (Zero-code alternative: `/invite @GitHub` in the channel, then
`/github subscribe nikitaskakunovs-debug/auction-admin- workflows` — but the
webhook message is tidier.)

## Production smoke test (after go-live)

A GitHub Actions cron probes the LIVE site every 30 minutes — API health,
storefront, admin panel — and pings Slack **only on failure**. Dormant until
you set the domain:

- repo → Settings → Secrets and variables → Actions → **Variables** tab →
  New repository variable → `SMOKE_DOMAIN` = `izsoli.lv`

(Pair it with an external uptime monitor — Better Stack / UptimeRobot free
tier pinging `https://api.izsoli.lv/api/health` every 30 s — so an outage
alerts within a minute even if GitHub Actions itself is delayed.)

## Automated dependency updates

`.github/dependabot.yml` opens weekly PRs for outdated / vulnerable
dependencies and GitHub Actions; each runs the full CI suite before it can
merge (and reports to Slack). Minor/patch bumps are grouped; majors come
singly. Turn on the security half in repo → Settings → Code security →
enable **Dependabot alerts** + **Dependabot security updates** (one click).

## Sentry error monitoring

Three Sentry projects (Fastify / Next.js / Browser JS) catch runtime errors
across the API, storefront, and admin panel. Dormant until the DSNs are set —
no DSN means the SDK never initialises, so nothing ships until you opt in.

1. Add the three DSNs to the droplet's `deploy/.env` (they're safe to store
   there — Sentry DSNs are public, embedded in the shipped bundles):

   ```
   SENTRY_DSN=https://f93d433b70105dd0e159f4de0554a500@o4511742271553536.ingest.de.sentry.io/4511742289248336
   SENTRY_DSN_WEB=https://f212bc741cf8a5992a2b69ccb01738fd@o4511742271553536.ingest.de.sentry.io/4511742277779536
   SENTRY_DSN_ADMIN=https://0232f4c4d8412302d213c6a371522c2f@o4511742271553536.ingest.de.sentry.io/4511742290493520
   ```

2. Rebuild so the web + admin DSNs get inlined (they're build-time values):
   `cd /opt/auction && git pull && cd deploy && docker compose -f docker-compose.prod.yml up -d --build`
   (the api DSN is runtime — a plain restart would suffice for it alone).

3. Route alerts to Slack: in Sentry → Settings → Integrations → **Slack** →
   add to workspace `auctionmvp` → then each project → Alerts → default rule →
   add a **Send a Slack notification** action → pick the channel. New-issue
   alerts then land in Slack the same as CI does.

## Recommended repo settings (one-time, in the GitHub UI)

- **Branch protection** on `main`: Settings → Branches → Add rule → require
  status checks `ci` and `e2e` to pass before merge. Makes "nothing merges
  red" a rule, not a habit.

## Standing routines

- Nightly 03:15 DB backup → Spaces `backups/` (14-day retention);
  restore drill: `zcat file.sql.gz | docker compose -f docker-compose.prod.yml exec -T postgres psql -U auction auction`
- Update procedure: `cd /opt/auction && git pull && cd deploy && docker compose -f docker-compose.prod.yml up -d --build`
  (+ `exec api node packages/db/dist/migrate.js` when a release notes a migration)
