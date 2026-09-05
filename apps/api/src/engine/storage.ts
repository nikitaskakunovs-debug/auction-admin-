import { customerFees, customers, items, orders, type Db } from "@auction/db";
import { and, eq, isNotNull, lte, sql } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { getFinSettings, setFinSetting } from "./finSettings.js";
import { enqueueNotification } from "./notifications.js";

/**
 * Плата за хранение оплаченного, но не забранного заказа.
 *
 * Раньше вещь просто лежала на складе бесплатно до самого срока, а потом
 * заказ отменялся — и человек узнавал об этом постфактум, потеряв 5%. Место
 * на складе при этом стоило нам денег молча. Теперь иначе: первые дни
 * бесплатны, дальше капает суточная плата, о ней сразу пишут, она видна в
 * кабинете, и на выдаче её берут вместе с товаром.
 *
 * Три ограничителя, чтобы плата осталась платой, а не наказанием:
 *  — бесплатные дни (никто не бежит на склад в тот же вечер);
 *  — потолок в деньгах и потолок долей от суммы заказа: за забытую вещь за
 *    20 € не может набежать 40 € долга;
 *  — доставка в пакомат хранения не знает вовсе — там вещь уезжает сразу.
 */

/**
 * Сколько платных дней хранения набежало к этому моменту.
 *
 * `startAt` — момент, раньше которого хранение не считается вовсе. Вещь,
 * оплаченная за месяц до введения правила, не должна на следующее утро
 * получить долг за этот месяц: отсчёт для неё начинается со дня, когда
 * правило заработало, и бесплатные дни она получает заново.
 */
export function storageDaysDue(args: {
  paidAt: Date;
  now: Date;
  freeDays: number;
  startAt?: Date;
}): number {
  const from = args.startAt && args.startAt > args.paidAt ? args.startAt : args.paidAt;
  const heldMs = args.now.getTime() - from.getTime();
  const heldDays = Math.floor(heldMs / 86_400_000);
  return Math.max(heldDays - args.freeDays, 0);
}

/** Плата за N дней с обоими потолками. */
export function storageOwedCents(args: {
  days: number;
  perDayCents: number;
  orderTotalCents: number;
  capCents: number;
  capBp: number;
}): number {
  const raw = args.days * args.perDayCents;
  const shareCap = Math.floor((args.orderTotalCents * args.capBp) / 10_000);
  return Math.max(0, Math.min(raw, args.capCents, shareCap));
}

/** Непогашенная плата за хранение по конкретному заказу. */
export async function storageFeeOfOrder(
  db: Pick<Db, "select">,
  orderId: string,
): Promise<{ id: string; amountCents: number } | null> {
  const [row] = await db
    .select({ id: customerFees.id, amountCents: customerFees.amountCents })
    .from(customerFees)
    .where(
      and(
        eq(customerFees.orderId, orderId),
        eq(customerFees.type, "storage"),
        eq(customerFees.status, "outstanding"),
      ),
    );
  return row ?? null;
}

/**
 * Ежедневный проход: досчитать хранение по всем лежащим заказам.
 *
 * Сумма не пересчитывается с нуля — она наращивается за новые дни по
 * сегодняшнему тарифу. Если владелец завтра поменяет цену за сутки, уже
 * посчитанные дни останутся по старой: выставленный счёт задним числом не
 * переписывают.
 */
