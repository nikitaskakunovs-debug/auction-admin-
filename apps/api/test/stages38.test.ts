import { creditEntries, credits, customers, invoices, items, listings, notifications, orders } from "@auction/db";
import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createLiveAuction, createWorld, loginAs, type TestWorld } from "./helpers.js";

/**
 * Этапы 3–8: подтверждение почты, аванс, сессии, матрица уведомлений,
 * счёт PDF и чек. Всё гоняется через HTTP-маршруты, как их зовёт кабинет.
 */
describe("этапы 3–8", () => {
  let world: TestWorld;
  let adminToken: string;

  beforeAll(async () => {
    // Единственный мир с ВКЛЮЧЁННОЙ проверкой почты — здесь она и проверяется.
    world = await createWorld({ REQUIRE_VERIFIED_EMAIL: "1" });
    adminToken = await loginAs(world, "super@auction.test");
  });
  afterAll(async () => {
    if (world) await world.close();
  });

  const register = async (email: string) => {
    const res = await world.server.app.inject({
      method: "POST",
      url: "/api/public/auth/register",
      payload: { email, alias: email.split("@")[0]!.replace(/[^a-z0-9]/gi, ""), password: "Bidder123!" },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as { accessToken: string; refreshToken: string; bidder: { id: string } };
  };

  /** Достаём ссылку подтверждения из письма — как сделал бы человек. */
  const verifyFromEmail = async (customerId: string) => {
    const [mail] = await world.ctx.db
      .select()
      .from(notifications)
      .where(eq(notifications.customerId, customerId))
      .orderBy(desc(notifications.createdAt));
    expect(mail?.type).toBe("verify_email");
    const token = /verify-email\?token=([A-Za-z0-9_-]+)/.exec(mail!.body)?.[1];
    expect(token, "в письме должна быть ссылка с токеном").toBeTruthy();
    const res = await world.server.app.inject({
      method: "POST",
      url: "/api/public/auth/verify-email",
      payload: { token },
    });
    expect(res.statusCode).toBe(200);
  };

  it("до подтверждения почты ставка закрыта, после — открыта; кривой токен отвергается", async () => {
    const me = await register("verify.gate@test.lv");

    // Живой аукцион — тем же помощником, что и остальные наборы.
    const { auctionId } = await createLiveAuction(world, adminToken, { startPriceCents: 1000 });

    const bid = () => world.server.app.inject({
      method: "POST", url: `/api/public/auctions/${auctionId}/bids`,
      headers: { authorization: `Bearer ${me.accessToken}` },
      payload: { maxCents: 1000 },
    });

    const blocked = await bid();
    expect(blocked.statusCode).toBe(403);
    expect((blocked.json() as { code: string }).code).toBe("EMAIL_NOT_VERIFIED");

    const bad = await world.server.app.inject({ method: "POST", url: "/api/public/auth/verify-email", payload: { token: "x".repeat(40) } });
    expect(bad.statusCode).toBe(401);

    await verifyFromEmail(me.bidder.id);
    const ok = await bid();
    expect(ok.statusCode).toBe(200);

    const meRes = await world.server.app.inject({
      method: "GET", url: "/api/public/auth/me",
      headers: { authorization: `Bearer ${me.accessToken}` },
    });
    expect((meRes.json() as { bidder: { emailVerified: boolean } }).bidder.emailVerified).toBe(true);
  });

  it("аванс: админ начисляет, клиент видит движение, оплата покрывается целиком, отмена возвращает", async () => {
    const me = await register("credit.user@test.lv");
    await verifyFromEmail(me.bidder.id);
    const bearer = { authorization: `Bearer ${me.accessToken}` };

    // Начисление больше нуля; списание в минус ниже нуля — отказ.
    const grant = await world.server.app.inject({
      method: "POST", url: `/api/customers/${me.bidder.id}/credit`, headers: auth(adminToken),
      payload: { amountCents: 10_000, kind: "grant", note: "pārmaksa testā" },
    });
    expect(grant.statusCode).toBe(200);
    const over = await world.server.app.inject({
      method: "POST", url: `/api/customers/${me.bidder.id}/credit`, headers: auth(adminToken),
      payload: { amountCents: -20_000, kind: "withdrawn" },
    });
    expect(over.statusCode).toBe(409);

    const view = await world.server.app.inject({ method: "GET", url: "/api/public/me/credit", headers: bearer });
    const credit = view.json() as { balanceCents: number; entries: Array<{ kind: string; amountCents: number }> };
    expect(credit.balanceCents).toBe(10_000);
    expect(credit.entries[0]!.kind).toBe("grant");

    // Fixed-цена лот за 60,50 € — аванс покрывает всё, заказ оплачивается без провайдера.
    const h = auth(adminToken);
    const item = await world.server.app.inject({ method: "POST", url: "/api/items", headers: h, payload: { sku: "ST38-2", title: "Credit lot", marketCode: "LV" } });
    const itemId = (item.json() as { item: { id: string } }).item.id;
    const listing = await world.server.app.inject({ method: "POST", url: "/api/listings", headers: h, payload: { itemId, type: "fixed", title: "Credit lot", marketCode: "LV", priceCents: 5000 } });
    const listingId = (listing.json() as { listing: { id: string } }).listing.id;
    await world.server.app.inject({ method: "POST", url: `/api/listings/${listingId}/publish`, headers: h });
    const buy = await world.server.app.inject({ method: "POST", url: `/api/public/listings/${listingId}/buy`, headers: bearer });
    expect(buy.statusCode).toBe(200);

    const ordersRes = await world.server.app.inject({ method: "GET", url: "/api/public/me/orders", headers: bearer });
    const order = (ordersRes.json() as { orders: Array<{ ref: string; totalCents: number }> }).orders[0]!;

    const pay = await world.server.app.inject({
      method: "POST", url: `/api/public/orders/${order.ref}/pay`, headers: bearer,
      payload: { useCredit: true },
    });
    expect(pay.statusCode).toBe(200);
    expect((pay.json() as { paid?: boolean }).paid).toBe(true);

    const after = await world.server.app.inject({ method: "GET", url: "/api/public/me/credit", headers: bearer });
    const balance = (after.json() as { balanceCents: number }).balanceCents;
    expect(balance).toBe(10_000 - order.totalCents);

    // Чек по оплаченному заказу — с зачётом аванса и кодом выдачи.
    const receipt = await world.server.app.inject({ method: "GET", url: `/api/public/me/orders/${order.ref}/receipt`, headers: bearer });
    expect(receipt.statusCode).toBe(200);
    const r = receipt.json() as { creditAppliedCents: number; pickupCode: string | null; totalCents: number };
    expect(r.creditAppliedCents).toBe(order.totalCents);
    expect(r.pickupCode).toBeTruthy();

    // Остаток можно вернуть на счёт — баланс обнуляется записью withdrawn.
    const wd = await world.server.app.inject({ method: "POST", url: "/api/public/me/credit/withdraw", headers: bearer });
    expect(wd.statusCode).toBe(200);
    expect((wd.json() as { withdrawn: number }).withdrawn).toBe(balance);
  });

  it("счёт PDF отдаётся владельцу заказа и только ему", async () => {
    const me = await register("invoice.owner@test.lv");
    await verifyFromEmail(me.bidder.id);
    const bearer = { authorization: `Bearer ${me.accessToken}` };
    const h = auth(adminToken);
    const item = await world.server.app.inject({ method: "POST", url: "/api/items", headers: h, payload: { sku: "ST38-3", title: "Invoice lot", marketCode: "LV" } });
    const itemId = (item.json() as { item: { id: string } }).item.id;
    const listing = await world.server.app.inject({ method: "POST", url: "/api/listings", headers: h, payload: { itemId, type: "fixed", title: "Invoice lot", marketCode: "LV", priceCents: 8000 } });
    const listingId = (listing.json() as { listing: { id: string } }).listing.id;
    await world.server.app.inject({ method: "POST", url: `/api/listings/${listingId}/publish`, headers: h });
    await world.server.app.inject({ method: "POST", url: `/api/public/listings/${listingId}/buy`, headers: bearer });
    const ordersRes = await world.server.app.inject({ method: "GET", url: "/api/public/me/orders", headers: bearer });
    const ref = (ordersRes.json() as { orders: Array<{ ref: string }> }).orders[0]!.ref;

    const pdf = await world.server.app.inject({ method: "GET", url: `/api/public/me/orders/${ref}/invoice.pdf`, headers: bearer });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    // В PDF попал латышский текст — значит, шрифт с диакритикой встроился.
    expect(pdf.rawPayload.length).toBeGreaterThan(8_000);

    const stranger = await register("invoice.stranger@test.lv");
    const denied = await world.server.app.inject({
      method: "GET", url: `/api/public/me/orders/${ref}/invoice.pdf`,
      headers: { authorization: `Bearer ${stranger.accessToken}` },
    });
    expect(denied.statusCode).toBe(404);
  });

  it("сессии: список с текущей, выход на конкретной и на всех остальных", async () => {
    const me = await register("sessions.user@test.lv");
    const bearer = { authorization: `Bearer ${me.accessToken}` };
    // Второй вход = вторая сессия.
    await world.server.app.inject({
      method: "POST", url: "/api/public/auth/login",
      payload: { email: "sessions.user@test.lv", password: "Bidder123!" },
    });

    const list = await world.server.app.inject({ method: "GET", url: "/api/public/me/sessions", headers: bearer });
    const sessions = (list.json() as { sessions: Array<{ id: string; current: boolean }> }).sessions;
    expect(sessions.length).toBe(2);
    expect(sessions.filter((s) => s.current).length).toBe(1);

    const other = sessions.find((s) => !s.current)!;
    const del = await world.server.app.inject({ method: "DELETE", url: `/api/public/me/sessions/${other.id}`, headers: bearer });
    expect(del.statusCode).toBe(200);

    await world.server.app.inject({
      method: "POST", url: "/api/public/auth/login",
      payload: { email: "sessions.user@test.lv", password: "Bidder123!" },
    });
    const out = await world.server.app.inject({ method: "POST", url: "/api/public/me/sessions/signout-others", headers: bearer });
    expect((out.json() as { revoked: number }).revoked).toBe(1);
    const after = await world.server.app.inject({ method: "GET", url: "/api/public/me/sessions", headers: bearer });
    expect((after.json() as { sessions: unknown[] }).sessions.length).toBe(1);
  });

  it("матрица уведомлений: выключенный outbid не ставится в очередь", async () => {
    const me = await register("prefs.user@test.lv");
    const bearer = { authorization: `Bearer ${me.accessToken}` };

    const put = await world.server.app.inject({
      method: "PUT", url: "/api/public/me/notification-prefs", headers: bearer,
      payload: { event: "outbid", email: false },
    });
    expect(put.statusCode).toBe(200);
    const get = await world.server.app.inject({ method: "GET", url: "/api/public/me/notification-prefs", headers: bearer });
    const prefs = (get.json() as { prefs: Array<{ event: string; email: boolean }> }).prefs;
    expect(prefs.find((p) => p.event === "outbid")!.email).toBe(false);

    // Прямой enqueue — как это сделал бы движок ставок.
    const { enqueueNotification } = await import("../src/engine/notifications.js");
    const before = await world.ctx.db.select().from(notifications).where(eq(notifications.customerId, me.bidder.id));
    await enqueueNotification(world.ctx, world.ctx.db, {
      customerId: me.bidder.id,
      type: "outbid",
      template: { alias: "x", lotTitle: "Lot", amountCents: 500 },
    });
    const afterOff = await world.ctx.db.select().from(notifications).where(eq(notifications.customerId, me.bidder.id));
    expect(afterOff.length).toBe(before.length); // не добавилось

    // Обязательное письмо (won) выключателя не имеет — идёт всегда.
    await enqueueNotification(world.ctx, world.ctx.db, {
      customerId: me.bidder.id,
      type: "won",
      template: { alias: "x", lotTitle: "Lot", orderRef: "A-1", totalCents: 1000, deadline: world.ctx.now() },
    });
    const afterWon = await world.ctx.db.select().from(notifications).where(eq(notifications.customerId, me.bidder.id));
    expect(afterWon.length).toBe(before.length + 1);
  });
});
