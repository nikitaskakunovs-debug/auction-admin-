import { items, stockMovements } from "@auction/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAuction } from "../src/engine/close.js";
import { auth, createBidder, createLiveAuction, createWorld, loginAs, type TestWorld } from "./helpers.js";

/**
 * W5 (stock-taking) + W6 (cost/margin). The approved decisions under test:
 * blind counting, no freeze (moved-during detection), nothing changes without
 * manager approval, cost private to finance.view, profit = hammer − cost with
 * delivery extras pro-rata, and honest no-cost-data counts.
 */
describe("stock counts + cost (W5/W6)", () => {
  let world: TestWorld;
  let superToken: string;
  let opsToken: string;
  let managerToken: string;
  let financeToken: string;

  beforeAll(async () => {
    world = await createWorld();
    superToken = await loginAs(world, "super@auction.test");
    opsToken = await loginAs(world, "ops@auction.test");
    managerToken = await loginAs(world, "listings@auction.test");
    financeToken = await loginAs(world, "finance@auction.test");
  });
  afterAll(async () => {
    if (world) await world.close();
  });

  const app = () => world.server.app;

  async function mkBin(zone: string, aisle: string): Promise<{ id: string; label: string }> {
    const res = await app().inject({
      method: "POST",
      url: "/api/warehouse/locations",
      headers: auth(superToken),
      payload: { zone, aisle, rack: "R1" },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { location: { id: string; label: string } }).location;
  }

  async function mkItem(title: string): Promise<{ id: string; sku: string }> {
    const sku = `C-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    const res = await app().inject({
      method: "POST",
      url: "/api/items",
      headers: auth(superToken),
      payload: { sku, title, marketCode: "LV" },
    });
    expect(res.statusCode).toBe(200);
    return { id: (res.json() as { item: { id: string } }).item.id, sku };
  }

  async function putaway(itemId: string, locationId: string): Promise<void> {
    const res = await app().inject({
      method: "POST",
      url: `/api/items/${itemId}/putaway`,
      headers: auth(opsToken),
      payload: { locationId, reason: "count test shelf" },
    });
    expect(res.statusCode).toBe(200);
  }

  // ── W5 ─────────────────────────────────────────────────────────────────────

  it("runs a blind count: five diff outcomes, manager-only approval, count_adjust ledger", async () => {
    const binA = await mkBin("CNT", "A1");
    const binB = await mkBin("CNT", "A2");

    const itemOk = await mkItem("Counted where it lives");
    const itemWrong = await mkItem("Filed in B, found in A");
    const itemMissing = await mkItem("Vanished from A");
    const itemMoved = await mkItem("Legitimately left mid-count");
    await putaway(itemOk.id, binA.id);
    await putaway(itemWrong.id, binB.id);
    await putaway(itemMissing.id, binA.id);
    await putaway(itemMoved.id, binB.id);

    const created = await app().inject({
      method: "POST",
      url: "/api/stock-counts",
      headers: auth(opsToken),
      payload: { name: "Augusta inventarizācija", zones: ["cnt"] },
    });
    expect(created.statusCode).toBe(200);
    const countId = (created.json() as { count: { id: string } }).count.id;

    // Blind per-scan feedback: what THIS item is, never what the bin should hold.
    const scanOk = await app().inject({
      method: "POST",
      url: `/api/stock-counts/${countId}/scan`,
      headers: auth(opsToken),
      payload: { code: itemOk.sku, locationId: binA.id },
    });
    expect(scanOk.json()).toMatchObject({ known: true, sku: itemOk.sku, samePlace: true });

    const scanWrong = await app().inject({
      method: "POST",
      url: `/api/stock-counts/${countId}/scan`,
      headers: auth(opsToken),
      payload: { code: itemWrong.id, locationId: binA.id }, // QR carries the uuid
    });
    expect(scanWrong.json()).toMatchObject({ known: true, samePlace: false });

    const scanUnknown = await app().inject({
      method: "POST",
      url: `/api/stock-counts/${countId}/scan`,
      headers: auth(opsToken),
      payload: { code: "NOPE-000000", locationId: binA.id },
    });
    expect(scanUnknown.json()).toMatchObject({ known: false });

    // The shelf keeps working: a movement after the session opened explains
    // itemMoved's absence, so it must NOT be flagged as missing.
    await world.ctx.db.insert(stockMovements).values({
      itemId: itemMoved.id,
      type: "pick",
      fromLocationId: binB.id,
      actorLabel: "Ops",
      reason: "picked for order mid-count",
      createdAt: new Date(Date.now() + 60_000),
    });

    for (const bin of [binA, binB]) {
      const done = await app().inject({
        method: "POST",
        url: `/api/stock-counts/${countId}/bin-done`,
        headers: auth(opsToken),
        payload: { locationId: bin.id },
      });
      expect(done.statusCode).toBe(200);
    }

    const diff = await app().inject({ method: "GET", url: `/api/stock-counts/${countId}/diff`, headers: auth(managerToken) });
    expect(diff.statusCode).toBe(200);
    const { tally, lines } = diff.json() as {
      tally: Record<string, number>;
      lines: Array<{ outcome: string; sku: string | null; code: string | null }>;
    };
    expect(tally).toMatchObject({ match: 1, wrong_bin: 1, missing: 1, moved_during: 1, unknown_label: 1 });
    expect(lines.find((l) => l.outcome === "missing")?.sku).toBe(itemMissing.sku);
    expect(lines.find((l) => l.outcome === "unknown_label")?.code).toBe("NOPE-000000");

    // Nothing changes without the manager: ops holds warehouse.manage but not
    // grading.review, so the shelf state is untouchable from the floor.
    const denied = await app().inject({ method: "POST", url: `/api/stock-counts/${countId}/approve`, headers: auth(opsToken) });
    expect(denied.statusCode).toBe(403);

    const approved = await app().inject({ method: "POST", url: `/api/stock-counts/${countId}/approve`, headers: auth(managerToken) });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ moved: 1, missing: 1 });

    const [wrongAfter] = await world.ctx.db.select().from(items).where(eq(items.id, itemWrong.id));
    expect(wrongAfter!.locationId).toBe(binA.id); // moved to where it was found
    const [missingAfter] = await world.ctx.db.select().from(items).where(eq(items.id, itemMissing.id));
    expect(missingAfter!.locationId).toBeNull(); // shelf stays honest
    const adjust = await world.ctx.db
      .select()
      .from(stockMovements)
      .where(and(eq(stockMovements.itemId, itemWrong.id), eq(stockMovements.type, "count_adjust")));
    expect(adjust).toHaveLength(1);
    expect(adjust[0]!.toLocationId).toBe(binA.id);

    // A closed session takes no more scans.
    const late = await app().inject({
      method: "POST",
      url: `/api/stock-counts/${countId}/scan`,
      headers: auth(opsToken),
      payload: { code: itemOk.sku, locationId: binA.id },
    });
    expect(late.statusCode).toBe(409);
  });

  // ── W6 ─────────────────────────────────────────────────────────────────────

  it("keeps purchase cost invisible and unwritable without finance.view", async () => {
    const item = await mkItem("Secret cost lot");
    const set = await app().inject({
      method: "PATCH",
      url: `/api/items/${item.id}`,
      headers: auth(superToken),
      payload: { costCents: 1_234 },
    });
    expect(set.statusCode).toBe(200);
    expect((set.json() as { item: { costCents: number } }).item.costCents).toBe(1_234);

    // Finance eyes see the number…
    const asFinance = await app().inject({ method: "GET", url: `/api/items/${item.id}`, headers: auth(financeToken) });
    expect((asFinance.json() as { item: { costCents: number } }).item.costCents).toBe(1_234);

    // …warehouse eyes see no such field, in the detail or in any list.
    const asOps = await app().inject({ method: "GET", url: `/api/items/${item.id}`, headers: auth(opsToken) });
    expect("costCents" in (asOps.json() as { item: Record<string, unknown> }).item).toBe(false);
    const list = await app().inject({ method: "GET", url: `/api/items?q=${item.sku}`, headers: auth(opsToken) });
    for (const row of (list.json() as { items: Array<Record<string, unknown>> }).items) {
      expect("costCents" in row).toBe(false);
    }

    // Ops may edit anything else — just not the money.
    const editOk = await app().inject({
      method: "PATCH",
      url: `/api/items/${item.id}`,
      headers: auth(opsToken),
      payload: { title: "Renamed by ops" },
    });
    expect(editOk.statusCode).toBe(200);
    const editCost = await app().inject({
      method: "PATCH",
      url: `/api/items/${item.id}`,
      headers: auth(opsToken),
      payload: { costCents: 5 },
    });
    expect(editCost.statusCode).toBe(403);
  });

  it("accepts cost at receiving only from finance-capable staff", async () => {
    const con = await app().inject({
      method: "POST",
      url: "/api/consignments",
      headers: auth(superToken),
      payload: { supplier: "Cost Test OÜ", marketCode: "LV" },
    });
    const conId = (con.json() as { consignment: { id: string } }).consignment.id;

    const opsWithCost = await app().inject({
      method: "POST",
      url: `/api/consignments/${conId}/receive`,
      headers: auth(opsToken),
      payload: { title: "Ops tries to price", costCents: 100 },
    });
    expect(opsWithCost.statusCode).toBe(403);

    const opsPlain = await app().inject({
      method: "POST",
      url: `/api/consignments/${conId}/receive`,
      headers: auth(opsToken),
      payload: { title: "Ops receives fine without cost" },
    });
    expect(opsPlain.statusCode).toBe(200);

    const withCost = await app().inject({
      method: "POST",
      url: `/api/consignments/${conId}/receive`,
      headers: auth(superToken),
      payload: { title: "Priced at intake", costCents: 500 },
    });
    expect(withCost.statusCode).toBe(200);
    const itemId = (withCost.json() as { item: { id: string } }).item.id;
    const [row] = await world.ctx.db.select().from(items).where(eq(items.id, itemId));
    expect(row!.costCents).toBe(500);
  });

  it("spreads a pallet total evenly across units, to the exact cent", async () => {
    const con = await app().inject({
      method: "POST",
      url: "/api/consignments",
      headers: auth(superToken),
      payload: { supplier: "Pallet SIA", marketCode: "LV" },
    });
    const conId = (con.json() as { consignment: { id: string } }).consignment.id;
    for (let i = 0; i < 3; i++) {
      await app().inject({
        method: "POST",
        url: `/api/consignments/${conId}/receive`,
        headers: auth(superToken),
        payload: { title: `Pallet unit ${i + 1}` },
      });
    }

    const denied = await app().inject({
      method: "POST",
      url: `/api/consignments/${conId}/spread-cost`,
      headers: auth(opsToken),
      payload: { totalCents: 1_000 },
    });
    expect(denied.statusCode).toBe(403);

    const spread = await app().inject({
      method: "POST",
      url: `/api/consignments/${conId}/spread-cost`,
      headers: auth(financeToken),
      payload: { totalCents: 1_000 },
    });
    expect(spread.statusCode).toBe(200);
    expect(spread.json()).toMatchObject({ units: 3, perUnitCents: 333 });
    const rows = await world.ctx.db.select().from(items).where(eq(items.consignmentId, conId));
    const costs = rows.map((r) => r.costCents).sort((a, b) => (b ?? 0) - (a ?? 0));
    expect(costs).toEqual([334, 333, 333]); // sums back to exactly 1000

    const extras = await app().inject({
      method: "PATCH",
      url: `/api/consignments/${conId}/costs`,
      headers: auth(financeToken),
      payload: { extraCostCents: 600 },
    });
    expect(extras.statusCode).toBe(200);
    expect((extras.json() as { consignment: { extraCostCents: number } }).consignment.extraCostCents).toBe(600);
  });

  it("profit report: hammer − cost with delivery extras pro-rata, honest about missing data", async () => {
    // A won + paid order whose item carries cost 1000 and belongs to a
    // delivery with €5.00 extras over one unit → effective cost 1500.
    const bidderId = await createBidder(world, "profit_buyer");
    const { itemId, auctionId } = await createLiveAuction(world, superToken, { startPriceCents: 1_000, endsInMs: 1_000 });
    await app().inject({
      method: "POST",
      url: `/api/auctions/${auctionId}/bids`,
      headers: auth(superToken),
      payload: { customerId: bidderId, maxCents: 4_000 },
    });
    world.setNow(new Date(Date.now() + 60_000));
    const closed = await closeAuction(world.ctx, auctionId);
    world.setNow(null);
    if (!closed.ok || !closed.orderRef) throw new Error("auction did not close won");

    const con = await app().inject({
      method: "POST",
      url: "/api/consignments",
      headers: auth(superToken),
      payload: { supplier: "Profit SIA", marketCode: "LV" },
    });
    const conId = (con.json() as { consignment: { id: string } }).consignment.id;
    await app().inject({
      method: "PATCH",
      url: `/api/consignments/${conId}/costs`,
      headers: auth(financeToken),
      payload: { extraCostCents: 500 },
    });
    await world.ctx.db.update(items).set({ costCents: 1_000, consignmentId: conId }).where(eq(items.id, itemId));

    const { orders } = await import("@auction/db");
    const [order] = await world.ctx.db.select().from(orders).where(eq(orders.ref, closed.orderRef));
    const pay = await app().inject({
      method: "POST",
      url: "/api/desk/pay",
      headers: auth(superToken),
      payload: { orderIds: [order!.id], method: "cash" },
    });
    expect(pay.statusCode).toBe(200);

    const denied = await app().inject({
      method: "GET",
      url: "/api/reports/profit?from=2000-01-01&to=2100-01-01",
      headers: auth(opsToken),
    });
    expect(denied.statusCode).toBe(403);

    const res = await app().inject({
      method: "GET",
      url: "/api/reports/profit?from=2000-01-01&to=2100-01-01",
      headers: auth(financeToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      summary: { soldCount: number; profitCents: number; noCostData: number };
      lines: Array<{ sku: string; soldCents: number; costCents: number | null; profitCents: number | null }>;
      consignments: Array<{ ref: string; soldCount: number; profitCents: number | null }>;
    };
    const [item] = await world.ctx.db.select().from(items).where(eq(items.id, itemId));
    const line = body.lines.find((l) => l.sku === item!.sku);
    expect(line, "sold lot appears in the report").toBeTruthy();
    // One bidder → hammer stays at the 1000-cent start price.
    expect(line!.soldCents).toBe(1_000);
    expect(line!.costCents).toBe(1_500); // 1000 own + 500 extras / 1 unit
    expect(line!.profitCents).toBe(-500);
    expect(body.summary.soldCount).toBeGreaterThanOrEqual(1);

    const conLine = body.consignments.find((c) => c.soldCount > 0 && c.profitCents === -500);
    expect(conLine, "delivery scoreboard carries the pro-rata result").toBeTruthy();
  });

  it("stock-value report: three buckets, finance-only, no-cost-data counts", async () => {
    const denied = await app().inject({ method: "GET", url: "/api/reports/stock-value", headers: auth(opsToken) });
    expect(denied.statusCode).toBe(403);

    const res = await app().inject({ method: "GET", url: "/api/reports/stock-value", headers: auth(financeToken) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<"ready" | "drafts" | "quarantine" | "total", { units: number; valueCents: number; noCostData: number }>;
    expect(body.total.units).toBe(body.ready.units + body.drafts.units + body.quarantine.units);
    // The priced pallet + intake lots from earlier tests are all still drafts.
    expect(body.drafts.valueCents).toBeGreaterThanOrEqual(1_500);
    expect(body.drafts.noCostData).toBeGreaterThanOrEqual(1);
  });
});
