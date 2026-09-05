import { consignments, items, listings, notifications, orders, suppliers, supplierInvoices } from "@auction/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeExpiredDiscrepancies, notifyIntakeClosed } from "../src/engine/supplierMail.js";
import { auth, createWorld, loginAs, type TestWorld } from "./helpers.js";

/**
 * Кабинет поставщика: вход только по приглашению, каждый видит ровно свои
 * поставки, счёт из кабинета идёт в общую очередь согласования, а смена
 * банковского счёта не применяется без подтверждения менеджера.
 */
describe("кабинет поставщика", () => {
  let world: TestWorld;
  let admin: string;
  let n = 0;

  const app = () => world.server.app;
  const mkSupplier = async (over: Partial<typeof suppliers.$inferInsert> = {}) => {
    n += 1;
    const [sup] = await world.ctx.db
      .insert(suppliers)
      .values({
        name: `Portal Sup ${n}`, email: `portal${n}@sup.test`, contactName: "Jānis", lang: "lv",
        bankAccount: "LV80BANK0000435195001", paymentTermsDays: 14, ...over,
      })
      .returning();
    return sup!;
  };
  /** Пригласить и активировать — путь, которым поставщик реально заходит. */
  const activate = async (supplierId: string, password = "Supplier123!") => {
    world.email.sent.length = 0;
    const invited = await app().inject({
      method: "POST", url: `/api/suppliers/${supplierId}/invite`, headers: auth(admin),
    });
    expect(invited.statusCode).toBe(200);
    // Ссылку берём из письма — как её увидит человек.
    const { dispatchNotifications } = await import("../src/engine/notifications.js");
    await dispatchNotifications(world.ctx);
    const letter = world.email.sent.at(-1)!;
    const token = /token=([A-Za-z0-9_-]+)/.exec(letter.text)?.[1];
    expect(token, "ссылка приглашения в письме").toBeTruthy();
    const res = await app().inject({
      method: "POST", url: `/api/piegadatajs/invite/${token}`, payload: { password },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { accessToken: string }).accessToken;
  };

  beforeAll(async () => {
    world = await createWorld();
    admin = await loginAs(world, "super@auction.test");
  });
  afterAll(async () => {
    if (world) await world.close();
  });

  it("без приглашения в кабинет не войти, а по ссылке — вход и письмо S2", async () => {
    const sup = await mkSupplier();
    // Пароля ещё нет — вход закрыт.
    const early = await app().inject({
      method: "POST", url: "/api/piegadatajs/login", payload: { email: sup.email, password: "Supplier123!" },
    });
    expect(early.statusCode).toBe(401);

    const token = await activate(sup.id);
    expect(token.length).toBeGreaterThan(20);
    const welcome = await world.ctx.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.supplierId, sup.id), eq(notifications.type, "sup_welcome")));
    expect(welcome).toHaveLength(1);

    // Ссылка одноразовая: второй раз тем же токеном не пройти.
    const again = await app().inject({
      method: "POST", url: "/api/piegadatajs/invite/whatever", payload: { password: "Supplier123!" },
    });
    expect(again.statusCode).toBe(404);

    // Зато обычный вход теперь работает.
    const login = await app().inject({
      method: "POST", url: "/api/piegadatajs/login", payload: { email: sup.email, password: "Supplier123!" },
    });
    expect(login.statusCode).toBe(200);
  });

  it("поставщик видит только свои поставки и продажи", async () => {
    const mine = await mkSupplier();
    const other = await mkSupplier();
    const token = await activate(mine.id);
    for (const [sup, ref] of [[mine, "CON-P1"], [other, "CON-P2"]] as const) {
      await world.ctx.db
        .insert(consignments)
        .values({ ref, supplier: sup.name, supplierId: sup.id, marketCode: "LV", expectedCount: 5 });
    }
    const res = await app().inject({ method: "GET", url: "/api/piegadatajs/deliveries", headers: auth(token) });
    expect(res.statusCode).toBe(200);
    const refs = (res.json() as { deliveries: Array<{ ref: string }> }).deliveries.map((d) => d.ref);
    expect(refs).toContain("CON-P1");
    expect(refs, "чужая поставка не видна").not.toContain("CON-P2");

    // Без токена кабинет закрыт вовсе.
    expect((await app().inject({ method: "GET", url: "/api/piegadatajs/deliveries" })).statusCode).toBe(401);
    // Токен покупателя в кабинет поставщика не пускает.
    const buyer = await app().inject({
      method: "POST", url: "/api/public/auth/register",
      payload: { email: "notasupplier@mail.test", alias: "notasupplier", password: "Bidder123!" },
    });
    const buyerToken = (buyer.json() as { accessToken: string }).accessToken;
    expect((await app().inject({ method: "GET", url: "/api/piegadatajs/deliveries", headers: auth(buyerToken) })).statusCode).toBe(401);
  });

  it("заявка на поставку появляется у склада и принимается одной кнопкой", async () => {
    const sup = await mkSupplier();
    const token = await activate(sup.id);
    const created = await app().inject({
      method: "POST", url: "/api/piegadatajs/deliveries", headers: auth(token),
      payload: { expectedCount: 40, plannedAt: new Date(world.ctx.now().getTime() + 86_400_000).toISOString() },
    });
    expect(created.statusCode).toBe(200);
    const delivery = (created.json() as { delivery: { id: string; ref: string; status: string } }).delivery;
    expect(delivery.status).toBe("announced");

    // Пока заявка не принята, приёмка в неё закрыта.
    const early = await app().inject({
      method: "POST", url: `/api/consignments/${delivery.id}/receive`, headers: auth(admin),
      payload: { title: "Prece" },
    });
    expect(early.statusCode).toBe(409);

    const accepted = await app().inject({
      method: "POST", url: `/api/consignments/${delivery.id}/accept`, headers: auth(admin),
    });
    expect(accepted.statusCode).toBe(200);
    const ok = await app().inject({
      method: "POST", url: `/api/consignments/${delivery.id}/receive`, headers: auth(admin),
      payload: { title: "Prece" },
    });
    expect(ok.statusCode).toBe(200);
  });

  it("расхождение ждёт ответа в кабинете: спор поднимает флаг, молчание закрывает акт", async () => {
    const sup = await mkSupplier();
    const token = await activate(sup.id);
    const [con] = await world.ctx.db
      .insert(consignments)
      .values({ ref: "CON-P3", supplier: sup.name, supplierId: sup.id, marketCode: "LV", expectedCount: 10 })
      .returning();
    n += 1;
    await world.ctx.db.insert(items).values({ sku: `PP-${n}`, title: "Prece", marketCode: "LV", consignmentId: con!.id });
    await notifyIntakeClosed(world.ctx, con!.id);

    const list = await app().inject({ method: "GET", url: "/api/piegadatajs/deliveries", headers: auth(token) });
    const row = (list.json() as { deliveries: Array<{ id: string; discrepancyStatus: string }> }).deliveries
      .find((d) => d.id === con!.id);
    expect(row!.discrepancyStatus).toBe("open");

    // Спор без объяснения не принимается.
    const empty = await app().inject({
      method: "POST", url: `/api/piegadatajs/deliveries/${con!.id}/reply`, headers: auth(token),
      payload: { decision: "dispute" },
    });
    expect(empty.statusCode).toBe(422);

    const disputed = await app().inject({
      method: "POST", url: `/api/piegadatajs/deliveries/${con!.id}/reply`, headers: auth(token),
      payload: { decision: "dispute", note: "atvedām visas 10, pārbaudiet vēlreiz" },
    });
    expect(disputed.statusCode).toBe(200);
    const { finFlags } = await import("@auction/db");
    const [flag] = await world.ctx.db.select().from(finFlags).where(eq(finFlags.dedupeKey, `sup_dispute:${con!.id}`));
    expect(flag, "спор попал в очередь внимания").toBeTruthy();

    // Второй акт: поставщик молчит — по истечении срока считается принятым.
    const [old] = await world.ctx.db
      .insert(consignments)
      .values({
        ref: "CON-P4", supplier: sup.name, supplierId: sup.id, marketCode: "LV", expectedCount: 3,
        discrepancyStatus: "open",
        discrepancyDueAt: new Date(world.ctx.now().getTime() - 86_400_000),
      })
      .returning();
    expect((await closeExpiredDiscrepancies(world.ctx)).closed).toBeGreaterThanOrEqual(1);
    const [after] = await world.ctx.db.select().from(consignments).where(eq(consignments.id, old!.id));
    expect(after!.discrepancyStatus).toBe("accepted");
  });

  it("счёт из кабинета попадает в очередь согласования и не задваивается", async () => {
    const sup = await mkSupplier();
    const token = await activate(sup.id);
    const payload = { number: "SUP-INV-1", invoiceDate: "2026-08-01", amountCents: 120_000 };
    const first = await app().inject({ method: "POST", url: "/api/piegadatajs/invoices", headers: auth(token), payload });
    expect(first.statusCode).toBe(200);
    const dup = await app().inject({ method: "POST", url: "/api/piegadatajs/invoices", headers: auth(token), payload });
    expect(dup.statusCode).toBe(409);

    const [inv] = await world.ctx.db
      .select()
      .from(supplierInvoices)
      .where(and(eq(supplierInvoices.supplierId, sup.id), eq(supplierInvoices.number, "SUP-INV-1")));
    // Срок оплаты посчитан по условиям поставщика (14 дней).
    expect(inv!.dueDate.toISOString().slice(0, 10)).toBe("2026-08-15");
    expect(["pending", "auto"]).toContain(inv!.approvalStatus);

    // Чужую поставку к своему счёту привязать нельзя.
    const stranger = await mkSupplier();
    const [foreign] = await world.ctx.db
      .insert(consignments)
      .values({ ref: "CON-P5", supplier: stranger.name, supplierId: stranger.id, marketCode: "LV" })
      .returning();
    const wrong = await app().inject({
      method: "POST", url: "/api/piegadatajs/invoices", headers: auth(token),
      payload: { number: "SUP-INV-2", invoiceDate: "2026-08-01", amountCents: 1_000, consignmentId: foreign!.id },
    });
    expect(wrong.statusCode).toBe(404);
  });

  it("смена банковского счёта ждёт подтверждения менеджера", async () => {
    const sup = await mkSupplier();
    const token = await activate(sup.id);
    world.email.sent.length = 0;
    const res = await app().inject({
      method: "PATCH", url: "/api/piegadatajs/profile", headers: auth(token),
      payload: { bankAccount: "LV11HACK0000000000009", phone: "+371 20 000 111" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { bankPending: boolean }).bankPending).toBe(true);

    const [pending] = await world.ctx.db.select().from(suppliers).where(eq(suppliers.id, sup.id));
    // Старый счёт остался, новый только заявлен; телефон поменялся сразу.
    expect(pending!.bankAccount).toBe("LV80BANK0000435195001");
    expect(pending!.pendingBankAccount).toBe("LV11HACK0000000000009");
    expect(pending!.phone).toBe("+371 20 000 111");
    // Предупреждение ушло на прежний адрес.
    expect(world.email.sent.some((m) => m.to === sup.email)).toBe(true);

    const approved = await app().inject({
      method: "POST", url: `/api/suppliers/${sup.id}/bank-change`, headers: auth(admin),
      payload: { decision: "approve" },
    });
    expect(approved.statusCode).toBe(200);
    const [after] = await world.ctx.db.select().from(suppliers).where(eq(suppliers.id, sup.id));
    expect(after!.bankAccount).toBe("LV11HACK0000000000009");
    expect(after!.pendingBankAccount).toBeNull();
  });

  it("экран реализации показывает проданное с ценами и процент продажи", async () => {
    const sup = await mkSupplier({ model: "commission", commissionBp: 2_000 });
    const token = await activate(sup.id);
    const [con] = await world.ctx.db
      .insert(consignments)
      .values({ ref: "CON-P6", supplier: sup.name, supplierId: sup.id, marketCode: "LV" })
      .returning();
    n += 1;
    const [sold] = await world.ctx.db
      .insert(items)
      .values({ sku: `SP-${n}`, title: "Pārdotā prece", marketCode: "LV", consignmentId: con!.id, status: "paid" })
      .returning();
    n += 1;
    await world.ctx.db
      .insert(items)
      .values({ sku: `SP-${n}`, title: "Vēl stāv", marketCode: "LV", consignmentId: con!.id, status: "listed" });
    const [listing] = await world.ctx.db
      .insert(listings)
      .values({ itemId: sold!.id, type: "fixed", title: "Pārdotā prece", marketCode: "LV", priceCents: 20_000, status: "published" })
      .returning();
    const buyer = await app().inject({
      method: "POST", url: "/api/public/auth/register",
      payload: { email: `pbuyer${n}@mail.test`, alias: `pbuyer${n}`, password: "Bidder123!" },
    });
    const buyerId = (buyer.json() as { bidder: { id: string } }).bidder.id;
    await world.ctx.db.insert(orders).values({
      ref: `PS-${n}`, listingId: listing!.id, itemId: sold!.id, customerId: buyerId,
      customerAlias: "buyer", customerEmail: `pbuyer${n}@mail.test`, marketCode: "LV",
      hammerCents: 16_528, premiumCents: 1_653, vatCents: 1_819, vatRateBp: 2_100, totalCents: 20_000,
      status: "paid", paidAt: world.ctx.now(),
    });

    const res = await app().inject({ method: "GET", url: "/api/piegadatajs/sales", headers: auth(token) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      lots: Array<{ title: string; priceCents: number }>;
      totals: { grossCents: number; commissionCents: number; payoutCents: number; sellThroughPercent: number; inStock: number };
    };
    expect(body.lots).toHaveLength(1);
    expect(body.lots[0]!.priceCents, "цену продажи показываем").toBe(20_000);
    expect(body.totals.grossCents).toBe(20_000);
    // Комиссия 20% → 40 € нам, 160 € поставщику.
    expect(body.totals.commissionCents).toBe(4_000);
    expect(body.totals.payoutCents).toBe(16_000);
    expect(body.totals.inStock).toBe(1);
    expect(body.totals.sellThroughPercent).toBe(50);
  });

  it("сводка кабинета собирает поставки, остаток и долг", async () => {
    const sup = await mkSupplier();
    const token = await activate(sup.id);
    await world.ctx.db
      .insert(consignments)
      .values({ ref: "CON-P7", supplier: sup.name, supplierId: sup.id, marketCode: "LV", status: "announced" });
    await world.ctx.db.insert(supplierInvoices).values({
      supplierId: sup.id, number: "SUM-1", invoiceDate: world.ctx.now(),
      dueDate: new Date(world.ctx.now().getTime() + 7 * 86_400_000),
      amountCents: 90_000, status: "unpaid", approvalStatus: "approved",
    });
    const res = await app().inject({ method: "GET", url: "/api/piegadatajs/summary", headers: auth(token) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      supplier: { name: string; paymentTermsDays: number };
      deliveries: { announced: number };
      money: { outstandingCents: number; nextDueDate: string | null };
    };
    expect(body.supplier.name).toBe(sup.name);
    expect(body.deliveries.announced).toBe(1);
    expect(body.money.outstandingCents).toBe(90_000);
    expect(body.money.nextDueDate).toBeTruthy();
  });
});
