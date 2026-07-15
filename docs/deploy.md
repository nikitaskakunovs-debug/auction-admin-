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

## Notes

- CORS, `PUBLIC_BASE_URL`, `STOREFRONT_BASE_URL`, and trust-proxy are derived
  from `DOMAIN` automatically in `docker-compose.prod.yml`.
- The ccTLD trio (`.lv/.ee/.lt`) works by adding the extra domains to DNS +
  the Caddyfile site list + `ORIGIN_LV/EE/LT` in `.env`, then rebuilding web.
- EE VAT is seeded at 24% — confirm with your accountant in Settings → Markets.
- Carrier APIs remain env-gated future work.
