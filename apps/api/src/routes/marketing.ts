import { customers, orders } from "@auction/db";
import { and, gte, lte, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { requirePermission, type PermissionService } from "../auth/rbac.js";

/**
 * Отдача рекламы: регистрации, заказы и выручка по кампаниям.
 *
 * Источник — атрибуция первого касания (utm-метки и реферер), записанная на
 * клиенте при регистрации и снятая снимком на каждый заказ. Здесь только
 * группировка: никакого обращения к рекламным кабинетам, цифры — из своей
 * базы, поэтому им можно верить при сверке с Meta/Google, а не наоборот.
 */
export function registerMarketingRoutes(app: FastifyInstance, ctx: AppContext, perms: PermissionService): void {
  const guard = (p: Parameters<typeof requirePermission>[1]) => ({ preHandler: requirePermission(perms, p) });

  app.get("/api/reports/marketing", guard("reports.view"), async (req, reply) => {
    const q = z
      .object({ from: z.string().optional(), to: z.string().optional() })
      .safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    const from = q.data.from ? new Date(`${q.data.from}T00:00:00Z`) : new Date(ctx.now().getTime() - 30 * 86_400_000);
    const to = q.data.to ? new Date(`${q.data.to}T23:59:59Z`) : ctx.now();

    // Ключ группировки одинаковый у клиентов и заказов: source|medium|campaign.
    const cSrc = sql<string>`coalesce(${customers.attribution}->>'source','')`;
    const cMed = sql<string>`coalesce(${customers.attribution}->>'medium','')`;
    const cCam = sql<string>`coalesce(${customers.attribution}->>'campaign','')`;
    const cRef = sql<string>`coalesce(${customers.attribution}->>'referrer','')`;
    const regs = await ctx.db
      .select({
        source: cSrc, medium: cMed, campaign: cCam,
        referrer: sql<string>`min(${cRef})`,
        registrations: sql<string>`count(*)`,
      })
      .from(customers)
      .where(and(gte(customers.createdAt, from), lte(customers.createdAt, to)))
      .groupBy(cSrc, cMed, cCam);

    const oSrc = sql<string>`coalesce(${orders.attribution}->>'source','')`;
    const oMed = sql<string>`coalesce(${orders.attribution}->>'medium','')`;
    const oCam = sql<string>`coalesce(${orders.attribution}->>'campaign','')`;
    const oRef = sql<string>`coalesce(${orders.attribution}->>'referrer','')`;
    const sold = await ctx.db
      .select({
        source: oSrc, medium: oMed, campaign: oCam,
        referrer: sql<string>`min(${oRef})`,
        orders: sql<string>`count(*)`,
        paidOrders: sql<string>`count(*) filter (where ${orders.status} = 'paid')`,
        revenueCents: sql<string>`coalesce(sum(${orders.totalCents}) filter (where ${orders.status} = 'paid'), 0)`,
      })
      .from(orders)
      .where(and(gte(orders.createdAt, from), lte(orders.createdAt, to)))
      .groupBy(oSrc, oMed, oCam);

    interface Row {
      source: string; medium: string; campaign: string; referrer: string;
      registrations: number; orders: number; paidOrders: number; revenueCents: number;
    }
    const byKey = new Map<string, Row>();
    const slot = (source: string, medium: string, campaign: string, referrer: string): Row => {
      const key = `${source}|${medium}|${campaign}`;
      let row = byKey.get(key);
      if (!row) {
        row = { source, medium, campaign, referrer, registrations: 0, orders: 0, paidOrders: 0, revenueCents: 0 };
        byKey.set(key, row);
      }
      if (!row.referrer && referrer) row.referrer = referrer;
      return row;
    };
    for (const r of regs) slot(r.source, r.medium, r.campaign, r.referrer).registrations += Number(r.registrations);
    for (const s of sold) {
      const row = slot(s.source, s.medium, s.campaign, s.referrer);
      row.orders += Number(s.orders);
      row.paidOrders += Number(s.paidOrders);
      row.revenueCents += Number(s.revenueCents);
    }

    const rows = [...byKey.values()].sort((a, b) => b.revenueCents - a.revenueCents || b.registrations - a.registrations);
    const totals = rows.reduce(
      (acc, r) => ({
        registrations: acc.registrations + r.registrations,
        orders: acc.orders + r.orders,
        paidOrders: acc.paidOrders + r.paidOrders,
        revenueCents: acc.revenueCents + r.revenueCents,
      }),
      { registrations: 0, orders: 0, paidOrders: 0, revenueCents: 0 },
    );
    return { from: from.toISOString(), to: to.toISOString(), rows, totals };
  });
}
