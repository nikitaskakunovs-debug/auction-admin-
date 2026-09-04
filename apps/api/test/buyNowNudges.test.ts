import { cartReminders, customers, items, listings, listingPriceDrops, notifications, watchlist } from "@auction/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCartReminders, runPriceDropNotices } from "../src/engine/buyNowNudges.js";
import { auth, createWorld, loginAs, type TestWorld } from "./helpers.js";

/**
 * Догоняющие письма по товарам «Pērc uzreiz» (BN-1, BN-2).
 *
 * У товара с фиксированной ценой нет ни ставок, ни срока закрытия — ушедшего
 * покупателя не возвращает ничто. Проверяем оба повода написать и, что важнее,
 * все случаи, когда писать НЕЛЬЗЯ: корзину опустошили, товар продан, цену
 * вернули обратно, снижение копеечное, письма уже было два.
 */
describe("письма по товарам «Pērc uzreiz»", () => {
  let world: TestWorld;
  let n = 0;

  const register = async (email: string) => {
    const res = await world.server.app.inject({
      method: "POST",
      url: "/api/public/auth/register",
      payload: { email, alias: email.split("@")[0]!.replace(/[^a-z0-9]/gi, ""), password: "Bidder123!" },
    });
    expect(res.statusCode).toBe(200);
    const out = res.json() as { accessToken: string; bidder: { id: string } };
    await world.ctx.db.update(customers).set({ lang: "lv" }).where(eq(customers.id, out.bidder.id));
    return out;
  };

  const mkListing = async (priceCents = 4900, quantity = 1) => {
    n += 1;
    const [item] = await world.ctx.db
      .insert(items)
      .values({ sku: `BN-${n}`, title: `Prece ${n}`, marketCode: "LV", status: "listed", category: "electronics" })
      .returning({ id: items.id });
    const [listing] = await world.ctx.db
      .insert(listings)
      .values({ itemId: item!.id, type: "fixed", title: `Prece ${n}`, marketCode: "LV", priceCents, quantity, status: "published" })
      .returning({ id: listings.id });
    return { itemId: item!.id, listingId: listing!.id };
  };

  const addToCart = (listingId: string, token: string) =>
    world.server.app.inject({
      method: "POST",
      url: "/api/public/cart",
      headers: { authorization: `Bearer ${token}` },
      payload: { listing_id: listingId },
    });

  const lettersFor = (customerId: string, type: string) =>
    world.ctx.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.customerId, customerId), eq(notifications.type, type)));

  /** Отодвинуть отметку корзины в прошлое — вместо ожидания трёх часов. */
  const ageCart = (customerId: string, hoursAgo: number) =>
    world.ctx.db
      .update(cartReminders)
      .set({ touchedAt: new Date(world.ctx.now().getTime() - hoursAgo * 3_600_000) })
      .where(eq(cartReminders.customerId, customerId));

  const ageDrops = (minutesAgo: number) =>
    world.ctx.db
      .update(listingPriceDrops)
      .set({ createdAt: new Date(world.ctx.now().getTime() - minutesAgo * 60_000) });

  beforeAll(async () => {
    world = await createWorld();
  });
  afterAll(async () => {
    if (world) await world.close();
  });

  /* ── BN-1: брошенная корзина ─────────────────────────────────────────── */

  it("корзина: два письма (3 ч и 20 ч) и ни одного третьего", async () => {
    const buyer = await register("bn-cart1@example.com");
    const lot = await mkListing(4900);
    expect((await addToCart(lot.listingId, buyer.accessToken)).statusCode).toBe(200);

    // Сразу после добавления писать рано.
    expect(await runCartReminders(world.ctx)).toBe(0);

    await ageCart(buyer.bidder.id, 4);
    expect(await runCartReminders(world.ctx)).toBe(1);
    const first = await lettersFor(buyer.bidder.id, "cart_reminder");
    expect(first).toHaveLength(1);
    // Письмо говорит о том самом товаре и честно предупреждает про резерв.
    expect(first[0]!.body).toContain("Prece");
    expect(first[0]!.body?.toLowerCase()).toContain("nerezervē");

    // Второй проход подряд ничего не добавляет: 20 часов ещё не прошло.
    expect(await runCartReminders(world.ctx)).toBe(0);

    await ageCart(buyer.bidder.id, 21);
    expect(await runCartReminders(world.ctx)).toBe(1);
    expect(await lettersFor(buyer.bidder.id, "cart_reminder")).toHaveLength(2);

    // Третьего письма не бывает, сколько бы корзина ни лежала.
    await ageCart(buyer.bidder.id, 200);
    expect(await runCartReminders(world.ctx)).toBe(0);
    expect(await lettersFor(buyer.bidder.id, "cart_reminder")).toHaveLength(2);
  });

  it("корзину опустошили — след исчезает, письма нет", async () => {
    const buyer = await register("bn-cart2@example.com");
    const lot = await mkListing();
    await addToCart(lot.listingId, buyer.accessToken);

    const drop = await world.server.app.inject({
      method: "DELETE",
      url: `/api/public/cart/${lot.listingId}`,
      headers: { authorization: `Bearer ${buyer.accessToken}` },
    });
    expect(drop.statusCode).toBe(200);

    const trace = await world.ctx.db.select().from(cartReminders).where(eq(cartReminders.customerId, buyer.bidder.id));
    expect(trace).toHaveLength(0);
    expect(await runCartReminders(world.ctx)).toBe(0);
    expect(await lettersFor(buyer.bidder.id, "cart_reminder")).toHaveLength(0);
  });

  it("товар из корзины уже продан — письма нет", async () => {
    const buyer = await register("bn-cart3@example.com");
    const lot = await mkListing();
    await addToCart(lot.listingId, buyer.accessToken);
    // Лот ушёл другому: продажа закрыта, вещь больше не в каталоге.
    await world.ctx.db
      .update(listings)
      .set({ status: "archived", quantity: 0 })
      .where(eq(listings.id, lot.listingId));

    await ageCart(buyer.bidder.id, 5);
    expect(await runCartReminders(world.ctx)).toBe(0);
    expect(await lettersFor(buyer.bidder.id, "cart_reminder")).toHaveLength(0);
    // След тоже убран — напоминать не о чем.
    expect(await world.ctx.db.select().from(cartReminders).where(eq(cartReminders.customerId, buyer.bidder.id))).toHaveLength(0);
  });

  it("покупка из корзины закрывает напоминание", async () => {
    const buyer = await register("bn-cart4@example.com");
    const lot = await mkListing();
    await addToCart(lot.listingId, buyer.accessToken);

    const checkout = await world.server.app.inject({
      method: "POST",
      url: "/api/public/cart/checkout",
      headers: { authorization: `Bearer ${buyer.accessToken}` },
      payload: {},
    });
    expect(checkout.statusCode).toBe(200);

    expect(await world.ctx.db.select().from(cartReminders).where(eq(cartReminders.customerId, buyer.bidder.id))).toHaveLength(0);
    expect(await runCartReminders(world.ctx)).toBe(0);
  });

  /* ── BN-2: снижение цены ─────────────────────────────────────────────── */

  it("цена снижена — письмо уходит следящему, с настоящей старой ценой", async () => {
    const watcher = await register("bn-drop1@example.com");
    const lot = await mkListing(5000);
    await world.ctx.db.insert(watchlist).values({ customerId: watcher.bidder.id, listingId: lot.listingId });

    const admin = await loginAs(world, "super@auction.test");
    const patch = await world.server.app.inject({
      method: "PATCH",
      url: `/api/listings/${lot.listingId}`,
      headers: auth(admin),
      payload: { priceCents: 4000 },
    });
    expect(patch.statusCode).toBe(200);

    // Пауза на исправление опечатки ещё идёт — письма нет.
    expect(await runPriceDropNotices(world.ctx)).toBe(0);

    await ageDrops(45);
    expect(await runPriceDropNotices(world.ctx)).toBe(1);
    const letters = await lettersFor(watcher.bidder.id, "price_drop");
    expect(letters).toHaveLength(1);
    // «Было» — настоящая прежняя цена, «стало» — живая: зачёркнутой цены,
    // которой не существовало, в письме быть не должно.
    expect(letters[0]!.body).toContain("50,00");
    expect(letters[0]!.body).toContain("40,00");
    expect(letters[0]!.subject).toContain("20%");
  });

  it("две правки подряд дают одно письмо от самой первой цены", async () => {
    const watcher = await register("bn-drop2@example.com");
    const lot = await mkListing(10_000);
    await world.ctx.db.insert(watchlist).values({ customerId: watcher.bidder.id, listingId: lot.listingId });
    const admin = await loginAs(world, "super@auction.test");

    // Сначала опечатка, следом верное число — человек должен увидеть одно
    // письмо с настоящей начальной ценой, а не два разных.
    for (const priceCents of [9000, 7000]) {
      const res = await world.server.app.inject({
        method: "PATCH",
        url: `/api/listings/${lot.listingId}`,
        headers: auth(admin),
        payload: { priceCents },
      });
      expect(res.statusCode).toBe(200);
    }

    await ageDrops(45);
    expect(await runPriceDropNotices(world.ctx)).toBe(1);
    const letters = await lettersFor(watcher.bidder.id, "price_drop");
    expect(letters).toHaveLength(1);
    expect(letters[0]!.body).toContain("100,00");
    expect(letters[0]!.body).toContain("70,00");
    expect(letters[0]!.subject).toContain("30%");
  });

  it("цену вернули обратно — письма нет", async () => {
    const watcher = await register("bn-drop3@example.com");
    const lot = await mkListing(6000);
    await world.ctx.db.insert(watchlist).values({ customerId: watcher.bidder.id, listingId: lot.listingId });
    const admin = await loginAs(world, "super@auction.test");

    for (const priceCents of [4000, 6000]) {
      await world.server.app.inject({
        method: "PATCH",
        url: `/api/listings/${lot.listingId}`,
        headers: auth(admin),
        payload: { priceCents },
      });
    }
    await ageDrops(45);
    expect(await runPriceDropNotices(world.ctx)).toBe(0);
    expect(await lettersFor(watcher.bidder.id, "price_drop")).toHaveLength(0);
  });

  it("копеечное снижение письма не стоит", async () => {
    const watcher = await register("bn-drop4@example.com");
    const lot = await mkListing(10_000);
    await world.ctx.db.insert(watchlist).values({ customerId: watcher.bidder.id, listingId: lot.listingId });
    const admin = await loginAs(world, "super@auction.test");

    // −2% при пороге 5%: беспокоить человека нечем.
    await world.server.app.inject({
      method: "PATCH",
      url: `/api/listings/${lot.listingId}`,
      headers: auth(admin),
      payload: { priceCents: 9800 },
    });
    await ageDrops(45);
    expect(await runPriceDropNotices(world.ctx)).toBe(0);
    expect(await lettersFor(watcher.bidder.id, "price_drop")).toHaveLength(0);
  });

  it("не следит — не пишем; повышение цены следа не оставляет", async () => {
    const stranger = await register("bn-drop5@example.com");
    const lot = await mkListing(5000);
    const admin = await loginAs(world, "super@auction.test");

    await world.server.app.inject({
      method: "PATCH",
      url: `/api/listings/${lot.listingId}`,
      headers: auth(admin),
      payload: { priceCents: 8000 },
    });
    // Подорожание — не событие: записи нет вовсе.
    const raised = await world.ctx.db
      .select()
      .from(listingPriceDrops)
      .where(eq(listingPriceDrops.listingId, lot.listingId));
    expect(raised).toHaveLength(0);

    await world.server.app.inject({
      method: "PATCH",
      url: `/api/listings/${lot.listingId}`,
      headers: auth(admin),
      payload: { priceCents: 5000 },
    });
    await ageDrops(45);
    // Снижение есть, следящих нет — рассылать некому.
    expect(await runPriceDropNotices(world.ctx)).toBe(0);
    expect(await lettersFor(stranger.bidder.id, "price_drop")).toHaveLength(0);
  });
});
