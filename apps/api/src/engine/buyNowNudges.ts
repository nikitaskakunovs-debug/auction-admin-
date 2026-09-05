import { type Db, cartReminders, customers, items, listings, listingPriceDrops, watchlist } from "@auction/db";
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { enqueueMarketing } from "./marketing.js";
import { getSettings } from "./settings.js";

/**
 * Догоняющие письма по товарам «Pērc uzreiz» (BN-1, BN-2).
 *
 * У аукционного лота есть кому вернуть человека: перебили ставку — пришло
 * письмо, лот на исходе — пришло письмо. У товара с фиксированной ценой нет
 * ни ставок, ни срока закрытия, поэтому ушедший уходит молча. Здесь два
 * повода написать ему честно:
 *
 *  BN-1 — в корзине что-то осталось (через 3 и через 20 часов, больше не пишем);
 *  BN-2 — цена на отслеживаемый товар снизилась.
 *
 * Оба письма уходят только вошедшему человеку: гостевой корзине писать
 * некуда, а связывать анонимную корзину с личностью мы не хотим.
 */

/* ── BN-1: след корзины ──────────────────────────────────────────────────── */

/** Ключ корзины аккаунта в Redis. Одно определение на маршрут и на крон. */
export const cartKeyOfCustomer = (customerId: string): string => `cart:c:${customerId}`;

interface StoredCartEntry {
  id: string;
  priceCents: number;
  at: number;
}

