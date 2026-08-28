import { auctions, customers, items, listings, notifications, savedSearches, watchlist } from "@auction/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { enqueueMarketing } from "../src/engine/marketing.js";
import { runSavedSearchAlerts, runWatchlistEndingAlerts } from "../src/engine/marketingCrons.js";
import { dispatchNotifications } from "../src/engine/notifications.js";
import { unsubscribeToken, verifyUnsubscribeToken } from "../src/engine/unsubscribe.js";
import { createWorld, type TestWorld } from "./helpers.js";

/**
 * Коммуникации: вишлист в базе, отписка одной ссылкой, планировщик
 * маркетинговых писем и кроны запрошенных подборок (LC-02, вэлмес).
 */
describe("вишлист, отписка и маркетинговый планировщик", () => {
  let world: TestWorld;
  let token: string;
  let bidderId: string;

  /** Дневное рижское время: тихие часы не мешают, письма не откладываются. */
  const DAY = new Date("2026-08-24T10:00:00Z");

  const register = async (email: string, marketingOptIn = true) => {
    const res = await world.server.app.inject({
      method: "POST",
      url: "/api/public/auth/register",
      payload: {
        email,
        alias: email.split("@")[0]!.replace(/[^a-z0-9]/gi, ""),
        password: "Bidder123!",
        marketingOptIn,
      },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as { accessToken: string; bidder: { id: string } };
  };

  /** Живые торги с опубликованным лотом; возвращает id торгов. */
  const makeAuction = async (sku: string, title: string, opts: { endsInHours?: number; priceCents?: number } = {}) => {
    const now = world.ctx.now().getTime();
    const [item] = await world.ctx.db
      .insert(items)
      .values({ sku, title, marketCode: "LV", status: "live", category: "other", description: "", photos: [] })
      .returning({ id: items.id });
    const [listing] = await world.ctx.db
      .insert(listings)
      .values({ itemId: item!.id, type: "auction", title, marketCode: "LV", startPriceCents: opts.priceCents ?? 10_000, status: "published" })
      .returning({ id: listings.id });
    const [auction] = await world.ctx.db
      .insert(auctions)
      .values({
        listingId: listing!.id,
        status: "live",
        startsAt: new Date(now - 3_600_000),
        endsAt: new Date(now + (opts.endsInHours ?? 72) * 3_600_000),
        bidCount: 0,
        reserveMet: false,
      })
      .returning({ id: auctions.id });
    return auction!.id;
  };

  beforeAll(async () => {
    world = await createWorld();
    world.setNow(DAY);
    const me = await register("comms.me@test.lv");
    token = me.accessToken;
    bidderId = me.bidder.id;
  });
  afterAll(async () => {
    if (world) await world.close();
  });
  beforeEach(() => {
    world.setNow(DAY);
  });

  // ── Отписка ───────────────────────────────────────────────────────────────

  it("токен отписки: подпись сходится, подделка и чужой секрет — нет", () => {
    const t = unsubscribeToken(bidderId, world.ctx.config.jwtSecret);
    expect(verifyUnsubscribeToken(t, world.ctx.config.jwtSecret)).toBe(bidderId);
    expect(verifyUnsubscribeToken(t.slice(0, -1) + "x", world.ctx.config.jwtSecret)).toBeNull();
    expect(verifyUnsubscribeToken(t, "other-secret")).toBeNull();
    expect(verifyUnsubscribeToken("garbage", world.ctx.config.jwtSecret)).toBeNull();
  });

  it("POST /unsubscribe выключает рассылку без входа; /resubscribe возвращает", async () => {
    const t = unsubscribeToken(bidderId, world.ctx.config.jwtSecret);
    const res = await world.server.app.inject({
      method: "POST",
      url: `/api/public/unsubscribe?t=${encodeURIComponent(t)}`,
    });
    expect(res.statusCode).toBe(200);
    let [me] = await world.ctx.db.select().from(customers).where(eq(customers.id, bidderId));
    expect(me!.unsubscribedAt).not.toBeNull();
    expect(me!.marketingOptIn).toBe(false);

    // Повторный клик ничего не ломает.
    const again = await world.server.app.inject({
      method: "POST",
      url: `/api/public/unsubscribe?t=${encodeURIComponent(t)}`,
    });
    expect(again.statusCode).toBe(200);

    const back = await world.server.app.inject({
      method: "POST",
      url: `/api/public/resubscribe?t=${encodeURIComponent(t)}`,
    });
    expect(back.statusCode).toBe(200);
    [me] = await world.ctx.db.select().from(customers).where(eq(customers.id, bidderId));
    expect(me!.unsubscribedAt).toBeNull();
    expect(me!.marketingOptIn).toBe(true);
  });

  it("битый токен отвечает 400, а GET состояние не меняет", async () => {
    const bad = await world.server.app.inject({ method: "POST", url: "/api/public/unsubscribe?t=xx.yy" });
    expect(bad.statusCode).toBe(400);

    const t = unsubscribeToken(bidderId, world.ctx.config.jwtSecret);
    const get = await world.server.app.inject({ method: "GET", url: `/api/public/unsubscribe?t=${encodeURIComponent(t)}` });
    expect(get.statusCode).toBe(302);
    expect(get.headers.location).toContain("/atteikties?t=");
    const [me] = await world.ctx.db.select().from(customers).where(eq(customers.id, bidderId));
    expect(me!.unsubscribedAt).toBeNull();
  });

  // ── Вишлист ───────────────────────────────────────────────────────────────

  it("вишлист: слияние из браузера, добавление, удаление; чужие id не берутся", async () => {
    const a1 = await makeAuction("WL-1", "Krēsls Thonet");
    const a2 = await makeAuction("WL-2", "Galds ozola");
    const ghost = "00000000-0000-4000-8000-000000000000";

    // Слияние локального списка: живые id попадают, выдуманный — нет.
    const merged = await world.server.app.inject({
      method: "POST",
      url: "/api/public/me/watchlist",
      headers: { authorization: `Bearer ${token}` },
      payload: { ids: [a1, ghost] },
    });
    expect(merged.statusCode).toBe(200);
    expect((merged.json() as { ids: string[] }).ids).toEqual([a1]);

    // Одиночное добавление + идемпотентность.
    const add = await world.server.app.inject({
      method: "POST",
      url: `/api/public/me/watchlist/${a2}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(add.statusCode).toBe(200);
    await world.server.app.inject({
      method: "POST",
      url: `/api/public/me/watchlist/${a2}`,
      headers: { authorization: `Bearer ${token}` },
    });

    const list = await world.server.app.inject({
      method: "GET",
      url: "/api/public/me/watchlist",
      headers: { authorization: `Bearer ${token}` },
    });
    const ids = (list.json() as { ids: string[] }).ids;
    expect(ids).toHaveLength(2);
    expect(ids).toContain(a1);
    expect(ids).toContain(a2);

    // Несуществующий лот — 404, без записи.
    const miss = await world.server.app.inject({
      method: "POST",
      url: `/api/public/me/watchlist/${ghost}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(miss.statusCode).toBe(404);

    const del = await world.server.app.inject({
      method: "DELETE",
      url: `/api/public/me/watchlist/${a1}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.statusCode).toBe(200);
    const after = await world.server.app.inject({
      method: "GET",
      url: "/api/public/me/watchlist",
      headers: { authorization: `Bearer ${token}` },
    });
    expect((after.json() as { ids: string[] }).ids).toEqual([a2]);

    const anon = await world.server.app.inject({ method: "GET", url: "/api/public/me/watchlist" });
    expect(anon.statusCode).toBe(401);
  });

  // ── Планировщик ───────────────────────────────────────────────────────────

  it("планировщик: согласие, отписка, лимиты и ночная тишина", async () => {
    const person = await register("comms.limits@test.lv", false);
    const template = { alias: "", lotTitle: "", searchName: "Testi", totalCount: 1, lots: [{ title: "Lote", priceCents: 5_000 }] };

    // Без согласия подборка не уходит…
    const noConsent = await enqueueMarketing(world.ctx, world.ctx.db, {
      customerId: person.bidder.id, type: "saved_search_hits", template, dedupeKey: "lim:1",
    });
    expect(noConsent).toEqual({ ok: false, skip: "no_consent" });
    // …а запрошенное письмо — уходит.
    const explicit = await enqueueMarketing(world.ctx, world.ctx.db, {
      customerId: person.bidder.id, type: "saved_search_hits", template, dedupeKey: "lim:2", explicit: true,
    });
    expect(explicit.ok).toBe(true);

    // Отписка глушит даже запрошенные письма.
    await world.ctx.db.update(customers).set({ unsubscribedAt: world.ctx.now() }).where(eq(customers.id, person.bidder.id));
    const afterUnsub = await enqueueMarketing(world.ctx, world.ctx.db, {
      customerId: person.bidder.id, type: "saved_search_hits", template, dedupeKey: "lim:3", explicit: true,
    });
    expect(afterUnsub).toEqual({ ok: false, skip: "unsubscribed" });
    await world.ctx.db.update(customers).set({ unsubscribedAt: null, marketingOptIn: true }).where(eq(customers.id, person.bidder.id));

    // 48 часов между подборками: вторая сразу после первой не уходит.
    const gap = await enqueueMarketing(world.ctx, world.ctx.db, {
      customerId: person.bidder.id, type: "saved_search_hits", template, dedupeKey: "lim:4",
    });
    expect(gap).toEqual({ ok: false, skip: "too_soon" });

    // Осушаем очередь: дальше проверяем только ночное письмо.
    await dispatchNotifications(world.ctx);

    // Ночью письмо ждёт утра: поставлено в 23:30 Риги — уйдёт в 08:00.
    const night = new Date("2026-08-24T20:30:00Z"); // 23:30 Рига (лето, UTC+3)
    world.setNow(night);
    const fresh = await register("comms.night@test.lv");
    const queued = await enqueueMarketing(world.ctx, world.ctx.db, {
      customerId: fresh.bidder.id, type: "saved_search_hits", template, dedupeKey: "lim:5", explicit: true,
    });
    expect(queued.ok).toBe(true);
    if (queued.ok) {
      // 08:00 Риги = 05:00 UTC следующего дня.
      expect(queued.scheduledFor.toISOString()).toBe("2026-08-25T05:00:00.000Z");
    }

    // Диспетчер отложенное ночью письмо не берёт, а утром — отправляет
    // с заголовками отписки.
    world.email.sent.length = 0;
    await dispatchNotifications(world.ctx);
    expect(world.email.forType("saved_search_hits").length).toBe(0);

    world.setNow(new Date("2026-08-25T05:01:00Z"));
    await dispatchNotifications(world.ctx);
    const out = world.email.forType("saved_search_hits");
    expect(out.length).toBeGreaterThan(0);
    const headers = out[0]!.headers ?? {};
    expect(headers["List-Unsubscribe"]).toContain("/api/public/unsubscribe?t=");
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    // Видимая ссылка отписки в теле письма.
    expect(out[0]!.text).toContain("/atteikties?t=");
    expect(out[0]!.html).toContain("/atteikties?t=");
  });

  it("сервисное письмо уходит без заголовков отписки", async () => {
    world.email.sent.length = 0;
    await world.ctx.db.insert(notifications).values({
      customerId: bidderId,
      type: "outbid",
      toEmail: "comms.me@test.lv",
      lang: "lv",
      subject: "Tevi pārsolīja",
      body: "Pašreizējā cena 77,00 € [outbid]",
    });
    await dispatchNotifications(world.ctx);
    const out = world.email.forType("outbid");
    expect(out.length).toBe(1);
    expect(out[0]!.headers).toBeUndefined();
  });

  // ── Кроны ─────────────────────────────────────────────────────────────────

  it("крон LC-02: первый проход только ставит отметку, второй шлёт новые лоты", async () => {
    const person = await register("comms.search@test.lv");
    await world.ctx.db.insert(savedSearches).values({
      customerId: person.bidder.id,
      name: "Thonet krēsli",
      query: { q: "thonet" },
      alertEmail: true,
    });

    // До отметки лот есть, но письмо не уходит: «новых» ещё не бывает.
    await makeAuction("LC-OLD", "Thonet krēsls Nr.14");
    expect(await runSavedSearchAlerts(world.ctx)).toBe(0);

    // Новый лот после отметки — письмо с ним.
    world.setNow(new Date(DAY.getTime() + 3_600_000));
    const auctionId = await makeAuction("LC-NEW", "Thonet šūpuļkrēsls", { priceCents: 25_000 });
    // createdAt ставит база, а не world.setNow — сдвинем отметку поиска назад.
    await world.ctx.db
      .update(savedSearches)
      .set({ lastRunAt: new Date(DAY.getTime() - 3_600_000) })
      .where(eq(savedSearches.customerId, person.bidder.id));
    expect(await runSavedSearchAlerts(world.ctx)).toBe(1);

    const [queued] = await world.ctx.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.customerId, person.bidder.id), eq(notifications.type, "saved_search_hits")));
    expect(queued).toBeDefined();
    expect(queued!.kind).toBe("marketing");
    expect(queued!.subject).toContain("Thonet krēsli");
    expect(queued!.body).toContain("Thonet šūpuļkrēsls");
    expect(queued!.body).toContain("€250.00");

    // Тот же день — дубль не ставится, отметка сдвинута.
    await world.ctx.db
      .update(savedSearches)
      .set({ lastRunAt: new Date(DAY.getTime() - 3_600_000) })
      .where(eq(savedSearches.customerId, person.bidder.id));
    expect(await runSavedSearchAlerts(world.ctx)).toBe(0);
    void auctionId;
  });

  it("крон вэлмес: письмо про торги на исходе, один раз на лот", async () => {
    const person = await register("comms.watch@test.lv");
    const soon = await makeAuction("WE-1", "Omega pulkstenis", { endsInHours: 6, priceCents: 40_000 });
    const far = await makeAuction("WE-2", "Dīvāns", { endsInHours: 90 });
    await world.ctx.db.insert(watchlist).values([
      { customerId: person.bidder.id, auctionId: soon },
      { customerId: person.bidder.id, auctionId: far },
    ]);

    expect(await runWatchlistEndingAlerts(world.ctx)).toBe(1);
    const [queued] = await world.ctx.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.customerId, person.bidder.id), eq(notifications.type, "watchlist_ending")));
    expect(queued).toBeDefined();
    expect(queued!.body).toContain("Omega pulkstenis");
    expect(queued!.body).not.toContain("Dīvāns");

    // Отметка стоит — повторный проход молчит.
    expect(await runWatchlistEndingAlerts(world.ctx)).toBe(0);
    const [row] = await world.ctx.db
      .select()
      .from(watchlist)
      .where(and(eq(watchlist.customerId, person.bidder.id), eq(watchlist.auctionId, soon)));
    expect(row!.endingNotifiedAt).not.toBeNull();
  });
});
