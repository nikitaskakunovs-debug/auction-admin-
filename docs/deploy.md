# Deploying to DigitalOcean (FRA1)

One droplet runs everything via Docker Compose: Postgres 16, Redis 7, the API,
the Next.js storefront, and Caddy (TLS + admin SPA + reverse proxy). Photos
live in Spaces (S3); backups go to the same bucket nightly. Total ~$29/month
(droplet $24 + Spaces $5). Scale path later: move Postgres to Managed
PostgreSQL (change `DATABASE_URL`, restore a dump — nothing else changes).

## 0. What you create in the DigitalOcean control panel

1. **Droplet** — Frankfurt (FRA1), Ubuntu 24.04 LTS, Basic / Premium AMD,
   4 GB RAM / 2 vCPU ($24/mo). Add your SSH key. Enable weekly backups (+20%).
2. **Spaces bucket** — FRA1, e.g. `yourbrand-photos`. Settings → enable CDN.
   API → Spaces Keys → generate a key pair (this is `S3_ACCESS_KEY/SECRET`).
3. **DNS** — point these A records at the droplet IP (at your registrar or
   DO DNS):

   | record | type | value |
   |---|---|---|
   | `@` | A | droplet IP |
   | `www` | A | droplet IP |
   | `api` | A | droplet IP |
   | `admin` | A | droplet IP |

Caddy issues Let's Encrypt certificates automatically once DNS resolves.

## 1. Prepare the droplet (once)

```bash
ssh root@<droplet-ip>
apt-get update && apt-get install -y ca-certificates curl git s3cmd
# Docker (official convenience script)
curl -fsSL https://get.docker.com | sh
# Basic firewall
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
```

## 2. Get the code and configure

```bash
mkdir -p /opt && cd /opt
git clone https://github.com/<owner>/<repo>.git auction
cd auction/deploy
cp .env.example .env
nano .env        # fill EVERYTHING in — see comments in the file
openssl rand -hex 24   # run twice: POSTGRES_PASSWORD and JWT_SECRET
```

## 3. Build and start

```bash
cd /opt/auction/deploy
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps       # wait until healthy
```

## 4. Migrate, then create your admin

```bash
# Apply all migrations
docker compose -f docker-compose.prod.yml exec api node packages/db/dist/migrate.js
# Baseline config (markets, roles, bins) + your super admin from
# INITIAL_ADMIN_EMAIL/PASSWORD in .env. NO demo data, NO demo admins.
docker compose -f docker-compose.prod.yml exec api node packages/db/dist/seed.js
```

Sign in at `https://admin.<domain>` — the mandatory-2FA flow makes you enroll
an authenticator on first login. Then **delete `INITIAL_ADMIN_PASSWORD` from
`.env`**. Create your staff under Settings → Team (one account per person,
least-privilege role).

## 5. Verify

- `https://<domain>` — storefront loads, languages switch.
- `https://admin.<domain>` — login + 2FA, Inventory/Receiving open.
- `https://api.<domain>/api/health` — `{"ok":true}`.
- Upload a photo to an item — the URL should point at the Spaces CDN.
- Warehouse mode on a phone: `https://admin.<domain>/#/wh`, add to home screen.
- Place a test bid from a second browser; watch it live in the admin monitor.

## 6. Backups (nightly, off-site)

```bash
s3cmd --configure       # Spaces key/secret, S3 endpoint fra1.digitaloceanspaces.com
chmod +x /opt/auction/deploy/backup.sh
crontab -e
# 15 3 * * * /opt/auction/deploy/backup.sh >> /var/log/auction-backup.log 2>&1
```

