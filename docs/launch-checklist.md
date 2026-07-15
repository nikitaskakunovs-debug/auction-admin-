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
- [ ] Carrier APIs (Omniva/DPD) if shipping is ever offered
- [ ] Error monitoring (Sentry) + an uptime check on `/api/health`
- [ ] Managed PostgreSQL migration when scale demands (change `DATABASE_URL`,
      restore a dump — nothing else changes)

## Standing routines

- Nightly 03:15 DB backup → Spaces `backups/` (14-day retention);
  restore drill: `zcat file.sql.gz | docker compose -f docker-compose.prod.yml exec -T postgres psql -U auction auction`
- Update procedure: `cd /opt/auction && git pull && cd deploy && docker compose -f docker-compose.prod.yml up -d --build`
  (+ `exec api node packages/db/dist/migrate.js` when a release notes a migration)
