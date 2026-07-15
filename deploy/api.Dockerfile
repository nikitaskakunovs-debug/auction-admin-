# Auction API — build from the monorepo root:
#   docker build -f deploy/api.Dockerfile .
FROM node:22-alpine AS build
ENV CI=true
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @auction/domain build \
 && pnpm --filter @auction/db build \
 && pnpm --filter @auction/api build
# Drop dev dependencies for the runtime image.
RUN pnpm install --prod --frozen-lockfile

FROM node:22-alpine
WORKDIR /repo
COPY --from=build /repo .
ENV NODE_ENV=production
EXPOSE 4000
# Migrations/seed run explicitly (see docs/deploy.md):
#   node packages/db/dist/migrate.js
#   node packages/db/dist/seed.js
CMD ["node", "apps/api/dist/index.js"]
