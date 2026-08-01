import { auctions, items, listings, orders, stockMovements } from "@auction/db";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { requirePermission, type PermissionService } from "../auth/rbac.js";

/**
 * R3 — what sells, and what sits.
 *
 * The panel could already say how much was earned; it could not say which
 * categories earn it, or which ones tie up a shelf for four months. Every
 * figure here is defined against data that already exists, and the response
 * says which basis it used, because a sell-through percentage means nothing
 * without knowing what was counted.
 *
 * Definitions, once:
 *   shelf date   the intake movement, else the item row's creation — when the
 *                lot physically became ours
 *   offered      the first time a lot went on sale: the earliest auction start
 *                across its listings, or a fixed-price listing's creation
 *   sold         an order paid, and still a sale (refunded and cancelled
 *                orders are excluded, exactly as the profit report does)
 *   days to sell shelf date → paid. Not auction start: the shelf is what costs
 *                money, and the wait before listing is part of the cost.
 */

/** Orders that still represent a sale. */
const SOLD_ORDER_STATUSES = ["paid"];

/** Item statuses that mean "still ours, still on a shelf". */
const IN_STOCK = ["draft", "listed", "live", "unsold", "returned", "unpaid_cancelled", "no_pickup_cancelled"];

const DAY_MS = 86_400_000;