Restore drill (do this once now, on a scratch database, so the first real
restore isn't the first attempt):

```bash
zcat auction-<stamp>.sql.gz | docker compose -f docker-compose.prod.yml exec -T postgres psql -U auction auction
```

## 7. Updating to a new version

```bash
cd /opt/auction && git pull
cd deploy
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml exec api node packages/db/dist/migrate.js
```

## Email ("our own sender")

`EMAIL_MODE=smtp` sends through whatever SMTP endpoint `.env` points at, with
your domain in the From line. Practical guidance:

- **Don't run Postfix on the droplet initially**: DigitalOcean blocks port 25
  on new accounts, and a fresh IP with no sending reputation goes to spam.
- **Do**: create a free relay account (Resend/Brevo), add their DKIM/SPF DNS
  records for your domain, put the SMTP credentials in `.env`. Mail is
  authenticated as *your* domain; switching providers (or to self-hosted
  later, once you have reputation and a dedicated IP) is only an env change.

## Klix payments (cards, Pay Later/BNPL, banklinks)

The integration is built in and OFF by default (`KLIX_MODE=off`) — the
storefront shows no pay button and orders are marked paid manually in
admin → Orders. To switch it on when Klix issues the credentials:

1. Put the keys in `/opt/auction/deploy/.env` (never in chat/screenshots):
   `KLIX_MODE=live`, `KLIX_BRAND_ID=…`, `KLIX_SECRET_KEY=…`.
   Klix **test** credentials use the same setting — the test brand is just a
   different key pair (test cards: VISA 4505 1312 3400 0029, MC 5191 6312
   3400 0024, any future date / any CVC).
2. `docker compose -f docker-compose.prod.yml up -d api` to restart the API.
3. Test: win/buy something with a test bidder → account page → **Pay now** →
   Klix checkout → pay with a test card → back on the account page the order
   flips to paid and the pickup code email goes out.

How it works: the API creates a Klix *purchase* and redirects the customer to
Klix's hosted checkout (which offers every method enabled on the brand —
cards, Pay Later, Swedbank/SEB/Luminor/Citadele banklinks). Klix then calls
`api.<domain>/api/public/payments/klix/callback` server-to-server; the API
re-fetches the purchase from Klix and only marks the order paid when Klix
itself reports `paid` (spoofed callbacks are harmless). If the callback is
ever lost, the account page's status poll reconciles on the next visit.
Payment attempts are visible per order in admin → Orders.

**Pay Later calculator**: once `KLIX_MODE=live`, auction pages, buy-now pages
and the account page show Klix's official monthly-payment widget on the full
checkout amount (hammer + premium + VAT — computed server-side, so the
calculator always matches the real total). The numbers come from Klix's
financing API for the products in YOUR merchant agreement — never computed
by us. Payment-due emails embed Klix's "representative example" text (the
legally required consumer-credit wording with the actual monthly payment for
that order's amount), fetched at send time and cached for a day. While
`KLIX_MODE=off` neither the widget nor the example appears anywhere.

**Pay by email link**: the "you won" / "purchase confirmed" / payment-reminder
emails carry a one-click pay link (signed, order-specific, expires with the
payment deadline) that opens the same Klix checkout without logging in.
Admin → Orders shows whether each payment attempt came from the web button or
the email link. Both doors share one open checkout per order — and a
superseded checkout is cancelled at Klix itself — so paying twice is
impossible by construction.

**Refunds**: on a Klix-paid order the admin Refund action returns the money
to the customer through the Klix API automatically (partial or full) and
records it — if Klix rejects the refund, nothing is recorded. The
"Record only" link covers refunds already made in the Klix portal or in
cash. Checkouts carry the order's payment deadline as a strict expiry, so a
stale payment link can't collect money for an order you've since cancelled.
Chargebacks/disputes are handled in the Klix merchant portal.

## Inbank BNPL (hire purchase / installments)

A second, independent BNPL provider next to Klix — also OFF by default
(`INBANK_MODE=off`). When the Inbank partner agreement is signed and they
issue the shop UUID + API key:

