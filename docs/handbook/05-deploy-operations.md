# 05 — Deploy & operations

## Production stack (`deploy/docker-compose.prod.yml`)

One droplet (DO FRA1, Ubuntu 24.04, 4 GB/2 vCPU ≈ $24/mo + Spaces ≈ $5/mo),
compose project `auction`, config from `/opt/auction/deploy/.env` (never
committed).

| Service | Image / build | Notes |
|---|---|---|
| `postgres` | `postgres:16-alpine` | user/db `auction`, `pgdata` volume, `pg_isready` healthcheck; not published. |
| `redis` | `redis:7-alpine` | `--appendonly yes`, `redisdata` volume; not published. |
| `api` | `deploy/api.Dockerfile` | Internal :4000. All integration env lands here. `uploads` volume only if `STORAGE_DRIVER=local`. |
| `web` | `deploy/web.Dockerfile` | Internal :3000; `API_URL=http://api:4000`; `NEXT_PUBLIC_*` as **build args**. |
| `caddy` | `deploy/caddy.Dockerfile` | :80/:443. Builds the admin SPA and serves it statically; TLS via Let's Encrypt (`ACME_EMAIL`). |

Derived from `DOMAIN` on the api service: `CORS_ORIGINS` (apex, www, admin,
wh), `PUBLIC_BASE_URL=https://api.$DOMAIN`, `STOREFRONT_BASE_URL`,
`ADMIN_BASE_URL`, `TRUST_PROXY=1`, `VIES_MODE=live`.

### Caddy routing (`deploy/Caddyfile`)
- `izsoli.lv`, `www.` → `web:3000`
- `api.izsoli.lv` → `api:4000` (public REST + WebSocket)
- `admin.izsoli.lv` and `wh.izsoli.lv` (identical blocks): `/api/*`,
  `/uploads/*`, `/ws*` → `api:4000`; everything else → static SPA from
  `/srv/admin` with SPA fallback. Same-origin proxy = no cross-origin admin
  auth. `wh.` needs its own DNS A record.

### Dockerfiles
- `api.Dockerfile` — node:22-alpine multi-stage: frozen install → build
  domain → db → api → prod-only install. CMD `node apps/api/dist/index.js`.
  Migrations are explicit, never in CMD.
- `web.Dockerfile` — build args `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SITE_URL`,
  `NEXT_PUBLIC_ORIGIN_LV/EE/LT`, `NEXT_PUBLIC_SENTRY_DSN` (inlined!).
- `caddy.Dockerfile` — builds `apps/admin/dist` (arg `VITE_SENTRY_DSN`),
  copies into `caddy:2` with the Caddyfile.

**Consequence:** changing any `NEXT_PUBLIC_*`/`VITE_*` value requires
`up -d --build`; `SENTRY_DSN` (API) is runtime-only.

## Provisioning & update

First-time setup is documented step-by-step in [`docs/deploy.md`](../deploy.md)
(droplet, DNS A records for `@ www api admin wh`, Spaces + CDN, ufw, Docker,
clone to `/opt/auction`, secrets via `openssl rand -hex 24`, migrate, seed,
first-admin 2FA enrollment, then delete `INITIAL_ADMIN_PASSWORD`).

**Update procedure** (also what CI-green means in practice):

```bash
cd /opt/auction && git pull \
  && cd deploy && docker compose -f docker-compose.prod.yml up -d --build \
  && docker compose -f docker-compose.prod.yml exec api node packages/db/dist/migrate.js
```

## Backups

`deploy/backup.sh` — nightly `pg_dump | gzip` → `s3cmd put` to Spaces
`backups/`, pruning objects older than 14 days. Cron:
`15 3 * * * /opt/auction/deploy/backup.sh >> /var/log/auction-backup.log 2>&1`.
Restore: `zcat dump.sql.gz | docker compose -f docker-compose.prod.yml exec -T
postgres psql -U auction auction`. DO weekly droplet backups are the second
layer.

## Environment variables

Operator-facing reference is `deploy/.env.example`; authoritative
defaults/validation in `apps/api/src/config.ts`.

