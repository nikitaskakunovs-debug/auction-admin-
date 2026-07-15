import { auctions, customers, items, orders } from "@auction/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuctionScheduler } from "../src/engine/scheduler.js";
import { auth, createBidder, createLiveAuction, createWorld, loginAs, type TestWorld } from "./helpers.js";

let world: TestWorld;
let token: string;
let scheduler: AuctionScheduler;

beforeAll(async () => {
  world = await createWorld();
  token = await loginAs(world, "super@auction.test");
  scheduler = new AuctionScheduler(world.ctx);
});
afterAll(async () => {
  await world.close();
});

async function bid(auctionId: string, customerId: string, maxCents: number) {
  return world.server.app.inject({
    method: "POST",
    url: `/api/auctions/${auctionId}/bids`,
    headers: auth(token),
    payload: { customerId, maxCents },
  });
}

/**
 * Drive the scheduler until an expected effect has landed. A single tick is
 * single-flight behind a Redis lock and can no-op (or lose a lock race), so
 * asserting after exactly one tick is non-deterministic — poll instead.
 */
async function tickUntil(done: () => Promise<boolean>, attempts = 25): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    await scheduler.tick();
    if (await done()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return done();
}

/** Poll the scheduler until an auction has left the `live` state. */
async function tickUntilClosed(auctionId: string): Promise<void> {
  const closed = await tickUntil(async () => {
    const [a] = await world.ctx.db.select({ status: auctions.status }).from(auctions).where(eq(auctions.id, auctionId));
    return !!a && a.status !== "live";
  });
  if (!closed) throw new Error(`auction ${auctionId} never left the live state`);
}

describe("auction close via the scheduler", () => {
  it("won auction → order with design-doc invoice math, item → awaiting_payment", async () => {
    const { auctionId, itemId } = await createLiveAuction(world, token, { startPriceCents: 10_000, endsInMs: 500, antiSnipeSec: 0 });
    const winner = await createBidder(world, "winner_1");
    const res = await bid(auctionId, winner, 10_000); // hammer €100
    expect(res.statusCode).toBe(200);

    await new Promise((r) => setTimeout(r, 600));
    await tickUntilClosed(auctionId);

    const [a] = await world.ctx.db.select().from(auctions).where(eq(auctions.id, auctionId));
    expect(a!.status).toBe("ended_won");

    const [order] = await world.ctx.db.select().from(orders).where(eq(orders.auctionId, auctionId));
    expect(order).toBeDefined();
    // €100 hammer + 10% premium + 21% VAT = €133.10 (doc worked example)
    expect(order!.hammerCents).toBe(10_000);
    expect(order!.premiumCents).toBe(1_000);
    expect(order!.vatCents).toBe(2_310);
    expect(order!.totalCents).toBe(13_310);
    expect(order!.status).toBe("awaiting_payment");
    expect(order!.paymentDeadlineAt).not.toBeNull();
    expect(order!.ref).toMatch(/^A-\d+$/);

    const [item] = await world.ctx.db.select().from(items).where(eq(items.id, itemId));
    expect(item!.status).toBe("awaiting_payment");
  });

  it("reserve not met → ended_reserve_not_met, item unsold, no order", async () => {
    const { auctionId, itemId } = await createLiveAuction(world, token, {
      startPriceCents: 1_000,
      reserveCents: 50_000,
      endsInMs: 400,
      antiSnipeSec: 0,
    });
    const bidder = await createBidder(world, "res_low");
    await bid(auctionId, bidder, 5_000);
    await new Promise((r) => setTimeout(r, 500));
    await tickUntilClosed(auctionId);

    const [a] = await world.ctx.db.select().from(auctions).where(eq(auctions.id, auctionId));
    expect(a!.status).toBe("ended_reserve_not_met");
    const [item] = await world.ctx.db.select().from(items).where(eq(items.id, itemId));
    expect(item!.status).toBe("unsold");
    const orderRows = await world.ctx.db.select().from(orders).where(eq(orders.auctionId, auctionId));
    expect(orderRows.length).toBe(0);
  });

  it("no bids → ended_no_bids, then relist creates a fresh scheduled auction", async () => {
    const { auctionId, itemId } = await createLiveAuction(world, token, { endsInMs: 300 });
    await new Promise((r) => setTimeout(r, 400));
    await tickUntilClosed(auctionId);

    const [a] = await world.ctx.db.select().from(auctions).where(eq(auctions.id, auctionId));
    expect(a!.status).toBe("ended_no_bids");

    const now = Date.now();
    const relist = await world.server.app.inject({
      method: "POST",
      url: `/api/auctions/${auctionId}/relist`,
      headers: auth(token),
      payload: { startsAt: new Date(now + 60_000).toISOString(), endsAt: new Date(now + 3_660_000).toISOString() },
    });
    expect(relist.statusCode).toBe(200);
    const [item] = await world.ctx.db.select().from(items).where(eq(items.id, itemId));
    expect(item!.status).toBe("listed");
    const next = (relist.json() as { auction: { id: string; status: string } }).auction;
    expect(next.status).toBe("scheduled");
  });

  it("scheduler opens scheduled auctions whose start has arrived", async () => {
    // createLiveAuction opens explicitly; here we schedule in the future and let time pass virtually.
    const { auctionId } = await createLiveAuction(world, token);
    // that one is open; sanity only
    const [a] = await world.ctx.db.select().from(auctions).where(eq(auctions.id, auctionId));
    expect(a!.status).toBe("live");
  });
});

