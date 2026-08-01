import { items, orders } from "@auction/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAuction } from "../src/engine/close.js";
import { auth, createBidder, createLiveAuction, createWorld, loginAs, type TestWorld } from "./helpers.js";

/**
 * R3 — what sells and what sits. The figures only mean something if their
 * basis is exact, so these pin the definitions: a cancelled auction run is not
 * a market signal, a refunded sale is not a sale, profit is absent rather than
 * zero where no purchase price was recorded, and none of the money is visible
 * without finance.view.
 */
describe("sell-through (R3)", () => {
  let world: TestWorld;
  let superToken: string;
  let opsToken: string;
  let financeToken: string;
  const WINDOW = "from=2000-01-01&to=2100-01-01";

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
  const report = async (token = financeToken) =>
    json<{
      totals: { soldInPeriod: number; offered: number; soldFromOffered: number; revenueCents: number };
      byCategory: Array<{
        category: string; offered: number; soldInPeriod: number; sellThroughPct: number | null;
        avgDaysToSell: number | null; avgPriceCents: number | null; profitCents?: number | null; noCostData?: number;
      }>;
      auctionOutcomes: { ended: number; won: number; noBids: number; cancelledExcluded: number };
      aging: Array<{ category: string; units: number; d0_30: number; d90plus: number }>;
      sittingLongest: Array<{ sku: string; daysOnShelf: number; timesListed: number }>;
      basis: Record<string, string>;
    }>(await app().inject({ method: "GET", url: `/api/reports/sell-through?${WINDOW}`, headers: auth(token) }));

  /** Win a lot and settle it, so it counts as sold. */
  async function soldLot(alias: string, opts: { costCents?: number } = {}): Promise<{ itemId: string; orderId: string }> {
    const bidderId = await createBidder(world, alias);
    const { auctionId, itemId } = await createLiveAuction(world, superToken, { startPriceCents: 2_000, endsInMs: 1_000 });
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
    if (opts.costCents !== undefined) {
      await app().inject({
        method: "PATCH", url: `/api/items/${itemId}/cost`, headers: auth(financeToken), payload: { costCents: opts.costCents },
      });
    }
    return { itemId, orderId: order!.id };
  }

  it("counts what sold, how long it took, and what share of what we offered", async () => {
    await soldLot("st_one", { costCents: 500 });
    await soldLot("st_two", { costCents: 800 });
    const before = await report();
    expect(before.totals.soldInPeriod).toBeGreaterThanOrEqual(2);
    expect(before.totals.offered).toBeGreaterThanOrEqual(2);
    const cat = before.byCategory.find((c) => c.soldInPeriod > 0);
    expect(cat, "a category with sales").toBeTruthy();
    expect(cat!.avgPriceCents).toBeGreaterThan(0);
    expect(cat!.avgDaysToSell, "sold the day it arrived").toBeGreaterThanOrEqual(0);
    expect(cat!.sellThroughPct).not.toBeNull();
    // The basis travels with the numbers — a percentage without its
    // definition is a number people argue about.
    expect(before.basis.sellThrough).toContain("offered");
  });

  it("does not count a refunded sale, and never counts a cancelled auction run", async () => {
    const lot = await soldLot("st_refunded", { costCents: 400 });
    const before = await report();

    const [order] = await world.ctx.db.select().from(orders).where(eq(orders.id, lot.orderId));
    const refund = await app().inject({
      method: "POST", url: `/api/orders/${lot.orderId}/refund`, headers: auth(superToken),
      payload: { amountCents: order!.totalCents, reason: "Prece neatbilda aprakstam" },
    });
    expect(refund.statusCode).toBe(200);

    const after = await report();
    expect(after.totals.soldInPeriod, "a refunded sale leaves the count").toBe(before.totals.soldInPeriod - 1);

    // An admin cancelling a run is not the market rejecting a lot.
    const { auctionId } = await createLiveAuction(world, superToken, { startPriceCents: 1_000 });
    await app().inject({
      method: "POST", url: `/api/auctions/${auctionId}/cancel`, headers: auth(superToken),
      payload: { reason: "Atsaukts pēc pārdevēja lūguma" },
    });
    const withCancel = await report();
    expect(withCancel.auctionOutcomes.won + withCancel.auctionOutcomes.noBids).toBe(withCancel.auctionOutcomes.ended);
  });

  it("reports no profit rather than zero profit where no purchase price was recorded", async () => {
    // A fresh world category with one sale and no cost recorded anywhere.
    await soldLot("st_nocost");
    const r = await report();
    const withUnpriced = r.byCategory.find((c) => (c.noCostData ?? 0) > 0);
    expect(withUnpriced, "a category with unpriced sales").toBeTruthy();
    if (withUnpriced!.noCostData === withUnpriced!.soldInPeriod) {
      expect(withUnpriced!.profitCents, "nothing priced — say so, do not say €0").toBeNull();
    } else {
      expect(withUnpriced!.profitCents).not.toBeNull();
    }
  });

  it("ages the shelf and names what has sat longest, with how often it was listed", async () => {
    const r = await report();
    expect(r.aging.length).toBeGreaterThan(0);
    for (const a of r.aging) {
      expect(a.units, "buckets add up to the category's units").toBe(
        a.d0_30 + (a as unknown as { d31_60: number }).d31_60 + (a as unknown as { d61_90: number }).d61_90 + a.d90plus,
      );
    }
    expect(r.sittingLongest.length).toBeGreaterThan(0);
    const days = r.sittingLongest.map((s) => s.daysOnShelf);
    expect([...days].sort((a, b) => b - a), "longest first").toEqual(days);
    expect(r.sittingLongest[0]!.timesListed).toBeGreaterThanOrEqual(0);
  });

  it("keeps the money behind finance.view and the report behind reports.view", async () => {
    const asOps = await report(opsToken);
    for (const c of asOps.byCategory) {
      expect("profitCents" in c, "warehouse eyes see volumes, not margins").toBe(false);
      expect("noCostData" in c).toBe(false);
    }
    const asFinance = await report(financeToken);
    expect(asFinance.byCategory.some((c) => "profitCents" in c)).toBe(true);

    // Content editors hold neither reports.view nor anything near it.
    const denied = await app().inject({
      method: "GET", url: `/api/reports/sell-through?${WINDOW}`, headers: auth(await loginAs(world, "content@auction.test")),
    });
    expect(denied.statusCode).toBe(403);
  });

  it("refuses a report with no period", async () => {
    const res = await app().inject({ method: "GET", url: "/api/reports/sell-through", headers: auth(financeToken) });
    expect(res.statusCode).toBe(400);
  });

  it("counts a relisted lot's runs, so a lot listed twice reads as listed twice", async () => {
    const { auctionId, itemId } = await createLiveAuction(world, superToken, { startPriceCents: 1_500, endsInMs: 1_000 });
    world.setNow(new Date(Date.now() + 60_000));
    await closeAuction(world.ctx, auctionId); // no bids → unsold
    world.setNow(null);
    const relist = await app().inject({
      method: "POST", url: `/api/auctions/${auctionId}/relist`, headers: auth(superToken),
      payload: { startsAt: new Date(Date.now() + 1_000).toISOString(), endsAt: new Date(Date.now() + 3_600_000).toISOString() },
    });
    expect(relist.statusCode).toBe(200);

    const [item] = await world.ctx.db.select().from(items).where(eq(items.id, itemId));
    const r = await report();
    const row = r.sittingLongest.find((s) => s.sku === item!.sku);
    expect(row, "an unsold lot is still on the shelf").toBeTruthy();
    expect(row!.timesListed, "two runs of the same listing").toBe(2);
  });
});