| Group | Variables (defaults) |
|---|---|
| Domains/TLS | `DOMAIN`, `ACME_EMAIL`, optional `ORIGIN_LV/EE/LT` |
| Secrets (required) | `POSTGRES_PASSWORD`, `JWT_SECRET` (≥32 chars enforced in prod) |
| First admin | `INITIAL_ADMIN_EMAIL`, `INITIAL_ADMIN_PASSWORD` (blank after enrollment) |
| Infra | `NODE_ENV`, `HOST` (0.0.0.0), `PORT` (4000), `DATABASE_URL`, `REDIS_URL`, `CORS_ORIGINS`, `TRUST_PROXY`, `PUBLIC_BASE_URL`, `STOREFRONT_BASE_URL`, `ADMIN_BASE_URL` |
| Auth knobs | `ACCESS_TOKEN_TTL_SEC` (900), `REFRESH_TOKEN_TTL_SEC` (7 d), `LOGIN_MAX_ATTEMPTS` (8), `LOGIN_LOCKOUT_SEC` (900), `RATE_LIMIT_MAX` (300/min), `TOTP_ISSUER` (Izsoli.lv), `TRUSTED_DEVICE_TTL_SEC` (30 d), `PASSWORD_RESET_TTL_SEC` (1800) |
| Engine | `PAYMENT_DEADLINE_HOURS` (72), `PAYMENT_REMINDER_LEAD_HOURS` (24), `ALLOW_BID_SIMULATION` (off in prod), `SCHEDULER_ENABLED` (1), `VIES_MODE` (live in prod, else simulate) |
| Photos | `STORAGE_DRIVER` (local\|s3), `UPLOAD_DIR`, `MAX_PHOTO_BYTES` (15 MB); S3: `S3_ENDPOINT`, `S3_REGION` (fra1), `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_PUBLIC_URL` |
| Email | `EMAIL_MODE` (console\|smtp), `SMTP_HOST/PORT/SECURE/USER/PASS`, `EMAIL_FROM` |
| Klix | `KLIX_MODE`, `KLIX_BRAND_ID`, `KLIX_SECRET_KEY`, `KLIX_METHODS`, (`KLIX_API_URL`) |
| Inbank | `INBANK_MODE`, `INBANK_API_URL` (demo-api for testing), `INBANK_SHOP_UUID`, `INBANK_API_KEY`, `INBANK_PRODUCT_CODE` |
| Omniva | `OMNIVA_MODE`, `OMNIVA_API_URL` (test-omx for sandbox), `OMNIVA_USERNAME`, `OMNIVA_PASSWORD` |
| DPD | `DPD_MODE`, `DPD_API_URL` (sandbox variant), `DPD_API_TOKEN`, `DPD_SERVICE_ALIAS` (DPD PUDO) |
| Sender identity | `SHIP_SENDER_NAME/PHONE/EMAIL/COUNTRY/POSTCODE/CITY/STREET` |
| Jira | `JIRA_MODE`, `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT` (IZS), `JIRA_WEBHOOK_SECRET` (null = endpoint 404s) |
| Sentry | `SENTRY_DSN` (api, runtime), `SENTRY_DSN_WEB` + `SENTRY_DSN_ADMIN` (build args), `SENTRY_RELEASE`, `SENTRY_ENVIRONMENT` |
| Frontend build-time | `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_ORIGIN_*`, `VITE_SENTRY_DSN` |
| Misc | `BACKUP_BUCKET` (backup.sh), `PW_EXECUTABLE_PATH` (local e2e) |

Production boot **fails** on: missing/short `JWT_SECRET`, missing
`CORS_ORIGINS`, or missing credentials for any provider whose mode is
`live`/`smtp`/`s3`.

## CI (`.github/workflows/`)

- **`ci.yml`** — on every branch push. Job `ci`: Postgres + Redis services →
  `pnpm install` → `build` (must precede typecheck) → `typecheck` →
  `db:migrate` → `test`. Job `e2e`: same services → build → install
  Chromium → `test:e2e` (Playwright boots the stack itself; HTML report
  uploaded on failure). Job `notify`: Slack summary (silent no-op without the
  `SLACK_WEBHOOK_URL` secret); `if: always()` — must **not** be a required
  check.
- **`smoke.yml`** — every 30 min against production once the repo variable
  `SMOKE_DOMAIN` is set: api health, storefront 200, admin 200; Slack on
  failure only.
- **`dependabot.yml`** — weekly Monday 06:00 Riga; npm (grouped
  minor+patch) + GitHub Actions.
- **Branch protection** (recommended in `docs/launch-checklist.md`): protect
  `main`, require checks `ci` and `e2e`.

## Ports & URLs cheat-sheet

| Env | Storefront | Admin | API | WS |
|---|---|---|---|---|
| Dev | localhost:3000 | localhost:5173 | localhost:4000 | :5173/ws (proxied) |
| Prod | izsoli.lv | admin.izsoli.lv (+ wh.) | api.izsoli.lv | wss://api.izsoli.lv/ws (public), wss://admin.izsoli.lv/ws (admin) |
