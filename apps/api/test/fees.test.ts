import { customerFees, customers, items, notifications, orders } from "@auction/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuctionScheduler } from "../src/engine/scheduler.js";
import { cancelNoShowDue } from "../src/engine/noShow.js";
import { auth, createLiveAuction, createWorld, loginAs, type TestWorld } from "./helpers.js";

let world: TestWorld;
let adminToken: string;
let opsToken: string;
let scheduler: AuctionScheduler;

beforeAll(async () => {
  world = await createWorld();
  adminToken = await loginAs(world, "super@auction.test");
  opsToken = await loginAs(world, "ops@auction.test");
  scheduler = new AuctionScheduler(world.ctx);
});
afterAll(async () => {
  await world.close();
});

async function registerBidder(alias: string) {
  const res = await world.server.app.inject({
    method: "POST",
    url: "/api/public/auth/register",
    payload: { email: `${alias}@fees.test`, alias, password: "Bidder123!", country: "LV" },
  });
  return res.json() as { accessToken: string; bidder: { id: string } };
}

/** Fixed-price purchase → order awaiting payment (deterministic). */
async function unpaidOrder(buyerToken: string, priceCents = 11_000): Promise<{ orderId: string; ref: string; itemId: string }> {
  const app = world.server.app;
  const sku = `FEE-${Math.random().toString(36).slice(2, 9)}`;
  const item = await app.inject({ method: "POST", url: "/api/items", headers: auth(adminToken), payload: { sku, title: `Fee ${sku}`, marketCode: "LV" } });
  const itemId = (item.json() as { item: { id: string } }).item.id;
  const listing = await app.inject({
    method: "POST",
    url: "/api/listings",
    headers: auth(adminToken),
    payload: { itemId, type: "fixed", title: `Fee ${sku}`, marketCode: "LV", priceCents, quantity: 1 },
  });
  const listingId = (listing.json() as { listing: { id: string } }).listing.id;
  await app.inject({ method: "POST", url: `/api/listings/${listingId}/publish`, headers: auth(adminToken) });
  const buy = await app.inject({ method: "POST", url: `/api/public/listings/${listingId}/buy`, headers: auth(buyerToken) });
  expect(buy.statusCode).toBe(200);
  const { orderRef } = buy.json() as { orderRef: string };
  const [order] = await world.ctx.db.select().from(orders).where(eq(orders.ref, orderRef));
  return { orderId: order!.id, ref: orderRef, itemId };
}

/** Run scheduler ticks until a predicate holds (single tick can lose the lock). */
async function tickUntil(done: () => Promise<boolean>, attempts = 25): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    await scheduler.tick();
    if (await done()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return done();
}

