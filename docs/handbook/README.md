# Izsoli.lv — Developer Handbook

Complete technical documentation for the Baltic auction platform (izsoli.lv):
a single-seller auction house for Latvia / Estonia / Lithuania with a custom
auction engine, a permissioned admin panel, a public storefront, a warehouse
ERP with a phone PWA, and integrations for payments, shipping, email,
monitoring and IT ticketing.

**Audience:** developers joining the project. Read this folder top to bottom
and you should be able to run the stack locally, find any subsystem in the
code, and deploy to production.

## Contents

| Chapter | Covers |
|---|---|
| [01 — Architecture](./01-architecture.md) | System overview, monorepo layout, data flow, tech stack, design principles |
| [02 — Domain & database](./02-domain-and-database.md) | Pure business logic (`packages/domain`), full Drizzle schema (39 tables), migrations, seed |
| [03 — API](./03-api.md) | Fastify server: every route, auth (JWT + 2FA), RBAC, auction engine, scheduler, WebSockets, config, tests |
| [04 — Frontends](./04-frontends.md) | Admin SPA (screens, shell, warehouse PWA, TV boards), Next.js storefront (i18n, SEO, live bidding), Playwright E2E |
| [05 — Deploy & operations](./05-deploy-operations.md) | Production Docker stack, Caddy, env reference, CI, backups, update procedure |
| [06 — Integrations](./06-integrations.md) | Jira, Klix, Inbank, Omniva/DPD, SMTP, Sentry, VIES — setup and flow for each |
| [07 — Security](./07-security.md) | Threat model: passwords, 2FA, sessions, RBAC, transport, audit |
| [08 — Screen tour](./08-screens.md) | Annotated screenshots of every screen (admin, storefront, warehouse, kiosk, TV board) |

## Quickstart (local development)

```bash
docker compose up -d          # Postgres 16 + Redis 7
pnpm install
pnpm build                    # builds domain + db first (required before typecheck)
pnpm db:migrate
pnpm db:seed                  # markets, roles, demo admins, demo lots + live auctions

pnpm dev:api                  # Fastify on :4000 (scheduler on)
pnpm dev:admin                # Vite on :5173 (proxies /api and /ws to :4000)
pnpm --filter @auction/web dev  # Next.js storefront on :3000
```

Sign in at http://localhost:5173 — one demo user per role, password `Admin123!`:
`super@auction.test` · `listings@` · `sales@` · `ops@` · `content@` · `support@`
· `finance@` (all `@auction.test`). All demo admins are pre-enrolled in TOTP
2FA with the fixed dev secret `JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP`
(`SEED_ADMIN_TOTP_SECRET` in `packages/db`) — add it to any authenticator app,
or compute a code programmatically:

```js
import { totp, base32Decode } from "@auction/domain";
totp(base32Decode("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"), Math.floor(Date.now() / 1000));
```

> Note the `base32Decode` — the API decodes the secret before verifying, so
> passing the raw base32 string to `totp()` produces a wrong code.

## Tests

```bash
pnpm test:unit          # packages/domain — pure logic (94 tests)
pnpm test:integration   # apps/api — 241 tests vs real Postgres/Redis
pnpm test:e2e           # apps/e2e — Playwright drives the built API + storefront
pnpm typecheck && pnpm build
```

## Production at a glance

- One DigitalOcean droplet (FRA1), five Docker containers (`postgres`, `redis`,
  `api`, `web`, `caddy`), code at `/opt/auction`, config at
  `/opt/auction/deploy/.env`.
- Domains: `izsoli.lv` (storefront) · `api.izsoli.lv` (REST + WS) ·
  `admin.izsoli.lv` (admin SPA) · `wh.izsoli.lv` (same SPA locked to
  warehouse mode).
- Update: `cd /opt/auction && git pull && cd deploy && docker compose -f
  docker-compose.prod.yml up -d --build && docker compose -f
  docker-compose.prod.yml exec api node packages/db/dist/migrate.js`
- Nightly Postgres dumps to DO Spaces (`deploy/backup.sh`, 14-day retention).

Full detail in [chapter 05](./05-deploy-operations.md).
