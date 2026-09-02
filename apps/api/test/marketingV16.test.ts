import { auctions, campaigns, customers, giftCards, items, listings, loyaltyLedger, loyaltyAccounts, notifications, orders, promoCodes, pushSubscriptions, userEvents } from "@auction/db";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueGiftCard, redeemGiftCard } from "../src/engine/giftCards.js";
import { dispatchCampaigns, runAbandonedBidNudges, runSecondPurchaseNudges, rebuildCoPurchases } from "../src/engine/growth.js";
import { movePoints, tierFor } from "../src/engine/loyalty.js";
import { withEmailTracking } from "../src/engine/notifications.js";
import { auth, createWorld, loginAs, type TestWorld } from "./helpers.js";

/**
 * Надстройка v15 (MD §6–7): подарочные карты, уровни лояльности,
 * free_shipping-промо, abandoned-bid / second-purchase автоматика, A/B
 * кампаний с трекингом открытий и кликов, партнёрская программа. Деньги и
 * дедупликация проверяются напрямую в базе.
 */

let world: TestWorld;
let adminToken: string;
let n = 0;

const register = async (email: string, extra: Record<string, unknown> = {}) => {
  const res = await world.server.app.inject({
    method: "POST",
    url: "/api/public/auth/register",
    payload: { email, alias: email.split("@")[0]!.replace(/[^a-z0-9]/gi, ""), password: "Bidder123!", ...extra },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { accessToken: string; bidder: { id: string } };
};

const mkFixed = async (priceCents = 10_000, category = "electronics") => {
  n += 1;
  const [item] = await world.ctx.db
    .insert(items)
    .values({ sku: `V16-${n}`, title: `Lote v16-${n}`, marketCode: "LV", status: "listed", category })
    .returning({ id: items.id });
  const [listing] = await world.ctx.db
    .insert(listings)
    .values({ itemId: item!.id, type: "fixed", title: `Lote v16-${n}`, marketCode: "LV", priceCents, quantity: 1, status: "published" })
    .returning({ id: listings.id });
  return listing!.id;
};

const mkAuction = async (opts: { endsInHours?: number; category?: string; priceCents?: number } = {}) => {
  n += 1;
  const now = world.ctx.now().getTime();
  const [item] = await world.ctx.db
    .insert(items)
    .values({ sku: `V16A-${n}`, title: `Auk v16-${n}`, marketCode: "LV", status: "live", category: opts.category ?? "electronics" })
    .returning({ id: items.id });
  const [listing] = await world.ctx.db
    .insert(listings)
    .values({ itemId: item!.id, type: "auction", title: `Auk v16-${n}`, marketCode: "LV", startPriceCents: opts.priceCents ?? 10_000, status: "published" })
    .returning({ id: listings.id });
  const [auction] = await world.ctx.db
    .insert(auctions)
    .values({
      listingId: listing!.id,
      status: "running",
      startsAt: new Date(now - 3_600_000),
      endsAt: new Date(now + (opts.endsInHours ?? 72) * 3_600_000),
    })
    .returning({ id: auctions.id });
  return { auctionId: auction!.id, listingId: listing!.id };
};

const addToCart = async (t: string, listingId: string) => {
  const res = await world.server.app.inject({
    method: "POST", url: "/api/public/cart", headers: auth(t), payload: { listing_id: listingId },
  });
  expect(res.statusCode).toBe(200);
};

beforeAll(async () => {
  world = await createWorld();
  adminToken = await loginAs(world, "super@auction.test");
});
afterAll(async () => {
  if (world) await world.close();
});

describe("надстройка v15: карты, уровни, free_shipping, автоматика, A/B", () => {
  it("подарочная карта: выдача → погашение в кредит → повторное погашение отбито", async () => {
    const { bidder, accessToken } = await register("gift.user@v16.lv").then((r) => ({ bidder: r.bidder, accessToken: r.accessToken }));
    const card = await issueGiftCard(world.ctx, { initialCents: 5_000, note: "tests", issuedBy: "vitest" });
    expect(card.code).toMatch(/^DAVANA-/);

    const redeem = await world.server.app.inject({
      method: "POST", url: "/api/public/me/gift-card", headers: auth(accessToken), payload: { code: card.code },
    });
    expect(redeem.statusCode).toBe(200);
    expect(redeem.json()).toMatchObject({ ok: true, amountCents: 5_000, creditBalanceCents: 5_000 });

    // Письмо о зачислении встало в очередь.
    const [letter] = await world.ctx.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.customerId, bidder.id), eq(notifications.type, "gift_card_received")));
    expect(letter).toBeTruthy();

    // Второй раз — отказ, карта одноразовая.
    const again = await redeemGiftCard(world.ctx, { code: card.code, customerId: bidder.id });
    expect(again).toMatchObject({ ok: false, reason: "redeemed" });
    const [row] = await world.ctx.db.select().from(giftCards).where(eq(giftCards.id, card.id));
    expect(row!.balanceCents).toBe(0);
    expect(row!.customerId).toBe(bidder.id);
  });

  it("уровни: серебро даёт множитель начисления, /me/points отдаёт уровень", async () => {
    const me = await register("tier.user@v16.lv");
    // Заработано €300 за всё время — порог серебра (€250) пройден.
    await world.ctx.db.transaction((tx) =>
      movePoints(tx, me.bidder.id, { reason: "purchase", amountCents: 30_000, orderRef: "T-1" }, world.ctx.now()),
    );
    const tier = await tierFor(world.ctx, world.ctx.db, me.bidder.id);
    expect(tier.tier).toBe("silver");
    expect(tier.earnBp).toBe(12_500);

    const res = await world.server.app.inject({ method: "GET", url: "/api/public/me/points", headers: auth(me.accessToken) });
    const body = res.json() as { tier: string; toNextTierCents: number };
    expect(body.tier).toBe("silver");
    expect(body.toNextTierCents).toBe(70_000);
  });

  it("free_shipping: код доезжает до заказа и обнуляет доставку Omniva", async () => {
    const me = await register("freeship@v16.lv");
    await world.ctx.db.insert(promoCodes).values({
      code: "PIEGADE0", type: "free_shipping", value: 0, source: "manual",
    });
    const listingId = await mkFixed(11_000);
    await addToCart(me.accessToken, listingId);
    const checkout = await world.server.app.inject({
      method: "POST", url: "/api/public/cart/checkout", headers: auth(me.accessToken),
      payload: { promo_code: "PIEGADE0" },
    });
    expect(checkout.statusCode).toBe(200);
    const { orders: created } = checkout.json() as { orders: Array<{ ref: string }> };
    expect(created).toHaveLength(1);

    const pick = await world.server.app.inject({
      method: "POST", url: `/api/public/orders/${created[0]!.ref}/fulfilment`, headers: auth(me.accessToken),
      payload: { method: "omniva_pm", machineId: "9910", recipientPhone: "+371 26123456", recipientName: "Anna Test" },
    });
    expect(pick.statusCode).toBe(200);
    const [order] = await world.ctx.db.select().from(orders).where(eq(orders.ref, created[0]!.ref));
    expect(order!.promoCodeId).toBeTruthy();
    expect(order!.shippingCents).toBe(0); // Omniva стоила бы 399
    expect(order!.handlingCents).toBe(200); // упаковка остаётся
  });

  it("§6.1 abandoned-bid: смотрел, не ставил, торги на исходе → одно письмо", async () => {
    const me = await register("abandon@v16.lv", { marketingOptIn: true });
    const { auctionId } = await mkAuction({ endsInHours: 5 });
    // Просмотр лота: журнал поведения пишется с витринного детального экрана.
    const view = await world.server.app.inject({
      method: "GET", url: `/api/public/auctions/${auctionId}`, headers: auth(me.accessToken),
    });
    expect(view.statusCode).toBe(200);

    await runAbandonedBidNudges(world.ctx);
    const mine = await world.ctx.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.customerId, me.bidder.id), eq(notifications.type, "abandoned_bid")));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.body).toContain("Auk v16-");

    // Повторный прогон — дубля нет (lifecycle_marks).
    await runAbandonedBidNudges(world.ctx);
    const again = await world.ctx.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.customerId, me.bidder.id), eq(notifications.type, "abandoned_bid")));
    expect(again).toHaveLength(1);
  });

  it("§6.2 second purchase: N дней после первой покупки без второй → письмо с подборкой", async () => {
    const me = await register("second@v16.lv", { marketingOptIn: true });
    await mkFixed(15_000, "tools"); // живой лот для подборки
    const listingId = await mkFixed(20_000, "tools");
    await addToCart(me.accessToken, listingId);
    const checkout = await world.server.app.inject({
      method: "POST", url: "/api/public/cart/checkout", headers: auth(me.accessToken), payload: {},
    });
    const { orders: created } = checkout.json() as { orders: Array<{ ref: string }> };
    // Покупка «оплачена» 22 дня назад (порог по умолчанию 21).
    const past = new Date(world.ctx.now().getTime() - 22 * 86_400_000);
    await world.ctx.db.update(orders).set({ status: "paid", paidAt: past }).where(eq(orders.ref, created[0]!.ref));

    await runSecondPurchaseNudges(world.ctx);
    const mine = await world.ctx.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.customerId, me.bidder.id), eq(notifications.type, "second_purchase")));
    expect(mine).toHaveLength(1);

    await runSecondPurchaseNudges(world.ctx);
    const again = await world.ctx.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.customerId, me.bidder.id), eq(notifications.type, "second_purchase")));
    expect(again).toHaveLength(1);
  });

  it("A/B кампания: детерминированный сплит, пиксель и клик пишут отметки", async () => {
    // Достаточно получателей, чтобы встретились оба варианта.
    const people: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const r = await register(`ab.${i}@v16.lv`, { marketingOptIn: true });
      people.push(r.bidder.id);
    }
    const [c] = await world.ctx.db
      .insert(campaigns)
      .values({
        name: "AB tests",
        content: { lv: { subject: "Variants A", body: "Sveiki! A." } },
        contentB: { lv: { subject: "Variants B", body: "Sveiki! B." } },
        status: "scheduled",
        scheduledAt: new Date(world.ctx.now().getTime() - 1_000),
      })
      .returning();
    await dispatchCampaigns(world.ctx);

    const sentRows = await world.ctx.db
      .select()
      .from(notifications)
      .where(eq(notifications.campaignId, c!.id));
    expect(sentRows.length).toBeGreaterThanOrEqual(4);
    const variants = new Set(sentRows.map((r) => r.variant));
    expect(variants.has("a")).toBe(true);
    expect(variants.has("b")).toBe(true);
    for (const r of sentRows) {
      expect(r.subject).toBe(r.variant === "b" ? "Variants B" : "Variants A");
    }

    // Пиксель открытия и переход по клику.
    const target = sentRows[0]!;
    const open = await world.server.app.inject({ method: "GET", url: `/api/t/o/${target.id}.png` });
    expect(open.statusCode).toBe(200);
    expect(open.headers["content-type"]).toContain("image/gif");
    const click = await world.server.app.inject({
      method: "GET",
      url: `/api/t/c/${target.id}?u=${encodeURIComponent(`${world.ctx.config.storefrontBaseUrl}/katalogs`)}`,
    });
    expect(click.statusCode).toBe(302);
    expect(click.headers.location).toContain("/katalogs");
    // Чужой адрес не пускаем — редирект уводит на витрину.
    const evil = await world.server.app.inject({
      method: "GET", url: `/api/t/c/${target.id}?u=${encodeURIComponent("https://evil.example/phish")}`,
    });
    expect(evil.headers.location).toBe(world.ctx.config.storefrontBaseUrl);

    const [tracked] = await world.ctx.db.select().from(notifications).where(eq(notifications.id, target.id));
    expect(tracked!.openedAt).toBeTruthy();
    expect(tracked!.clickedAt).toBeTruthy();

    // Статистика в админке разложена по вариантам.
    const list = await world.server.app.inject({ method: "GET", url: "/api/marketing/campaigns", headers: auth(adminToken) });
    const mine = (list.json() as { campaigns: Array<{ id: string; tracking: Array<{ variant: string | null; opened: number }> }> })
      .campaigns.find((x) => x.id === c!.id)!;
    expect(mine.tracking.length).toBeGreaterThanOrEqual(2);
    expect(mine.tracking.reduce((s, t) => s + t.opened, 0)).toBe(1);
  });

  it("обёртка трекинга не трогает ссылку отписки", () => {
    const html = `<a href="https://izsoli.lv/katalogs">loti</a> <a href="https://izsoli.lv/atteikties?t=x">atteikties</a>`;
    const out = withEmailTracking(html, "11111111-2222-3333-4444-555555555555", "https://api.izsoli.lv");
    expect(out).toContain("/api/t/c/11111111-2222-3333-4444-555555555555?u=");
    expect(out).toContain(`href="https://izsoli.lv/atteikties?t=x"`);
    expect(out).toContain("/api/t/o/11111111-2222-3333-4444-555555555555.png");
  });

  it("партнёрская программа: ?aff= пишет привязку, отчёт считает комиссию", async () => {
    const created = await world.server.app.inject({
      method: "POST", url: "/api/marketing/affiliates", headers: auth(adminToken),
      payload: { name: "Blogeris Jānis", code: "JANIS", commissionBp: 1_000 },
    });
    expect(created.statusCode).toBe(200);

    const me = await register("aff.friend@v16.lv", { aff: "janis" });
    const [row] = await world.ctx.db.select().from(customers).where(eq(customers.id, me.bidder.id));
    expect(row!.affiliateId).toBeTruthy();

    // Оплаченный заказ привлечённого → комиссия 10% от товарной части.
    const listingId = await mkFixed(30_000);
    await addToCart(me.accessToken, listingId);
    const checkout = await world.server.app.inject({
      method: "POST", url: "/api/public/cart/checkout", headers: auth(me.accessToken), payload: {},
    });
    const { orders: myOrders } = checkout.json() as { orders: Array<{ ref: string }> };
    await world.ctx.db.update(orders).set({ status: "paid", paidAt: world.ctx.now() }).where(eq(orders.ref, myOrders[0]!.ref));

    const report = await world.server.app.inject({ method: "GET", url: "/api/marketing/affiliates", headers: auth(adminToken) });
    const janis = (report.json() as { affiliates: Array<{ code: string; stats: { signups: number; paidOrders: number; goodsCents: number; commissionCents: number } }> })
      .affiliates.find((a) => a.code === "JANIS")!;
    expect(janis.stats.signups).toBe(1);
    expect(janis.stats.paidOrders).toBe(1);
    expect(janis.stats.goodsCents).toBe(30_000);
    expect(janis.stats.commissionCents).toBe(3_000);
  });

  it("push: ключ выдаётся, подписка сохраняется и удаляется", async () => {
    const me = await register("push.user@v16.lv");
    const key = await world.server.app.inject({ method: "GET", url: "/api/public/push/vapid-key" });
    expect((key.json() as { publicKey: string }).publicKey.length).toBeGreaterThan(20);

    const sub = await world.server.app.inject({
      method: "POST", url: "/api/public/push/subscribe", headers: auth(me.accessToken),
      payload: { endpoint: "https://push.example/ep-1", keys: { p256dh: "p".repeat(20), auth: "a".repeat(10) } },
    });
    expect(sub.statusCode).toBe(200);
    const rows = await world.ctx.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.customerId, me.bidder.id));
    expect(rows).toHaveLength(1);

    const del = await world.server.app.inject({
      method: "DELETE", url: "/api/public/push/subscribe", headers: auth(me.accessToken),
      payload: { endpoint: "https://push.example/ep-1" },
    });
    expect(del.statusCode).toBe(200);
    const after = await world.ctx.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.customerId, me.bidder.id));
    expect(after).toHaveLength(0);
  });

  it("витринные хвосты: интересы сеют статистику, рекомендации и соц-доказательство отвечают", async () => {
    const me = await register("tails@v16.lv");
    const interests = await world.server.app.inject({
      method: "POST", url: "/api/public/me/interests", headers: auth(me.accessToken),
      payload: { categories: ["tools", "nonexistent"] },
    });
    expect(interests.statusCode).toBe(200);
    expect((interests.json() as { saved: string[] }).saved).toEqual(["tools"]);

    await mkFixed(9_000, "tools");
    const rec = await world.server.app.inject({ method: "GET", url: "/api/public/recommendations", headers: auth(me.accessToken) });
    const recBody = rec.json() as { category: string | null; lots: unknown[] };
    expect(recBody.category).toBe("tools");
    expect(recBody.lots.length).toBeGreaterThan(0);

    const { auctionId } = await mkAuction({ endsInHours: 48 });
    const detail = await world.server.app.inject({ method: "GET", url: `/api/public/auctions/${auctionId}` });
    const d = detail.json() as { watchersCount: number; bidsLastHour: number };
    expect(d.watchersCount).toBe(0);
    expect(d.bidsLastHour).toBe(0);

    const similar = await world.server.app.inject({ method: "GET", url: `/api/public/auctions/${auctionId}/similar` });
    expect(similar.statusCode).toBe(200);

    await rebuildCoPurchases(world.ctx); // не падает на пустых данных
  });
});
