import { customers } from "@auction/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createWorld, loginAs, type TestWorld } from "./helpers.js";

/**
 * Согласия: на cookie и на рассылку.
 *
 * Обе вещи раньше не существовали. Выбор в плашке cookie записывался только в
 * браузер посетителя и не читался вообще ничем, а согласия на маркетинг не было
 * ни в базе, ни в API. GDPR (ст. 7 п. 1) требует уметь показать, что человек
 * соглашался, — эти проверки за тем и написаны.
 */
describe("согласия", () => {
  let world: TestWorld;
  let adminToken: string;

  beforeAll(async () => {
    world = await createWorld();
    adminToken = await loginAs(world, "super@auction.test");
  });
  afterAll(async () => {
    if (world) await world.close();
  });

  const register = async (email: string, marketingOptIn?: boolean) => {
    const res = await world.server.app.inject({
      method: "POST",
      url: "/api/public/auth/register",
      payload: {
        email,
        alias: email.split("@")[0]!.replace(/[^a-z0-9_.-]/gi, "").slice(0, 20),
        password: "Bidder123!",
        country: "LV",
        ...(marketingOptIn === undefined ? {} : { marketingOptIn }),
      },
    });
    expect(res.statusCode, `регистрация ${email}`).toBe(200);
    return (res.json() as { accessToken: string; bidder: { id: string } });
  };

  it("записывает решение гостя и отдаёт его обратно тому же браузеру", async () => {
    const visitorId = "visitor-guest-0001";
    const post = await world.server.app.inject({
      method: "POST",
      url: "/api/public/consent",
      payload: { visitorId, mode: "custom", analytics: true, marketing: false },
    });
    expect(post.statusCode).toBe(200);

    const get = await world.server.app.inject({
      method: "GET",
      url: `/api/public/consent?visitorId=${visitorId}`,
    });
    const body = get.json() as {
      consent: { mode: string; analytics: boolean; marketing: boolean } | null;
      stale: boolean;
    };
    expect(body.consent, "решение нашлось").toBeTruthy();
    expect(body.consent!.mode).toBe("custom");
    expect(body.consent!.analytics).toBe(true);
    expect(body.consent!.marketing).toBe(false);
    expect(body.stale, "редакция текста та же — спрашивать заново не нужно").toBe(false);
  });

  it("не выдаёт чужое решение другому браузеру", async () => {
    const get = await world.server.app.inject({
      method: "GET",
      url: "/api/public/consent?visitorId=visitor-nobody-9999",
    });
    expect((get.json() as { consent: unknown }).consent).toBeNull();
  });

  it("хранит историю: каждое решение — отдельная запись, действует последнее", async () => {
    const visitorId = "visitor-changes-mind";
    for (const mode of ["accept", "reject"]) {
      const res = await world.server.app.inject({
        method: "POST",
        url: "/api/public/consent",
        payload: { visitorId, mode, analytics: mode === "accept", marketing: mode === "accept" },
      });
      expect(res.statusCode).toBe(200);
    }
    const get = await world.server.app.inject({
      method: "GET",
      url: `/api/public/consent?visitorId=${visitorId}`,
    });
    // Отзыв — последний по времени, значит он и действует.
    expect((get.json() as { consent: { mode: string } }).consent.mode).toBe("reject");

    const log = await world.server.app.inject({
      method: "GET",
      url: "/api/consents",
      headers: auth(adminToken),
    });
    expect(log.statusCode).toBe(200);
    const rows = (log.json() as { consents: Array<{ visitorId: string }> }).consents;
    // Обе строки на месте: прежнее согласие не переписано отзывом.
    expect(rows.filter((r) => r.visitorId === visitorId)).toHaveLength(2);
  });

  it("привязывает согласие вошедшего к аккаунту, а не к браузеру", async () => {
    const { accessToken } = await register("consent.linked@test.lv");
    const post = await world.server.app.inject({
      method: "POST",
      url: "/api/public/consent",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { visitorId: "visitor-phone-A", mode: "accept", analytics: true, marketing: true },
    });
    expect(post.statusCode).toBe(200);

    // Второе устройство: другой браузер, тот же человек — спрашивать не нужно.
    const other = await world.server.app.inject({
      method: "GET",
      url: "/api/public/consent?visitorId=visitor-laptop-B",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect((other.json() as { consent: { mode: string } | null }).consent?.mode).toBe("accept");
  });

  it("не ставит согласия на рассылку без явной галочки", async () => {
    const { bidder } = await register("consent.silent@test.lv");
    const [row] = await world.ctx.db.select().from(customers).where(eq(customers.id, bidder.id));
    // Молчание согласием не является: отсутствие галочки — это false, не null.
    expect(row!.marketingOptIn).toBe(false);
    expect(row!.marketingOptInAt).toBeNull();
  });

  it("записывает согласие на рассылку с датой и источником", async () => {
    const { bidder } = await register("consent.optin@test.lv", true);
    const [row] = await world.ctx.db.select().from(customers).where(eq(customers.id, bidder.id));
    expect(row!.marketingOptIn).toBe(true);
    expect(row!.marketingOptInAt, "без даты согласие ничего не стоит").toBeTruthy();
    expect(row!.marketingSource).toBe("register");
  });

  it("даёт отозвать рассылку из кабинета и сохраняет след отзыва", async () => {
    const { accessToken, bidder } = await register("consent.optout@test.lv", true);
    const off = await world.server.app.inject({
      method: "POST",
      url: "/api/public/me/marketing",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { optIn: false },
    });
    expect(off.statusCode).toBe(200);

    const [row] = await world.ctx.db.select().from(customers).where(eq(customers.id, bidder.id));
    expect(row!.marketingOptIn).toBe(false);
    expect(row!.marketingOptOutAt, "отзыв тоже нужно уметь показать").toBeTruthy();
    // Дату согласия не стираем — иначе не доказать, что оно вообще было.
    expect(row!.marketingOptInAt).toBeTruthy();

    const me = await world.server.app.inject({
      method: "GET",
      url: "/api/public/auth/me",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect((me.json() as { bidder: { marketingOptIn: boolean } }).bidder.marketingOptIn).toBe(false);
  });

  it("правит профиль через PATCH /me: ник и рассылку, с теми же датами согласия", async () => {
    const { accessToken, bidder } = await register("consent.patchme@test.lv");

    // Ник: кабинет шлёт только то, что менялось.
    const alias = await world.server.app.inject({
      method: "PATCH",
      url: "/api/public/me",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { alias: "jauns.niks" },
    });
    expect(alias.statusCode).toBe(200);
    expect((alias.json() as { alias: string }).alias).toBe("jauns.niks");

    // Рассылка тем же маршрутом обязана оставлять тот же след, что и остальные входы.
    const on = await world.server.app.inject({
      method: "PATCH",
      url: "/api/public/me",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { marketingOptIn: true },
    });
    expect(on.statusCode).toBe(200);
    let [row] = await world.ctx.db.select().from(customers).where(eq(customers.id, bidder.id));
    expect(row!.alias).toBe("jauns.niks");
    expect(row!.marketingOptIn).toBe(true);
    expect(row!.marketingOptInAt, "без даты согласие ничего не стоит").toBeTruthy();
    expect(row!.marketingSource).toBe("account");

    const off = await world.server.app.inject({
      method: "PATCH",
      url: "/api/public/me",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { marketingOptIn: false },
    });
    expect(off.statusCode).toBe(200);
    [row] = await world.ctx.db.select().from(customers).where(eq(customers.id, bidder.id));
    expect(row!.marketingOptIn).toBe(false);
    expect(row!.marketingOptOutAt, "отзыв тоже нужно уметь показать").toBeTruthy();
    expect(row!.marketingOptInAt, "дату согласия не стираем").toBeTruthy();

    // Пустой запрос и кривой ник — отказ, без записи.
    const empty = await world.server.app.inject({
      method: "PATCH",
      url: "/api/public/me",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
    const bad = await world.server.app.inject({
      method: "PATCH",
      url: "/api/public/me",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { alias: "x" },
    });
    expect(bad.statusCode).toBe(400);
    const anon = await world.server.app.inject({
      method: "PATCH",
      url: "/api/public/me",
      payload: { alias: "kadscits" },
    });
    expect(anon.statusCode).toBe(401);
  });

  it("показывает согласие в списке клиентов и умеет отобрать согласившихся", async () => {
    await register("consent.listed@test.lv", true);
    const res = await world.server.app.inject({
      method: "GET",
      url: "/api/customers?marketing=yes&limit=200",
      headers: auth(adminToken),
    });
    expect(res.statusCode).toBe(200);
    const list = (res.json() as { customers: Array<{ email: string; marketingOptIn: boolean }> }).customers;
    expect(list.every((c) => c.marketingOptIn), "в выборке только согласившиеся").toBe(true);
    expect(list.some((c) => c.email === "consent.listed@test.lv")).toBe(true);
  });

  it("держит журнал согласий за правом смотреть клиентов", async () => {
    const warehouse = await loginAs(world, "wh@auction.test").catch(() => null);
    if (!warehouse) return; // роли склада в мире нет — проверять нечего
    const res = await world.server.app.inject({
      method: "GET",
      url: "/api/consents",
      headers: auth(warehouse),
    });
    expect(res.statusCode).toBe(403);
  });
});
