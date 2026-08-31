import { cookieConsents, customers, items, listings, orders } from "@auction/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorld, loginAs, type TestWorld } from "./helpers.js";

/**
 * Атрибуция от и до: два касания, сшивка согласия гостя с аккаунтом, способ
 * входа, снимок на заказе, отчёт по обеим моделям и расшифровка строки.
 */
describe("откуда пришёл клиент: касания, согласия, отчёт", () => {
  let world: TestWorld;
  let token: string;
  let bidderId: string;
  let adminToken: string;

  const register = async (email: string) => {
    const res = await world.server.app.inject({
      method: "POST",
      url: "/api/public/auth/register",
      payload: { email, alias: email.split("@")[0]!.replace(/[^a-z0-9]/gi, ""), password: "Bidder123!" },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as { accessToken: string; bidder: { id: string } };
  };

  beforeAll(async () => {
    world = await createWorld();
    const me = await register("attr.me@test.lv");
    token = me.accessToken;
    bidderId = me.bidder.id;
    adminToken = await loginAs(world, "super@auction.test");
  });
  afterAll(async () => {
    if (world) await world.close();
  });

  const post = (payload: Record<string, unknown>) =>
    world.server.app.inject({
      method: "POST",
      url: "/api/public/me/attribution",
      headers: { authorization: `Bearer ${token}` },
      payload,
    });

  it("первое касание пишется один раз, последнее — на каждом визите", async () => {
    await post({
      first: { source: "google", medium: "cpc", campaign: "vasara", landing: "/katalogs" },
      last: { source: "google", medium: "cpc", campaign: "vasara", landing: "/katalogs" },
    });
    let [row] = await world.ctx.db.select().from(customers).where(eq(customers.id, bidderId));
    expect(row!.attribution?.source).toBe("google");
    expect(row!.attributionLast?.campaign).toBe("vasara");
    expect(row!.attributionTouches).toBe(1);

    // Второй визит — по рассылке. Первое касание обязано устоять.
    await post({
      first: { source: "facebook", medium: "paid_social" },
      last: { source: "email", medium: "email", campaign: "atgriesanas" },
    });
    [row] = await world.ctx.db.select().from(customers).where(eq(customers.id, bidderId));
    expect(row!.attribution?.source).toBe("google");
    expect(row!.attributionLast?.source).toBe("email");
    expect(row!.attributionLast?.campaign).toBe("atgriesanas");
    expect(row!.attributionTouches).toBe(2);
  });

  it("старый плоский вид тела всё ещё принимается", async () => {
    const other = await register("attr.flat@test.lv");
    const res = await world.server.app.inject({
      method: "POST",
      url: "/api/public/me/attribution",
      headers: { authorization: `Bearer ${other.accessToken}` },
      payload: { source: "tiktok", medium: "paid_social" },
    });
    expect(res.statusCode).toBe(200);
    const [row] = await world.ctx.db.select().from(customers).where(eq(customers.id, other.bidder.id));
    expect(row!.attribution?.source).toBe("tiktok");
    // Одно касание — оба поля заполнены им же.
    expect(row!.attributionLast?.source).toBe("tiktok");
  });

  it("id браузера сшивает согласие, данное до регистрации", async () => {
    const visitorId = "visitor-abc-123";
    // Гость решил про cookie до того, как завёл аккаунт.
    await world.ctx.db.insert(cookieConsents).values({
      visitorId,
      mode: "custom",
      analytics: true,
      marketing: false,
      policyVersion: "2026-08-21",
      host: "izsoli.lv",
    });
    await post({ visitorId });

    const res = await world.server.app.inject({
      method: "GET",
      url: `/api/customers/${bidderId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { customer: { visitorId: string }; consents: Array<{ mode: string; viaVisitor: boolean }> };
    expect(body.customer.visitorId).toBe(visitorId);
    const guest = body.consents.find((c) => c.mode === "custom");
    expect(guest).toBeDefined();
    expect(guest!.viaVisitor).toBe(true);
  });

  it("способ входа записывается: пароль сейчас, обновление токена — нет", async () => {
    const login = await world.server.app.inject({
      method: "POST",
      url: "/api/public/auth/login",
      payload: { email: "attr.me@test.lv", password: "Bidder123!" },
    });
    expect(login.statusCode).toBe(200);
    const [row] = await world.ctx.db.select().from(customers).where(eq(customers.id, bidderId));
    expect(row!.lastLoginMethod).toBe("password");
    expect(row!.lastLoginAt).not.toBeNull();

    const before = row!.lastLoginAt!.getTime();
    const { refreshToken } = login.json() as { refreshToken: string };
    await world.server.app.inject({ method: "POST", url: "/api/public/auth/refresh", payload: { refreshToken } });
    const [after] = await world.ctx.db.select().from(customers).where(eq(customers.id, bidderId));
    expect(after!.lastLoginAt!.getTime()).toBe(before);
  });

  it("заказ несёт оба снимка, отчёт считает по обеим моделям и расшифровывается", async () => {
    // Заказ кладём напрямую: проверяем отчёт, а не движок покупки.
    const [item] = await world.ctx.db
      .insert(items)
      .values({ sku: "ATTR-1", title: "Lote", marketCode: "LV", status: "paid" })
      .returning({ id: items.id });
    const [listing] = await world.ctx.db
      .insert(listings)
      .values({ itemId: item!.id, type: "fixed", title: "Lote", marketCode: "LV", priceCents: 12_100, status: "sold" })
      .returning({ id: listings.id });
    await world.ctx.db.insert(orders).values({
      ref: "A-7001",
      listingId: listing!.id,
      itemId: item!.id,
      customerId: bidderId,
      customerAlias: "attrme",
      customerEmail: "attr.me@test.lv",
      marketCode: "LV",
      hammerCents: 9_090, premiumCents: 909, vatCents: 2_101, vatRateBp: 2_100,
      totalCents: 12_100,
      status: "paid",
      attribution: { source: "google", medium: "cpc", campaign: "vasara" },
      attributionLast: { source: "email", medium: "email", campaign: "atgriesanas" },
    });

    const report = async (model: string) => {
      const res = await world.server.app.inject({
        method: "GET",
        url: `/api/reports/marketing?model=${model}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      return res.json() as { rows: Array<{ source: string; campaign: string; paidOrders: number; revenueCents: number }> };
    };

    // Первое касание отдаёт выручку тому, кто привёл; последнее — письму.
    const first = await report("first");
    expect(first.rows.find((r) => r.source === "google")?.revenueCents).toBe(12_100);
    expect(first.rows.find((r) => r.source === "email")).toBeUndefined();

    const last = await report("last");
    expect(last.rows.find((r) => r.source === "email")?.revenueCents).toBe(12_100);
    expect(last.rows.find((r) => r.source === "google")?.paidOrders ?? 0).toBe(0);

    // Расшифровка строки: тот самый заказ и тот самый человек.
    const detail = await world.server.app.inject({
      method: "GET",
      url: "/api/reports/marketing/detail?model=last&source=email&medium=email&campaign=atgriesanas",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(detail.statusCode).toBe(200);
    const d = detail.json() as { orders: Array<{ ref: string }>; revenueCents: number };
    expect(d.orders.map((o) => o.ref)).toContain("A-7001");
    expect(d.revenueCents).toBe(12_100);

    // Тот же отбор в списке заказов — ссылка «открыть в списке» из отчёта.
    const list = await world.server.app.inject({
      method: "GET",
      url: "/api/orders?attrModel=last&attrSource=email&attrMedium=email&attrCampaign=atgriesanas",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(list.statusCode).toBe(200);
    const l = list.json() as { orders: Array<{ ref: string }> };
    expect(l.orders.map((o) => o.ref)).toEqual(["A-7001"]);
  });

  it("карточка заказа показывает покупателя и его касания", async () => {
    const [order] = await world.ctx.db.select({ id: orders.id }).from(orders).where(eq(orders.ref, "A-7001"));
    const res = await world.server.app.inject({
      method: "GET",
      url: `/api/orders/${order!.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      order: { attribution: { source: string }; attributionLast: { source: string } };
      buyer: { alias: string; ordersCount: number; lastLoginMethod: string } | null;
    };
    expect(body.order.attribution.source).toBe("google");
    expect(body.order.attributionLast.source).toBe("email");
    expect(body.buyer?.alias).toBe("attrme");
    expect(body.buyer?.ordersCount).toBe(1);
    expect(body.buyer?.lastLoginMethod).toBe("password");
  });
});
