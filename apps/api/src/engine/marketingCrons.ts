import { auctions, customers, items, listings, savedSearches, watchlist } from "@auction/db";
import { and, asc, eq, gt, ilike, inArray, isNull, lte, sql } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { enqueueMarketing } from "./marketing.js";

/**
 * Два письма, которые человек попросил сам.
 *
 * LC-02, крон сохранённых поисков: галочка «сообщать о новых лотах» у поиска —
 * и раз в проход мы ищем лоты, появившиеся после прошлой проверки. Второй крон
 * смотрит вэлмес: торги, за которыми человек следит, подходят к концу.
 *
 * Оба идут через enqueueMarketing с explicit — стоп-сигналы (отписка, возврат
 * почты, блокировка) уважаются всегда, но общее согласие на рассылку для
 * запрошенного письма не требуется, и лимит частоты его не откладывает.
 */

/** Сколько лотов помещается в письмо; остальное — числом «и ещё N». */
const LOTS_PER_EMAIL = 5;
/** «Скоро закроется» — за столько часов до конца торгов. */
const ENDING_WINDOW_HOURS = 24;

/** Живые торги, подходящие под снимок фильтров сохранённого поиска. */
function searchConditions(query: {
  q?: string | undefined;
  category?: string | undefined;
  market?: string | undefined;
  priceMinCents?: number | undefined;
  priceMaxCents?: number | undefined;
  condition?: string | undefined;
  noReserve?: boolean | undefined;
}) {
  const conds = [inArray(auctions.status, ["live", "scheduled"]), eq(listings.status, "published")];
  if (query.q && query.q.trim().length >= 2) conds.push(ilike(listings.title, `%${query.q.trim()}%`));
  if (query.category) conds.push(eq(items.category, query.category));
  if (query.market) conds.push(eq(listings.marketCode, query.market.toUpperCase()));
  const price = sql`coalesce(${auctions.currentPriceCents}, ${listings.startPriceCents})`;
  if (query.priceMinCents !== undefined) conds.push(sql`${price} >= ${query.priceMinCents}`);
  if (query.priceMaxCents !== undefined) conds.push(sql`${price} <= ${query.priceMaxCents}`);
  if (query.condition) conds.push(eq(items.condition, query.condition));
  if (query.noReserve) conds.push(isNull(listings.reserveCents));
  return conds;
}

/** Крон LC-02: новые лоты под сохранённые поиски с включённой рассылкой. */
export async function runSavedSearchAlerts(ctx: AppContext): Promise<number> {
  const now = ctx.now();
  const searches = await ctx.db
    .select({
      id: savedSearches.id,
      customerId: savedSearches.customerId,
      name: savedSearches.name,
      query: savedSearches.query,
      lastRunAt: savedSearches.lastRunAt,
    })
    .from(savedSearches)
    .where(eq(savedSearches.alertEmail, true));

  let queued = 0;
  for (const s of searches) {
    // Первый проход письма не шлёт: без отметки времени «новыми» оказался бы
    // весь каталог. Ставим отметку — считать начнём со следующего прохода.
    if (s.lastRunAt === null) {
      await ctx.db.update(savedSearches).set({ lastRunAt: now }).where(eq(savedSearches.id, s.id));
      continue;
    }

    const rows = await ctx.db
      .select({
        title: listings.title,
        priceCents: sql<number>`coalesce(${auctions.currentPriceCents}, ${listings.startPriceCents})`,
        endsAt: auctions.endsAt,
      })
      .from(auctions)
      .innerJoin(listings, eq(auctions.listingId, listings.id))
      .innerJoin(items, eq(listings.itemId, items.id))
      .where(and(...searchConditions(s.query), gt(auctions.createdAt, s.lastRunAt)))
      .orderBy(asc(auctions.endsAt))
      .limit(50);
    if (rows.length === 0) {
      await ctx.db.update(savedSearches).set({ lastRunAt: now }).where(eq(savedSearches.id, s.id));
      continue;
    }

    const result = await enqueueMarketing(ctx, ctx.db, {
      customerId: s.customerId,
      type: "saved_search_hits",
      template: {
        alias: "",
        lotTitle: "",
        searchName: s.name,
        totalCount: rows.length,
        lots: rows.slice(0, LOTS_PER_EMAIL).map((r) => ({ title: r.title, priceCents: Number(r.priceCents), endsAt: r.endsAt })),
      },
      // Не чаще одного письма в сутки на один поиск, сколько бы лотов ни пришло.
      dedupeKey: `saved_search:${s.id}:${now.toISOString().slice(0, 10)}`,
      explicit: true,
    });
    // Отметка двигается только когда лоты доехали до очереди (или письмо за
    // сегодня уже стоит): при временном отказе лоты копятся до следующего
    // прохода, а не пропадают.
    if (result.ok || result.skip === "duplicate" || result.skip === "unsubscribed"
      || result.skip === "bounced" || result.skip === "blocked" || result.skip === "erased"
      || result.skip === "service_address") {
      await ctx.db.update(savedSearches).set({ lastRunAt: now }).where(eq(savedSearches.id, s.id));
    }
    if (result.ok) queued += 1;
  }
  return queued;
}

/** Крон вэлмес: следимые торги, до конца которых меньше суток. */
export async function runWatchlistEndingAlerts(ctx: AppContext): Promise<number> {
  const now = ctx.now();
  const windowEnd = new Date(now.getTime() + ENDING_WINDOW_HOURS * 3_600_000);
  const rows = await ctx.db
    .select({
      watchId: watchlist.id,
      customerId: watchlist.customerId,
      title: listings.title,
      priceCents: sql<number>`coalesce(${auctions.currentPriceCents}, ${listings.startPriceCents})`,
      endsAt: auctions.endsAt,
    })
    .from(watchlist)
    .innerJoin(auctions, eq(watchlist.auctionId, auctions.id))
    .innerJoin(listings, eq(auctions.listingId, listings.id))
    .innerJoin(customers, eq(watchlist.customerId, customers.id))
    .where(
      and(
        isNull(watchlist.endingNotifiedAt),
        eq(auctions.status, "live"),
        gt(auctions.endsAt, now),
        lte(auctions.endsAt, windowEnd),
        isNull(customers.erasedAt),
      ),
    )
    .orderBy(asc(auctions.endsAt))
    .limit(500);
  if (rows.length === 0) return 0;

  // Одно письмо на человека за проход, сколько бы лотов ни заканчивалось.
  const byCustomer = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byCustomer.get(r.customerId) ?? [];
    list.push(r);
    byCustomer.set(r.customerId, list);
  }

  let queued = 0;
  for (const [customerId, lots] of byCustomer) {
    const result = await enqueueMarketing(ctx, ctx.db, {
      customerId,
      type: "watchlist_ending",
      template: {
        alias: "",
        lotTitle: "",
        lots: lots.slice(0, LOTS_PER_EMAIL).map((l) => ({ title: l.title, priceCents: Number(l.priceCents), endsAt: l.endsAt })),
      },
      dedupeKey: `watch_ending:${customerId}:${now.toISOString().slice(0, 10)}`,
      explicit: true,
    });
    // Отметить надо при любом исходе, кроме сбоя: человек с отпиской или
    // возвратом почты не должен проверяться заново каждые полчаса.
    if (result.ok || result.skip !== "duplicate") {
      await ctx.db
        .update(watchlist)
        .set({ endingNotifiedAt: now })
        .where(inArray(watchlist.id, lots.map((l) => l.watchId)));
    }
    if (result.ok) queued += 1;
  }
  return queued;
}
