import { customers, notifications, orders } from "@auction/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuctionScheduler } from "../src/engine/scheduler.js";
import { dispatchNotifications } from "../src/engine/notifications.js";
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
beforeEach(() => {
  world.email.sent.length = 0;
  world.email.failNext = 0;
});

async function bid(auctionId: string, customerId: string, maxCents: number) {
  return world.server.app.inject({
    method: "POST",
    url: `/api/auctions/${auctionId}/bids`,
    headers: auth(token),
    payload: { customerId, maxCents },
  });
}

describe("outbid notifications", () => {
  it("enqueues an outbid email for the dethroned leader, and dispatch sends it", async () => {
    const { auctionId } = await createLiveAuction(world, token, { startPriceCents: 1_000 });
    const alice = await createBidder(world, "notif_alice", { email: "alice@n.test", country: "LV" });
    const bob = await createBidder(world, "notif_bob", { email: "bob@n.test" });

    await bid(auctionId, alice, 2_000);
    await bid(auctionId, bob, 9_000); // alice dethroned

    const pending = await world.ctx.db.select().from(notifications).where(eq(notifications.customerId, alice));
    expect(pending.length).toBe(1);
    expect(pending[0]!.type).toBe("outbid");
    expect(pending[0]!.toEmail).toBe("alice@n.test");
    expect(pending[0]!.lang).toBe("lv"); // LV bidder → Latvian template

    const n = await dispatchNotifications(world.ctx);
    expect(n).toBe(1);
    expect(world.email.sent.some((m) => m.to === "alice@n.test" && m.subject.includes("pārsolīts"))).toBe(true);

    // The bidder who is merely defended-against (still leading) gets nothing.
    const carol = await createBidder(world, "notif_carol", { email: "carol@n.test" });
    await bid(auctionId, carol, 3_000); // below bob's max — bob defends, stays leader
    const carolNotifs = await world.ctx.db.select().from(notifications).where(eq(notifications.customerId, bob));
    expect(carolNotifs.length).toBe(0); // bob was never outbid
  });
});

describe("won notifications", () => {
  it("emails the winner on close with the order ref and total", async () => {
    const { auctionId } = await createLiveAuction(world, token, { startPriceCents: 10_000, endsInMs: 250, antiSnipeSec: 0 });
    const winner = await createBidder(world, "notif_winner", { email: "winner@n.test" });
    await bid(auctionId, winner, 10_000);
    await new Promise((r) => setTimeout(r, 320));
    await scheduler.tick(); // closes + enqueues + dispatches

    const won = world.email.sent.filter((m) => m.to === "winner@n.test" && m.text.includes("[won]"));
    expect(won.length).toBe(1);
    expect(won[0]!.text).toMatch(/A-\d+/); // order ref present
  });
});

describe("payment reminders (design-doc unpaid flow)", () => {
  async function wonOrder(email: string) {
    const { auctionId } = await createLiveAuction(world, token, { startPriceCents: 5_000, endsInMs: 250, antiSnipeSec: 0 });
    const buyer = await createBidder(world, `pr_${Math.random().toString(36).slice(2, 8)}`, { email });
    await bid(auctionId, buyer, 5_000);
    await new Promise((r) => setTimeout(r, 320));
    await scheduler.tick();
    const [order] = await world.ctx.db.select().from(orders).where(eq(orders.auctionId, auctionId));
    return { order: order!, buyer };
  }

  it("sends exactly one reminder inside the lead window, then auto-cancels after the deadline", async () => {
    const { order, buyer } = await wonOrder("remind@n.test");
    world.email.sent.length = 0;

    // Warp to inside the reminder window (deadline is 72h out; lead is 24h).
    world.setNow(new Date(order.paymentDeadlineAt!.getTime() - 3_600_000)); // 1h before deadline
    try {
      await scheduler.tick();
      await scheduler.tick(); // second tick must NOT double-send (dedupe)
      const reminders = world.email.sent.filter((m) => m.to === "remind@n.test" && m.text.includes("[payment_reminder]"));
      expect(reminders.length).toBe(1);

      // Past the deadline → auto-cancel + strike.
      world.setNow(new Date(order.paymentDeadlineAt!.getTime() + 60_000));
      await scheduler.tick();
      const [after] = await world.ctx.db.select().from(orders).where(eq(orders.id, order.id));
      expect(after!.status).toBe("cancelled");
      expect((await world.ctx.db.select().from(customers).where(eq(customers.id, buyer)))[0]!.strikes).toBe(1);
    } finally {
      world.setNow(null);
    }
  });
});

describe("order-paid receipt", () => {
  it("emails a receipt when an order is marked paid", async () => {
    const { auctionId } = await createLiveAuction(world, token, { startPriceCents: 5_000, endsInMs: 250, antiSnipeSec: 0 });
    const buyer = await createBidder(world, "paid_buyer", { email: "paid@n.test" });
    await bid(auctionId, buyer, 5_000);
    await new Promise((r) => setTimeout(r, 320));
    await scheduler.tick();
    const [order] = await world.ctx.db.select().from(orders).where(eq(orders.auctionId, auctionId));
    world.email.sent.length = 0;

    const ops = await loginAs(world, "ops@auction.test");
    await world.server.app.inject({ method: "POST", url: `/api/orders/${order!.id}/mark-paid`, headers: auth(ops) });
    await dispatchNotifications(world.ctx);
    expect(world.email.sent.some((m) => m.to === "paid@n.test" && m.text.includes("[order_paid]"))).toBe(true);
  });
});

describe("dispatch reliability", () => {
  it("retries a failed send and does not lose the message", async () => {
    const { auctionId } = await createLiveAuction(world, token, { startPriceCents: 1_000 });
    const a = await createBidder(world, "retry_a", { email: "retry_a@n.test" });
    const b = await createBidder(world, "retry_b", { email: "retry_b@n.test" });
    await bid(auctionId, a, 2_000);
    await bid(auctionId, b, 9_000); // enqueues one outbid for a

    world.email.failNext = 1; // first send throws
    await dispatchNotifications(world.ctx);
    expect(world.email.sent.length).toBe(0);
    let [row] = await world.ctx.db.select().from(notifications).where(eq(notifications.customerId, a));
    expect(row!.status).toBe("pending");
    expect(row!.attempts).toBe(1);

    await dispatchNotifications(world.ctx); // retry succeeds
    expect(world.email.sent.some((m) => m.to === "retry_a@n.test")).toBe(true);
    [row] = await world.ctx.db.select().from(notifications).where(eq(notifications.customerId, a));
    expect(row!.status).toBe("sent");
  });

  it("never emails an erased bidder", async () => {
    const { auctionId } = await createLiveAuction(world, token, { startPriceCents: 1_000 });
    const a = await createBidder(world, "erase_a", { email: "erase_a@n.test", country: "LV" });
    const b = await createBidder(world, "erase_b", { email: "erase_b@n.test" });
    await bid(auctionId, a, 2_000);
    await world.ctx.db.update(customers).set({ erasedAt: new Date() }).where(eq(customers.id, a));
    await bid(auctionId, b, 9_000); // would enqueue an outbid for the now-erased a

    const rows = await world.ctx.db.select().from(notifications).where(eq(notifications.customerId, a));
    expect(rows.length).toBe(0);
  });
});
