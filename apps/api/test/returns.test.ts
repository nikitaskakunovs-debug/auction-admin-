import { items, orders, payments, returnCases, stockMovements } from "@auction/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAuction } from "../src/engine/close.js";
import { auth, createBidder, createLiveAuction, createWorld, loginAs, type TestWorld } from "./helpers.js";

/**
 * R2 — returns at the counter. The rules that matter: the 14-day window bends
 * but is recorded when it does; a decision moves money, the item and the case
 * together or not at all; and an Inbank-paid order tells staff to use the
 * provider's portal instead of quietly leaving the return half-done.
 */
describe("returns at the counter (R2)", () => {
  let world: TestWorld;
  let superToken: string;
  let opsToken: string;
  let contentToken: string;

  beforeAll(async () => {
    world = await createWorld();
    superToken = await loginAs(world, "super@auction.test");
    opsToken = await loginAs(world, "ops@auction.test");
    contentToken = await loginAs(world, "content@auction.test");
  });
  afterAll(async () => {
    if (world) await world.close();
  });

  const app = () => world.server.app;
  const json = <T>(res: { json: () => unknown }) => res.json() as T;

  /** Win → pay at the desk → collect, so the lot is genuinely in a buyer's hands. */
  async function collectedLot(alias: string): Promise<{ bidderId: string; orderId: string; itemId: string; ref: string }> {
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
      method: "POST", url: "/api/desk/pay", headers: auth(superToken),
      payload: { orderIds: [order!.id], method: "cash" },
    });
    const checkin = await app().inject({
      method: "POST", url: "/api/pickup/checkin", headers: auth(superToken), payload: { customerId: bidderId },
    });
    const ticketId = json<{ ticketId: string }>(checkin).ticketId;
    await app().inject({ method: "POST", url: `/api/pickup/tickets/${ticketId}/claim`, headers: auth(superToken) });
    const queue = await app().inject({ method: "GET", url: "/api/pickup/queue", headers: auth(superToken) });
    const ticket = json<{ tickets: Array<{ id: string; lines: Array<{ id: string }> }> }>(queue).tickets.find((t) => t.id === ticketId);
    for (const line of ticket!.lines) {
      await app().inject({
        method: "POST", url: `/api/pickup/tickets/${ticketId}/lines/${line.id}`, headers: auth(superToken),
        payload: { status: "picked" },
      });
    }
    await app().inject({ method: "POST", url: `/api/pickup/tickets/${ticketId}/delivering`, headers: auth(superToken) });
    const done = await app().inject({
      method: "POST", url: `/api/pickup/tickets/${ticketId}/complete`, headers: auth(superToken),
      payload: { overrideReason: "test collection" },
    });
    expect(done.statusCode).toBe(200);
    return { bidderId, orderId: order!.id, itemId, ref: closed.orderRef };
  }

  const openCase = (payload: Record<string, unknown>, token = opsToken) =>
    app().inject({ method: "POST", url: "/api/returns", headers: auth(token), payload });

  it("offers what the customer actually collected, with the window on each line", async () => {
    const lot = await collectedLot("ret_list");
    const res = await app().inject({
      method: "GET", url: `/api/desk/returnable?customerId=${lot.bidderId}`, headers: auth(opsToken),
    });
    expect(res.statusCode).toBe(200);
    const line = json<{ lines: Array<{ orderId: string; itemId: string; daysLeft: number; withinWindow: boolean; refundableCents: number; alreadyReturned: boolean }> }>(res)
      .lines.find((l) => l.orderId === lot.orderId);
    expect(line, "the lot they just took home is returnable").toBeTruthy();
    expect(line!.withinWindow).toBe(true);
    expect(line!.daysLeft).toBeGreaterThan(12);
    expect(line!.refundableCents).toBeGreaterThan(0);
    expect(line!.alreadyReturned).toBe(false);
  });

  it("bends the 14-day window only when someone says why", async () => {
    const lot = await collectedLot("ret_late");
    // Three weeks on: the door does not disappear, it asks a question.
    world.setNow(new Date(Date.now() + 21 * 86_400_000));

    const bare = await openCase({ orderId: lot.orderId, itemId: lot.itemId, reason: "changed_mind" });
    expect(bare.statusCode).toBe(422);
    expect(json<{ error: string }>(bare).error).toBe("override_reason_required");

    const withReason = await openCase({
      orderId: lot.orderId, itemId: lot.itemId, reason: "changed_mind",
      overrideReason: "Pastāvīgs klients, pieņemam izņēmuma kārtā",
    });
    expect(withReason.statusCode).toBe(200);
    const c = json<{ case: { withinWindow: boolean; overrideReason: string; ref: string } }>(withReason).case;
    expect(c.withinWindow).toBe(false);
    expect(c.overrideReason).toContain("Pastāvīgs");
    expect(c.ref).toMatch(/^RET-/);
    world.setNow(null);
  });

  it("refunds, moves the item and closes the case in one decision", async () => {
    const lot = await collectedLot("ret_full");
    const opened = await openCase({ orderId: lot.orderId, itemId: lot.itemId, reason: "not_as_described", note: "Trūkst akumulatora" });
    expect(opened.statusCode).toBe(200);
    const caseId = json<{ case: { id: string } }>(opened).case.id;

    const [before] = await world.ctx.db.select().from(orders).where(eq(orders.id, lot.orderId));
    const resolved = await app().inject({
      method: "POST", url: `/api/returns/${caseId}/resolve`, headers: auth(superToken),
      payload: { decision: "refund_full", destination: "quarantine" },
    });
    expect(resolved.statusCode).toBe(200);

    const [after] = await world.ctx.db.select().from(orders).where(eq(orders.id, lot.orderId));
    expect(after!.status, "a full refund closes the order out").toBe("refunded");

    const [item] = await world.ctx.db.select().from(items).where(eq(items.id, lot.itemId));
    expect(item!.status).toBe("returned");

    const moves = await world.ctx.db
      .select()
      .from(stockMovements)
      .where(and(eq(stockMovements.itemId, lot.itemId), eq(stockMovements.type, "restock")));
    expect(moves.length, "the goods coming back are in the movement ledger").toBeGreaterThanOrEqual(1);

    const [row] = await world.ctx.db.select().from(returnCases).where(eq(returnCases.id, caseId));
    expect(row!.status).toBe("resolved");
    expect(row!.decision).toBe("refund_full");
    expect(row!.destination).toBe("quarantine");
    expect(row!.refundCents).toBe(before!.totalCents);
  });

  it("refuses a partial refund larger than what is left", async () => {
    const lot = await collectedLot("ret_part");
    const caseId = json<{ case: { id: string } }>(
      await openCase({ orderId: lot.orderId, itemId: lot.itemId, reason: "damaged" }),
    ).case.id;
    const [order] = await world.ctx.db.select().from(orders).where(eq(orders.id, lot.orderId));

    const tooMuch = await app().inject({
      method: "POST", url: `/api/returns/${caseId}/resolve`, headers: auth(superToken),
      payload: { decision: "refund_partial", refundCents: order!.totalCents + 1, destination: "stock" },
    });
    expect(tooMuch.statusCode).toBe(422);

    const ok = await app().inject({
      method: "POST", url: `/api/returns/${caseId}/resolve`, headers: auth(superToken),
      payload: { decision: "refund_partial", refundCents: 500, destination: "stock" },
    });
    expect(ok.statusCode).toBe(200);
    const [after] = await world.ctx.db.select().from(orders).where(eq(orders.id, lot.orderId));
    expect(after!.status, "a part refund leaves the order paid").toBe("paid");
  });

  it("records a rejected claim without moving money or goods", async () => {
    const lot = await collectedLot("ret_reject");
    const caseId = json<{ case: { id: string } }>(
      await openCase({ orderId: lot.orderId, itemId: lot.itemId, reason: "changed_mind" }),
    ).case.id;

    const wrongDestination = await app().inject({
      method: "POST", url: `/api/returns/${caseId}/resolve`, headers: auth(superToken),
      payload: { decision: "rejected", destination: "stock" },
    });
    expect(wrongDestination.statusCode, "a rejected claim cannot also restock the item").toBe(422);

    const res = await app().inject({
      method: "POST", url: `/api/returns/${caseId}/resolve`, headers: auth(superToken),
      payload: { decision: "rejected", destination: "kept_by_buyer", note: "Stāvoklis aprakstīts, pārdots kā redzēts" },
    });
    expect(res.statusCode).toBe(200);
    const [order] = await world.ctx.db.select().from(orders).where(eq(orders.id, lot.orderId));
    expect(order!.status).toBe("paid");
    const [item] = await world.ctx.db.select().from(items).where(eq(items.id, lot.itemId));
    expect(item!.status, "the buyer keeps it").toBe("delivered");
  });

  /**
   * The one that would hurt in production: Inbank credit contracts cannot be
   * refunded through an API. If the return completed anyway, the case would
   * say the money went back when it never did.
   */
  it("leaves an Inbank return untouched and tells staff to use the portal", async () => {
    const lot = await collectedLot("ret_inbank");
    await world.ctx.db.insert(payments).values({
      orderId: lot.orderId,
      provider: "inbank",
      status: "paid",
      amountCents: 1_000,
      providerId: "inbank-test-contract",
    });
    const caseId = json<{ case: { id: string } }>(
      await openCase({ orderId: lot.orderId, itemId: lot.itemId, reason: "not_as_described" }),
    ).case.id;

    const blocked = await app().inject({
      method: "POST", url: `/api/returns/${caseId}/resolve`, headers: auth(superToken),
      payload: { decision: "refund_full", destination: "quarantine" },
    });
    expect(blocked.statusCode).toBe(409);
    expect(json<{ error: string }>(blocked).error).toBe("provider_refund_unsupported");

    const [stillOpen] = await world.ctx.db.select().from(returnCases).where(eq(returnCases.id, caseId));
    expect(stillOpen!.status, "nothing half-done").toBe("open");
    const [item] = await world.ctx.db.select().from(items).where(eq(items.id, lot.itemId));
    expect(item!.status).toBe("delivered");
    const [order] = await world.ctx.db.select().from(orders).where(eq(orders.id, lot.orderId));
    expect(order!.status).toBe("paid");

    // Credited in Inbank's portal, then recorded here.
    const recorded = await app().inject({
      method: "POST", url: `/api/returns/${caseId}/resolve`, headers: auth(superToken),
      payload: { decision: "refund_full", destination: "quarantine", viaProvider: false },
    });
    expect(recorded.statusCode).toBe(200);
    const [done] = await world.ctx.db.select().from(returnCases).where(eq(returnCases.id, caseId));
    expect(done!.status).toBe("resolved");
  });

  it("shows the decider what this customer has returned before", async () => {
    const bidderId = await createBidder(world, "ret_history");
    const made: string[] = [];
    for (let i = 0; i < 2; i++) {
      const { auctionId, itemId } = await createLiveAuction(world, superToken, { startPriceCents: 1_000, endsInMs: 1_000 });
      await app().inject({
        method: "POST", url: `/api/auctions/${auctionId}/bids`, headers: auth(superToken),
        payload: { customerId: bidderId, maxCents: 5_000 },
      });
      world.setNow(new Date(Date.now() + 60_000));
      const closed = await closeAuction(world.ctx, auctionId);
      world.setNow(null);
      const [order] = await world.ctx.db.select().from(orders).where(eq(orders.ref, closed.orderRef!));
      await app().inject({
        method: "POST", url: "/api/desk/pay", headers: auth(superToken),
        payload: { orderIds: [order!.id], method: "cash" },
      });
      await world.ctx.db.update(items).set({ status: "delivered" }).where(eq(items.id, itemId));
      const c = await openCase({ orderId: order!.id, itemId, reason: "damaged" });
      const caseId = json<{ case: { id: string } }>(c).case.id;
      made.push(caseId);
      if (i === 0) {
        await app().inject({
          method: "POST", url: `/api/returns/${caseId}/resolve`, headers: auth(superToken),
          payload: { decision: "refund_full", destination: "quarantine" },
        });
      }
    }

    const detail = await app().inject({ method: "GET", url: `/api/returns/${made[1]}`, headers: auth(opsToken) });
    expect(detail.statusCode).toBe(200);
    const body = json<{ history: Array<{ ref: string; decision: string }> }>(detail);
    expect(body.history.length, "the earlier resolved return is visible while deciding this one").toBeGreaterThanOrEqual(1);
    expect(body.history[0]!.decision).toBe("refund_full");
  });

  it("keeps opening and deciding on the right sides of the permission line", async () => {
    const lot = await collectedLot("ret_perms");
    // A content editor has no business at the counter at all.
    expect((await openCase({ orderId: lot.orderId, itemId: lot.itemId, reason: "other" }, contentToken)).statusCode).toBe(403);

    const caseId = json<{ case: { id: string } }>(
      await openCase({ orderId: lot.orderId, itemId: lot.itemId, reason: "other" }),
    ).case.id;
    expect((await app().inject({
      method: "POST", url: `/api/returns/${caseId}/resolve`, headers: auth(contentToken),
      payload: { decision: "rejected", destination: "kept_by_buyer" },
    })).statusCode).toBe(403);

    // And the amount never reaches the activity feed, which most roles read.
    const feed = await app().inject({ method: "GET", url: "/api/audit?limit=200", headers: auth(opsToken) });
    const entries = json<{ entries: Array<{ action: string; detail: Record<string, unknown> | null }> }>(feed).entries;
    const opened = entries.find((e) => e.action === "return_opened");
    expect(opened, "returns are audited").toBeTruthy();
    for (const e of entries.filter((x) => x.action.startsWith("return_"))) {
      expect(Object.keys(e.detail ?? {})).not.toContain("amountCents");
      expect(Object.keys(e.detail ?? {})).not.toContain("refundCents");
    }
  });
});