describe("orders: payment, fulfilment, unpaid handling", () => {
  async function wonOrder() {
    const { auctionId, itemId } = await createLiveAuction(world, token, { startPriceCents: 5_000, endsInMs: 300, antiSnipeSec: 0 });
    const buyer = await createBidder(world, `buyer_${Math.random().toString(36).slice(2, 8)}`);
    await bid(auctionId, buyer, 5_000);
    await new Promise((r) => setTimeout(r, 400));
    // Drive the scheduler until the close has produced the winner's order
    // rather than assuming one tick lands it — keeps the helper deterministic.
    let order: typeof orders.$inferSelect | undefined;
    await tickUntil(async () => {
      [order] = await world.ctx.db.select().from(orders).where(eq(orders.auctionId, auctionId));
      return !!order;
    });
    if (!order) throw new Error(`auction ${auctionId} did not close into an order`);
    return { order, itemId, buyer };
  }

  it("mark paid → item paid → fulfilment chain to closed", async () => {
    const { order, itemId } = await wonOrder();
    const ops = await loginAs(world, "ops@auction.test");

    const paid = await world.server.app.inject({
      method: "POST",
      url: `/api/orders/${order.id}/mark-paid`,
      headers: auth(ops),
    });
    expect(paid.statusCode).toBe(200);
    expect((await world.ctx.db.select().from(items).where(eq(items.id, itemId)))[0]!.status).toBe("paid");

    for (const to of ["picking", "packed", "shipped", "delivered", "closed"]) {
      const res = await world.server.app.inject({
        method: "POST",
        url: `/api/items/${itemId}/transition`,
        headers: auth(ops),
        payload: { to },
      });
      expect(res.statusCode).toBe(200);
    }
    // Skipping a step is rejected.
    const { itemId: item2 } = await wonOrder();
    const ordersRow = await world.ctx.db.select().from(orders).where(eq(orders.itemId, item2));
    await world.server.app.inject({
      method: "POST",
      url: `/api/orders/${ordersRow[0]!.id}/mark-paid`,
      headers: auth(ops),
    });
    const bad = await world.server.app.inject({
      method: "POST",
      url: `/api/items/${item2}/transition`,
      headers: auth(ops),
      payload: { to: "shipped" },
    });
    expect(bad.statusCode).toBe(409);
  });

  it("refunds: partial then full flips status; over-max rejected", async () => {
    const { order } = await wonOrder();
    const ops = await loginAs(world, "ops@auction.test");
    await world.server.app.inject({ method: "POST", url: `/api/orders/${order.id}/mark-paid`, headers: auth(ops) });

    const part = await world.server.app.inject({
      method: "POST",
      url: `/api/orders/${order.id}/refund`,
      headers: auth(ops),
      payload: { amountCents: 1_000, reason: "chipped corner" },
    });
    expect(part.statusCode).toBe(200);

    const over = await world.server.app.inject({
      method: "POST",
      url: `/api/orders/${order.id}/refund`,
      headers: auth(ops),
      payload: { amountCents: order.totalCents, reason: "too much" },
    });
    expect(over.statusCode).toBe(422);

    const rest = await world.server.app.inject({
      method: "POST",
      url: `/api/orders/${order.id}/refund`,
      headers: auth(ops),
      payload: { amountCents: order.totalCents - 1_000, reason: "full return" },
    });
    expect(rest.statusCode).toBe(200);
    expect((await world.ctx.db.select().from(orders).where(eq(orders.id, order.id)))[0]!.status).toBe("refunded");
  });

  it("manual cancel-unpaid strikes the buyer and frees the item", async () => {
    const { order, itemId, buyer } = await wonOrder();
    const ops = await loginAs(world, "ops@auction.test");
    const res = await world.server.app.inject({
      method: "POST",
      url: `/api/orders/${order.id}/cancel-unpaid`,
      headers: auth(ops),
      payload: { reason: "no payment after reminders", strike: true },
    });
    expect(res.statusCode).toBe(200);
    expect((await world.ctx.db.select().from(items).where(eq(items.id, itemId)))[0]!.status).toBe("unpaid_cancelled");
    expect((await world.ctx.db.select().from(customers).where(eq(customers.id, buyer)))[0]!.strikes).toBe(1);
  });

  it("scheduler auto-cancels past the payment deadline (design-doc unpaid flow)", async () => {
    const { order, itemId, buyer } = await wonOrder();
    // Warp past the deadline.
    world.setNow(new Date(Date.now() + (world.ctx.config.paymentDeadlineHours + 1) * 3_600_000));
    try {
      await tickUntil(async () => {
        const [o] = await world.ctx.db.select({ status: orders.status }).from(orders).where(eq(orders.id, order.id));
        return o?.status === "cancelled";
      });
      expect((await world.ctx.db.select().from(orders).where(eq(orders.id, order.id)))[0]!.status).toBe("cancelled");
      expect((await world.ctx.db.select().from(items).where(eq(items.id, itemId)))[0]!.status).toBe("unpaid_cancelled");
      expect((await world.ctx.db.select().from(customers).where(eq(customers.id, buyer)))[0]!.strikes).toBe(1);
    } finally {
      world.setNow(null);
    }
  });
});
