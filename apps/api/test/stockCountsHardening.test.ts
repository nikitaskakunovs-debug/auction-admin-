import { items, orders, stockCountScans, stockMovements } from "@auction/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAuction } from "../src/engine/close.js";
import { auth, createBidder, createLiveAuction, createWorld, loginAs, type TestWorld } from "./helpers.js";

/**
 * The defects an adversarial review of W5+W6 found, each pinned by a test so
 * it cannot come back: a re-scan must beat the mistake it corrects, a
 * legitimate mid-count move must never be undone by approval, the answer key
 * stays with managers, and cost never leaks — or gets silently erased.
 */
describe("stock count + cost hardening", () => {
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
  const json = <T>(res: { json: () => unknown }) => res.json() as T;

  async function mkBin(zone: string, aisle: string): Promise<{ id: string; label: string }> {
    const res = await app().inject({
      method: "POST", url: "/api/warehouse/locations", headers: auth(superToken),
      payload: { zone, aisle, rack: "R1" },
    });
    expect(res.statusCode).toBe(200);
    return json<{ location: { id: string; label: string } }>(res).location;
  }

  async function mkItem(title: string): Promise<{ id: string; sku: string }> {
    const sku = `H-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    const res = await app().inject({
      method: "POST", url: "/api/items", headers: auth(superToken),
      payload: { sku, title, marketCode: "LV" },
    });
    expect(res.statusCode).toBe(200);
    return { id: json<{ item: { id: string } }>(res).item.id, sku };
  }

  const putaway = async (itemId: string, locationId: string) => {
    const res = await app().inject({
      method: "POST", url: `/api/items/${itemId}/putaway`, headers: auth(opsToken),
      payload: { locationId, reason: "shelving for count test" },
    });
    expect(res.statusCode).toBe(200);
  };

  const startCount = async (name: string, zones: string[]): Promise<string> => {
    const res = await app().inject({
      method: "POST", url: "/api/stock-counts", headers: auth(opsToken), payload: { name, zones },
    });
    expect(res.statusCode).toBe(200);
    return json<{ count: { id: string } }>(res).count.id;
  };

  const scan = (countId: string, code: string, locationId: string) =>
    app().inject({ method: "POST", url: `/api/stock-counts/${countId}/scan`, headers: auth(opsToken), payload: { code, locationId } });

  const binDone = (countId: string, locationId: string) =>
    app().inject({ method: "POST", url: `/api/stock-counts/${countId}/bin-done`, headers: auth(opsToken), payload: { locationId } });

  const diff = (countId: string, token = managerToken) =>
    app().inject({ method: "GET", url: `/api/stock-counts/${countId}/diff`, headers: auth(token) });

  interface DiffLine { outcome: string; sku: string | null; foundLabel: string | null; expectedLabel: string | null; multipleBins: boolean }
  const lineFor = (res: { json: () => unknown }, sku: string): DiffLine | undefined =>
    json<{ lines: DiffLine[] }>(res).lines.find((l) => l.sku === sku);

  // ── W5 ─────────────────────────────────────────────────────────────────────

  it("lets a corrected re-scan beat the mistake it corrects", async () => {
    const [binA, binB] = [await mkBin("HRD1", "A1"), await mkBin("HRD1", "A2")];
    const item = await mkItem("Scanned twice, corrected second time");
    await putaway(item.id, binB.id);

    const countId = await startCount("Re-scan wins", ["HRD1"]);
    // Wrong bin selected on the phone, then corrected — the second scan is
    // the truth, and it must be the one that decides.
    await scan(countId, item.sku, binA.id);
    await scan(countId, item.sku, binB.id);
    await binDone(countId, binA.id);
    await binDone(countId, binB.id);

    const line = lineFor(await diff(countId), item.sku);
    expect(line?.outcome).toBe("match");
    expect(line?.multipleBins, "seen in two bins is surfaced, not hidden").toBe(true);
  });

  it("does not undo a move that happened after the shelf was counted", async () => {
    const [binA, binB] = [await mkBin("HRD2", "A1"), await mkBin("HRD2", "A2")];
    const item = await mkItem("Counted in A, then properly moved to B");
    await putaway(item.id, binA.id);

    const countId = await startCount("No freeze", ["HRD2"]);
    await scan(countId, item.sku, binA.id);
    await binDone(countId, binA.id);
    // A picker moves it for real, mid-count, and records the move.
    await putaway(item.id, binB.id);
    await binDone(countId, binB.id);

    expect(lineFor(await diff(countId), item.sku)?.outcome).toBe("moved_during");

    const approved = await app().inject({ method: "POST", url: `/api/stock-counts/${countId}/approve`, headers: auth(managerToken) });
    expect(approved.statusCode).toBe(200);
    const [after] = await world.ctx.db.select().from(items).where(eq(items.id, item.id));
    expect(after!.locationId, "approval leaves the legitimate move alone").toBe(binB.id);
  });

  it("does not resurrect an item that shipped during the count", async () => {
    const bin = await mkBin("HRD3", "A1");
    const item = await mkItem("Sold and shipped mid-count");
    await putaway(item.id, bin.id);

    const countId = await startCount("Picked mid-count", ["HRD3"]);
    await scan(countId, item.sku, bin.id);
    // Picking clears the location the way the pickup engine does.
    await world.ctx.db.insert(stockMovements).values({
      itemId: item.id, type: "pick", fromLocationId: bin.id, actorLabel: "Ops", reason: "picked for order",
    });
    await world.ctx.db.update(items).set({ locationId: null, location: "" }).where(eq(items.id, item.id));
    await binDone(countId, bin.id);

    expect(lineFor(await diff(countId), item.sku)?.outcome).toBe("moved_during");
    await app().inject({ method: "POST", url: `/api/stock-counts/${countId}/approve`, headers: auth(managerToken) });
    const [after] = await world.ctx.db.select().from(items).where(eq(items.id, item.id));
    expect(after!.locationId, "a shipped item does not go back on the shelf").toBeNull();
  });

  it("still reports a genuinely missing item when a movement only put things INTO its bin", async () => {
    const bin = await mkBin("HRD4", "A1");
    const gone = await mkItem("Really missing");
    const arrival = await mkItem("Arrived mid-count");
    await putaway(gone.id, bin.id);

    const countId = await startCount("Inbound movement", ["HRD4"]);
    await putaway(arrival.id, bin.id); // a movement INTO the counted bin
    await scan(countId, arrival.sku, bin.id);
    await binDone(countId, bin.id);

    expect(lineFor(await diff(countId), gone.sku)?.outcome).toBe("missing");
  });

  it("keeps the answer key with managers and changes nothing before they approve", async () => {
    const bin = await mkBin("HRD5", "A1");
    const misfiled = await mkItem("Filed here, found nowhere");
    await putaway(misfiled.id, bin.id);
    const countId = await startCount("Blind", ["HRD5"]);
    await binDone(countId, bin.id);

    // The floor staff who do the counting must not be able to read the diff.
    expect((await diff(countId, opsToken)).statusCode).toBe(403);
    expect((await diff(countId, managerToken)).statusCode).toBe(200);

    // Reading the diff must not touch the shelf.
    const [before] = await world.ctx.db.select().from(items).where(eq(items.id, misfiled.id));
    expect(before!.locationId).toBe(bin.id);
    expect((await app().inject({ method: "POST", url: `/api/stock-counts/${countId}/approve`, headers: auth(opsToken) })).statusCode).toBe(403);
    const [stillThere] = await world.ctx.db.select().from(items).where(eq(items.id, misfiled.id));
    expect(stillThere!.locationId, "nothing moves without a manager").toBe(bin.id);
  });

  it("replays the approved result instead of recomputing it away", async () => {
    const bin = await mkBin("HRD6", "A1");
    const item = await mkItem("Missing, then approved");
    await putaway(item.id, bin.id);
    const countId = await startCount("Snapshot", ["HRD6"]);
    await binDone(countId, bin.id);
    expect(lineFor(await diff(countId), item.sku)?.outcome).toBe("missing");

    await app().inject({ method: "POST", url: `/api/stock-counts/${countId}/approve`, headers: auth(managerToken) });
    // Recomputing live would find nothing (the item no longer has a bin);
    // the manager must still see what was corrected.
    const after = await diff(countId);
    expect(lineFor(after, item.sku)?.outcome).toBe("missing");
    expect(json<{ count: { status: string } }>(after).count.status).toBe("approved");

    // …and the snapshot must not ride along on the payloads floor staff read.
    const detail = await app().inject({ method: "GET", url: `/api/stock-counts/${countId}`, headers: auth(opsToken) });
    expect("result" in json<{ count: Record<string, unknown> }>(detail).count).toBe(false);
  });

  it("rejects scans into bins the session does not cover, and cancels cleanly", async () => {
    const inScope = await mkBin("HRD7", "A1");
    const outOfScope = await mkBin("HRD8", "A1");
    const item = await mkItem("Out of scope probe");
    await putaway(item.id, inScope.id);
    const countId = await startCount("Scope", ["HRD7"]);

    const bad = await scan(countId, item.sku, outOfScope.id);
    expect(bad.statusCode).toBe(409);
    expect(json<{ error: string }>(bad).error).toBe("bin_out_of_scope");
    expect((await binDone(countId, outOfScope.id)).statusCode).toBe(409);

    const cancelled = await app().inject({ method: "POST", url: `/api/stock-counts/${countId}/cancel`, headers: auth(opsToken) });
    expect(cancelled.statusCode).toBe(200);
    expect((await scan(countId, item.sku, inScope.id)).statusCode).toBe(409);
    expect((await app().inject({ method: "POST", url: `/api/stock-counts/${countId}/approve`, headers: auth(managerToken) })).statusCode).toBe(409);
  });

  it("lets a counted item still be deleted", async () => {
    const bin = await mkBin("HRD9", "A1");
    const item = await mkItem("Duplicate intake, later deleted");
    await putaway(item.id, bin.id);
    const countId = await startCount("Delete after count", ["HRD9"]);
    await scan(countId, item.sku, bin.id);

    const del = await app().inject({ method: "DELETE", url: `/api/items/${item.id}`, headers: auth(superToken) });
    expect(del.statusCode, "a scan row must not pin the item forever").toBe(200);
    const scansLeft = await world.ctx.db.select().from(stockCountScans).where(eq(stockCountScans.countId, countId));
    expect(scansLeft.filter((s) => s.itemId === item.id)).toHaveLength(0);
  });

  // ── W6 ─────────────────────────────────────────────────────────────────────

  it("saves cost for a finance user who cannot edit items at all", async () => {
    const item = await mkItem("Finance-only cost write");
    // The finance role holds finance.view but not items.edit — through the
    // main item PATCH it could see the field and never save it.
    expect((await app().inject({
      method: "PATCH", url: `/api/items/${item.id}`, headers: auth(financeToken), payload: { title: "nope" },
    })).statusCode).toBe(403);

    const set = await app().inject({
      method: "PATCH", url: `/api/items/${item.id}/cost`, headers: auth(financeToken), payload: { costCents: 4_200 },
    });
    expect(set.statusCode).toBe(200);
    expect((await world.ctx.db.select().from(items).where(eq(items.id, item.id)))[0]!.costCents).toBe(4_200);

    // Blank means unknown and must round-trip as null, never as zero.
    await app().inject({ method: "PATCH", url: `/api/items/${item.id}/cost`, headers: auth(financeToken), payload: { costCents: null } });
    expect((await world.ctx.db.select().from(items).where(eq(items.id, item.id)))[0]!.costCents).toBeNull();

    expect((await app().inject({
      method: "PATCH", url: `/api/items/${item.id}/cost`, headers: auth(opsToken), payload: { costCents: 1 },
    })).statusCode).toBe(403);
  });

  it("keeps the pallet price out of the activity feed for non-finance roles", async () => {
    const con = await app().inject({
      method: "POST", url: "/api/consignments", headers: auth(superToken),
      payload: { supplier: "Audit Leak SIA", marketCode: "LV" },
    });
    const conId = json<{ consignment: { id: string } }>(con).consignment.id;
    await app().inject({
      method: "POST", url: `/api/consignments/${conId}/receive`, headers: auth(superToken), payload: { title: "Pallet unit" },
    });
    await app().inject({
      method: "POST", url: `/api/consignments/${conId}/spread-cost`, headers: auth(financeToken), payload: { totalCents: 480_000 },
    });
    await app().inject({
      method: "PATCH", url: `/api/consignments/${conId}/costs`, headers: auth(financeToken), payload: { extraCostCents: 3_600 },
    });

    // Ops holds audit.view — the audit feed is exactly where cost used to leak.
    const feed = await app().inject({ method: "GET", url: "/api/audit?limit=200", headers: auth(opsToken) });
    expect(feed.statusCode).toBe(200);
    expect(feed.body).not.toContain("480000");
    expect(feed.body).not.toContain("3600");
    const financeFeed = await app().inject({ method: "GET", url: "/api/audit?limit=200", headers: auth(financeToken) });
    expect(financeFeed.body, "finance still sees what it paid").toContain("480000");

    // And the delivery payload itself keeps its extras private.
    const asOps = await app().inject({ method: "GET", url: `/api/consignments/${conId}`, headers: auth(opsToken) });
    expect(asOps.body).not.toContain("extraCostCents");
    const asFinance = await app().inject({ method: "GET", url: `/api/consignments/${conId}`, headers: auth(financeToken) });
    expect(asFinance.body).toContain("extraCostCents");
  });

  it("drops refunded sales from profit and counts lots with no cost honestly", async () => {
    // Two sales in the window: one refunded, one with no cost recorded.
    const sell = async (alias: string): Promise<{ itemId: string; orderId: string }> => {
      const bidderId = await createBidder(world, alias);
      const { itemId, auctionId } = await createLiveAuction(world, superToken, { startPriceCents: 2_000, endsInMs: 1_000 });
      await app().inject({
        method: "POST", url: `/api/auctions/${auctionId}/bids`, headers: auth(superToken),
        payload: { customerId: bidderId, maxCents: 9_000 },
      });
      world.setNow(new Date(Date.now() + 60_000));
      const closed = await closeAuction(world.ctx, auctionId);
      world.setNow(null);
      if (!closed.ok || !closed.orderRef) throw new Error("auction did not close won");
      const [order] = await world.ctx.db.select().from(orders).where(eq(orders.ref, closed.orderRef));
      await app().inject({
        method: "POST", url: "/api/desk/pay", headers: auth(superToken), payload: { orderIds: [order!.id], method: "cash" },
      });
      return { itemId, orderId: order!.id };
    };

    const refunded = await sell("hard_refunded");
    const noCost = await sell("hard_nocost");
    await app().inject({ method: "PATCH", url: `/api/items/${refunded.itemId}/cost`, headers: auth(financeToken), payload: { costCents: 500 } });

    const url = "/api/reports/profit?from=2000-01-01&to=2100-01-01";
    const before = json<{ summary: { soldCount: number; profitCents: number; noCostData: number } }>(
      await app().inject({ method: "GET", url, headers: auth(financeToken) }),
    ).summary;
    expect(before.noCostData, "a sale with no cost is counted, not ignored").toBeGreaterThanOrEqual(1);

    // Refund it the way the orders route does: status flips, paidAt stays.
    await world.ctx.db.update(orders).set({ status: "refunded" }).where(eq(orders.id, refunded.orderId));

    const after = json<{ summary: { soldCount: number; profitCents: number } }>(
      await app().inject({ method: "GET", url, headers: auth(financeToken) }),
    ).summary;
    expect(after.soldCount, "a refunded order is not a sale").toBe(before.soldCount - 1);
    expect(after.profitCents, "and its profit goes with it").toBe(before.profitCents - (1_503 - 500)); // молоток из финальных 2000

    void noCost;
  });

  it("writes a partially refunded sale down instead of booking it in full", async () => {
    const bidderId = await createBidder(world, "hard_partial");
    const { itemId, auctionId } = await createLiveAuction(world, superToken, { startPriceCents: 2_000, endsInMs: 1_000 });
    await app().inject({
      method: "POST", url: `/api/auctions/${auctionId}/bids`, headers: auth(superToken),
      payload: { customerId: bidderId, maxCents: 9_000 },
    });
    world.setNow(new Date(Date.now() + 60_000));
    const closed = await closeAuction(world.ctx, auctionId);
    world.setNow(null);
    if (!closed.ok || !closed.orderRef) throw new Error("auction did not close won");
    const [order] = await world.ctx.db.select().from(orders).where(eq(orders.ref, closed.orderRef));
    await app().inject({
      method: "POST", url: "/api/desk/pay", headers: auth(superToken), payload: { orderIds: [order!.id], method: "cash" },
    });
    await app().inject({
      method: "PATCH", url: `/api/items/${itemId}/cost`, headers: auth(financeToken), payload: { costCents: 500 },
    });

    const url = "/api/reports/profit?from=2000-01-01&to=2100-01-01";
    const read = async () => json<{ summary: { revenueCents: number; profitCents: number } }>(
      await app().inject({ method: "GET", url, headers: auth(financeToken) }),
    ).summary;
    const before = await read();

    // A goodwill discount after the fact: the buyer keeps the lot, part of the
    // money goes back. The order stays `paid`, so nothing else marks it down.
    const refund = await app().inject({
      method: "POST", url: `/api/orders/${order!.id}/refund`, headers: auth(superToken),
      payload: { amountCents: Math.round(order!.totalCents / 2), reason: "Skrāpējums, ko apraksts neminēja" },
    });
    expect(refund.statusCode).toBe(200);
    const [stillPaid] = await world.ctx.db.select().from(orders).where(eq(orders.id, order!.id));
    expect(stillPaid!.status, "a partial refund leaves the order paid — that is the trap").toBe("paid");

    const after = await read();
    // Вернулась половина кассы — уходит половина молотковой доли
    // (молоток 1503 из финальных 2000, половина с округлением — 752).
    expect(after.revenueCents).toBe(before.revenueCents - 752);
    expect(after.profitCents).toBe(before.profitCents - 752);
  });

  it("counts a delivery's received units once, however many times they sold", async () => {
    const con = await app().inject({
      method: "POST", url: "/api/consignments", headers: auth(superToken),
      payload: { supplier: "Scoreboard OÜ", marketCode: "LV" },
    });
    const conId = json<{ consignment: { id: string } }>(con).consignment.id;
    for (const title of ["Unit one", "Unit two"]) {
      await app().inject({ method: "POST", url: `/api/consignments/${conId}/receive`, headers: auth(superToken), payload: { title } });
    }
    const report = json<{ consignments: Array<{ ref: string; receivedCount: number }> }>(
      await app().inject({ method: "GET", url: "/api/reports/profit?from=2000-01-01&to=2100-01-01", headers: auth(financeToken) }),
    );
    const row = report.consignments.find((c) => c.receivedCount > 0 && c.ref);
    expect(row).toBeTruthy();
    const mine = report.consignments.find((c) => c.ref === json<{ consignment: { ref: string } }>(con).consignment.ref);
    expect(mine?.receivedCount).toBe(2);
  });

  it("never exposes cost to an unauthenticated caller", async () => {
    const item = await mkItem("Public probe");
    await app().inject({ method: "PATCH", url: `/api/items/${item.id}/cost`, headers: auth(financeToken), payload: { costCents: 999 } });
    for (const url of ["/api/public/listings", "/api/public/auctions"]) {
      const res = await app().inject({ method: "GET", url });
      expect(res.body).not.toContain("costCents");
    }
    const movements = await world.ctx.db
      .select()
      .from(stockMovements)
      .where(and(eq(stockMovements.itemId, item.id), eq(stockMovements.type, "count_adjust")));
    expect(movements).toHaveLength(0);
  });
});
