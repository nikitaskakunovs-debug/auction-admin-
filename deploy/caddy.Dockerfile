# Caddy (TLS terminator) with the built admin SPA baked in.
FROM node:22-alpine AS build
# Sentry DSN is inlined into the admin bundle at build time (empty = off).
ARG VITE_SENTRY_DSN
ENV VITE_SENTRY_DSN=$VITE_SENTRY_DSN
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @auction/domain build && pnpm --filter @auction/admin build

FROM caddy:2
COPY --from=build /repo/apps/admin/dist /srv/admin
COPY deploy/Caddyfile /etc/caddy/Caddyfile