export async function runStorageFees(ctx: AppContext): Promise<number> {
  const s = await getFinSettings(ctx);
  if (s.storage_per_day_cents <= 0) return 0;
  const now = ctx.now();

  // Первый прогон только отмечает точку старта и ничего не считает. Иначе на
  // складе, где вещи лежат месяцами, в первое же утро выписалось бы два
  // десятка долгов за прошлое — по правилу, которого в те дни не было.
  if (s.storage_start_ms <= 0) {
    await setFinSetting(ctx, "storage_start_ms", now.getTime());
    return 0;
  }
  const startAt = new Date(s.storage_start_ms);

  const chargeableFrom = new Date(now.getTime() - s.storage_free_days * 86_400_000);
  // Бесплатные дни с момента старта ещё не вышли — считать нечего никому.
  if (startAt > chargeableFrom) return 0;

  const due = await ctx.db
    .select({
      id: orders.id,
      ref: orders.ref,
      customerId: orders.customerId,
      totalCents: orders.totalCents,
      paidAt: orders.paidAt,
      chargedDays: orders.storageChargedDays,
      deadline: orders.pickupDeadlineAt,
      title: items.title,
    })
    .from(orders)
    .innerJoin(items, eq(items.id, orders.itemId))
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .where(
      and(
        eq(orders.status, "paid"),
        // Только самовывоз: посылка уезжает со склада сразу, хранить нечего.
        eq(orders.fulfilment, "pickup"),
        eq(items.status, "paid"),
        isNotNull(orders.paidAt),
        lte(orders.paidAt, chargeableFrom),
      ),
    )
    .limit(500);

  let charged = 0;
  for (const order of due) {
    const days = storageDaysDue({ paidAt: order.paidAt!, now, freeDays: s.storage_free_days, startAt });
    if (days <= order.chargedDays) continue;

    const existing = await storageFeeOfOrder(ctx.db, order.id);
    const owed = storageOwedCents({
      days,
      perDayCents: s.storage_per_day_cents,
      orderTotalCents: order.totalCents,
      capCents: s.storage_cap_cents,
      capBp: s.storage_cap_bp,
    });
    // Потолок достигнут — дни идут, долг больше не растёт.
    if (owed <= (existing?.amountCents ?? 0)) {
      await ctx.db.update(orders).set({ storageChargedDays: days }).where(eq(orders.id, order.id));
      continue;
    }

    if (existing) {
      await ctx.db
        .update(customerFees)
        .set({ amountCents: owed, note: `glabāšana ${days} d.` })
        .where(eq(customerFees.id, existing.id));
    } else {
      await ctx.db.insert(customerFees).values({
        customerId: order.customerId,
        orderId: order.id,
        orderRef: order.ref,
        type: "storage",
        amountCents: owed,
        status: "outstanding",
        note: `glabāšana ${days} d.`,
      });
    }
    await ctx.db.update(orders).set({ storageChargedDays: days }).where(eq(orders.id, order.id));
    charged += 1;

    // Письмо — только в день, когда плата началась. Дальше сумму человек
    // видит в кабинете и в напоминании о выдаче; долбить письмом каждые
    // сутки за то, что он не успел приехать, мы не будем.
    if (!existing) {
      await enqueueNotification(ctx, ctx.db, {
        customerId: order.customerId,
        type: "storage_started",
        template: {
          alias: "",
          lotTitle: order.title,
          orderRef: order.ref,
          storageCents: owed,
          storagePerDayCents: s.storage_per_day_cents,
          storageFreeDays: s.storage_free_days,
          ...(order.deadline ? { deadline: order.deadline } : {}),
        },
        dedupeKey: `storage_started:${order.id}`,
      }).catch(() => undefined);
    }
  }
  return charged;
}

/**
 * Итог по хранению при отмене неполученного заказа: накопленная плата
 * удерживается из возврата, как и комиссия за возврат на склад. Больше, чем
 * человек заплатил, удержать нельзя — остаток просто прощается.
 */
export function applyStorageToRefund(args: {
  refundCents: number;
  storageCents: number;
}): { refundCents: number; storageRetainedCents: number } {
  const retained = Math.min(Math.max(args.storageCents, 0), Math.max(args.refundCents, 0));
  return { refundCents: args.refundCents - retained, storageRetainedCents: retained };
}

/** Сумма хранения по заказу для показа в кабинете и на стойке выдачи. */
export async function storageSummary(
  db: Pick<Db, "select">,
  orderId: string,
): Promise<{ outstandingCents: number }> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${customerFees.amountCents}), 0)` })
    .from(customerFees)
    .where(
      and(
        eq(customerFees.orderId, orderId),
        eq(customerFees.type, "storage"),
        eq(customerFees.status, "outstanding"),
      ),
    );
  return { outstandingCents: Number(row?.total ?? 0) };
}
