import { mkdir } from "node:fs/promises";
import path from "node:path";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuthRoutes } from "./auth/routes.js";
import { PermissionService } from "./auth/rbac.js";
import { verifyAccessToken } from "./auth/jwt.js";
import type { AppContext } from "./context.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerAuctionRoutes } from "./routes/auctions.js";
import { registerCmsRoutes } from "./routes/cms.js";
import { registerCustomerRoutes } from "./routes/customers.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerFinanceRoutes } from "./routes/finance.js";
import { registerItemRoutes } from "./routes/items.js";
import { registerListingRoutes } from "./routes/listings.js";
import { registerOrderRoutes } from "./routes/orders.js";
import { registerPickupRoutes } from "./routes/pickup.js";
import { registerPublicRoutes } from "./routes/public.js";
import { registerWs } from "./ws.js";

export interface BuiltServer {
  app: FastifyInstance;
  perms: PermissionService;
}

export async function buildServer(ctx: AppContext, opts: { logger?: boolean } = {}): Promise<BuiltServer> {
  const app = Fastify({ logger: opts.logger ?? false });

  // Parse the httpOnly refresh cookie.
  await app.register(cookie);

  // Security headers (clickjacking, MIME-sniffing, referrer leakage, HSTS).
  // CSP is disabled here — this process serves JSON, and the admin SPA / Next
  // storefront set their own content-security policies on the HTML they serve.
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
    hsts: { maxAge: 15_552_000, includeSubDomains: true },
  });

  // CORS locked to the configured admin + storefront origins (never a wildcard
  // with credentials). Same-origin/server-side calls send no Origin and pass.
  const allowed = new Set(ctx.config.corsOrigins);
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || allowed.has(origin)),
    credentials: true,
  });

  // Global rate limit (per-IP), Redis-backed so it holds across instances.
  // Auth endpoints add their own stricter caps via per-route config.
  await app.register(rateLimit, {
    global: true,
    max: ctx.config.rateLimitMax,
    timeWindow: "1 minute",
    redis: ctx.redis,
    // Health checks and the WebSocket upgrade must not be throttled.
    allowList: (req) => req.url === "/api/health",
  });

  // Photo uploads (multipart). Per-file ceiling from config; a request may
  // carry several photos at once from the grading station.
  await app.register(multipart, {
    limits: { fileSize: ctx.config.maxPhotoBytes, files: 10, fields: 5 },
  });

  // Local storage driver: the API itself serves the processed photos.
  // Keys are uuid-unique so far-future caching is safe.
  if (ctx.config.storageDriver === "local") {
    const uploadRoot = path.resolve(ctx.config.uploadDir);
    await mkdir(uploadRoot, { recursive: true });
    await app.register(fastifyStatic, {
      root: uploadRoot,
      prefix: "/uploads/",
      decorateReply: false,
      index: false,
      maxAge: "365d",
      immutable: true,
    });
  }

  // Bearer-token parsing; enforcement is per-route via requirePermission.
  // Admin and bidder tokens are strictly separated by the `kind` claim.
  app.addHook("onRequest", async (req) => {
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) {
      const claims = verifyAccessToken(header.slice(7), ctx.config.jwtSecret, ctx.now().getTime());
      if (claims?.kind === "admin") req.admin = claims;
      else if (claims?.kind === "bidder") req.bidder = claims;
    }
  });

  const perms = new PermissionService(ctx.db);

  app.get("/api/health", async () => ({ ok: true, at: ctx.now().toISOString() }));

  registerAuthRoutes(app, ctx, perms);
  registerDashboardRoutes(app, ctx);
  registerAuctionRoutes(app, ctx, perms);
  registerItemRoutes(app, ctx, perms);
  registerListingRoutes(app, ctx, perms);
  registerOrderRoutes(app, ctx, perms);
  registerCustomerRoutes(app, ctx, perms);
  registerFinanceRoutes(app, ctx, perms);
  registerAdminRoutes(app, ctx, perms);
  registerCmsRoutes(app, ctx, perms);
  registerPickupRoutes(app, ctx, perms);
  registerPublicRoutes(app, ctx);
  await registerWs(app, ctx);

  return { app, perms };
}
