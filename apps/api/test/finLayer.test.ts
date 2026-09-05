import { createHash } from "node:crypto";
import { approvalRules, consignments, customers, finFlags, items, ledgerEntries, listings, loyaltyAccounts, loyaltyLedger, orders, refunds, suppliers, supplierInvoices } from "@auction/db";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approveInvoice, matchApprovalRule, rejectInvoice, routeInvoiceApproval } from "../src/engine/approvals.js";
import { runClearingOverdue, runEuThreshold, runRefundSla } from "../src/engine/finFlags.js";
import { getFinSettings, invalidateFinSettingsCache, setFinSetting } from "../src/engine/finSettings.js";
import { allocateConsignmentCost, createExportBatch } from "../src/engine/ledger.js";
import { movePoints } from "../src/engine/loyalty.js";
import { runPointsExpiry } from "../src/engine/loyaltyExpiry.js";
import { markRefundPaid, refundOrder } from "../src/engine/refund.js";
import { settleOrderPaid } from "../src/engine/settlement.js";
import { createWorld, type TestWorld } from "./helpers.js";

/**
 * Финансовый слой (fin-architecture): проводки продажи, Refund Pending со
 * сторно только после «выплачено», распределитель себестоимости палеты,
 * approval-маршруты с двойной подписью, FIFO-сгорание баллов и контрольные
 * кроны. Всё проверяется деньгами — суммами в журнале.
 */
