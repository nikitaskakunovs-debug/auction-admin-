import { createHash } from "node:crypto";
import { campaigns, customers, items, listings, loyaltyAccounts, notifications, orders, promoCodes, referralCodes, referrals, segments, userCategoryStats, userRfm } from "@auction/db";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatchCampaigns, evaluateSegment, rebuildStats, recomputeSegments, runWelcomeReminders } from "../src/engine/growth.js";
import { movePoints } from "../src/engine/loyalty.js";
import { settleOrderPaid } from "../src/engine/settlement.js";
import { createWorld, type TestWorld } from "./helpers.js";

/**
 * План v15: приветственный код, промокоды в чекауте, баллы лояльности и
 * двухступенчатая реферальная награда. Проверяем деньгами: скидка проходит
 * через раскладку счёта, баллы не превышают потолок, награды не платятся
 * дважды и не платятся при fraud-флаге.
 */
describe("маркетинг v15: welcome-код, промо, баллы, рефералы", () => {
  let world: TestWorld;
  let n = 0;

  const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

  const register = async (email: string, extra: Record<string, unknown> = {}, remoteAddress?: string) => {
    const res = await world.server.app.inject({
      method: "POST",
      url: "/api/public/auth/register",
      ...(remoteAddress ? { remoteAddress } : {}),
      payload: { email, alias: email.split("@")[0]!.replace(/[^a-z0-9]/gi, ""), password: "Bidder123!", ...extra },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as { accessToken: string; bidder: { id: string } };
  };

  /** Подтверждение почты без чтения письма: подсовываем известный токен. */
  const verify = async (customerId: string) => {
    const token = `verify-token-${customerId}`.padEnd(24, "x");
    await world.ctx.db
      .update(customers)
      .set({ emailVerifyTokenHash: sha256(token), emailVerifySentAt: world.ctx.now() })
      .where(eq(customers.id, customerId));
    const res = await world.server.app.inject({
      method: "POST",
      url: "/api/public/auth/verify-email",
      payload: { token },
    });
    expect(res.statusCode).toBe(200);
  };

  const mkListing = async (priceCents = 10_000, category = "electronics") => {
    n += 1;
    const [item] = await world.ctx.db
      .insert(items)
      .values({ sku: `V15-${n}`, title: `Lote v15-${n}`, marketCode: "LV", status: "listed", category })
      .returning({ id: items.id });
    const [listing] = await world.ctx.db
      .insert(listings)
      .values({ itemId: item!.id, type: "fixed", title: `Lote v15-${n}`, marketCode: "LV", priceCents, quantity: 1, status: "published" })
      .returning({ id: listings.id });
    return listing!.id;
  };

  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  const addToCart = async (t: string, listingId: string) => {
    const res = await world.server.app.inject({
      method: "POST", url: "/api/public/cart", headers: auth(t), payload: { listing_id: listingId },
    });
    expect(res.statusCode).toBe(200);
  };

  const checkout = (t: string, promo?: string) =>
    world.server.app.inject({
      method: "POST", url: "/api/public/cart/checkout", headers: auth(t),
      payload: { ...(promo ? { promo_code: promo } : {}) },
    });

  beforeAll(async () => {
    world = await createWorld();
  });
  afterAll(async () => {
    if (world) await world.close();
  });

  it("регистрация выпускает личный welcome-код и кладёт его в письмо верификации", async () => {
    const a = await register("anna@v15.test");
    const [code] = await world.ctx.db.select().from(promoCodes).where(eq(promoCodes.customerId, a.bidder.id));
    expect(code).toBeTruthy();
    expect(code!.source).toBe("welcome_auto");
    expect(code!.type).toBe("percent");
    expect(code!.value).toBe(10);
    expect(code!.usageLimitPerUser).toBe(1);

    const [letter] = await world.ctx.db
      .select({ body: notifications.body, type: notifications.type })
      .from(notifications)
      .where(and(eq(notifications.customerId, a.bidder.id), eq(notifications.type, "verify_email")))
      .orderBy(desc(notifications.createdAt))
      .limit(1);
    expect(letter!.body).toContain(code!.code);

    // Личный список кодов виден в кабинете.
    const mine = await world.server.app.inject({
      method: "GET", url: "/api/public/me/promo-codes", headers: auth(a.accessToken),
    });
    expect((mine.json() as { codes: Array<{ code: string }> }).codes[0]!.code).toBe(code!.code);
  });

  it("welcome-код даёт скидку в чекауте, второй раз не работает и чужим не даётся", async () => {
    const b = await register("boris@v15.test");
    await verify(b.bidder.id);
    const [code] = await world.ctx.db.select().from(promoCodes).where(eq(promoCodes.customerId, b.bidder.id));

    const l1 = await mkListing(10_000);
    await addToCart(b.accessToken, l1);
    const res = await checkout(b.accessToken, code!.code);
    expect(res.statusCode).toBe(200);
    const out = res.json() as { orders: Array<{ ref: string; totalCents: number }> };
    // −10% от финальной цены: 100 € → 90 €.
    expect(out.orders[0]!.totalCents).toBe(9_000);
    const [order] = await world.ctx.db.select().from(orders).where(eq(orders.ref, out.orders[0]!.ref));
    expect(order!.promoDiscountCents).toBe(1_000);
    expect(order!.promoCodeId).toBe(code!.id);
    // Раскладка счёта сходится в ноль от нового итога.
    expect(order!.hammerCents + order!.premiumCents + order!.vatCents).toBe(9_000);

    // Повторное использование — отказ ДО создания заказа.
    const l2 = await mkListing(5_000);
    await addToCart(b.accessToken, l2);
    const again = await checkout(b.accessToken, code!.code);
    expect(again.statusCode).toBe(422);
    expect((again.json() as { reason: string }).reason).toMatch(/usage_limit|user_limit/);

    // Чужому владельцу личный код не принадлежит.
    const c = await register("carla@v15.test");
    await verify(c.bidder.id);
    const l3 = await mkListing(5_000);
    await addToCart(c.accessToken, l3);
    const stranger = await checkout(c.accessToken, code!.code);
    expect(stranger.statusCode).toBe(422);
    expect((stranger.json() as { reason: string }).reason).toBe("not_yours");
  });

  it("оплата начисляет баллы (1 €/€), письмо говорит о них, потолок списания — 50%", async () => {
    const d = await register("dina@v15.test");
    await verify(d.bidder.id);
    const l = await mkListing(25_100); // 251 €
    await addToCart(d.accessToken, l);
    const res = await checkout(d.accessToken);
    const ref = (res.json() as { orders: Array<{ ref: string }> }).orders[0]!.ref;
    const [order] = await world.ctx.db.select().from(orders).where(eq(orders.ref, ref));

    const settled = await settleOrderPaid(world.ctx, order!.id, { id: null, label: "test" });
    expect(settled.outcome).toBe("settled");
    const [account] = await world.ctx.db.select().from(loyaltyAccounts).where(eq(loyaltyAccounts.customerId, d.bidder.id));
    // 251 € оплаты → 251 балл → 25 100 центов скидочного номинала.
    expect(account!.balanceCents).toBe(25_100);

    const [paidLetter] = await world.ctx.db
      .select({ body: notifications.body })
      .from(notifications)
      .where(and(eq(notifications.customerId, d.bidder.id), eq(notifications.type, "order_paid")))
      .orderBy(desc(notifications.createdAt))
      .limit(1);
    expect(paidLetter!.body).toContain("punkt"); // абзац о баллах (lv)

    // Списание: заказ на 100 € — баллами можно закрыть не больше 50 €.
    const l2 = await mkListing(10_000);
    await addToCart(d.accessToken, l2);
    const res2 = await checkout(d.accessToken);
    const ref2 = (res2.json() as { orders: Array<{ ref: string }> }).orders[0]!.ref;
    await world.server.app.inject({
      method: "POST", url: `/api/public/orders/${ref2}/pay`, headers: auth(d.accessToken),
      payload: { usePoints: true },
    });
    const [order2] = await world.ctx.db.select().from(orders).where(eq(orders.ref, ref2));
    expect(order2!.pointsAppliedCents).toBe(5_000);
    const [after] = await world.ctx.db.select().from(loyaltyAccounts).where(eq(loyaltyAccounts.customerId, d.bidder.id));
    expect(after!.balanceCents).toBe(20_100);

    // За часть, оплаченную баллами, новые баллы не начисляются.
    await settleOrderPaid(world.ctx, order2!.id, { id: null, label: "test" });
    const [final] = await world.ctx.db.select().from(loyaltyAccounts).where(eq(loyaltyAccounts.customerId, d.bidder.id));
    // +50 € реальной оплаты → +5 000.
    expect(final!.balanceCents).toBe(25_100);
  });

  it("реферал: 5 € за подтверждение, 10 € за первый оплаченный заказ, повышенный welcome у друга", async () => {
    const referrer = await register("rita@v15.test");
    await verify(referrer.bidder.id);
    const refInfo = await world.server.app.inject({
      method: "GET", url: "/api/public/me/referral", headers: auth(referrer.accessToken),
    });
    const { code: refCode } = refInfo.json() as { code: string };
    expect(refCode.length).toBeGreaterThan(5);

    // Друг приходит с ДРУГОГО адреса — иначе сработает антифрод (ниже).
    const friend = await register("fricis@v15.test", { ref: refCode }, "10.7.7.7");
    // Другу — повышенный процент welcome-кода.
    const [friendCode] = await world.ctx.db.select().from(promoCodes).where(eq(promoCodes.customerId, friend.bidder.id));
    expect(friendCode!.source).toBe("referral_referred");
    expect(friendCode!.value).toBe(15);

    await verify(friend.bidder.id);
    const [r1] = await world.ctx.db.select().from(referrals).where(eq(referrals.referredCustomerId, friend.bidder.id));
    expect(r1!.status).toBe("signup_rewarded");
    const [acc1] = await world.ctx.db.select().from(loyaltyAccounts).where(eq(loyaltyAccounts.customerId, referrer.bidder.id));
    expect(acc1!.balanceCents).toBe(500);

    // Первый ОПЛАЧЕННЫЙ заказ друга — вторая ступень.
    const l = await mkListing(8_000);
    await addToCart(friend.accessToken, l);
    const res = await checkout(friend.accessToken);
    const ref = (res.json() as { orders: Array<{ ref: string }> }).orders[0]!.ref;
    const [order] = await world.ctx.db.select().from(orders).where(eq(orders.ref, ref));
    await settleOrderPaid(world.ctx, order!.id, { id: null, label: "test" });

    const [r2] = await world.ctx.db.select().from(referrals).where(eq(referrals.referredCustomerId, friend.bidder.id));
    expect(r2!.status).toBe("order_rewarded");
    const [acc2] = await world.ctx.db.select().from(loyaltyAccounts).where(eq(loyaltyAccounts.customerId, referrer.bidder.id));
    expect(acc2!.balanceCents).toBe(500 + 1_000);

    // Вторая оплата друга второй раз не награждает.
    const l2 = await mkListing(6_000);
    await addToCart(friend.accessToken, l2);
    const resB = await checkout(friend.accessToken);
    const refB = (resB.json() as { orders: Array<{ ref: string }> }).orders[0]!.ref;
    const [orderB] = await world.ctx.db.select().from(orders).where(eq(orders.ref, refB));
    await settleOrderPaid(world.ctx, orderB!.id, { id: null, label: "test" });
    const [acc3] = await world.ctx.db.select().from(loyaltyAccounts).where(eq(loyaltyAccounts.customerId, referrer.bidder.id));
    expect(acc3!.balanceCents).toBe(1_500);
  });

  it("самоприглашение с того же IP получает fraud-флаг и наград не платит", async () => {
    const solo = await register("solo@v15.test");
    await verify(solo.bidder.id);
    const info = await world.server.app.inject({
      method: "GET", url: "/api/public/me/referral", headers: auth(solo.accessToken),
    });
    const { code } = info.json() as { code: string };
    // «Друг» с того же адреса, что и все inject-запросы пригласившего.
    const twin = await register("twin@v15.test", { ref: code });
    await verify(twin.bidder.id);
    const [r] = await world.ctx.db.select().from(referrals).where(eq(referrals.referredCustomerId, twin.bidder.id));
    expect(r!.fraudFlag).toBe(true);
    expect(r!.status).toBe("pending"); // награда придержана до ручной проверки
    const [acc] = await world.ctx.db.select().from(loyaltyAccounts).where(eq(loyaltyAccounts.customerId, solo.bidder.id));
    expect(acc?.balanceCents ?? 0).toBe(0);
  });

  it("ночная сводка строит интересы и RFM, сегмент собирает участников", async () => {
    // У Дины из предыдущего теста есть оплаченные заказы в electronics.
    await rebuildStats(world.ctx);
    const [dina] = await world.ctx.db.select().from(customers).where(eq(customers.email, "dina@v15.test"));
    const stats = await world.ctx.db.select().from(userCategoryStats).where(eq(userCategoryStats.customerId, dina!.id));
    const ele = stats.find((s) => s.category === "electronics");
    expect(ele).toBeTruthy();
    expect(ele!.purchaseCount).toBeGreaterThanOrEqual(2);
    const [rfm] = await world.ctx.db.select().from(userRfm).where(eq(userRfm.customerId, dina!.id));
    expect(rfm).toBeTruthy();
    expect(rfm!.frequency).toBeGreaterThanOrEqual(2);

    const members = await evaluateSegment(world.ctx, {
      match: "all",
      conditions: [{ field: "category_purchase_count", op: ">=", value: 2, category: "electronics" }],
    });
    expect(members).toContain(dina!.id);
    const none = await evaluateSegment(world.ctx, {
      match: "all",
      conditions: [{ field: "category_purchase_count", op: ">=", value: 99, category: "electronics" }],
    });
    expect(none).not.toContain(dina!.id);
  });

  it("кампания уходит сегменту с барьерами согласия и фиксирует статистику", async () => {
    const [dina] = await world.ctx.db.select().from(customers).where(eq(customers.email, "dina@v15.test"));
    // Дина согласна на маркетинг; Борис (без согласия) — контрольная группа.
    await world.ctx.db.update(customers).set({ marketingOptIn: true }).where(eq(customers.id, dina!.id));
    const [seg] = await world.ctx.db
      .insert(segments)
      .values({
        name: "Электроника 2+",
        rule: { match: "all", conditions: [{ field: "category_purchase_count", op: ">=", value: 2, category: "electronics" }] },
      })
      .returning();
    await recomputeSegments(world.ctx);
    const [camp] = await world.ctx.db
      .insert(campaigns)
      .values({
        name: "Тестовая кампания",
        segmentId: seg!.id,
        status: "scheduled",
        scheduledAt: new Date(Date.now() - 60_000),
        content: {
          lv: { subject: "Sveiki, {alias}!", body: "Jauni loti elektronikā.\n\nApskati katalogu." },
          ru: { subject: "Привет, {alias}!", body: "Новые лоты в электронике.\n\nЗагляните в каталог." },
          en: { subject: "Hi {alias}!", body: "New electronics lots.\n\nHave a look." },
        },
      })
      .returning();
    await dispatchCampaigns(world.ctx);
    const [after] = await world.ctx.db.select().from(campaigns).where(eq(campaigns.id, camp!.id));
    expect(after!.status).toBe("sent");
    expect((after!.stats as { queued?: number }).queued).toBe(1);
    const [letter] = await world.ctx.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.customerId, dina!.id), eq(notifications.type, "campaign")))
      .limit(1);
    expect(letter).toBeTruthy();
    expect(letter!.kind).toBe("marketing");
    expect(letter!.body).toContain("[campaign]");
    expect(letter!.body).toMatch(/Atteikties no jaunumiem|Отписаться от рассылки|Unsubscribe from updates/);
  });

  it("напоминание о welcome-коде уходит на 3-й день и только раз", async () => {
    const g = await register("gita@v15.test", { marketingOptIn: true });
    await verify(g.bidder.id);
    // Прошло 3,5 дня: человек в окне напоминания, код не использован.
    world.setNow(new Date(Date.now() + 3.5 * 86_400_000));
    try {
      await runWelcomeReminders(world.ctx);
      const letters = await world.ctx.db
        .select()
        .from(notifications)
        .where(and(eq(notifications.customerId, g.bidder.id), eq(notifications.type, "welcome_reminder")));
      expect(letters.length).toBe(1);
      expect(letters[0]!.kind).toBe("marketing");
      // Второй проход крона второго письма не рождает.
      await runWelcomeReminders(world.ctx);
      const again = await world.ctx.db
        .select()
        .from(notifications)
        .where(and(eq(notifications.customerId, g.bidder.id), eq(notifications.type, "welcome_reminder")));
      expect(again.length).toBe(1);
    } finally {
      world.setNow(null);
    }
  });

  it("минус больше остатка баллов отвергается", async () => {
    const e = await register("egils@v15.test");
    await expect(
      world.ctx.db.transaction((tx) =>
        movePoints(tx, e.bidder.id, { reason: "manual", amountCents: -100 }, world.ctx.now()),
      ),
    ).rejects.toThrow();
  });
});
