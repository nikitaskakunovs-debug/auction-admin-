import { auctions, items, listings, orders } from "@auction/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorld, type TestWorld } from "./helpers.js";

/**
 * Гостевая корзина: отложить лот можно без входа, вход нужен только при
 * оформлении. Проверяем весь контракт: снимок цены, слияние при входе,
 * недоступность, превращение в заказы и невозможность продать одну вещь двоим.
 */
describe("гостевая корзина «Pērc uzreiz»", () => {
  let world: TestWorld;
  let n = 0;

  const register = async (email: string) => {
    const res = await world.server.app.inject({
      method: "POST",
      url: "/api/public/auth/register",
      payload: { email, alias: email.split("@")[0]!.replace(/[^a-z0-9]/gi, ""), password: "Bidder123!" },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as { accessToken: string; bidder: { id: string } };
  };

  const mkListing = async (priceCents = 12_100, quantity = 1) => {
    n += 1;
    const [item] = await world.ctx.db
      .insert(items)
      .values({ sku: `CART-${n}`, title: `Lote ${n}`, marketCode: "LV", status: "listed", category: "electronics" })
      .returning({ id: items.id });
    const [listing] = await world.ctx.db
      .insert(listings)
      .values({ itemId: item!.id, type: "fixed", title: `Lote ${n}`, marketCode: "LV", priceCents, quantity, status: "published" })
      .returning({ id: listings.id });
    return { itemId: item!.id, listingId: listing!.id, sku: `CART-${n}` };
  };

  const add = (listingId: string, visitor?: string, token?: string) =>
    world.server.app.inject({
      method: "POST",
      url: "/api/public/cart",
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
      payload: { listing_id: listingId, ...(visitor ? { visitor_id: visitor } : {}) },
    });

  const list = (visitor?: string, token?: string) =>
    world.server.app.inject({
      method: "GET",
      url: `/api/public/cart${visitor ? `?visitor_id=${visitor}` : ""}`,
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    });

  beforeAll(async () => {
    world = await createWorld();
  });
  afterAll(async () => {
    if (world) await world.close();
  });

  it("гость откладывает лот без входа; повтор не задваивает", async () => {
    const a = await mkListing();
    const first = await add(a.listingId, "guest-visitor-1");
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ ok: true, added: true, count: 1 });
    // Счётчик стартует с добавления: единица закреплена на десять минут.
    expect((first.json() as { reservedUntil: number | null }).reservedUntil).toBeGreaterThan(world.ctx.now().getTime());

    const again = await add(a.listingId, "guest-visitor-1");
    expect(again.json()).toMatchObject({ added: false, count: 1 });

    const view = list("guest-visitor-1");
    const body = (await view).json() as {
      items: Array<{ totalCents: number; hammerCents: number; premiumCents: number; vatCents: number; available: boolean; quantity: number }>;
      count: number;
      totalCents: number;
    };
    expect(body.count).toBe(1);
    expect(body.totalCents).toBe(12_100);
    const row = body.items[0]!;
    expect(row.available).toBe(true);
    expect(row.quantity).toBe(1);
    // Раскладка та же, что выпишет счёт: части сходятся в витринную цену.
    expect(row.hammerCents + row.premiumCents + row.vatCents).toBe(row.totalCents);
  });

  it("что нельзя купить — нельзя и отложить", async () => {
    const gone = await mkListing();
    await world.ctx.db.update(listings).set({ status: "archived" }).where(eq(listings.id, gone.listingId));
    const res = await add(gone.listingId, "guest-visitor-1");
    expect(res.statusCode).toBe(409);
    // Без опознания корзины нет вовсе.
    const anon = await add((await mkListing()).listingId);
    expect(anon.statusCode).toBe(400);
  });

  it("удаление убирает лот из корзины", async () => {
    const b = await mkListing();
    await add(b.listingId, "guest-visitor-2");
    const del = await world.server.app.inject({
      method: "DELETE",
      url: `/api/public/cart/${b.listingId}?visitor_id=guest-visitor-2`,
    });
    expect(del.json()).toMatchObject({ ok: true, count: 0 });
    const after = (await list("guest-visitor-2")).json() as { count: number };
    expect(after.count).toBe(0);
  });

  it("вход сливает гостевую корзину с корзиной аккаунта и не задваивает лот", async () => {
    const l1 = await mkListing();
    const l2 = await mkListing();
    await add(l1.listingId, "guest-visitor-3");
    await add(l2.listingId, "guest-visitor-3");

    const me = await register("cart.merge@test.lv");
    // В аккаунте уже лежит тот же l1 — при слиянии он не должен задвоиться.
    await add(l1.listingId, undefined, me.accessToken);

    const merged = (await list("guest-visitor-3", me.accessToken)).json() as { count: number; items: Array<{ listingId: string }> };
    expect(merged.count).toBe(2);
    expect(new Set(merged.items.map((i) => i.listingId))).toEqual(new Set([l1.listingId, l2.listingId]));

    // Гостевая корзина после слияния пуста: лоты теперь принадлежат аккаунту.
    const guestAfter = (await list("guest-visitor-3")).json() as { count: number };
    expect(guestAfter.count).toBe(0);
  });

  it("изменение цены после добавления помечается явно", async () => {
    const l = await mkListing(10_000);
    await add(l.listingId, "guest-visitor-4");
    await world.ctx.db.update(listings).set({ priceCents: 11_000 }).where(eq(listings.id, l.listingId));
    const view = (await list("guest-visitor-4")).json() as { items: Array<{ priceChanged: boolean; totalCents: number }> };
    expect(view.items[0]!.priceChanged).toBe(true);
    // Показывается живая цена движка, не снимок из корзины.
    expect(view.items[0]!.totalCents).toBe(11_000);
  });

  it("оформление: заказы создаются, ушедший другому лот к оплате не попадает", async () => {
    const mine = await mkListing();
    const contested = await mkListing();
    const me = await register("cart.buyer@test.lv");
    await add(mine.listingId, undefined, me.accessToken);
    await add(contested.listingId, undefined, me.accessToken);

    // Пока резерв жив, лот у человека не отнять; но он думал дольше десяти
    // минут — резерв истёк, и спорный лот купил другой, мимо корзины.
    const rival = await register("cart.rival@test.lv");
    const rivalBuy = () =>
      world.server.app.inject({
        method: "POST",
        url: `/api/public/listings/${contested.listingId}/buy`,
        headers: { authorization: `Bearer ${rival.accessToken}` },
      });
    expect((await rivalBuy()).statusCode).toBe(409);
    world.setNow(new Date(world.ctx.now().getTime() + 11 * 60_000));
    expect((await rivalBuy()).statusCode).toBe(200);

    const checkout = await world.server.app.inject({
      method: "POST",
      url: "/api/public/cart/checkout",
      headers: { authorization: `Bearer ${me.accessToken}` },
      payload: {},
    });
    expect(checkout.statusCode).toBe(200);
    const body = checkout.json() as {
      ok: boolean;
      orders: Array<{ ref: string; totalCents: number; listingId: string }>;
      unavailable: Array<{ listingId: string; title: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0]!.listingId).toBe(mine.listingId);
    expect(body.unavailable.map((u) => u.listingId)).toEqual([contested.listingId]);

    // Заказ настоящий и ровно один; спорный лот принадлежит сопернику.
    const [ord] = await world.ctx.db.select().from(orders).where(eq(orders.ref, body.orders[0]!.ref));
    expect(ord!.customerId).toBe(me.bidder.id);
    expect(ord!.status).toBe("awaiting_payment");
    const contestedOrders = await world.ctx.db.select().from(orders).where(eq(orders.listingId, contested.listingId));
    expect(contestedOrders).toHaveLength(1);
    expect(contestedOrders[0]!.customerId).toBe(rival.bidder.id);

    // Корзина после оформления пуста.
    const after = (await list(undefined, me.accessToken)).json() as { count: number };
    expect(after.count).toBe(0);
    world.setNow(null);
  });

  it("тип продажи заказа решает движок: auction против buy_now", async () => {
    const me = await register("cart.saletype@test.lv");

    // Покупка фикс-лота через корзину → buy_now.
    const fixed = await mkListing();
    await add(fixed.listingId, undefined, me.accessToken);
    const checkout = await world.server.app.inject({
      method: "POST",
      url: "/api/public/cart/checkout",
      headers: { authorization: `Bearer ${me.accessToken}` },
      payload: {},
    });
    expect(checkout.statusCode).toBe(200);

    // Заказ, рождённый торгами, кладём напрямую — проверяем поле, не торги.
    n += 1;
    const [aItem] = await world.ctx.db
      .insert(items)
      .values({ sku: `CART-${n}`, title: "Изысканный лот", marketCode: "LV", status: "awaiting_payment" })
      .returning({ id: items.id });
    const [aListing] = await world.ctx.db
      .insert(listings)
      .values({ itemId: aItem!.id, type: "auction", title: "Изысканный лот", marketCode: "LV", startPriceCents: 5_000, status: "published" })
      .returning({ id: listings.id });
    const now = world.ctx.now();
    const [auction] = await world.ctx.db
      .insert(auctions)
      .values({ listingId: aListing!.id, status: "ended_won", startsAt: now, endsAt: now })
      .returning({ id: auctions.id });
    await world.ctx.db.insert(orders).values({
      ref: "A-8801", auctionId: auction!.id, listingId: aListing!.id, itemId: aItem!.id,
      customerId: me.bidder.id, customerAlias: "cartsaletype", customerEmail: "cart.saletype@test.lv",
      marketCode: "LV",
      hammerCents: 5_000, premiumCents: 500, vatCents: 1_155, vatRateBp: 2_100,
      totalCents: 6_655, status: "awaiting_payment",
    });

    const mine = await world.server.app.inject({
      method: "GET",
      url: "/api/public/me/orders",
      headers: { authorization: `Bearer ${me.accessToken}` },
    });
    expect(mine.statusCode).toBe(200);
    const byRef = new Map(
      (mine.json() as { orders: Array<{ ref: string; saleType: string }> }).orders.map((o) => [o.ref, o.saleType]),
    );
    expect(byRef.get("A-8801")).toBe("auction");
    const bought = (checkout.json() as { orders: Array<{ ref: string }> }).orders[0]!.ref;
    expect(byRef.get(bought)).toBe("buy_now");
  });

  it("оформляется только отмеченное — остальное остаётся лежать", async () => {
    const a = await mkListing();
    const b = await mkListing();
    const me = await register("cart.subset@test.lv");
    await add(a.listingId, undefined, me.accessToken);
    await add(b.listingId, undefined, me.accessToken);

    const checkout = await world.server.app.inject({
      method: "POST",
      url: "/api/public/cart/checkout",
      headers: { authorization: `Bearer ${me.accessToken}` },
      payload: { listing_ids: [a.listingId] },
    });
    expect(checkout.statusCode).toBe(200);
    const body = checkout.json() as { orders: Array<{ listingId: string }> };
    expect(body.orders.map((o) => o.listingId)).toEqual([a.listingId]);

    const after = (await list(undefined, me.accessToken)).json() as { items: Array<{ listingId: string }> };
    expect(after.items.map((i) => i.listingId)).toEqual([b.listingId]);
  });

  it("остаток больше единицы: продажа списывает одну, лот живёт до последней", async () => {
    const l = await mkListing(10_000, 3);
    const a = await register("stock.a@test.lv");
    const b = await register("stock.b@test.lv");
    const buy = (token: string) =>
      world.server.app.inject({
        method: "POST",
        url: `/api/public/listings/${l.listingId}/buy`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });

    expect((await buy(a.accessToken)).statusCode).toBe(200);
    expect((await buy(b.accessToken)).statusCode).toBe(200);

    // Остаток честно уменьшился, лот всё ещё в продаже, витринная карточка
    // не тронута; у каждой проданной единицы — собственная складская карточка.
    const [row] = await world.ctx.db.select().from(listings).where(eq(listings.id, l.listingId));
    expect(row!.quantity).toBe(1);
    expect(row!.status).toBe("published");
    const [display] = await world.ctx.db.select().from(items).where(eq(items.id, l.itemId));
    expect(display!.status).toBe("listed");
    const sold = await world.ctx.db.select().from(orders).where(eq(orders.listingId, l.listingId));
    expect(sold).toHaveLength(2);
    expect(new Set(sold.map((o) => o.itemId)).size).toBe(2);
    expect(sold.every((o) => o.itemId !== l.itemId)).toBe(true);

    // Последнюю единицу продаём классическим путём: лот закрывается.
    const c = await register("stock.c@test.lv");
    expect((await buy(c.accessToken)).statusCode).toBe(200);
    const [closed] = await world.ctx.db.select().from(listings).where(eq(listings.id, l.listingId));
    expect(closed!.quantity).toBe(0);
    expect(closed!.status).toBe("archived");
    const [displayAfter] = await world.ctx.db.select().from(items).where(eq(items.id, l.itemId));
    expect(displayAfter!.status).toBe("awaiting_payment");
  });

  it("резерв держит одну единицу из остатка, а не весь лот", async () => {
    const l = await mkListing(10_000, 2);
    await add(l.listingId, "resv-guest-1");
    const start = await world.server.app.inject({
      method: "POST",
      url: "/api/public/cart/checkout-start",
      payload: { visitor_id: "resv-guest-1" },
    });
    expect(start.statusCode).toBe(200);
    const sr = start.json() as { reserved: Array<{ until: number }>; reservedUntil: number | null };
    expect(sr.reserved).toHaveLength(1);
    expect(sr.reservedUntil).toBeGreaterThan(world.ctx.now().getTime());

    // Одна единица придержана — вторая свободна: чужая покупка проходит.
    const rival = await register("resv.rival@test.lv");
    const buy = () =>
      world.server.app.inject({
        method: "POST",
        url: `/api/public/listings/${l.listingId}/buy`,
        headers: { authorization: `Bearer ${rival.accessToken}` },
        payload: {},
      });
    expect((await buy()).statusCode).toBe(200);
    // А вот последняя единица — за оформляющим: чужая покупка ждёт.
    expect((await buy()).statusCode).toBe(409);

    // Хозяин резерва входит и забирает свою единицу.
    const me = await register("resv.owner@test.lv");
    const checkout = await world.server.app.inject({
      method: "POST",
      url: "/api/public/cart/checkout",
      headers: { authorization: `Bearer ${me.accessToken}` },
      payload: { visitor_id: "resv-guest-1" },
    });
    expect(checkout.statusCode).toBe(200);
    expect((checkout.json() as { orders: unknown[] }).orders).toHaveLength(1);
  });

  it("просроченный резерв снимается сам", async () => {
    const l = await mkListing(10_000, 1);
    await add(l.listingId, "resv-guest-2");
    const start = await world.server.app.inject({
      method: "POST",
      url: "/api/public/cart/checkout-start",
      payload: { visitor_id: "resv-guest-2" },
    });
    expect(start.statusCode).toBe(200);

    const rival = await register("resv.late@test.lv");
    const buy = () =>
      world.server.app.inject({
        method: "POST",
        url: `/api/public/listings/${l.listingId}/buy`,
        headers: { authorization: `Bearer ${rival.accessToken}` },
        payload: {},
      });
    // Пока резерв жив — единица занята.
    expect((await buy()).statusCode).toBe(409);
    // Одиннадцать минут спустя резерв истёк, и лот снова общий.
    world.setNow(new Date(world.ctx.now().getTime() + 11 * 60_000));
    try {
      expect((await buy()).statusCode).toBe(200);
    } finally {
      world.setNow(null);
    }
  });

  it("оформление без входа невозможно, пустая корзина не оформляется", async () => {
    const anon = await world.server.app.inject({ method: "POST", url: "/api/public/cart/checkout", payload: {} });
    expect(anon.statusCode).toBe(401);

    const empty = await register("cart.empty@test.lv");
    const res = await world.server.app.inject({
      method: "POST",
      url: "/api/public/cart/checkout",
      headers: { authorization: `Bearer ${empty.accessToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(409);
  });
});
