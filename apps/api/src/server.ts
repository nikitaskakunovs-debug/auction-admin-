import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuthRoutes } from "./auth/routes.js";
import { PermissionService } from "./auth/rbac.js";
import { verifyAccessToken } from "./auth/jwt.js";
import type { AppContext } from "./context.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerAuctionRoutes } from "./routes/auctions.js";
import { registerCustomerRoutes } from "./routes/customers.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerFinanceRoutes } from "./routes/finance.js";
import { registerItemRoutes } from "./routes/items.js";
import { registerListingRoutes } from "./routes/listings.js";
import { registerOrderRoutes } from "./routes/orders.js";
import { registerWs } from "./ws.js";

export interface BuiltServer {
  app: FastifyInstance;
  perms: PermissionService;
}

export async function buildServer(ctx: AppContext, opts: { logger?: boolean } = {}): Promise<BuiltServer> {
  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(cors, { origin: true });

  // Bearer-token parsing; enforcement is per-route via requirePermission.
  app.addHook("onRequest", async (req) => {
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) {
      const claims = verifyAccessToken(header.slice(7), ctx.config.jwtSecret, ctx.now().getTime());
      if (claims) req.admin = claims;
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
  await registerWs(app, ctx);

  return { app, perms };
}
