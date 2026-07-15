# Caddy (TLS terminator) with the built admin SPA baked in.
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @auction/domain build && pnpm --filter @auction/admin build

FROM caddy:2
COPY --from=build /repo/apps/admin/dist /srv/admin
COPY deploy/Caddyfile /etc/caddy/Caddyfile
