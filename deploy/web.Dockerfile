# Storefront (Next.js) — build from the monorepo root.
# NEXT_PUBLIC_* values are inlined at BUILD time — pass them as build args.
FROM node:22-alpine AS build
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_ORIGIN_LV
ARG NEXT_PUBLIC_ORIGIN_EE
ARG NEXT_PUBLIC_ORIGIN_LT
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_PUBLIC_ORIGIN_LV=$NEXT_PUBLIC_ORIGIN_LV \
    NEXT_PUBLIC_ORIGIN_EE=$NEXT_PUBLIC_ORIGIN_EE \
    NEXT_PUBLIC_ORIGIN_LT=$NEXT_PUBLIC_ORIGIN_LT
ENV CI=true
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @auction/web build
RUN pnpm prune --prod

FROM node:22-alpine
RUN corepack enable
WORKDIR /repo
COPY --from=build /repo .
ENV NODE_ENV=production
EXPOSE 3000
CMD ["pnpm", "--filter", "@auction/web", "start"]
