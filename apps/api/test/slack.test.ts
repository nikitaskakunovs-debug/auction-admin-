import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAuction } from "../src/engine/close.js";
import { settleOrderPaid } from "../src/engine/settlement.js";
import type { SimulatedSlackClient } from "../src/engine/slack.js";
import { auth, createBidder, createLiveAuction, createWorld, loginAs, type TestWorld } from "./helpers.js";

/**
 * Phase S1 — Slack mirroring. The simulated client records what would have
 * been posted, so these assert the vocabulary and channel routing without
 * touching the network.
 */
describe("slack mirroring", () => {
  let world: TestWorld;
  let token: string;
  const slack = () => world.ctx.slack as SimulatedSlackClient;

  beforeAll(async () => {
    world = await createWorld();
    token = await loginAs(world, "super@auction.test");
  });
  afterAll(async () => {
    if (world) await world.close();
  });

  /** Bid, jump past the end, close — returns the won-order ref. */
  async function winAuction(alias: string, maxCents: number): Promise<string> {
    const bidderId = await createBidder(world, alias);
    const { auctionId } = await createLiveAuction(world, token, { startPriceCents: 1_000, endsInMs: 1_000 });
    const bid = await world.server.app.inject({
      method: "POST",
      url: `/api/auctions/${auctionId}/bids`,
      headers: auth(token),
      payload: { customerId: bidderId, maxCents },
    });
    if (bid.statusCode !== 200) throw new Error(`bid failed: ${bid.body}`);
    world.setNow(new Date(Date.now() + 60_000));
    const closed = await closeAuction(world.ctx, auctionId);
    world.setNow(null);
    if (!closed.ok || !closed.orderRef) throw new Error("auction did not close won");
    return closed.orderRef;
  }

  it("posts a won auction to #orders with price and bidder", async () => {
    const before = slack().sent.length;
    await winAuction("slack_win", 5_000);

    const won = slack().sent.slice(before).find((m) => m.title.includes("Izsole noslēgusies"));
    expect(won, "won message posted").toBeTruthy();
    expect(won!.channel).toBe("orders");
    expect(won!.text).toContain("€");
    expect(won!.fields?.join(" ")).toContain("slack_win");
  });

  it("posts payment settlement to #orders", async () => {
    const ref = await winAuction("slack_paid", 9_000);
    const list = await world.server.app.inject({
      method: "GET",
      url: "/api/orders?status=awaiting_payment",
      headers: auth(token),
    });
    const order = (list.json() as { orders: Array<{ id: string; ref: string }> }).orders.find((o) => o.ref === ref);
    expect(order, "order exists").toBeTruthy();

    const before = slack().sent.length;
    await settleOrderPaid(world.ctx, order!.id, { id: null, label: "Tests" });

    const paid = slack().sent.slice(before).find((m) => m.title.includes("Apmaksāts"));
    expect(paid, "paid message posted").toBeTruthy();
    expect(paid!.channel).toBe("orders");
    expect(paid!.text).toContain(ref);
  });

  it("posts a bug report to #bugs with severity and reporter", async () => {
    const before = slack().sent.length;
    const res = await world.server.app.inject({
      method: "POST",
      url: "/api/bugs",
      headers: auth(token),
      payload: { body: "Poga nestrādā", screen: "orders", type: "bug", severity: "high", context: {} },
    });
    expect(res.statusCode).toBe(200);

    const bug = slack().sent.slice(before).find((m) => m.title.includes("Jauns ziņojums"));
    expect(bug, "bug message posted").toBeTruthy();
    expect(bug!.channel).toBe("bugs");
    expect(bug!.text).toBe("Poga nestrādā");
    expect(bug!.fields?.join(" ")).toContain("augsta");
  });

  it("never throws into the caller when Slack fails", async () => {
    const original = world.ctx.slack;
    // A client whose post() always rejects must not break the business action.
    world.ctx.slack = {
      channelName: () => "#x",
      post: () => Promise.reject(new Error("slack down")),
    };
    const res = await world.server.app.inject({
      method: "POST",
      url: "/api/bugs",
      headers: auth(token),
      payload: { body: "Vēl viens", screen: "orders", type: "bug", severity: "low", context: {} },
    });
    expect(res.statusCode).toBe(200);
    world.ctx.slack = original;
  });
});
