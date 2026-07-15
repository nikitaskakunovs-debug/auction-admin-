import { auctions, bids, items, orders } from "@auction/db";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";

/** Dashboard KPIs — available to every authenticated admin (Shhh pattern:
 * the dashboard is force-included for all roles). */
export function registerDashboardRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/dashboard", async (req, reply) => {
    if (!req.admin) return reply.code(401).send({ error: "unauthenticated" });
    const now = ctx.now();
    const soon = new Date(now.getTime() + 2 * 3_600_000);
    const monthAgo = new Date(now.getTime() - 30 * 86_400_000);

    const [liveCount] = await ctx.db
      .select({ n: sql<string>`count(*)` })
      .from(auctions)
      .where(eq(auctions.status, "live"));
    const [endingSoon] = await ctx.db
      .select({ n: sql<string>`count(*)` })
      .from(auctions)
      .where(and(eq(auctions.status, "live"), lte(auctions.endsAt, soon)));
    const [scheduled] = await ctx.db
      .select({ n: sql<string>`count(*)` })
      .from(auctions)
      .where(eq(auctions.status, "scheduled"));
    const [unpaid] = await ctx.db
      .select({ n: sql<string>`count(*)`, total: sql<string>`coalesce(sum(${orders.totalCents}), 0)` })
      .from(orders)
      .where(eq(orders.status, "awaiting_payment"));
    const [gmv] = await ctx.db
      .select({ n: sql<string>`count(*)`, total: sql<string>`coalesce(sum(${orders.totalCents}), 0)` })
      .from(orders)
      .where(and(gte(orders.createdAt, monthAgo), eq(orders.status, "paid")));
    const [bids24h] = await ctx.db
      .select({ n: sql<string>`count(*)` })
      .from(bids)
      .where(gte(bids.createdAt, new Date(now.getTime() - 86_400_000)));
    const itemsByStatus = await ctx.db
      .select({ status: items.status, n: sql<string>`count(*)` })
      .from(items)
      .groupBy(items.status);

    return {
      liveAuctions: Number(liveCount!.n),
      endingSoon: Number(endingSoon!.n),
      scheduledAuctions: Number(scheduled!.n),
      unpaidOrders: { count: Number(unpaid!.n), totalCents: Number(unpaid!.total) },
      gmv30d: { count: Number(gmv!.n), totalCents: Number(gmv!.total) },
      bids24h: Number(bids24h!.n),
      itemsByStatus: Object.fromEntries(itemsByStatus.map((r) => [r.status, Number(r.n)])),
    };
  });
}
