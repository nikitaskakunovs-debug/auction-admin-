import { createHash } from "node:crypto";
import { consignments, customers, items, listings, loyaltyAccounts, loyaltyLedger, notifications, orders, suppliers, supplierInvoices } from "@auction/db";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NOTIFICATION_TYPES, SUPPLIER_TYPES } from "../src/engine/emailCopy.js";
import { setFinSetting, invalidateFinSettingsCache } from "../src/engine/finSettings.js";
import { movePoints } from "../src/engine/loyalty.js";
import { runPointsExpiryWarnings } from "../src/engine/loyaltyExpiry.js";
import { enqueueSupplierNotification, renderNotification } from "../src/engine/notifications.js";
import { notifyIntakeClosed, runSupplierMonthly, runSupplierUnsold } from "../src/engine/supplierMail.js";
import { auth, createWorld, loginAs, type TestWorld } from "./helpers.js";

/**
 * Новые письма (план переписки, части A и S): пробелы покупательской
 * переписки и вся связь с поставщиком. Проверяем, что письмо рождается от
 * настоящего события, попадает нужному адресату и говорит по делу.
 */
describe("письма: пробелы покупателям + переписка с поставщиками", () => {
  let world: TestWorld;
  let n = 0;

  const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
  const register = async (email: string, lang: "lv" | "ru" | "en" = "lv") => {
    const res = await world.server.app.inject({
      method: "POST",
      url: "/api/public/auth/register",
      payload: { email, alias: email.split("@")[0]!.replace(/[^a-z0-9]/gi, ""), password: "Bidder123!" },
    });
    expect(res.statusCode).toBe(200);
    const out = res.json() as { accessToken: string; bidder: { id: string } };
    // Язык писем берётся из карточки клиента; в тестах фиксируем его явно,
    // иначе формат сумм и заголовки зависели бы от страны по умолчанию.
    await world.ctx.db.update(customers).set({ lang }).where(eq(customers.id, out.bidder.id));
    return out;
  };
  const lettersFor = (customerId: string, type: string) =>
    world.ctx.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.customerId, customerId), eq(notifications.type, type)))
      .orderBy(desc(notifications.createdAt));
  const supplierLetters = (supplierId: string, type: string) =>
    world.ctx.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.supplierId, supplierId), eq(notifications.type, type)));

  const mkSupplier = async (over: Partial<typeof suppliers.$inferInsert> = {}) => {
    n += 1;
    const [sup] = await world.ctx.db
      .insert(suppliers)
      .values({ name: `Mail Sup ${n}`, email: `sup${n}@mail.test`, contactName: "Jānis Ozols", lang: "lv", ...over })
      .returning();
    return sup!;
  };

  beforeAll(async () => {
    world = await createWorld();
  });
  afterAll(async () => {
    if (world) await world.close();
  });

  it("каждый тип письма рендерится на трёх языках и содержит своё название", async () => {
    for (const type of NOTIFICATION_TYPES) {
      for (const lang of ["lv", "ru", "en"] as const) {
        const msg = await renderNotification(world.ctx, type, lang, { alias: "Elīna", lotTitle: "Omega" });
        expect(msg.subject.length, `${type}/${lang} subject`).toBeGreaterThan(3);
        expect(msg.html, `${type}/${lang} html`).toContain("<!doctype html>");
        // Машинная метка типа в текстовой версии — по ней письма ищут в логе.
        expect(msg.text, `${type}/${lang} tag`).toContain(`[${type}]`);
      }
    }
  });

  it("сброс пароля приходит в фирменном оформлении и НЕ оседает в журнале", async () => {
    const u = await register("reset@mail.test");
    world.email.sent.length = 0;
    const res = await world.server.app.inject({
      method: "POST", url: "/api/public/auth/forgot-password", payload: { email: "reset@mail.test" },
    });
    expect(res.statusCode).toBe(200);
    // Отправка идёт после ответа — ждём выемку.
    await new Promise((r) => setTimeout(r, 300));
    const letter = world.email.sent.find((m) => m.to === "reset@mail.test");
    expect(letter, "письмо ушло").toBeTruthy();
    expect(letter!.html ?? "", "оформление на месте").toContain("JAUNA PAROLE");
    expect(letter!.text).toContain("[password_reset]");
    // Ссылка сброса — ключ от аккаунта: в журнале уведомлений её быть не должно.
    expect(await lettersFor(u.bidder.id, "password_reset")).toHaveLength(0);
  });

  it("смена пароля поднимает письмо безопасности", async () => {
    const u = await register("secure@mail.test");
    // Полный путь: запрос сброса → установка нового пароля.
    await world.server.app.inject({ method: "POST", url: "/api/public/auth/forgot-password", payload: { email: "secure@mail.test" } });
    await new Promise((r) => setTimeout(r, 300));
    const link = world.email.sent.filter((m) => m.to === "secure@mail.test").at(-1)!.text.match(/token=([A-Za-z0-9_-]+)/);
    expect(link, "ссылка в письме").toBeTruthy();
    const done = await world.server.app.inject({
      method: "POST", url: "/api/public/auth/reset-password", payload: { token: link![1], newPassword: "NewBidder123!" },
    });
    expect(done.statusCode).toBe(200);
    const alerts = await lettersFor(u.bidder.id, "security_alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.body).toContain("[security_alert]");
  });

  it("предупреждение о сгорании баллов уходит один раз на месяц сгорания", async () => {
    const u = await register("expiry2@mail.test");
    const start = new Date(world.ctx.now().getTime());
    start.setUTCFullYear(start.getUTCFullYear() - 2);
    await setFinSetting(world.ctx, "points_expiry_start_ms", start.getTime(), "test");
    invalidateFinSettingsCache();
    await movePoints(world.ctx.db, u.bidder.id, { reason: "purchase", amountCents: 4_000, note: "old" }, world.ctx.now());
    // Начисление, которому до сгорания меньше 30 дней (11 месяцев назад).
    const backdate = new Date(world.ctx.now().getTime());
    backdate.setUTCMonth(backdate.getUTCMonth() - 11);
    backdate.setUTCDate(backdate.getUTCDate() - 20);
    const [acc] = await world.ctx.db.select().from(loyaltyAccounts).where(eq(loyaltyAccounts.customerId, u.bidder.id));
    await world.ctx.db
      .update(loyaltyLedger)
      .set({ createdAt: backdate })
      .where(and(eq(loyaltyLedger.accountId, acc!.id), eq(loyaltyLedger.note, "old")));

    expect((await runPointsExpiryWarnings(world.ctx)).warned).toBe(1);
    const letters = await lettersFor(u.bidder.id, "points_expiring");
    expect(letters).toHaveLength(1);
    expect(letters[0]!.body).toContain("40,00");
    // Повторный прогон в тот же месяц второго письма не шлёт.
    await runPointsExpiryWarnings(world.ctx);
    expect(await lettersFor(u.bidder.id, "points_expiring")).toHaveLength(1);
  });

  it("снятие лота с торгов пишет каждому участнику по одному письму", async () => {
    const a = await register("bidder-a@mail.test");
    const b = await register("bidder-b@mail.test");
    n += 1;
    const [item] = await world.ctx.db
      .insert(items).values({ sku: `WD-${n}`, title: `Snimaemyj lot ${n}`, marketCode: "LV", status: "live" }).returning();
    const [listing] = await world.ctx.db
      .insert(listings)
      .values({ itemId: item!.id, type: "auction", title: `Snimaemyj lot ${n}`, marketCode: "LV", startPriceCents: 1_000, status: "published" })
      .returning();
    const { auctions, bids } = await import("@auction/db");
    const [auction] = await world.ctx.db
      .insert(auctions)
      .values({
        listingId: listing!.id, status: "live",
        startsAt: new Date(world.ctx.now().getTime() - 3_600_000),
        endsAt: new Date(world.ctx.now().getTime() + 3_600_000),
      })
      .returning();
    for (const [i, u] of [a, b].entries()) {
      await world.ctx.db.insert(bids).values({
        auctionId: auction!.id, customerId: u.bidder.id,
        amountCents: 2_000 + i * 100, maxCents: 2_000 + i * 100, seq: i + 1, auto: false,
      });
    }

    const admin = await loginAs(world, "super@auction.test");
    const res = await world.server.app.inject({
      method: "POST", url: `/api/auctions/${auction!.id}/cancel`,
      headers: auth(admin),
      payload: { reason: "prece atsaukta" },
    });
    expect(res.statusCode).toBe(200);
    for (const u of [a, b]) {
      const letters = await lettersFor(u.bidder.id, "lot_withdrawn");
      expect(letters, u.bidder.id).toHaveLength(1);
      expect(letters[0]!.body).toContain("prece atsaukta");
    }
  });

  it("акт приёмки уходит поставщику, а недостача превращает его в расхождение", async () => {
    const clean = await mkSupplier();
    const [conOk] = await world.ctx.db
      .insert(consignments)
      .values({ ref: "CON-M1", supplier: clean.name, supplierId: clean.id, marketCode: "LV", expectedCount: 2 })
      .returning();
    for (const t of ["A", "B"]) {
      n += 1;
      await world.ctx.db.insert(items).values({ sku: `IN-${n}`, title: t, marketCode: "LV", consignmentId: conOk!.id });
    }
    await notifyIntakeClosed(world.ctx, conOk!.id);
    const act = await supplierLetters(clean.id, "sup_intake_done");
    expect(act).toHaveLength(1);
    expect(act[0]!.toEmail).toBe(clean.email);
    expect(act[0]!.body).toContain("CON-M1");

    const short = await mkSupplier();
    const [conShort] = await world.ctx.db
      .insert(consignments)
      .values({ ref: "CON-M2", supplier: short.name, supplierId: short.id, marketCode: "LV", expectedCount: 10 })
      .returning();
    n += 1;
    await world.ctx.db.insert(items).values({ sku: `IN-${n}`, title: "solo", marketCode: "LV", consignmentId: conShort!.id });
    await notifyIntakeClosed(world.ctx, conShort!.id);
    const disc = await supplierLetters(short.id, "sup_discrepancy");
    expect(disc).toHaveLength(1);
    // 10 заявлено − 1 принято = 9 не принято, и назван срок ответа.
    expect(disc[0]!.body).toContain("9");
    expect(disc[0]!.subject).toContain("CON-M2");
  });

  it("счёт поставщика: согласование и отказ пишут ему разными письмами", async () => {
    const sup = await mkSupplier();
    const mk = async (number: string) => {
      const [inv] = await world.ctx.db
        .insert(supplierInvoices)
        .values({
          supplierId: sup.id, number, invoiceDate: world.ctx.now(), dueDate: world.ctx.now(),
          amountCents: 50_000, approvalStatus: "pending",
        })
        .returning();
      return inv!;
    };
    const { approveInvoice, rejectInvoice } = await import("../src/engine/approvals.js");
    const ok = await mk("MAIL-1");
    expect(await approveInvoice(world.ctx, ok.id, { id: null, label: "Boss", roleId: "super_admin" })).toEqual({ ok: true, final: true });
    const accepted = await supplierLetters(sup.id, "sup_invoice_accepted");
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.subject).toContain("MAIL-1");

    const bad = await mk("MAIL-2");
    expect(await rejectInvoice(world.ctx, bad.id, { id: null, label: "Boss", roleId: "super_admin" }, "summa nesakrīt")).toEqual({ ok: true });
    const rejected = await supplierLetters(sup.id, "sup_invoice_rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.body).toContain("summa nesakrīt");
  });

  it("месячная сводка считает продажи, а комиссионному поставщику шлёт расчёт выплаты", async () => {
    const sup = await mkSupplier({ model: "commission", commissionBp: 2_500 });
    const [con] = await world.ctx.db
      .insert(consignments)
      .values({ ref: "CON-M3", supplier: sup.name, supplierId: sup.id, marketCode: "LV" })
      .returning();
    // Товар принят и продан в ПРОШЛОМ месяце — отчёт считает именно его.
    const now = world.ctx.now();
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
    n += 1;
    const [item] = await world.ctx.db
      .insert(items)
      .values({ sku: `SM-${n}`, title: "Prece", marketCode: "LV", consignmentId: con!.id, status: "paid", createdAt: lastMonth })
      .returning();
    const [listing] = await world.ctx.db
      .insert(listings).values({ itemId: item!.id, type: "fixed", title: "Prece", marketCode: "LV", priceCents: 10_000, status: "published" }).returning();
    const buyer = await register("supbuyer@mail.test");
    await world.ctx.db.insert(orders).values({
      ref: `SM-${n}`, listingId: listing!.id, itemId: item!.id, customerId: buyer.bidder.id,
      customerAlias: "buyer", customerEmail: "supbuyer@mail.test", marketCode: "LV",
      hammerCents: 8_264, premiumCents: 826, vatCents: 910, vatRateBp: 2_100, totalCents: 10_000,
      status: "paid", paidAt: lastMonth, createdAt: lastMonth,
    });

    // Крон срабатывает в назначенный день месяца.
    await setFinSetting(world.ctx, "supplier_report_day", now.getUTCDate(), "test");
    invalidateFinSettingsCache();
    const sent = await runSupplierMonthly(world.ctx);
    expect(sent.sent).toBeGreaterThanOrEqual(2);

    const summary = await supplierLetters(sup.id, "sup_monthly_report");
    expect(summary).toHaveLength(1);
    expect(summary[0]!.body).toContain("100,00");

    const settlement = await supplierLetters(sup.id, "sup_sales_report");
    expect(settlement).toHaveLength(1);
    // 100 € продажи − 25% комиссии = 75 € к выплате.
    expect(settlement[0]!.body).toContain("75,00");
    expect(settlement[0]!.body).toContain("25,00");
  });

  it("непроданный остаток зовёт поставщика принять решение", async () => {
    const sup = await mkSupplier();
    const [con] = await world.ctx.db
      .insert(consignments)
      .values({ ref: "CON-M4", supplier: sup.name, supplierId: sup.id, marketCode: "LV" })
      .returning();
    const old = new Date(world.ctx.now().getTime() - 90 * 86_400_000);
    for (const t of ["X", "Y", "Z"]) {
      n += 1;
      await world.ctx.db
        .insert(items)
        .values({ sku: `US-${n}`, title: t, marketCode: "LV", consignmentId: con!.id, status: "listed", createdAt: old });
    }
    expect((await runSupplierUnsold(world.ctx)).sent).toBeGreaterThanOrEqual(1);
    const letters = await supplierLetters(sup.id, "sup_unsold");
    expect(letters).toHaveLength(1);
    expect(letters[0]!.body).toContain("3");
  });

  it("поставщику без адреса и выключенному письма не уходят", async () => {
    const noEmail = await mkSupplier({ email: "" });
    const off = await mkSupplier({ active: false });
    for (const s of [noEmail, off]) {
      await enqueueSupplierNotification(world.ctx, world.ctx.db, {
        supplierId: s.id,
        type: "sup_welcome",
        template: { alias: "", lotTitle: "" },
      });
      expect(await supplierLetters(s.id, "sup_welcome")).toHaveLength(0);
    }
  });

  it("письма поставщикам — служебные: без блока отписки", async () => {
    for (const type of SUPPLIER_TYPES) {
      const msg = await renderNotification(world.ctx, type, "lv", { alias: "Jānis", lotTitle: "" });
      expect(msg.html.toLowerCase(), type).not.toContain("atteikties no jaunumiem");
    }
  });
});
