import type { AppContext } from "../context.js";

/**
 * Поштучный резерв лотов «Pērc uzreiz».
 *
 * Резерв появляется в один-единственный момент — когда человек нажал
 * «Noformēt pasūtījumu» и ушёл на вход или регистрацию. На десять минут за
 * ним закрепляется ОДНА единица остатка, а не весь лот: при остатке 10 и
 * одном оформляющем остальным доступны девять. Таймер виден в корзине;
 * по истечении резерв снимается сам, без крона — просроченные записи
 * вычищаются при каждом обращении.
 *
 * Резерв — вежливость, а не сделка: окончательно единицу забирает только
 * оформленный заказ (атомарный buyNow). Поэтому храним в Redis: потеря
 * резервов при перезапуске стоит дешевле, чем таблица и обслуживание.
 *
 * Устройство: ZSET на лот, участник — «держатель» (идентификатор браузера
 * или аккаунта), оценка — момент истечения. Повторное нажатие не продлевает
 * резерв: десять минут отсчитываются от первого.
 */

export const RESERVE_TTL_MS = 10 * 60_000;

const keyOf = (listingId: string) => `resv:${listingId}`;

/** Снять просроченное — Redis сам этого не делает для членов ZSET. */
async function purge(ctx: AppContext, listingId: string): Promise<void> {
  await ctx.redis.zremrangebyscore(keyOf(listingId), "-inf", ctx.now().getTime());
}

/** Сколько единиц держат ДРУГИЕ — свои резервы человека не считаются. */
export async function heldByOthers(ctx: AppContext, listingId: string, mine: string[]): Promise<number> {
  await purge(ctx, listingId);
  const holders = await ctx.redis.zrange(keyOf(listingId), 0, -1);
  const my = new Set(mine.filter(Boolean));
  return holders.filter((h) => !my.has(h)).length;
}

/** Все живые резервы лота — для витринного остатка. */
export async function heldTotal(ctx: AppContext, listingId: string): Promise<number> {
  await purge(ctx, listingId);
  return ctx.redis.zcard(keyOf(listingId));
}

/** До какого момента лот держит этот человек; null — не держит. */
export async function myHoldUntil(ctx: AppContext, listingId: string, mine: string[]): Promise<number | null> {
  await purge(ctx, listingId);
  for (const holder of mine) {
    if (!holder) continue;
    const score = await ctx.redis.zscore(keyOf(listingId), holder);
    if (score !== null) return Number(score);
  }
  return null;
}

/**
 * Закрепить одну единицу за держателем. Возвращает момент истечения или
 * null, когда свободных единиц не осталось (остаток разобран другими).
 */
export async function reserveUnit(
  ctx: AppContext,
  args: { listingId: string; holder: string; quantity: number; also?: string[] },
): Promise<number | null> {
  const mine = [args.holder, ...(args.also ?? [])];
  const existing = await myHoldUntil(ctx, args.listingId, mine);
  if (existing !== null) return existing;
  if ((await heldByOthers(ctx, args.listingId, mine)) >= args.quantity) return null;
  const until = ctx.now().getTime() + RESERVE_TTL_MS;
  await ctx.redis.zadd(keyOf(args.listingId), "NX", until, args.holder);
  // Ключ целиком живёт чуть дольше самого длинного резерва — мусор не копится.
  await ctx.redis.pexpire(keyOf(args.listingId), RESERVE_TTL_MS + 60_000);
  return until;
}

/** Отпустить резервы человека — после покупки или удаления из корзины. */
export async function releaseHold(ctx: AppContext, listingId: string, mine: string[]): Promise<void> {
  const holders = mine.filter(Boolean);
  if (holders.length > 0) await ctx.redis.zrem(keyOf(listingId), ...holders);
}