describe("финансовый слой: ledger, возвраты, апрувы, сгорание", () => {
  let world: TestWorld;
  let n = 0;

  const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

  const register = async (email: string) => {
    const res = await world.server.app.inject({
      method: "POST",
      url: "/api/public/auth/register",
      payload: { email, alias: email.split("@")[0]!.replace(/[^a-z0-9]/gi, ""), password: "Bidder123!" },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as { accessToken: string; bidder: { id: string } };
  };
  const verify = async (customerId: string) => {
    const token = `verify-token-${customerId}`.padEnd(24, "x");
    await world.ctx.db
      .update(customers)
      .set({ emailVerifyTokenHash: sha256(token), emailVerifySentAt: world.ctx.now() })
      .where(eq(customers.id, customerId));
    const res = await world.server.app.inject({ method: "POST", url: "/api/public/auth/verify-email", payload: { token } });
    expect(res.statusCode).toBe(200);
  };
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  const mkListing = async (priceCents: number) => {
    n += 1;
    const [item] = await world.ctx.db
      .insert(items)
      .values({ sku: `FIN-${n}`, title: `Fin lote ${n}`, marketCode: "LV", status: "listed", costCents: 2_000 })
      .returning({ id: items.id });
    const [listing] = await world.ctx.db
      .insert(listings)
      .values({ itemId: item!.id, type: "fixed", title: `Fin lote ${n}`, marketCode: "LV", priceCents, quantity: 1, status: "published" })
      .returning({ id: listings.id });
    return { itemId: item!.id, listingId: listing!.id };
  };
  const buyOrder = async (email: string, priceCents: number) => {
    const u = await register(email);
    await verify(u.bidder.id);
    const l = await mkListing(priceCents);
    const add = await world.server.app.inject({
      method: "POST", url: "/api/public/cart", headers: auth(u.accessToken), payload: { listing_id: l.listingId },
    });
    expect(add.statusCode).toBe(200);
    const res = await world.server.app.inject({ method: "POST", url: "/api/public/cart/checkout", headers: auth(u.accessToken), payload: {} });
    expect(res.statusCode).toBe(200);
    const ref = (res.json() as { orders: Array<{ ref: string }> }).orders[0]!.ref;
    const [order] = await world.ctx.db.select().from(orders).where(eq(orders.ref, ref));
    return { order: order!, customerId: u.bidder.id };
  };
  const entriesFor = (orderRef: string) =>
    world.ctx.db.select().from(ledgerEntries).where(eq(ledgerEntries.orderRef, orderRef)).orderBy(asc(ledgerEntries.createdAt));

  beforeAll(async () => {
    world = await createWorld();
  });
  afterAll(async () => {
    if (world) await world.close();
  });

  it("оплата заказа раскладывается в журнал: выручка+PVN = итог, clearing по провайдеру, COGS, баллы", async () => {
    const { order } = await buyOrder("ledger1@fin.test", 10_000);
    const settled = await settleOrderPaid(world.ctx, order.id, { id: null, label: "test" }, { provider: "klix" });
    expect(settled.outcome).toBe("settled");

    const entries = await entriesFor(order.ref);
    const sum = (account: string) => entries.filter((e) => e.account === account).reduce((s, e) => s + e.amountCents, 0);
    // Компоненты выручки сходятся с итогом заказа цент в цент.
    expect(sum("revenue_hammer") + sum("revenue_premium") + sum("revenue_shipping") + sum("vat_payable") + sum("rounding_differences")).toBe(order.totalCents);
    // Онлайн-оплата повисла «в пути» у Klix на полную сумму.
    expect(sum("clearing_klix")).toBe(order.totalCents);
    // COGS списал себестоимость и уменьшил запасы.
    expect(sum("expense_cogs")).toBe(2_000);
    expect(sum("asset_inventory")).toBe(-2_000);
    // Начисленные баллы увеличили обязательство (100 € → 100 баллов).
    expect(sum("liability_loyalty_points")).toBe(10_000);
  });

  it("bank-возврат: заявка вешает liability, сторно выручки — ТОЛЬКО после «выплачено»", async () => {
    const { order } = await buyOrder("refund1@fin.test", 20_000);
    await settleOrderPaid(world.ctx, order.id, { id: null, label: "test" }, { provider: "klix" });

    const out = await refundOrder(world.ctx, order.id, {
      amountCents: 20_000, reason: "prece bojāta", viaProvider: false, method: "bank", actor: { id: null, label: "ops" },
    });
    expect(out.ok).toBe(true);
    const [refund] = await world.ctx.db.select().from(refunds).where(eq(refunds.orderId, order.id));
    expect(refund!.status).toBe("requested");

    let entries = await entriesFor(order.ref);
    const pending = entries.filter((e) => e.account === "liability_refunds_pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.amountCents).toBe(20_000);
    // Сторно ещё НЕ проведено, заказ не помечен возвращённым.
    expect(entries.filter((e) => e.account === "revenue_hammer" && e.amountCents < 0)).toHaveLength(0);
    expect((await world.ctx.db.select().from(orders).where(eq(orders.id, order.id)))[0]!.status).toBe("paid");

    const marked = await markRefundPaid(world.ctx, refund!.id, { id: null, label: "grāmatvede" });
    expect(marked.ok).toBe(true);
    entries = await entriesFor(order.ref);
    const sum = (account: string) => entries.filter((e) => e.account === account).reduce((s, e) => s + e.amountCents, 0);
    // Liability снята, выручка сторнирована пропорционально (полный возврат).
    expect(sum("liability_refunds_pending")).toBe(0);
    expect(sum("revenue_hammer") + sum("revenue_premium") + sum("revenue_shipping") + sum("vat_payable") + sum("rounding_differences")).toBe(0);
    const [after] = await world.ctx.db.select().from(orders).where(eq(orders.id, order.id));
    expect(after!.status).toBe("refunded");
    const [refundAfter] = await world.ctx.db.select().from(refunds).where(eq(refunds.id, refund!.id));
    expect(refundAfter!.status).toBe("paid");
  });

  it("cash-возврат у стойки — мгновенный: сразу paid и сторно, без liability", async () => {
    const { order } = await buyOrder("refund2@fin.test", 5_000);
    await settleOrderPaid(world.ctx, order.id, { id: null, label: "test" });
    const out = await refundOrder(world.ctx, order.id, {
      amountCents: 2_000, reason: "daļējs", viaProvider: false, actor: { id: null, label: "ops" },
    });
    expect(out.ok).toBe(true);
    const [refund] = await world.ctx.db.select().from(refunds).where(eq(refunds.orderId, order.id));
    expect(refund!.status).toBe("paid");
    const entries = await entriesFor(order.ref);
    expect(entries.filter((e) => e.account === "liability_refunds_pending")).toHaveLength(0);
    const storno = entries.filter((e) => e.refType === "refund").reduce((s, e) => s + e.amountCents, 0);
    // Частичный возврат: сторнированные компоненты в сумме дают −2000.
    expect(storno).toBe(-2_000);
  });

  it("распределитель палеты: по оценке листингов, последний забирает остаток", async () => {
    const [sup] = await world.ctx.db.insert(suppliers).values({ name: "Pallet Sup" }).returning();
    const [con] = await world.ctx.db
      .insert(consignments)
      .values({ ref: "CON-F1", supplier: "Pallet Sup", supplierId: sup!.id, marketCode: "LV", extraCostCents: 500 })
      .returning();
    const mkUnit = async (sku: string, price: number | null) => {
      const [item] = await world.ctx.db
        .insert(items)
        .values({ sku, title: sku, marketCode: "LV", consignmentId: con!.id })
        .returning({ id: items.id });
      if (price != null) {
        await world.ctx.db.insert(listings).values({ itemId: item!.id, type: "fixed", title: sku, marketCode: "LV", priceCents: price, status: "draft" });
      }
      return item!.id;
    };
    const a = await mkUnit("PAL-A", 3_000);
    const b = await mkUnit("PAL-B", 1_000);
    await world.ctx.db.insert(supplierInvoices).values({
      supplierId: sup!.id, consignmentId: con!.id, number: "PINV-1",
      invoiceDate: world.ctx.now(), dueDate: world.ctx.now(), amountCents: 1_500, approvalStatus: "approved",
    });
    // Пул = 1500 (счёт) + 500 (extra) = 2000; веса 3:1 → 1500 и 500.
    const result = await allocateConsignmentCost(world.ctx.db, con!.id, world.ctx.now());
    expect(result).toEqual({ allocated: 2, poolCents: 2_000 });
    const cost = async (id: string) => (await world.ctx.db.select().from(items).where(eq(items.id, id)))[0]!.costCents;
    expect(await cost(a)).toBe(1_500);
    expect(await cost(b)).toBe(500);

    // Fallback поровну: у единиц нет ни одной оценки.
    const [con2] = await world.ctx.db
      .insert(consignments)
      .values({ ref: "CON-F2", supplier: "Pallet Sup", supplierId: sup!.id, marketCode: "LV", extraCostCents: 1_001 })
      .returning();
    const c = await world.ctx.db.insert(items).values({ sku: "PAL-C", title: "c", marketCode: "LV", consignmentId: con2!.id }).returning({ id: items.id });
    const d = await world.ctx.db.insert(items).values({ sku: "PAL-D", title: "d", marketCode: "LV", consignmentId: con2!.id }).returning({ id: items.id });
    const r2 = await allocateConsignmentCost(world.ctx.db, con2!.id, world.ctx.now());
    expect(r2).toEqual({ allocated: 2, poolCents: 1_001 });
    // 500 + 501 — последний забирает остаток, сумма сходится до цента.
    expect((await cost(c[0]!.id))! + (await cost(d[0]!.id))!).toBe(1_001);
  });

  it("approval-маршруты: auto проводится сам, дорогой счёт ждёт две подписи разных людей", async () => {
    await world.ctx.db.insert(approvalRules).values([
      { minCents: 0, maxCents: 20_000, approver: "auto", dual: false, position: 0 },
      { minCents: 20_000, maxCents: null, approver: "role:operations", dual: true, position: 1 },
    ]);
    const small = await matchApprovalRule(world.ctx.db, 10_000);
    expect(small.approver).toBe("auto");
    const big = await matchApprovalRule(world.ctx.db, 50_000);
    expect(big).toMatchObject({ approver: "role:operations", dual: true });

    const [sup] = await world.ctx.db.insert(suppliers).values({ name: "Appr Sup" }).returning();
    const mkInvoice = async (number: string, amountCents: number) => {
      const [inv] = await world.ctx.db
        .insert(supplierInvoices)
        .values({ supplierId: sup!.id, number, invoiceDate: world.ctx.now(), dueDate: world.ctx.now(), amountCents, approvalStatus: "pending" })
        .returning();
      return inv!;
    };

    // Мелкий счёт — auto: сразу проведён и в журнале.
    const smallInv = await mkInvoice("AP-1", 15_000);
    expect(await routeInvoiceApproval(world.ctx, smallInv.id, { id: null, label: "test" })).toBe("auto");
    const [autoRow] = await world.ctx.db.select().from(supplierInvoices).where(eq(supplierInvoices.id, smallInv.id));
    expect(autoRow!.approvalStatus).toBe("auto");
    const autoEntries = await world.ctx.db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.refType, "supplier_invoice"), eq(ledgerEntries.refId, smallInv.id)));
    expect(autoEntries).toHaveLength(1);
    expect(autoEntries[0]!.amountCents).toBe(15_000);

    // Дорогой счёт — pending; чужая роль не может, первый апрувер даёт первую
    // подпись, второй раз ТОТ ЖЕ человек — отказ, другой (finance) — финал.
    const bigInv = await mkInvoice("AP-2", 50_000);
    expect(await routeInvoiceApproval(world.ctx, bigInv.id, { id: null, label: "test" })).toBe("pending");
    const wrong = await approveInvoice(world.ctx, bigInv.id, { id: null, label: "Content", roleId: "content_editor" });
    expect(wrong).toEqual({ ok: false, error: "wrong_approver" });
    const first = await approveInvoice(world.ctx, bigInv.id, { id: null, label: "Ops Anna", roleId: "operations" });
    expect(first).toEqual({ ok: true, final: false });
    const [dualFlag] = await world.ctx.db.select().from(finFlags).where(eq(finFlags.dedupeKey, `dual:${bigInv.id}`));
    expect(dualFlag).toBeTruthy();
    const same = await approveInvoice(world.ctx, bigInv.id, { id: null, label: "Ops Anna", roleId: "operations" });
    expect(same).toEqual({ ok: false, error: "same_person" });
    const second = await approveInvoice(world.ctx, bigInv.id, { id: null, label: "Grāmatvede", roleId: "finance" });
    expect(second).toEqual({ ok: true, final: true });
    const [approved] = await world.ctx.db.select().from(supplierInvoices).where(eq(supplierInvoices.id, bigInv.id));
    expect(approved!.approvalStatus).toBe("approved");
    expect(approved!.secondApprovedBy).toBe("Grāmatvede");
    const [resolvedFlag] = await world.ctx.db.select().from(finFlags).where(eq(finFlags.dedupeKey, `dual:${bigInv.id}`));
    expect(resolvedFlag!.status).toBe("resolved");

    // Отклонение работает только для pending.
    const rejInv = await mkInvoice("AP-3", 50_000);
    await routeInvoiceApproval(world.ctx, rejInv.id, { id: null, label: "test" });
    const rej = await rejectInvoice(world.ctx, rejInv.id, { id: null, label: "Ops", roleId: "operations" }, "dubults rēķins");
    expect(rej.ok).toBe(true);
    const again = await rejectInvoice(world.ctx, rejInv.id, { id: null, label: "Ops", roleId: "operations" }, "vēlreiz");
    expect(again).toEqual({ ok: false, error: "not_pending" });
  });

  it("FIFO-сгорание: старые непотраченные начисления сгорают в breakage, свежие остаются", async () => {
    const u = await register("expiry@fin.test");
    // Режим стартовал 2 года назад; порог — 12 месяцев.
    const start = new Date(world.ctx.now().getTime());
    start.setUTCFullYear(start.getUTCFullYear() - 2);
    await setFinSetting(world.ctx, "points_expiry_start_ms", start.getTime(), "test");
    invalidateFinSettingsCache();

    await movePoints(world.ctx.db, u.bidder.id, { reason: "purchase", amountCents: 1_000, note: "old" }, world.ctx.now());
    await movePoints(world.ctx.db, u.bidder.id, { reason: "purchase", amountCents: 500, note: "fresh" }, world.ctx.now());
    await movePoints(world.ctx.db, u.bidder.id, { reason: "redemption", amountCents: -300, note: "spent" }, world.ctx.now());
    // Старое начисление уводим за порог (13 месяцев назад).
    const backdate = new Date(world.ctx.now().getTime());
    backdate.setUTCMonth(backdate.getUTCMonth() - 13);
    const [acc] = await world.ctx.db.select().from(loyaltyAccounts).where(eq(loyaltyAccounts.customerId, u.bidder.id));
    await world.ctx.db
      .update(loyaltyLedger)
      .set({ createdAt: backdate })
      .where(and(eq(loyaltyLedger.accountId, acc!.id), eq(loyaltyLedger.note, "old")));

    const result = await runPointsExpiry(world.ctx);
    // FIFO: списание 300 съело старейшее начисление → от старой 1000 осталось
    // 700, они сгорают; свежие 500 живут. Баланс 1200 → 500.
    expect(result.expiredCents).toBe(700);
    const [after] = await world.ctx.db.select().from(loyaltyAccounts).where(eq(loyaltyAccounts.id, acc!.id));
    expect(after!.balanceCents).toBe(500);
    const breakage = await world.ctx.db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.account, "revenue_loyalty_breakage"), eq(ledgerEntries.refId, u.bidder.id)));
    expect(breakage).toHaveLength(1);
    expect(breakage[0]!.amountCents).toBe(700);
    // Повторный прогон ничего не сжигает дважды.
    expect((await runPointsExpiry(world.ctx)).expiredCents).toBe(0);
  });

  it("кроны-контролёры: SLA возврата, clearing-окно, порог €10k EE+LT", async () => {
    // SLA: bank-возврат старше 3 дней → флаг.
    const { order } = await buyOrder("sla@fin.test", 4_000);
    await settleOrderPaid(world.ctx, order.id, { id: null, label: "test" });
    await refundOrder(world.ctx, order.id, { amountCents: 4_000, reason: "sla tests", viaProvider: false, method: "bank", actor: { id: null, label: "ops" } });
    const [slaRefund] = await world.ctx.db.select().from(refunds).where(eq(refunds.orderId, order.id));
    await world.ctx.db
      .update(refunds)
      .set({ createdAt: new Date(world.ctx.now().getTime() - 4 * 86_400_000) })
      .where(eq(refunds.id, slaRefund!.id));
    await runRefundSla(world.ctx);
    const [slaFlag] = await world.ctx.db.select().from(finFlags).where(eq(finFlags.dedupeKey, `refund_sla:${slaRefund!.id}`));
    expect(slaFlag).toBeTruthy();

    // Clearing: klix-запись старше 2 дней без выплаты → флаг по заказу.
    const { order: o2 } = await buyOrder("clearing@fin.test", 6_000);
    await settleOrderPaid(world.ctx, o2.id, { id: null, label: "test" }, { provider: "klix" });
    await world.ctx.db
      .update(ledgerEntries)
      .set({ eventAt: new Date(world.ctx.now().getTime() - 3 * 86_400_000) })
      .where(and(eq(ledgerEntries.orderRef, o2.ref), eq(ledgerEntries.account, "clearing_klix")));
    await runClearingOverdue(world.ctx);
    const [clFlag] = await world.ctx.db.select().from(finFlags).where(eq(finFlags.dedupeKey, `clearing:clearing_klix:${o2.ref}`));
    expect(clFlag).toBeTruthy();
    expect(clFlag!.amountCents).toBe(o2.totalCents);

    // €10k: эстонские оплаты на 85% порога → предупреждение при 80%.
    const { order: ee } = await buyOrder("eulimits@fin.test", 4_000);
    await world.ctx.db
      .update(orders)
      .set({ marketCode: "EE", status: "paid", paidAt: world.ctx.now(), totalCents: 850_000 })
      .where(eq(orders.id, ee.id));
    await runEuThreshold(world.ctx);
    const year = world.ctx.now().getUTCFullYear();
    const [alert] = await world.ctx.db.select().from(finFlags).where(eq(finFlags.dedupeKey, `eu:${year}:alert`));
    expect(alert).toBeTruthy();
  });

  it("экспорт-батч: строки уходят один раз, CSV сходится, повтор пуст", async () => {
    const from = new Date(world.ctx.now().getTime() - 400 * 86_400_000);
    const to = new Date(world.ctx.now().getTime() + 86_400_000);
    const result = await createExportBatch(world.ctx, { fromAt: from, toAt: to, format: "csv", actor: "test" });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.entryCount).toBeGreaterThan(0);
    const lines = result.content.trim().split("\r\n");
    expect(lines[0]).toContain("date;account");
    expect(lines).toHaveLength(result.entryCount + 1);
    // Все строки периода помечены батчем — второй экспорт пуст.
    const again = await createExportBatch(world.ctx, { fromAt: from, toAt: to, format: "xml", actor: "test" });
    expect(again).toEqual({ error: "empty" });
  });

  it("настройки финслоя: каждое значение правится и переживает кэш", async () => {
    await setFinSetting(world.ctx, "tolerance_bank_cents", 25, "test");
    invalidateFinSettingsCache();
    const s = await getFinSettings(world.ctx);
    expect(s.tolerance_bank_cents).toBe(25);
    expect(s.refund_sla_days).toBe(3);
    expect(s.points_expiry_months).toBe(12);
  });
});
