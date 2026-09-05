import { createHash } from "node:crypto";
import { cookieConsents, customers, items, listings, metaEvents, orders } from "@auction/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildUserData, hasMarketingConsent } from "../src/engine/metaCapi.js";
import { purchaseEventId, purchaseToMeta } from "../src/engine/metaPurchase.js";
import { createWorld, type TestWorld } from "./helpers.js";

const sha = (v: string) => createHash("sha256").update(v).digest("hex");

/**
 * Meta Conversions API: нормализация и хеширование, согласие как обязательное
 * условие отправки, единый event_id для браузера и сервера.
 *
 * Сеть здесь не трогаем — проверяем ровно то, что решает наш код: что уходит,
 * кому и при каких условиях.
 */
describe("Meta CAPI: данные, согласие, дедупликация", () => {
  let world: TestWorld;
  let bidderId: string;

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
    // С выключенной интеграцией движок молчит целиком — а проверяем мы как
    // раз включённую: что она отправляет и, главное, чего не отправляет.
    world = await createWorld({
      META_CAPI_ACCESS_TOKEN: "test-token-not-real",
      META_DATASET_ID: "1042398411738942",
    });
    const me = await register("meta.me@test.lv");
    bidderId = me.bidder.id;
  });
  afterAll(async () => {
    if (world) await world.close();
  });

  it("нормализует и хеширует всё, что требует Meta, и ничего пустого не шлёт", () => {
    const ud = buildUserData({
      customerId: "cust-1",
      email: "  Aija.Demo@Example.LV ",
      phone: "+371 20 000 001",
      name: "  Aija   Demo  ",
      country: "LV",
      zip: "LV- 1010",
      city: " Rīga ",
      ip: "1.2.3.4",
      userAgent: "Mozilla/5.0",
      fbp: "fb.1.1.2",
      fbc: "fb.1.1.abc",
    });

    expect(ud.em).toEqual([sha("aija.demo@example.lv")]);
    expect(ud.ph).toEqual([sha("37120000001")]);
    expect(ud.fn).toEqual([sha("aija")]);
    expect(ud.ln).toEqual([sha("demo")]);
    expect(ud.country).toEqual([sha("lv")]);
    expect(ud.zp).toEqual([sha("lv-1010")]);
    expect(ud.external_id).toEqual([sha("cust-1")]);
    // Эти четыре Meta требует в открытом виде — хешировать их нельзя.
    expect(ud.client_ip_address).toBe("1.2.3.4");
    expect(ud.client_user_agent).toBe("Mozilla/5.0");
    expect(ud.fbp).toBe("fb.1.1.2");
    expect(ud.fbc).toBe("fb.1.1.abc");

    // Пустое и отсутствующее не превращается в пустые строки: Meta считает
    // такие поля мусорными, и они портят оценку качества сопоставления.
    const bare = buildUserData({ email: "   ", phone: "12", name: "" });
    expect(bare.em).toBeUndefined();
    expect(bare.ph).toBeUndefined();
    expect(bare.fn).toBeUndefined();
  });

  it("согласие берётся из журнала, а не из факта входа", async () => {
    // Аккаунт есть, согласия нет — отправлять нельзя.
    expect(await hasMarketingConsent(world.ctx, { customerId: bidderId })).toBe(false);

    await world.ctx.db.insert(cookieConsents).values({
      customerId: bidderId, visitorId: "v-meta-1", mode: "reject",
      analytics: false, marketing: false, policyVersion: "2026-08-21", host: "izsoli.lv",
    });
    expect(await hasMarketingConsent(world.ctx, { customerId: bidderId })).toBe(false);

    // Человек передумал — считается ПОСЛЕДНЕЕ решение.
    await world.ctx.db.insert(cookieConsents).values({
      customerId: bidderId, visitorId: "v-meta-1", mode: "accept",
      analytics: true, marketing: true, policyVersion: "2026-08-21", host: "izsoli.lv",
    });
    expect(await hasMarketingConsent(world.ctx, { customerId: bidderId })).toBe(true);

    // Гость до регистрации — по идентификатору браузера.
    expect(await hasMarketingConsent(world.ctx, { visitorId: "v-meta-1" })).toBe(true);
    expect(await hasMarketingConsent(world.ctx, { visitorId: "v-unknown" })).toBe(false);
    expect(await hasMarketingConsent(world.ctx, {})).toBe(false);
  });

  it("точка приёма не отправляет без согласия и не принимает покупку от браузера", async () => {
    const guest = await register("meta.guest@test.lv");
    const post = (payload: Record<string, unknown>, token?: string) =>
      world.server.app.inject({
        method: "POST",
        url: "/api/public/meta/event",
        ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
        payload,
      });

    // Согласия у этого человека нет — событие отмечается как пропущенное.
    const denied = await post({
      event_name: "ViewContent",
      event_id: "vc-no-consent-1",
      event_source_url: "https://izsoli.lv/auction/x",
    }, guest.accessToken);
    expect(denied.statusCode).toBe(200);
    expect((denied.json() as { sent: boolean }).sent).toBe(false);
    const [skipped] = await world.ctx.db
      .select().from(metaEvents).where(eq(metaEvents.eventId, "vc-no-consent-1"));
    expect(skipped!.status).toBe("skipped");
    expect(skipped!.error).toBe("no_marketing_consent");

    // Покупку со слов браузера не принимаем ни при каком согласии.
    const purchase = await post({
      event_name: "Purchase",
      event_id: "purchase-A-0001",
      event_source_url: "https://izsoli.lv/account",
    });
    expect((purchase.json() as { sent: boolean }).sent).toBe(false);

    // Чужие имена событий отбиваются схемой.
    const bogus = await post({
      event_name: "Whatever",
      event_id: "x-1",
      event_source_url: "https://izsoli.lv/",
    });
    expect(bogus.statusCode).toBe(400);
  });

  it("покупка: event_id по правилу, без согласия — не отправляется", async () => {
    const buyer = await register("meta.buyer@test.lv");
    const [item] = await world.ctx.db
      .insert(items).values({ sku: "META-1", title: "Lote", marketCode: "LV", status: "paid" })
      .returning({ id: items.id });
    const [listing] = await world.ctx.db
      .insert(listings)
      .values({ itemId: item!.id, type: "fixed", title: "Lote", marketCode: "LV", priceCents: 12_100, status: "sold" })
      .returning({ id: listings.id });
    const [order] = await world.ctx.db
      .insert(orders)
      .values({
        ref: "A-9001", listingId: listing!.id, itemId: item!.id,
        customerId: buyer.bidder.id, customerAlias: "metabuyer", customerEmail: "meta.buyer@test.lv",
        marketCode: "LV",
        hammerCents: 9_090, premiumCents: 909, vatCents: 2_101, vatRateBp: 2_100,
        totalCents: 12_100, status: "paid", paidAt: world.ctx.now(),
      })
      .returning();

    // Правило совпадает с тем, что строит витрина.
    expect(purchaseEventId("A-9001")).toBe("purchase-A-9001");

    await purchaseToMeta(world.ctx, order!);
    const [row] = await world.ctx.db
      .select().from(metaEvents).where(eq(metaEvents.eventId, "purchase-A-9001"));
    expect(row!.status).toBe("skipped");
    expect(row!.error).toBe("no_marketing_consent");
    expect(row!.customerId).toBe(buyer.bidder.id);
  });

  it("удалённый аккаунт данных не отдаёт", async () => {
    const gone = await register("meta.gone@test.lv");
    await world.ctx.db
      .update(customers).set({ erasedAt: world.ctx.now() }).where(eq(customers.id, gone.bidder.id));
    const { identityOfCustomer } = await import("../src/engine/metaCapi.js");
    expect(await identityOfCustomer(world.ctx, gone.bidder.id)).toEqual({});
  });
});