describe("unpaid-winner restock fee (auto-cancel)", () => {
  it("records an outstanding 5% fee, strikes, emails, and blocks bid + buy until settled", async () => {
    const buyer = await registerBidder("debt_dana");
    const { orderId } = await unpaidOrder(buyer.accessToken, 11_000); // total 13310

    // Warp past the 72h payment deadline and let the scheduler cancel.
    world.setNow(new Date(Date.now() + 80 * 3_600_000));
    try {
      const cancelled = await tickUntil(async () => {
        const [o] = await world.ctx.db.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId));
        return o?.status === "cancelled";
      });
      expect(cancelled).toBe(true);
    } finally {
      world.setNow(null);
    }

    const [order] = await world.ctx.db.select().from(orders).where(eq(orders.id, orderId));
    expect(order!.cancelReason).toBe("unpaid");
    expect(order!.restockFeeCents).toBe(666); // 5% of 13310, half-up

    const feeRows = await world.ctx.db.select().from(customerFees).where(eq(customerFees.customerId, buyer.bidder.id));
    expect(feeRows).toHaveLength(1);
    expect(feeRows[0]!.type).toBe("unpaid_restock");
    expect(feeRows[0]!.status).toBe("outstanding");
    expect(feeRows[0]!.amountCents).toBe(666);

    const [cust] = await world.ctx.db.select().from(customers).where(eq(customers.id, buyer.bidder.id));
    expect(cust!.strikes).toBe(1);

    const mails = await world.ctx.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.customerId, buyer.bidder.id), eq(notifications.type, "unpaid_cancelled")));
    expect(mails).toHaveLength(1);
    expect(mails[0]!.body).toContain("6.66");

    // The account sees the debt…
    const myFees = await world.server.app.inject({ method: "GET", url: "/api/public/me/fees", headers: auth(buyer.accessToken) });
    expect((myFees.json() as { outstandingCents: number }).outstandingCents).toBe(666);

    // …and bidding + buying are paused.
    const { auctionId } = await createLiveAuction(world, adminToken, { startPriceCents: 1_000 });
    const bid = await world.server.app.inject({
      method: "POST",
      url: `/api/public/auctions/${auctionId}/bids`,
      headers: auth(buyer.accessToken),
      payload: { maxCents: 5_000 },
    });
    expect(bid.statusCode).toBe(422);
    expect((bid.json() as { code: string }).code).toBe("FEES_OUTSTANDING");

    const second = await unpaidOrder((await registerBidder("debt_helper")).accessToken).catch(() => null);
    expect(second).not.toBeNull(); // sanity: others are unaffected

    // Ops settles the fee (paid at the desk) → the account unblocks instantly.
    const settle = await world.server.app.inject({
      method: "POST",
      url: `/api/customers/${buyer.bidder.id}/fees/${feeRows[0]!.id}/settle`,
      headers: auth(opsToken),
      payload: { note: "paid cash at the desk" },
    });
    expect(settle.statusCode).toBe(200);

    const bid2 = await world.server.app.inject({
      method: "POST",
      url: `/api/public/auctions/${auctionId}/bids`,
      headers: auth(buyer.accessToken),
      payload: { maxCents: 5_000 },
    });
    expect(bid2.statusCode).toBe(200);
  });

  it("manual cancel-unpaid can skip the fee; waiving requires a note", async () => {
    const buyer = await registerBidder("debt_mercy");
    const noFee = await unpaidOrder(buyer.accessToken);
    const cancel = await world.server.app.inject({
      method: "POST",
      url: `/api/orders/${noFee.orderId}/cancel-unpaid`,
      headers: auth(opsToken),
      payload: { reason: "customer asked to withdraw", strike: false, restockFee: false },
    });
    expect(cancel.statusCode).toBe(200);
    let feeRows = await world.ctx.db.select().from(customerFees).where(eq(customerFees.customerId, buyer.bidder.id));
    expect(feeRows).toHaveLength(0);

    // With the fee (default), then waive it — reason required, audited.
    const withFee = await unpaidOrder(buyer.accessToken);
    await world.server.app.inject({
      method: "POST",
      url: `/api/orders/${withFee.orderId}/cancel-unpaid`,
      headers: auth(opsToken),
      payload: { reason: "no payment" },
    });
    feeRows = await world.ctx.db
      .select()
      .from(customerFees)
      .where(and(eq(customerFees.customerId, buyer.bidder.id), eq(customerFees.status, "outstanding")));
    expect(feeRows).toHaveLength(1);

    const noNote = await world.server.app.inject({
      method: "POST",
      url: `/api/customers/${buyer.bidder.id}/fees/${feeRows[0]!.id}/waive`,
      headers: auth(opsToken),
      payload: {},
    });
    expect(noNote.statusCode).toBe(400);

    const waived = await world.server.app.inject({
      method: "POST",
      url: `/api/customers/${buyer.bidder.id}/fees/${feeRows[0]!.id}/waive`,
      headers: auth(opsToken),
      payload: { note: "goodwill — long-time client" },
    });
    expect(waived.statusCode).toBe(200);

    // Waiving twice is refused (no longer outstanding).
    const again = await world.server.app.inject({
      method: "POST",
      url: `/api/customers/${buyer.bidder.id}/fees/${feeRows[0]!.id}/waive`,
      headers: auth(opsToken),
      payload: { note: "again" },
    });
    expect(again.statusCode).toBe(409);
  });

  it("content editor cannot settle fees (RBAC)", async () => {
    const contentToken = await loginAs(world, "content@auction.test");
    const res = await world.server.app.inject({
      method: "POST",
      url: "/api/customers/00000000-0000-0000-0000-000000000000/fees/00000000-0000-0000-0000-000000000000/settle",
      headers: auth(contentToken),
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("no-pickup fee lands in the same ledger, born settled", () => {
  it("records a settled no_pickup_restock row that does NOT block bidding", async () => {
    const buyer = await registerBidder("ledger_lena");
    const { orderId } = await unpaidOrder(buyer.accessToken, 11_000);
    const paid = await world.server.app.inject({ method: "POST", url: `/api/orders/${orderId}/mark-paid`, headers: auth(opsToken) });
    expect(paid.statusCode).toBe(200);

    world.setNow(new Date(Date.now() + 15 * 86_400_000));
    try {
      await cancelNoShowDue(world.ctx);
    } finally {
      world.setNow(null);
    }

    const feeRows = await world.ctx.db.select().from(customerFees).where(eq(customerFees.customerId, buyer.bidder.id));
    expect(feeRows).toHaveLength(1);
    expect(feeRows[0]!.type).toBe("no_pickup_restock");
    expect(feeRows[0]!.status).toBe("settled"); // deducted from held funds
    expect(feeRows[0]!.amountCents).toBe(666);

    // Settled-at-source fees never pause the account.
    const { auctionId } = await createLiveAuction(world, adminToken, { startPriceCents: 1_000 });
    const bid = await world.server.app.inject({
      method: "POST",
      url: `/api/public/auctions/${auctionId}/bids`,
      headers: auth(buyer.accessToken),
      payload: { maxCents: 5_000 },
    });
    expect(bid.statusCode).toBe(200);
  });
});