async function readCart(ctx: AppContext, customerId: string): Promise<StoredCartEntry[]> {
  try {
    const raw = await ctx.redis.get(cartKeyOfCustomer(customerId));
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as StoredCartEntry[]).filter((e) => typeof e?.id === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Корзину наполнили — завести или обновить след и начать отсчёт заново.
 * Счётчик писем сбрасывается: положили новое — это новый повод напомнить.
 */
export async function touchCartReminder(
  ctx: AppContext,
  args: { customerId: string; listingId: string | null; itemCount: number },
): Promise<void> {
  if (args.itemCount <= 0) {
    await clearCartReminder(ctx, args.customerId);
    return;
  }
  const now = ctx.now();
  await ctx.db
    .insert(cartReminders)
    .values({
      customerId: args.customerId,
      touchedAt: now,
      listingId: args.listingId,
      itemCount: args.itemCount,
      stage: 0,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: cartReminders.customerId,
      set: { touchedAt: now, listingId: args.listingId, itemCount: args.itemCount, stage: 0, updatedAt: now },
    });
}

/**
 * Из корзины что-то убрали. Таймер намеренно НЕ перезапускается: уборка в
 * корзине — не тот же поступок, что выбор нового товара, и не повод отодвигать
 * напоминание ещё на три часа.
 */
export async function syncCartReminderCount(
  ctx: AppContext,
  args: { customerId: string; itemCount: number },
): Promise<void> {
  if (args.itemCount <= 0) {
    await clearCartReminder(ctx, args.customerId);
    return;
  }
  await ctx.db
    .update(cartReminders)
    .set({ itemCount: args.itemCount, updatedAt: ctx.now() })
    .where(eq(cartReminders.customerId, args.customerId));
}

/** Корзина пуста (купили или всё убрали) — напоминать не о чем. */
export async function clearCartReminder(ctx: AppContext, customerId: string): Promise<void> {
  await ctx.db.delete(cartReminders).where(eq(cartReminders.customerId, customerId));
}

/**
 * Крон BN-1. Двумя письмами и всё: третьего не будет, сколько бы корзина ни
 * лежала. Перед отправкой корзина перечитывается из Redis — за это время её
 * могли опустошить, а товар мог уйти другому.
 */
export async function runCartReminders(ctx: AppContext): Promise<number> {
  const s = await getSettings(ctx);
  const now = ctx.now();
  const firstDue = new Date(now.getTime() - s.cart_reminder_first_hours * 3_600_000);
  const secondDue = new Date(now.getTime() - s.cart_reminder_second_hours * 3_600_000);

  const due = await ctx.db
    .select({
      customerId: cartReminders.customerId,
      touchedAt: cartReminders.touchedAt,
      listingId: cartReminders.listingId,
      stage: cartReminders.stage,
    })
    .from(cartReminders)
    .innerJoin(customers, eq(customers.id, cartReminders.customerId))
    .where(
      and(
        isNull(customers.erasedAt),
        or(
          and(eq(cartReminders.stage, 0), lte(cartReminders.touchedAt, firstDue)),
          and(eq(cartReminders.stage, 1), lte(cartReminders.touchedAt, secondDue)),
        ),
      ),
    )
    .orderBy(asc(cartReminders.touchedAt))
    .limit(200);

  let queued = 0;
  for (const row of due) {
    const cart = await readCart(ctx, row.customerId);
    if (cart.length === 0) {
      await clearCartReminder(ctx, row.customerId);
      continue;
    }

    // Живые данные: писать про исчезнувший или уже проданный товар нельзя.
    const ids = cart.map((e) => e.id);
    const alive = await ctx.db
      .select({ id: listings.id, title: listings.title, priceCents: listings.priceCents })
      .from(listings)
      .innerJoin(items, eq(listings.itemId, items.id))
      .where(
        and(
          inArray(listings.id, ids),
          eq(listings.status, "published"),
          eq(items.status, "listed"),
          gt(listings.quantity, 0),
          isNotNull(listings.priceCents),
        ),
      );
    if (alive.length === 0) {
      await clearCartReminder(ctx, row.customerId);
      continue;
    }
    // Показываем последний положенный товар; если он уже ушёл — любой живой.
    const lead = alive.find((l) => l.id === row.listingId) ?? alive[0]!;

    const result = await enqueueMarketing(ctx, ctx.db, {
      customerId: row.customerId,
      type: "cart_reminder",
      template: {
        alias: "",
        lotTitle: lead.title,
        amountCents: lead.priceCents ?? undefined,
        cartCount: alive.length,
        actionUrl: `${ctx.config.storefrontBaseUrl}/grozs`,
      },
      // Человек сам положил товар в корзину — письмо про его собственный
      // выбор, а не рассылка. Отписка, возврат почты и блокировка всё равно
      // действуют: explicit снимает только требование общего согласия.
      explicit: true,
      dedupeKey: `cart:${row.customerId}:${row.stage + 1}:${row.touchedAt.toISOString()}`,
    }).catch(() => ({ ok: false as const, skip: "duplicate" as const }));

    // Шаг растёт при любом исходе, кроме гонки двух кронов: иначе человек с
    // отпиской проверялся бы заново каждые полчаса.
    if (result.ok || result.skip !== "duplicate") {
      await ctx.db
        .update(cartReminders)
        .set({ stage: row.stage + 1, itemCount: alive.length, updatedAt: now })
        .where(eq(cartReminders.customerId, row.customerId));
    }
    if (result.ok) queued += 1;
  }
  return queued;
}

/* ── BN-2: снижение цены ─────────────────────────────────────────────────── */

/**
 * Записать снижение цены. Письмо здесь НЕ отправляется: цену часто правят
 * дважды подряд (сначала опечатка, потом верное число), и первое письмо ушло
 * бы навсегда. Крон подождёт установленную паузу и сверится с живой ценой.
 */
export async function recordPriceDrop(
  ctx: AppContext,
  db: Pick<Db, "insert">,
  args: { listingId: string; oldPriceCents: number; newPriceCents: number },
): Promise<void> {
  if (args.newPriceCents >= args.oldPriceCents) return;
  await db.insert(listingPriceDrops).values({
    listingId: args.listingId,
    oldPriceCents: args.oldPriceCents,
    newPriceCents: args.newPriceCents,
    createdAt: ctx.now(),
  });
}

/**
 * Крон BN-2. По каждому лоту берётся вся цепочка неразосланных правок: «было»
 * — самая ранняя цена, «стало» — живая цена из базы. Так две правки подряд
 * дают одно честное письмо, а откат цены обратно — ни одного.
 */
export async function runPriceDropNotices(ctx: AppContext): Promise<number> {
  const s = await getSettings(ctx);
  const now = ctx.now();
  const ready = new Date(now.getTime() - s.price_drop_delay_min * 60_000);

  const pending = await ctx.db
    .select({
      id: listingPriceDrops.id,
      listingId: listingPriceDrops.listingId,
      oldPriceCents: listingPriceDrops.oldPriceCents,
      createdAt: listingPriceDrops.createdAt,
    })
    .from(listingPriceDrops)
    .where(and(isNull(listingPriceDrops.notifiedAt), lte(listingPriceDrops.createdAt, ready)))
    .orderBy(asc(listingPriceDrops.createdAt))
    .limit(200);
  if (pending.length === 0) return 0;

  const byListing = new Map<string, typeof pending>();
  for (const d of pending) {
    const list = byListing.get(d.listingId) ?? [];
    list.push(d);
    byListing.set(d.listingId, list);
  }

  let queued = 0;
  for (const [listingId, drops] of byListing) {
    const close = async (recipients: number) => {
      await ctx.db
        .update(listingPriceDrops)
        .set({ notifiedAt: now, recipients })
        .where(inArray(listingPriceDrops.id, drops.map((d) => d.id)));
    };

    const [live] = await ctx.db
      .select({ title: listings.title, priceCents: listings.priceCents, status: listings.status, quantity: listings.quantity, itemStatus: items.status })
      .from(listings)
      .innerJoin(items, eq(listings.itemId, items.id))
      .where(eq(listings.id, listingId));

    const sellable =
      live && live.status === "published" && live.quantity > 0 && live.itemStatus === "listed" && live.priceCents !== null;
    if (!sellable) {
      await close(0);
      continue;
    }

    const was = drops[0]!.oldPriceCents;
    const nowCents = live.priceCents!;
    // Цену вернули обратно (или подняли) — писать не о чем.
    if (nowCents >= was || was <= 0) {
      await close(0);
      continue;
    }
    const dropBp = Math.round(((was - nowCents) / was) * 10_000);
    if (dropBp < s.price_drop_min_bp) {
      await close(0);
      continue;
    }

    const watchers = await ctx.db
      .select({ customerId: watchlist.customerId })
      .from(watchlist)
      .innerJoin(customers, eq(customers.id, watchlist.customerId))
      .where(and(eq(watchlist.listingId, listingId), isNull(customers.erasedAt)))
      .limit(1000);

    let sent = 0;
    for (const wRow of watchers) {
      const result = await enqueueMarketing(ctx, ctx.db, {
        customerId: wRow.customerId,
        type: "price_drop",
        template: {
          alias: "",
          lotTitle: live.title,
          amountCents: nowCents,
          oldPriceCents: was,
          dropPercent: Math.round(dropBp / 100),
          actionUrl: `${ctx.config.storefrontBaseUrl}/lots/${listingId}`,
        },
        // Лот в списке отслеживания — человек сам попросил о нём сообщать.
        explicit: true,
        dedupeKey: `price_drop:${listingId}:${nowCents}:${wRow.customerId}`,
      }).catch(() => ({ ok: false as const, skip: "duplicate" as const }));
      if (result.ok) sent += 1;
    }
    await close(sent);
    queued += sent;
  }
  return queued;
}
