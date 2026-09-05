import { customers, orders } from "@auction/db";
import { and, desc, gte, lte, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { requirePermission, type PermissionService } from "../auth/rbac.js";

/**
 * Отдача рекламы: регистрации, заказы и выручка по кампаниям.
 *
 * Источник — метки, записанные на витрине и снятые снимком на каждый заказ.
 * Никакого обращения к рекламным кабинетам: цифры из своей базы, поэтому им
 * можно верить при сверке с Meta/Google, а не наоборот.
 *
 * Моделей атрибуции две, и обе нужны.
 *   first — кто человека ПРИВЁЛ. По ней считается цена привлечения.
 *   last  — что привело его к ЭТОЙ покупке. Только по ней видно отдачу
 *           письма и ретаргетинга: в модели первого касания их заслуга
 *           целиком достаётся тому каналу, что когда-то привёл человека.
 * Обе живут рядом, потому что вопрос «куда добавить денег» и вопрос
 * «что сработало на этой неделе» — разные вопросы к одним и тем же данным.
 */
export function registerMarketingRoutes(app: FastifyInstance, ctx: AppContext, perms: PermissionService): void {
  const guard = (p: Parameters<typeof requirePermission>[1]) => ({ preHandler: requirePermission(perms, p) });

  const range = (from?: string, to?: string) => ({
    from: from ? new Date(`${from}T00:00:00Z`) : new Date(ctx.now().getTime() - 30 * 86_400_000),
    to: to ? new Date(`${to}T23:59:59Z`) : ctx.now(),
  });

  app.get("/api/reports/marketing", guard("reports.view"), async (req, reply) => {
    const q = z
      .object({
        from: z.string().optional(),
        to: z.string().optional(),
        model: z.enum(["first", "last"]).default("first"),
      })
      .safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    const { from, to } = range(q.data.from, q.data.to);

    // Регистрации всегда по первому касанию: «привёл» — это по определению
    // первое касание, у регистрации второго ещё и не было.
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

    // Заказы — по выбранной модели. Старые заказы без снимка последнего
    // касания честно откатываются на первое, а не выпадают из отчёта.
    const oCol = q.data.model === "first"
      ? sql`${orders.attribution}`
      : sql`coalesce(${orders.attributionLast}, ${orders.attribution})`;
    const oSrc = sql<string>`coalesce(${oCol}->>'source','')`;
    const oMed = sql<string>`coalesce(${oCol}->>'medium','')`;
    const oCam = sql<string>`coalesce(${oCol}->>'campaign','')`;
    const oRef = sql<string>`coalesce(${oCol}->>'referrer','')`;
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
    return { from: from.toISOString(), to: to.toISOString(), model: q.data.model, rows, totals };
  });

  /**
   * Расшифровка одной строки отчёта: кто именно зарегистрировался и какие
   * заказы пришли. Без неё цифра «2 заказа» остаётся цифрой — а вопрос всегда
   * один и тот же: какие это заказы и что за люди.
   */
  app.get("/api/reports/marketing/detail", guard("reports.view"), async (req, reply) => {
    const q = z
      .object({
        from: z.string().optional(),
        to: z.string().optional(),
        model: z.enum(["first", "last"]).default("first"),
        // Пустая строка — «без меток»: самая крупная строка отчёта, в неё
        // тоже нужно уметь провалиться.
        source: z.string().max(120).default(""),
        medium: z.string().max(120).default(""),
        campaign: z.string().max(120).default(""),
      })
      .safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    const { from, to } = range(q.data.from, q.data.to);
    const { source, medium, campaign } = q.data;

    const matches = (col: ReturnType<typeof sql>) =>
      and(
        sql`coalesce(${col}->>'source','') = ${source}`,
        sql`coalesce(${col}->>'medium','') = ${medium}`,
        sql`coalesce(${col}->>'campaign','') = ${campaign}`,
      );

    const regRows = await ctx.db
      .select({
        id: customers.id,
        alias: customers.alias,
        email: customers.email,
        country: customers.country,
        createdAt: customers.createdAt,
        marketingOptIn: customers.marketingOptIn,
        landing: sql<string>`coalesce(${customers.attribution}->>'landing','')`,
        referrer: sql<string>`coalesce(${customers.attribution}->>'referrer','')`,
      })
      .from(customers)
      .where(and(gte(customers.createdAt, from), lte(customers.createdAt, to), matches(sql`${customers.attribution}`)))
      .orderBy(desc(customers.createdAt))
      .limit(200);

    const oCol = q.data.model === "first"
      ? sql`${orders.attribution}`
      : sql`coalesce(${orders.attributionLast}, ${orders.attribution})`;
    const orderRows = await ctx.db
      .select({
        id: orders.id,
        ref: orders.ref,
        customerId: orders.customerId,
        customerAlias: orders.customerAlias,
        status: orders.status,
        totalCents: orders.totalCents,
        createdAt: orders.createdAt,
        landing: sql<string>`coalesce(${oCol}->>'landing','')`,
      })
      .from(orders)
      .where(and(gte(orders.createdAt, from), lte(orders.createdAt, to), matches(oCol)))
      .orderBy(desc(orders.createdAt))
      .limit(200);

    return {
      key: { source, medium, campaign },
      model: q.data.model,
      registrations: regRows,
      orders: orderRows,
      revenueCents: orderRows.filter((o) => o.status === "paid").reduce((s, o) => s + o.totalCents, 0),
    };
  });
}
