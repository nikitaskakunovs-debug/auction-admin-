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
import { registerAdRoutes } from "./routes/ads.js";
import { registerCmsRoutes } from "./routes/cms.js";
import { registerCustomerRoutes } from "./routes/customers.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerFinanceRoutes } from "./routes/finance.js";
import { registerGradingRoutes } from "./routes/grading.js";
import { registerItemCommentRoutes } from "./routes/itemComments.js";
import { registerItemRoutes } from "./routes/items.js";
import { registerListingRoutes } from "./routes/listings.js";
import { registerOrderRoutes } from "./routes/orders.js";
import { registerPaymentRoutes } from "./routes/payments.js";
import { registerPickupRoutes } from "./routes/pickup.js";
import { registerFrontDeskRoutes } from "./routes/frontDesk.js";
import { registerReturnRoutes } from "./routes/returns.js";
import { registerPublicRoutes } from "./routes/public.js";
import { registerReceivingRoutes } from "./routes/receiving.js";
import { registerSearchRoutes } from "./routes/search.js";
import { registerStockCountRoutes } from "./routes/stockCounts.js";
import { registerMarketingRoutes } from "./routes/marketing.js";
import { registerMarketingAdminRoutes } from "./routes/marketingAdmin.js";
import { registerFinRoutes } from "./routes/fin.js";
import { registerEmailHookRoutes } from "./routes/emailHooks.js";
import { registerTrackRoutes } from "./routes/track.js";
import { registerMetaRoutes } from "./routes/meta.js";
import { registerCartRoutes } from "./routes/cart.js";
import { registerSellThroughRoutes } from "./routes/sellThrough.js";
import { registerSupplierRoutes } from "./routes/suppliers.js";
import { registerSupplierPortalRoutes } from "./routes/supplierPortal.js";
import { registerViewRoutes } from "./routes/views.js";
import { registerShippingRoutes } from "./routes/shipping.js";
import { registerWarehouseOpsRoutes } from "./routes/warehouseOps.js";
import { registerWarehouseStatsRoutes } from "./routes/warehouseStats.js";
import { registerBadgeRoutes } from "./routes/badges.js";
import { registerBugRoutes } from "./routes/bugs.js";
import { registerWs } from "./ws.js";

export interface BuiltServer {
  app: FastifyInstance;
  perms: PermissionService;
}

export async function buildServer(ctx: AppContext, opts: { logger?: boolean } = {}): Promise<BuiltServer> {
  // trustProxy: behind Caddy the client IP arrives in X-Forwarded-For; without
  // this the rate limiter and login lockout would key every visitor to the
  // proxy's address (one shared bucket for the whole site).
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: ctx.config.trustProxy });

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
    // По умолчанию @fastify/cors пускает из браузера только GET/HEAD/POST —
    // и «Noņemt» в корзине (DELETE) молча умирал на preflight. Разрешаем
    // весь набор, которым пользуется витрина.
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
  });

  // Почтовики (Gmail, Yahoo) жмут кнопку «Отписаться» сами и шлют
  // form-urlencoded — без этого разбора Fastify ответил бы 415, и кнопка
  // в почте перестала бы работать. Тело нам не нужно: токен в адресе.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) =>
    done(null, body),
  );

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
      else if (claims?.kind === "supplier") req.supplier = claims;
    }
  });

  const perms = new PermissionService(ctx.db);

  // W6: purchase cost is private to finance.view. Rather than trusting every
  // route (present and future) that returns item or consignment rows to
  // remember to strip it, one global hook removes cost fields from any JSON
  // payload for everyone else — warehouse staff, bidders, the public site.
  app.addHook("preSerialization", async (req, _reply, payload) => {
    if (payload === null || typeof payload !== "object") return payload;
    if (req.admin && (await perms.has(req.admin.role, "finance.view"))) return payload;
    stripCostDeep(payload);
    return payload;
  });

  app.get("/api/health", async () => ({ ok: true, at: ctx.now().toISOString() }));

  registerAuthRoutes(app, ctx, perms);
  registerDashboardRoutes(app, ctx);
  registerAuctionRoutes(app, ctx, perms);
  registerItemRoutes(app, ctx, perms);
  registerListingRoutes(app, ctx, perms);
  registerOrderRoutes(app, ctx, perms);
  registerCustomerRoutes(app, ctx, perms);
  registerAdRoutes(app, ctx, perms);
  registerFinanceRoutes(app, ctx, perms);
  registerAdminRoutes(app, ctx, perms);
  registerCmsRoutes(app, ctx, perms);
  registerPickupRoutes(app, ctx, perms);
  registerFrontDeskRoutes(app, ctx, perms);
  registerReturnRoutes(app, ctx, perms);
  registerStockCountRoutes(app, ctx, perms);
  registerWarehouseOpsRoutes(app, ctx, perms);
  registerWarehouseStatsRoutes(app, ctx, perms);
  registerBadgeRoutes(app, ctx, perms);
  registerBugRoutes(app, ctx, perms);
  registerGradingRoutes(app, ctx, perms);
  registerItemCommentRoutes(app, ctx, perms);
  registerReceivingRoutes(app, ctx, perms);
  registerSupplierRoutes(app, ctx, perms);
  registerSupplierPortalRoutes(app, ctx);
  registerSellThroughRoutes(app, ctx, perms);
  registerMarketingRoutes(app, ctx, perms);
  registerMarketingAdminRoutes(app, ctx, perms);
  registerFinRoutes(app, ctx, perms);
  registerEmailHookRoutes(app, ctx);
  registerTrackRoutes(app, ctx);
  registerPublicRoutes(app, ctx);
  registerMetaRoutes(app, ctx);
  registerCartRoutes(app, ctx);
  registerPaymentRoutes(app, ctx);
  registerShippingRoutes(app, ctx, perms);
  registerSearchRoutes(app, ctx, perms);
  registerViewRoutes(app, ctx);
  await registerWs(app, ctx);

  return { app, perms };
}

const COST_KEYS = ["costCents", "extraCostCents"] as const;

/** Delete cost fields anywhere in a response payload (in place). Depth-capped:
 * real payloads are shallow (list → row → nested json), cycles impossible. */
function stripCostDeep(node: unknown, depth = 0): void {
  if (depth > 6 || node === null || typeof node !== "object" || node instanceof Date) return;
  if (Array.isArray(node)) {
    for (const el of node) stripCostDeep(el, depth + 1);
    return;
  }
  const obj = node as Record<string, unknown>;
  for (const key of COST_KEYS) if (key in obj) delete obj[key];
  for (const value of Object.values(obj)) stripCostDeep(value, depth + 1);
}
