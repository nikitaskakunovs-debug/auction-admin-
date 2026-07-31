import { consignments, supplierInvoices, suppliers } from "@auction/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createWorld, loginAs, type TestWorld } from "./helpers.js";

/**
 * R1 — supplier invoices. The platform knew what stock cost but not whether
 * the supplier had been paid; these pin the rules that answer that: names stop
 * multiplying, bills fall due on each supplier's terms, part payments add up,
 * and none of the money is visible to the people who unload the pallet.
 */
describe("supplier invoices (R1)", () => {
  let world: TestWorld;
  let superToken: string;
  let opsToken: string;
  let financeToken: string;

  beforeAll(async () => {
    world = await createWorld();
    superToken = await loginAs(world, "super@auction.test");
    opsToken = await loginAs(world, "ops@auction.test");
    financeToken = await loginAs(world, "finance@auction.test");
  });
  afterAll(async () => {
    if (world) await world.close();
  });

  const app = () => world.server.app;
  const json = <T>(res: { json: () => unknown }) => res.json() as T;

  const mkSupplier = async (name: string, extra: Record<string, unknown> = {}, token = superToken) =>
    app().inject({ method: "POST", url: "/api/suppliers", headers: auth(token), payload: { name, ...extra } });

  const mkDelivery = async (payload: Record<string, unknown>) =>
    app().inject({ method: "POST", url: "/api/consignments", headers: auth(superToken), payload: { marketCode: "LV", ...payload } });

  it("stops the same supplier being invented twice under different spellings", async () => {
    const first = await mkSupplier("Nordic Trade OÜ");
    expect(first.statusCode).toBe(200);
    const id = json<{ supplier: { id: string } }>(first).supplier.id;

    const again = await mkSupplier("  nordic trade oü  ");
    expect(again.statusCode).toBe(409);
    expect(json<{ error: string; supplierId: string }>(again)).toMatchObject({ error: "supplier_exists", supplierId: id });

    // And a delivery that types the name rather than picking it still links up.
    const delivery = await mkDelivery({ supplier: "NORDIC TRADE OÜ" });
    expect(delivery.statusCode).toBe(200);
    const con = json<{ consignment: { supplierId: string; supplier: string } }>(delivery).consignment;
    expect(con.supplierId).toBe(id);
    expect(con.supplier, "the supplier's own spelling wins").toBe("Nordic Trade OÜ");
  });

  it("keeps terms and bank details away from the warehouse", async () => {
    const created = await mkSupplier("Terms Test SIA", { paymentTermsDays: 30, bankAccount: "LV80BANK0000435195001" });
    expect(created.statusCode).toBe(200);

    // Ops holds warehouse.manage: it may create a supplier, but not price one.
    const opsPlain = await mkSupplier("Ops May Create SIA", {}, opsToken);
    expect(opsPlain.statusCode).toBe(200);
    const opsPriced = await mkSupplier("Ops May Not Price SIA", { paymentTermsDays: 60 }, opsToken);
    expect(opsPriced.statusCode).toBe(403);
    const opsBank = await mkSupplier("Ops May Not Bank SIA", { bankAccount: "LV80BANK0000435195002" }, opsToken);
    expect(opsBank.statusCode).toBe(403);

    const asOps = await app().inject({ method: "GET", url: "/api/suppliers", headers: auth(opsToken) });
    expect(asOps.body).not.toContain("LV80BANK");
    expect(asOps.body).not.toContain("outstandingCents");
    const asFinance = await app().inject({ method: "GET", url: "/api/suppliers", headers: auth(financeToken) });
    expect(asFinance.body).toContain("LV80BANK");
  });

  it("falls due on that supplier's terms, and reconciles against recorded cost", async () => {
    const sup = json<{ supplier: { id: string } }>(await mkSupplier("Due Date OÜ", { paymentTermsDays: 30 })).supplier;
    const con = json<{ consignment: { id: string } }>(await mkDelivery({ supplier: "Due Date OÜ", supplierId: sup.id })).consignment;

    // Two units at €5.00 each, plus €6.00 of transport recorded on the delivery.
    for (const title of ["Unit A", "Unit B"]) {
      await app().inject({
        method: "POST", url: `/api/consignments/${con.id}/receive`, headers: auth(superToken),
        payload: { title, costCents: 500 },
      });
    }
    await app().inject({
      method: "PATCH", url: `/api/consignments/${con.id}/costs`, headers: auth(financeToken), payload: { extraCostCents: 600 },
    });

    const created = await app().inject({
      method: "POST", url: "/api/supplier-invoices", headers: auth(financeToken),
      payload: { consignmentId: con.id, number: "DD-001", invoiceDate: "2026-07-01", amountCents: 2_000 },
    });
    expect(created.statusCode).toBe(200);
    const invoice = json<{ invoice: { id: string; dueDate: string; supplierId: string } }>(created).invoice;
    expect(invoice.supplierId, "supplier taken from the delivery").toBe(sup.id);
    expect(new Date(invoice.dueDate).toISOString().slice(0, 10), "01.07 + 30 days").toBe("2026-07-31");

    const detail = await app().inject({ method: "GET", url: `/api/supplier-invoices/${invoice.id}`, headers: auth(financeToken) });
    expect(json<{ reconciliation: { recordedCostCents: number; varianceCents: number; noCostDataCount: number } }>(detail).reconciliation)
      .toMatchObject({ recordedCostCents: 1_600, varianceCents: 400, noCostDataCount: 0 });
  });

  it("adds part payments up and refuses to be overpaid", async () => {
    const sup = json<{ supplier: { id: string } }>(await mkSupplier("Part Pay SIA")).supplier;
    const inv = json<{ invoice: { id: string } }>(
      await app().inject({
        method: "POST", url: "/api/supplier-invoices", headers: auth(financeToken),
        payload: { supplierId: sup.id, number: "PP-1", invoiceDate: "2026-07-10", amountCents: 10_000 },
      }),
    ).invoice;

    const pay = async (amountCents: number) =>
      app().inject({
        method: "POST", url: `/api/supplier-invoices/${inv.id}/payments`, headers: auth(financeToken),
        payload: { amountCents, method: "bank_transfer" },
      });

    const first = await pay(4_000);
    expect(first.statusCode).toBe(200);
    expect(json<{ invoice: { status: string; outstandingCents: number } }>(first).invoice)
      .toMatchObject({ status: "partly_paid", outstandingCents: 6_000 });

    const tooMuch = await pay(6_001);
    expect(tooMuch.statusCode).toBe(422);
    expect(json<{ error: string }>(tooMuch).error).toBe("exceeds_outstanding");

    const rest = await pay(6_000);
    expect(json<{ invoice: { status: string; outstandingCents: number } }>(rest).invoice)
      .toMatchObject({ status: "paid", outstandingCents: 0 });

    // A paid invoice cannot be cancelled out from under its payments.
    const cancel = await app().inject({
      method: "PATCH", url: `/api/supplier-invoices/${inv.id}`, headers: auth(financeToken), payload: { status: "cancelled" },
    });
    expect(cancel.statusCode).toBe(409);

    // Deleting a payment puts the balance back.
    const detail = json<{ payments: Array<{ id: string }> }>(
      await app().inject({ method: "GET", url: `/api/supplier-invoices/${inv.id}`, headers: auth(financeToken) }),
    );
    const undo = await app().inject({
      method: "DELETE", url: `/api/supplier-invoices/${inv.id}/payments/${detail.payments[0]!.id}`, headers: auth(financeToken),
    });
    expect(undo.statusCode).toBe(200);
    expect(json<{ invoice: { status: string } }>(undo).invoice.status).not.toBe("paid");
  });

  it("reports what is outstanding, what is overdue, and how it ages", async () => {
    const sup = json<{ supplier: { id: string } }>(await mkSupplier("Aging OÜ")).supplier;
    const mkInvoice = (number: string, dueDate: string, amountCents: number) =>
      app().inject({
        method: "POST", url: "/api/supplier-invoices", headers: auth(financeToken),
        payload: { supplierId: sup.id, number, invoiceDate: "2026-05-01", dueDate, amountCents },
      });

    // The clock is ours to set: one bill 40 days late, one due next week.
    world.setNow(new Date("2026-07-15T12:00:00.000Z"));
    await mkInvoice("AG-late", "2026-06-05", 5_000);
    await mkInvoice("AG-soon", "2026-07-18", 3_000);

    const res = await app().inject({ method: "GET", url: "/api/reports/payables", headers: auth(financeToken) });
    expect(res.statusCode).toBe(200);
    const body = json<{
      totals: { outstandingCents: number; overdueCents: number; dueThisWeekCents: number; overdueCount: number };
      aging: { current: number; d31_60: number };
      bySupplier: Array<{ name: string; outstandingCents: number; overdueCents: number }>;
    }>(res);
    expect(body.totals.outstandingCents).toBeGreaterThanOrEqual(8_000);
    expect(body.totals.overdueCents).toBeGreaterThanOrEqual(5_000);
    expect(body.totals.dueThisWeekCents).toBeGreaterThanOrEqual(3_000);
    expect(body.aging.d31_60, "40 days late lands in the 31–60 bucket").toBeGreaterThanOrEqual(5_000);
    const mine = body.bySupplier.find((s) => s.name === "Aging OÜ");
    expect(mine).toMatchObject({ outstandingCents: 8_000, overdueCents: 5_000 });
    world.setNow(null);
  });

  it("never shows a payable to anyone without finance.view", async () => {
    for (const url of ["/api/supplier-invoices", "/api/reports/payables"]) {
      expect((await app().inject({ method: "GET", url, headers: auth(opsToken) })).statusCode).toBe(403);
    }
    const [inv] = await world.ctx.db.select().from(supplierInvoices).limit(1);
    if (inv) {
      expect((await app().inject({
        method: "POST", url: `/api/supplier-invoices/${inv.id}/payments`, headers: auth(opsToken), payload: { amountCents: 1 },
      })).statusCode).toBe(403);
    }

    // The activity feed is readable with audit.view, which ops holds — no sum
    // may appear there, or the permission it sits behind is decoration.
    const feed = await app().inject({ method: "GET", url: "/api/audit?limit=200", headers: auth(opsToken) });
    expect(feed.statusCode).toBe(200);
    expect(feed.body).not.toContain("10000");
    expect(feed.body).not.toContain("amountCents");
  });

  it("lets an older delivery be attached to a supplier before it can be billed", async () => {
    // A delivery whose typed name matched nothing during the backfill.
    const con = json<{ consignment: { id: string } }>(await mkDelivery({ supplier: "Unmatched Seller" })).consignment;
    await world.ctx.db.update(consignments).set({ supplierId: null }).where(eq(consignments.id, con.id));

    const early = await app().inject({
      method: "POST", url: "/api/supplier-invoices", headers: auth(financeToken),
      payload: { consignmentId: con.id, number: "UM-1", invoiceDate: "2026-07-01", amountCents: 100 },
    });
    expect(early.statusCode, "no supplier, no bill").toBe(422);

    const sup = json<{ supplier: { id: string } }>(await mkSupplier("Attached Later SIA")).supplier;
    const attach = await app().inject({
      method: "PATCH", url: `/api/consignments/${con.id}/supplier`, headers: auth(opsToken), payload: { supplierId: sup.id },
    });
    expect(attach.statusCode).toBe(200);
    const [row] = await world.ctx.db.select().from(consignments).where(eq(consignments.id, con.id));
    expect(row!.supplier, "the display name follows the record").toBe("Attached Later SIA");

    const now = await app().inject({
      method: "POST", url: "/api/supplier-invoices", headers: auth(financeToken),
      payload: { consignmentId: con.id, number: "UM-1", invoiceDate: "2026-07-01", amountCents: 100 },
    });
    expect(now.statusCode).toBe(200);
    const [supplierRow] = await world.ctx.db.select().from(suppliers).where(eq(suppliers.id, sup.id));
    expect(supplierRow!.paymentTermsDays, "the house default when none was set").toBe(14);
  });
});