1. Fill `INBANK_MODE=live`, `INBANK_SHOP_UUID=…`, `INBANK_API_KEY=…` in
   `/opt/auction/deploy/.env` (for partner testing first:
   `INBANK_API_URL=https://demo-api.inbank.eu`).
2. Restart the api container. The storefront account page then shows an
   extra "Inbank installments" button next to Pay now.
3. During onboarding, confirm the pos-session request field names against
   the partner docs (the mapping is one function in
   `apps/api/src/engine/inbank.ts` — see the note there).

Flow: the API creates an e-POS session and redirects the customer to
Inbank's environment, where the whole credit application happens. Inbank
notifies our callback on status changes; the order settles ONLY when a
direct status check shows `completed` (credit approval alone — `granted` —
is not payment). BNPL approvals can take a while: the storefront shows
"payment is being processed" and the customer gets the paid email whenever
the callback lands. One open checkout per order is enforced across BOTH
providers, so a customer can't pay the same order twice via Klix and
Inbank. Refunds for Inbank-paid orders are done in the Inbank partner
portal (contract credit/termination), then recorded in admin with the
"Record only" path — the API refuses to fake-refund them automatically.

## Omniva parcel shipping

Built in and OFF by default (`OMNIVA_MODE=off`) — until then every order is
warehouse pickup. When the Omniva business contract is signed and they issue
the customer code + password:

1. Fill `OMNIVA_MODE=live`, `OMNIVA_USERNAME`, `OMNIVA_PASSWORD` and the
   `SHIP_SENDER_*` block (warehouse address on the labels) in
   `/opt/auction/deploy/.env`. For their sandbox first:
   `OMNIVA_API_URL=https://test-omx.omniva.eu/api/v01/omx`.
2. Restart the api container.
3. The buyer's account page then offers "Omniva parcel machine" next to
   pickup: they choose a machine + leave a phone (for the locker SMS) BEFORE
   paying — the delivery price AND the packing/handling fee (both per market
   in Settings → Markets) join the order total, the invoice is reissued as a
   correction, and any open checkout reprices. Neither shipping nor handling
   is ever part of the 10% buyer premium — that applies to the hammer price
   only.
4. After payment, admin → Orders → the order → **Shipping** card:
   **Register Omniva shipment** (barcode issued, customer gets the tracking
   email) → **Print label** (PDF opens in a tab — print, stick, hand the
   parcel to Omniva) → tracking events update on **Refresh tracking** and
   automatically every 30 minutes. The item walks paid → packed → shipped →
   delivered with the parcel.

Refunds/returns of shipped goods and courier pickup orders stay manual.

## DPD parcel lockers

The second carrier, on the same seam and also OFF by default
(`DPD_MODE=off`). When the DPD business contract is signed:

1. Fill `DPD_MODE=live` + `DPD_API_TOKEN` in `/opt/auction/deploy/.env`
   (sandbox first: `DPD_API_URL=https://sandbox-eserviss.dpd.lv/api/v1`).
   Confirm the locker service alias with `GET /services` and set
   `DPD_SERVICE_ALIAS` if it differs from "DPD PUDO".
2. Restart the api container. The account page then offers "DPD parcel
   locker" next to Omniva and pickup, at its own per-market price
   (Settings → Markets → "DPD locker €"); the same handling fee applies.
3. Admin flow is identical to Omniva: Register DPD shipment → Print label
   (A6 PDF) → tracking events, all in the order's Shipping card.

## Notes

- CORS, `PUBLIC_BASE_URL`, `STOREFRONT_BASE_URL`, and trust-proxy are derived
  from `DOMAIN` automatically in `docker-compose.prod.yml`.
- The ccTLD trio (`.lv/.ee/.lt`) works by adding the extra domains to DNS +
  the Caddyfile site list + `ORIGIN_LV/EE/LT` in `.env`, then rebuilding web.
- EE VAT is seeded at 24% — confirm with your accountant in Settings → Markets.
- Carrier APIs remain env-gated future work.
