import { customerFees, items, notifications, orders, refunds } from "@auction/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cancelNoShowDue } from "../src/engine/noShow.js";
import { getFinSettings, setFinSetting } from "../src/engine/finSettings.js";
import { runStorageFees, storageDaysDue, storageOwedCents } from "../src/engine/storage.js";
import { auth, createWorld, loginAs, type TestWorld } from "./helpers.js";

/**
 * Плата за хранение оплаченного, но не забранного заказа.
 *
 * Проверяем не только «сумма набежала», но и границы, ради которых плата
 * вообще может считаться честной: бесплатные дни, оба потолка, отсутствие
 * платы у посылок, и то, что на выдаче вещь не уходит с непогашенным долгом.
 */
describe("плата за хранение", () => {
  let world: TestWorld;
  let adminToken: string;
  let n = 0;

  const registerBidder = async (alias: string) => {
    const res = await world.server.app.inject({
      method: "POST",
      url: "/api/public/auth/register",
      payload: { email: `${alias}@stor.test`, alias, password: "Bidder123!", country: "LV" },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as { accessToken: string; bidder: { id: string } };
  };

  /** Оплаченный заказ, лежащий на складе N дней. */
  const heldOrder = async (
    buyerToken: string,
    opts: { priceCents?: number; daysHeld: number; fulfilment?: "pickup" | "omniva_pm" } = { daysHeld: 0 },
  ) => {
    n += 1;
    const app = world.server.app;
    const sku = `STOR-${n}`;
    const item = await app.inject({ method: "POST", url: "/api/items", headers: auth(adminToken), payload: { sku, title: `Stor ${n}`, marketCode: "LV" } });
    const itemId = (item.json() as { item: { id: string } }).item.id;
    const listing = await app.inject({
      method: "POST",
      url: "/api/listings",
      headers: auth(adminToken),
      payload: { itemId, type: "fixed", title: `Stor ${n}`, marketCode: "LV", priceCents: opts.priceCents ?? 10_000, quantity: 1 },
    });
    const listingId = (listing.json() as { listing: { id: string } }).listing.id;
    await app.inject({ method: "POST", url: `/api/listings/${listingId}/publish`, headers: auth(adminToken) });
    const buy = await app.inject({ method: "POST", url: `/api/public/listings/${listingId}/buy`, headers: auth(buyerToken) });
    const { orderRef } = buy.json() as { orderRef: string };
    const [order] = await world.ctx.db.select().from(orders).where(eq(orders.ref, orderRef));

    // Оплачиваем вручную и отматываем дату оплаты в прошлое.
    const { settleOrderPaid } = await import("../src/engine/settlement.js");
    if (opts.fulfilment && opts.fulfilment !== "pickup") {
      await world.ctx.db.update(orders).set({ fulfilment: opts.fulfilment }).where(eq(orders.id, order!.id));
    }
    await settleOrderPaid(world.ctx, order!.id, { id: null, label: "test" }, { via: "test" });
    const paidAt = new Date(world.ctx.now().getTime() - opts.daysHeld * 86_400_000);
    await world.ctx.db.update(orders).set({ paidAt }).where(eq(orders.id, order!.id));
    return { orderId: order!.id, ref: orderRef, itemId };
  };

  const storageFees = (orderId: string) =>
    world.ctx.db
      .select()
      .from(customerFees)
      .where(and(eq(customerFees.orderId, orderId), eq(customerFees.type, "storage")));

  /** Отодвинуть точку старта платного хранения в прошлое (или сбросить). */
  const setStorageStart = (ms: number) => setFinSetting(world.ctx, "storage_start_ms", ms);

  beforeAll(async () => {
    world = await createWorld();
    adminToken = await loginAs(world, "super@auction.test");
    // Режим давно работает: тесты ниже про саму плату, а не про её запуск.
    await setStorageStart(world.ctx.now().getTime() - 365 * 86_400_000);
  });
  afterAll(async () => {
    if (world) await world.close();
  });

  /* ── Арифметика ───────────────────────────────────────────────────────── */

  it("бесплатные дни не считаются, дальше день = день", () => {
    expect(storageDaysDue({ paidAt: new Date("2026-01-01T10:00:00Z"), now: new Date("2026-01-05T10:00:00Z"), freeDays: 7 })).toBe(0);
    expect(storageDaysDue({ paidAt: new Date("2026-01-01T10:00:00Z"), now: new Date("2026-01-08T10:00:00Z"), freeDays: 7 })).toBe(0);
    expect(storageDaysDue({ paidAt: new Date("2026-01-01T10:00:00Z"), now: new Date("2026-01-11T10:00:00Z"), freeDays: 7 })).toBe(3);
  });

  it("вещь, оплаченная до введения правила, лежит с момента введения", () => {
    const paidAt = new Date("2026-01-01T10:00:00Z");
    const startAt = new Date("2026-03-01T10:00:00Z");
    // Два месяца на полке до правила — но долг с них не считается.
    expect(storageDaysDue({ paidAt, now: new Date("2026-03-05T10:00:00Z"), freeDays: 7, startAt })).toBe(0);
    // Бесплатные дни она получает заново, от точки старта.
    expect(storageDaysDue({ paidAt, now: new Date("2026-03-08T10:00:00Z"), freeDays: 7, startAt })).toBe(0);
    expect(storageDaysDue({ paidAt, now: new Date("2026-03-11T10:00:00Z"), freeDays: 7, startAt })).toBe(3);
    // Оплаченной после старта отсечка не мешает: считаем со дня оплаты.
    const later = new Date("2026-03-10T10:00:00Z");
    expect(storageDaysDue({ paidAt: later, now: new Date("2026-03-20T10:00:00Z"), freeDays: 7, startAt })).toBe(3);
  });

  it("оба потолка: и в деньгах, и долей от заказа", () => {
    const base = { perDayCents: 100, capCents: 3_000, capBp: 5_000 };
    // 10 дней по 1 € — до потолков далеко.
    expect(storageOwedCents({ ...base, days: 10, orderTotalCents: 10_000 })).toBe(1_000);
    // 200 дней упираются в денежный потолок.
    expect(storageOwedCents({ ...base, days: 200, orderTotalCents: 100_000 })).toBe(3_000);
    // Дешёвая вещь: половина её цены, а не 30 €. За забытую вещь за 20 €
    // не может набежать больше 10 €.
    expect(storageOwedCents({ ...base, days: 200, orderTotalCents: 2_000 })).toBe(1_000);
  });

  /* ── Начисление ───────────────────────────────────────────────────────── */

  it("первые дни бесплатны — долга нет и письма нет", async () => {
    const buyer = await registerBidder("stor_free");
    const order = await heldOrder(buyer.accessToken, { daysHeld: 5 });
    expect(await runStorageFees(world.ctx)).toBe(0);
    expect(await storageFees(order.orderId)).toHaveLength(0);
  });

  it("после бесплатных дней капает по тарифу; письмо одно, не каждый день", async () => {
    const buyer = await registerBidder("stor_charged");
    const order = await heldOrder(buyer.accessToken, { daysHeld: 10 });

    expect(await runStorageFees(world.ctx)).toBe(1);
    const [fee] = await storageFees(order.orderId);
    expect(fee!.amountCents).toBe(300); // 10 дней − 7 бесплатных = 3 дня × 1 €
    expect(fee!.status).toBe("outstanding");

    const letters = () =>
      world.ctx.db
        .select()
        .from(notifications)
        .where(and(eq(notifications.customerId, buyer.bidder.id), eq(notifications.type, "storage_started")));
    expect(await letters()).toHaveLength(1);

    // Ещё два дня на полке: сумма растёт, второго письма нет.
    await world.ctx.db
      .update(orders)
      .set({ paidAt: new Date(world.ctx.now().getTime() - 12 * 86_400_000) })
      .where(eq(orders.id, order.orderId));
    expect(await runStorageFees(world.ctx)).toBe(1);
    const [grown] = await storageFees(order.orderId);
    expect(grown!.amountCents).toBe(500);
    expect(await letters()).toHaveLength(1);
  });

  it("повторный проход в тот же день ничего не добавляет", async () => {
    const buyer = await registerBidder("stor_idem");
    const order = await heldOrder(buyer.accessToken, { daysHeld: 9 });
    await runStorageFees(world.ctx);
    const [first] = await storageFees(order.orderId);
    expect(await runStorageFees(world.ctx)).toBe(0);
    const [second] = await storageFees(order.orderId);
    expect(second!.amountCents).toBe(first!.amountCents);
  });

  it("посылке в пакомат хранение не начисляется", async () => {
    const buyer = await registerBidder("stor_parcel");
    const order = await heldOrder(buyer.accessToken, { daysHeld: 20, fulfilment: "omniva_pm" });
    await runStorageFees(world.ctx);
    expect(await storageFees(order.orderId)).toHaveLength(0);
  });

  /* ── Выдача и отмена ──────────────────────────────────────────────────── */

  it("на выдаче вещь не уходит, пока хранение не оплачено", async () => {
    const buyer = await registerBidder("stor_desk");
    const order = await heldOrder(buyer.accessToken, { daysHeld: 12 });
    await runStorageFees(world.ctx);
    const ops = await loginAs(world, "ops@auction.test");
    const app = world.server.app;

    const [ord] = await world.ctx.db.select().from(orders).where(eq(orders.id, order.orderId));
    const checkin = await app.inject({ method: "POST", url: "/api/public/pickup/checkin", payload: { code: ord!.pickupCode } });
    expect(checkin.statusCode).toBe(200);
    const queue = await app.inject({ method: "GET", url: "/api/pickup/queue", headers: auth(ops) });
    const ticket = (queue.json() as { tickets: Array<{ id: string; lines: Array<{ id: string }> }> }).tickets[0]!;
    await app.inject({ method: "POST", url: `/api/pickup/tickets/${ticket.id}/claim`, headers: auth(ops) });
    for (const line of ticket.lines) {
      await app.inject({
        method: "POST",
        url: `/api/pickup/tickets/${ticket.id}/lines/${line.id}`,
        headers: auth(ops),
        payload: { status: "picked" },
      });
    }
    await app.inject({ method: "POST", url: `/api/pickup/tickets/${ticket.id}/delivering`, headers: auth(ops) });

    const blocked = await app.inject({
      method: "POST",
      url: `/api/pickup/tickets/${ticket.id}/complete`,
      headers: auth(ops),
      payload: { pickupCode: ord!.pickupCode },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ error: "storage_unpaid", storageDueCents: 500 });
    // Вещь всё ещё наша: со склада она не ушла.
    const [item] = await world.ctx.db.select().from(items).where(eq(items.id, order.itemId));
    expect(item!.status).not.toBe("delivered");

    // Кассир принял деньги — выдача проходит.
    const [fee] = await storageFees(order.orderId);
    await world.ctx.db
      .update(customerFees)
      .set({ status: "settled", settledAt: world.ctx.now() })
      .where(eq(customerFees.id, fee!.id));
    const done = await app.inject({
      method: "POST",
      url: `/api/pickup/tickets/${ticket.id}/complete`,
      headers: auth(ops),
      payload: { pickupCode: ord!.pickupCode },
    });
    expect(done.statusCode).toBe(200);
  });

  it("не забрал вовсе — хранение удерживается из возврата", async () => {
    const buyer = await registerBidder("stor_noshow");
    const order = await heldOrder(buyer.accessToken, { daysHeld: 12 });
    await runStorageFees(world.ctx);

    // Срок самовывоза прошёл.
    await world.ctx.db
      .update(orders)
      .set({ pickupDeadlineAt: new Date(world.ctx.now().getTime() - 3_600_000) })
      .where(eq(orders.id, order.orderId));
    await cancelNoShowDue(world.ctx);

    const [refund] = await world.ctx.db.select().from(refunds).where(eq(refunds.orderId, order.orderId));
    // 100 € − 5% комиссии − 5 € хранения (12 дней − 7 бесплатных).
    expect(refund!.amountCents).toBe(10_000 - 500 - 500);
    // Долг закрыт удержанием — второй раз те же деньги не просим.
    const [fee] = await storageFees(order.orderId);
    expect(fee!.status).toBe("settled");
    expect(fee!.amountCents).toBe(500);
  });

  /* ── Запуск режима ────────────────────────────────────────────────────── */

  it("первый запуск не выставляет долг за прошлое", async () => {
    const buyer = await registerBidder("stor_legacy");
    // Вещь лежит месяц: по тарифу это 23 платных дня, то есть потолок.
    const order = await heldOrder(buyer.accessToken, { daysHeld: 30 });
    await setStorageStart(0);

    // Первый прогон только запоминает момент — денег ни с кого.
    expect(await runStorageFees(world.ctx)).toBe(0);
    expect(await storageFees(order.orderId)).toHaveLength(0);
    const started = (await getFinSettings(world.ctx)).storage_start_ms;
    expect(started).toBeGreaterThan(0);

    // И назавтра тоже: бесплатные дни человек получает заново, с этой точки.
    expect(await runStorageFees(world.ctx)).toBe(0);
    expect(await storageFees(order.orderId)).toHaveLength(0);

    // А когда бесплатные дни от старта пройдут — плата пойдёт как обычно,
    // но за дни после старта, а не за весь месяц на полке.
    await setStorageStart(world.ctx.now().getTime() - 9 * 86_400_000);
    expect(await runStorageFees(world.ctx)).toBe(1);
    const [fee] = await storageFees(order.orderId);
    expect(fee!.amountCents).toBe(200); // 9 дней − 7 бесплатных, а не 23
  });
});