export function registerSellThroughRoutes(app: FastifyInstance, ctx: AppContext, perms: PermissionService): void {
  const guard = (p: Parameters<typeof requirePermission>[1]) => ({ preHandler: requirePermission(perms, p) });

  /** The shelf date per item, as SQL — intake movement first, row age second. */
  const shelfDateSql = sql`coalesce((
    select min(m.created_at) from stock_movements m
    where m.item_id = items.id and m.type = 'intake'
  ), items.created_at)`;

  /** The first time this item was put on sale, across all of its listings. */
  const firstOfferSql = sql`(
    select min(x.at) from (
      select a.starts_at as at from auctions a
        join listings l on l.id = a.listing_id
        where l.item_id = items.id and a.status <> 'cancelled'
      union all
      select l.created_at as at from listings l
        where l.item_id = items.id and l.type = 'fixed'
    ) x
  )`;

  app.get("/api/reports/sell-through", guard("reports.view"), async (req, reply) => {
    const q = z.object({ from: z.coerce.date(), to: z.coerce.date() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_range", detail: "from and to (ISO dates) required" });
    const { from, to } = q.data;
    const finance = req.admin ? await perms.has(req.admin.role, "finance.view") : false;
    const now = ctx.now();

    // ── Sold in the window, by category ──────────────────────────────────────
    const soldRows = await ctx.db
      .select({
        category: items.category,
        sold: sql<string>`count(*)`,
        revenueCents: sql<string>`coalesce(sum(${orders.hammerCents}), 0)`,
        avgDays: sql<string>`coalesce(avg(extract(epoch from (${orders.paidAt} - ${shelfDateSql})) / 86400.0), 0)`,
        // Profit only where a purchase cost was recorded; a blank cost is
        // unknown and is reported as a count, never summed as zero.
        profitCents: sql<string>`coalesce(sum(${orders.hammerCents} - ${items.costCents}) filter (where ${items.costCents} is not null), 0)`,
        noCostData: sql<string>`count(*) filter (where ${items.costCents} is null)`,
      })
      .from(orders)
      .innerJoin(items, eq(orders.itemId, items.id))
      .where(and(inArray(orders.status, SOLD_ORDER_STATUSES), gte(orders.paidAt, from), lt(orders.paidAt, to)))
      .groupBy(items.category);

    // ── Offered in the window, by category ───────────────────────────────────
    // "Of what we put on sale then, how much has sold since." Lots offered
    // near the end of the window have had less time to sell — the response
    // carries the window so the screen can say so.
    const offeredRows = await ctx.db
      .select({
        category: items.category,
        offered: sql<string>`count(*)`,
        sinceSold: sql<string>`count(*) filter (where exists (
          select 1 from orders o where o.item_id = items.id and o.status = 'paid'
        ))`,
      })
      .from(items)
      .where(and(sql`${firstOfferSql} >= ${from}`, sql`${firstOfferSql} < ${to}`))
      .groupBy(items.category);

    const offeredBy = new Map(offeredRows.map((r) => [r.category, r]));
    const categories = new Set([...soldRows.map((r) => r.category), ...offeredRows.map((r) => r.category)]);

    const byCategory = [...categories]
      .map((category) => {
        const s = soldRows.find((r) => r.category === category);
        const o = offeredBy.get(category);
        const offered = Number(o?.offered ?? 0);
        const sinceSold = Number(o?.sinceSold ?? 0);
        const soldCount = Number(s?.sold ?? 0);
        const base = {
          category,
          offered,
          soldFromOffered: sinceSold,
          sellThroughPct: offered > 0 ? Math.round((sinceSold / offered) * 100) : null,
          soldInPeriod: soldCount,
          revenueCents: Number(s?.revenueCents ?? 0),
          avgDaysToSell: soldCount > 0 ? Math.round(Number(s?.avgDays ?? 0)) : null,
          avgPriceCents: soldCount > 0 ? Math.round(Number(s?.revenueCents ?? 0) / soldCount) : null,
        };
        // Money is finance's: the fields are absent, not null, for everyone
        // else — the global strip hook only knows the cost-named keys.
        if (!finance) return base;
        const noCostData = Number(s?.noCostData ?? 0);
        const priced = soldCount - noCostData;
        return {
          ...base,
          // Null, not zero, when nothing in this category had a purchase price:
          // "€0.00 profit" and "we never recorded what it cost" are different
          // statements and only one of them is true.
          profitCents: priced > 0 ? Number(s?.profitCents ?? 0) : null,
          noCostData,
        };
      })
      .sort((a, b) => b.soldInPeriod - a.soldInPeriod || b.offered - a.offered);

    // ── How auction runs ended in the window ─────────────────────────────────
    // Cancelled runs are an admin action, not a market signal, and would drag
    // the rate down if counted.
    const outcomeRows = await ctx.db
      .select({ status: auctions.status, n: sql<string>`count(*)` })
      .from(auctions)
      .where(and(sql`${auctions.closedAt} is not null`, gte(auctions.closedAt, from), lt(auctions.closedAt, to)))
      .groupBy(auctions.status);
    const outcomeOf = (s: string) => Number(outcomeRows.find((r) => r.status === s)?.n ?? 0);
    const endedWon = outcomeOf("ended_won");
    const endedNoBids = outcomeOf("ended_no_bids");
    const endedNoReserve = outcomeOf("ended_reserve_not_met");
    const cancelled = outcomeOf("cancelled");

    // ── What is sitting on the shelves right now ─────────────────────────────
    const agingRows = await ctx.db
      .select({
        category: items.category,
        units: sql<string>`count(*)`,
        d0_30: sql<string>`count(*) filter (where ${shelfDateSql} > ${new Date(now.getTime() - 30 * DAY_MS)})`,
        d31_60: sql<string>`count(*) filter (where ${shelfDateSql} <= ${new Date(now.getTime() - 30 * DAY_MS)} and ${shelfDateSql} > ${new Date(now.getTime() - 60 * DAY_MS)})`,
        d61_90: sql<string>`count(*) filter (where ${shelfDateSql} <= ${new Date(now.getTime() - 60 * DAY_MS)} and ${shelfDateSql} > ${new Date(now.getTime() - 90 * DAY_MS)})`,
        d90plus: sql<string>`count(*) filter (where ${shelfDateSql} <= ${new Date(now.getTime() - 90 * DAY_MS)})`,
      })
      .from(items)
      .where(inArray(items.status, IN_STOCK))
      .groupBy(items.category);

    const sittingRows = await ctx.db
      .select({
        id: items.id,
        sku: items.sku,
        title: items.title,
        category: items.category,
        status: items.status,
        shelfDate: sql<Date>`${shelfDateSql}`,
        // Each auction run is its own row, so re-listing is countable; a
        // fixed-price offer counts as one.
        timesListed: sql<string>`(
          select count(*) from auctions a join listings l on l.id = a.listing_id
            where l.item_id = items.id and a.status <> 'cancelled'
        ) + (
          select count(*) from listings l where l.item_id = items.id and l.type = 'fixed'
        )`,
      })
      .from(items)
      .where(inArray(items.status, IN_STOCK))
      .orderBy(sql`${shelfDateSql} asc`)
      .limit(20);

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      asOf: now.toISOString(),
      basis: {
        // Said out loud, because a percentage without its definition is a
        // number people argue about.
        sellThrough: "items first offered in the period, and how many have sold since",
        daysToSell: "from the shelf date to the day the order was paid",
        excluded: "refunded and cancelled orders; cancelled auction runs",
      },
      totals: {
        soldInPeriod: byCategory.reduce((n, c) => n + c.soldInPeriod, 0),
        offered: byCategory.reduce((n, c) => n + c.offered, 0),
        soldFromOffered: byCategory.reduce((n, c) => n + c.soldFromOffered, 0),
        revenueCents: byCategory.reduce((n, c) => n + c.revenueCents, 0),
      },
      byCategory,
      auctionOutcomes: {
        ended: endedWon + endedNoBids + endedNoReserve,
        won: endedWon,
        noBids: endedNoBids,
        reserveNotMet: endedNoReserve,
        cancelledExcluded: cancelled,
      },
      aging: agingRows.map((r) => ({
        category: r.category,
        units: Number(r.units),
        d0_30: Number(r.d0_30),
        d31_60: Number(r.d31_60),
        d61_90: Number(r.d61_90),
        d90plus: Number(r.d90plus),
      })),
      sittingLongest: sittingRows.map((r) => ({
        id: r.id,
        sku: r.sku,
        title: r.title,
        category: r.category,
        status: r.status,
        daysOnShelf: Math.floor((now.getTime() - new Date(r.shelfDate).getTime()) / DAY_MS),
        timesListed: Number(r.timesListed),
      })),
    };
  });
}
