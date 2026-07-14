import { customers, items, notifications, orders, refunds, stockMovements, warehouseLocations } from "@auction/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cancelNoShowDue, remindPickupDue } from "../src/engine/noShow.js";
import { auth, createWorld, loginAs, type TestWorld } from "./helpers.js";

let world: TestWorld;
let adminToken: string;
let opsToken: string;

beforeAll(async () => {
  world = await createWorld();
  adminToken = await loginAs(world, "super@auction.test");
  opsToken = await loginAs(world, "ops@auction.test");
});
afterAll(async () => {
  await world.close();
});

async function registerBidder(alias: string) {
  const res = await world.server.app.inject({
    method: "POST",
    url: "/api/public/auth/register",
    payload: { email: `${alias}@pickup.test`, alias, password: "Bidder123!", country: "LV" },
  });
  return res.json() as { accessToken: string; bidder: { id: string } };
}

/** Fixed-price purchase → paid order: the deterministic path to a pickup. */
async function paidOrder(buyerToken: string, priceCents = 10_000): Promise<{ orderId: string; ref: string; itemId: string; totalCents: number }> {
  const app = world.server.app;
  const sku = `PU-${Math.random().toString(36).slice(2, 9)}`;
  const item = await app.inject({ method: "POST", url: "/api/items", headers: auth(adminToken), payload: { sku, title: `Pickup ${sku}`, marketCode: "LV" } });
  const itemId = (item.json() as { item: { id: string } }).item.id;
  const listing = await app.inject({
    method: "POST",
    url: "/api/listings",
    headers: auth(adminToken),
    payload: { itemId, type: "fixed", title: `Pickup ${sku}`, marketCode: "LV", priceCents, quantity: 1 },
  });
  const listingId = (listing.json() as { listing: { id: string } }).listing.id;
  await app.inject({ method: "POST", url: `/api/listings/${listingId}/publish`, headers: auth(adminToken) });
  const buy = await app.inject({ method: "POST", url: `/api/public/listings/${listingId}/buy`, headers: auth(buyerToken) });
  expect(buy.statusCode).toBe(200);
  const { orderRef, totalCents } = buy.json() as { orderRef: string; totalCents: number };
  const [order] = await world.ctx.db.select().from(orders).where(eq(orders.ref, orderRef));
  const paid = await app.inject({ method: "POST", url: `/api/orders/${order!.id}/mark-paid`, headers: auth(opsToken) });
  expect(paid.statusCode).toBe(200);
  return { orderId: order!.id, ref: orderRef, itemId, totalCents };
}

describe("pickup pass (mark-paid)", () => {
  it("assigns a 6-digit code + 14-day deadline and emails the pass", async () => {
    const buyer = await registerBidder("pass_owner");
    const { orderId } = await paidOrder(buyer.accessToken);

    const [order] = await world.ctx.db.select().from(orders).where(eq(orders.id, orderId));
    expect(order!.pickupCode).toMatch(/^\d{6}$/);
    const days = (order!.pickupDeadlineAt!.getTime() - order!.paidAt!.getTime()) / 86_400_000;
    expect(days).toBeCloseTo(14, 5);

    const [mail] = await world.ctx.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.customerId, buyer.bidder.id), eq(notifications.type, "pickup_ready")));
    expect(mail!.body).toContain(order!.pickupCode!);

    // The bidder sees their own pass; it never appears on public surfaces.
    const pass = await world.server.app.inject({ method: "GET", url: "/api/public/me/pickup", headers: auth(buyer.accessToken) });
    const passBody = pass.json() as { pickup: Array<{ pickupCode: string }> };
    expect(passBody.pickup.some((p) => p.pickupCode === order!.pickupCode)).toBe(true);
  });
});

describe("warehouse ERP: locations + movements", () => {
  it("creates a bin, puts an item away, and ledgers every move", async () => {
    const buyer = await registerBidder("erp_binny");
    const { itemId } = await paidOrder(buyer.accessToken);

    const loc = await world.server.app.inject({
      method: "POST",
      url: "/api/warehouse/locations",
      headers: auth(adminToken),
      payload: { zone: "front", aisle: "A9", rack: "R1", shelf: "S1" },
    });
    expect(loc.statusCode).toBe(200);
    const location = (loc.json() as { location: { id: string; label: string; zone: string } }).location;
    expect(location.label).toBe("FRONT-A9-R1-S1"); // zone upper-cased, label derived

    const put = await world.server.app.inject({
      method: "POST",
      url: `/api/items/${itemId}/putaway`,
      headers: auth(opsToken),
      payload: { locationId: location.id, reason: "intake shelf" },
    });
    expect(put.statusCode).toBe(200);

    const [item] = await world.ctx.db.select().from(items).where(eq(items.id, itemId));
    expect(item!.locationId).toBe(location.id);

    const moves = await world.server.app.inject({ method: "GET", url: `/api/items/${itemId}/movements`, headers: auth(opsToken) });
    const { movements } = moves.json() as { movements: Array<{ type: string; toLabel: string | null }> };
    expect(movements[0]!.type).toBe("putaway");
    expect(movements[0]!.toLabel).toBe("FRONT-A9-R1-S1");
  });

  it("operations cannot create bins without warehouse.manage? (they can — ops has it); content editor cannot", async () => {
    const contentToken = await loginAs(world, "content@auction.test");
    const res = await world.server.app.inject({
      method: "POST",
      url: "/api/warehouse/locations",
      headers: auth(contentToken),
      payload: { zone: "BACK", aisle: "A1" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("pickup flow: kiosk check-in → pick → deliver → handover", () => {
  it("runs the full happy path with a live, PII-free board", async () => {
    const buyer = await registerBidder("flow_kris");
    const a = await paidOrder(buyer.accessToken, 20_000);
    const b = await paidOrder(buyer.accessToken, 5_000); // second order, same visit

    const [orderA] = await world.ctx.db.select().from(orders).where(eq(orders.id, a.orderId));
    const code = orderA!.pickupCode!;

    // A code that matches no active paid order is a 404.
    const wrongCode = code === "000000" ? "000001" : "000000";
    const bad = await world.server.app.inject({ method: "POST", url: "/api/public/pickup/checkin", payload: { code: wrongCode } });
    expect(bad.statusCode).toBe(404);
    expect((bad.json() as { error: string }).error).toBe("code_not_found");

    // Kiosk check-in bundles BOTH paid orders into one ticket.
    const checkin = await world.server.app.inject({ method: "POST", url: "/api/public/pickup/checkin", payload: { code } });
    expect(checkin.statusCode).toBe(200);
    const t1 = checkin.json() as { ticketNumber: number; lineCount: number; alreadyCheckedIn: boolean };
    expect(t1.ticketNumber).toBeGreaterThanOrEqual(100);
    expect(t1.lineCount).toBe(2);
    expect(t1.alreadyCheckedIn).toBe(false);

    // Idempotent: scanning again returns the same ticket.
    const again = await world.server.app.inject({ method: "POST", url: "/api/public/pickup/checkin", payload: { code } });
    expect((again.json() as { alreadyCheckedIn: boolean }).alreadyCheckedIn).toBe(true);
    expect((again.json() as { ticketNumber: number }).ticketNumber).toBe(t1.ticketNumber);

    // The public board shows the ticket — numbers and progress, zero PII.
    const board = await world.server.app.inject({ method: "GET", url: "/api/public/pickup/board" });
    const boardBody = board.body;
    expect(boardBody).toContain(String(t1.ticketNumber));
    expect(boardBody).not.toContain("@");
    expect(boardBody).not.toContain("flow_kris");
    expect(boardBody).not.toContain(code);

    // Worker: queue → claim → pick both lines → delivering → complete.
    const queue = await world.server.app.inject({ method: "GET", url: "/api/pickup/queue", headers: auth(opsToken) });
    const ticket = (queue.json() as { tickets: Array<{ id: string; number: number; lines: Array<{ id: string; itemId: string }> }> }).tickets.find(
      (t) => t.number === t1.ticketNumber,
    )!;
    expect(ticket.lines).toHaveLength(2);

    const claim = await world.server.app.inject({ method: "POST", url: `/api/pickup/tickets/${ticket.id}/claim`, headers: auth(opsToken) });
    expect(claim.statusCode).toBe(200);
    const [itemA] = await world.ctx.db.select().from(items).where(eq(items.id, a.itemId));
    expect(itemA!.status).toBe("picking");

    // Delivering before all lines are done is refused.
    const early = await world.server.app.inject({ method: "POST", url: `/api/pickup/tickets/${ticket.id}/delivering`, headers: auth(opsToken) });
    expect(early.statusCode).toBe(409);

    for (const line of ticket.lines) {
      const picked = await world.server.app.inject({
        method: "POST",
        url: `/api/pickup/tickets/${ticket.id}/lines/${line.id}`,
        headers: auth(opsToken),
        payload: { status: "picked" },
      });
      expect(picked.statusCode).toBe(200);
    }
    // Picking writes `pick` movements into the ledger.
    const movesA = await world.ctx.db.select().from(stockMovements).where(eq(stockMovements.itemId, a.itemId));
    expect(movesA.some((m) => m.type === "pick")).toBe(true);

    const deliver = await world.server.app.inject({ method: "POST", url: `/api/pickup/tickets/${ticket.id}/delivering`, headers: auth(opsToken) });
    expect(deliver.statusCode).toBe(200);

    // Handover requires the client's code: wrong → 403 + audited, right → done.
    const reject = await world.server.app.inject({
      method: "POST",
      url: `/api/pickup/tickets/${ticket.id}/complete`,
      headers: auth(opsToken),
      payload: { pickupCode: code === "999999" ? "999998" : "999999" },
    });
    expect(reject.statusCode).toBe(403);

    const done = await world.server.app.inject({
      method: "POST",
      url: `/api/pickup/tickets/${ticket.id}/complete`,
      headers: auth(opsToken),
      payload: { pickupCode: code },
    });
    expect(done.statusCode).toBe(200);

    const [itemA2] = await world.ctx.db.select().from(items).where(eq(items.id, a.itemId));
    const [itemB2] = await world.ctx.db.select().from(items).where(eq(items.id, b.itemId));
    expect(itemA2!.status).toBe("delivered");
    expect(itemB2!.status).toBe("delivered");
  });

  it("cancelling a ticket rolls items back to paid so the no-show clock keeps running", async () => {
    const buyer = await registerBidder("flow_quit");
    const { itemId, orderId } = await paidOrder(buyer.accessToken);
    const [order] = await world.ctx.db.select().from(orders).where(eq(orders.id, orderId));
    await world.server.app.inject({ method: "POST", url: "/api/public/pickup/checkin", payload: { code: order!.pickupCode! } });

    const queue = await world.server.app.inject({ method: "GET", url: "/api/pickup/queue", headers: auth(opsToken) });
    const ticket = (queue.json() as { tickets: Array<{ id: string; status: string; lines: Array<{ itemId: string }> }> }).tickets.find(
      (t) => t.status === "waiting" && t.lines.some((l) => l.itemId === itemId),
    )!;
    await world.server.app.inject({ method: "POST", url: `/api/pickup/tickets/${ticket.id}/claim`, headers: auth(opsToken) });
    const cancel = await world.server.app.inject({
      method: "POST",
      url: `/api/pickup/tickets/${ticket.id}/cancel`,
      headers: auth(opsToken),
      payload: { reason: "client had to leave" },
    });
    expect(cancel.statusCode).toBe(200);
    const [item] = await world.ctx.db.select().from(items).where(eq(items.id, itemId));
    expect(item!.status).toBe("paid");
  });
});

describe("no-show engine: reminders, 5% restock fee, strike, restock queue", () => {
  it("reminds inside the 3-day window exactly once per window", async () => {
    const buyer = await registerBidder("late_rita");
    const { orderId } = await paidOrder(buyer.accessToken);
    // Pull the deadline into the 3d window (but outside 1d).
    await world.ctx.db
      .update(orders)
      .set({ pickupDeadlineAt: new Date(world.ctx.now().getTime() + 2 * 86_400_000) })
      .where(eq(orders.id, orderId));

    await remindPickupDue(world.ctx);
    await remindPickupDue(world.ctx); // idempotent via dedupe key
    const mails = await world.ctx.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.customerId, buyer.bidder.id), eq(notifications.type, "pickup_reminder")));
    expect(mails).toHaveLength(1);
  });

  it("past the deadline: cancel + 5% fee + refund record + strike + manual restock to draft", async () => {
    const buyer = await registerBidder("gone_gary");
    const { orderId, itemId, totalCents } = await paidOrder(buyer.accessToken, 11_000); // total 13310
    expect(totalCents).toBe(13_310);

    // Warp past the 14-day deadline.
    world.setNow(new Date(Date.now() + 15 * 86_400_000));
    try {
      await cancelNoShowDue(world.ctx);

      const [order] = await world.ctx.db.select().from(orders).where(eq(orders.id, orderId));
      expect(order!.status).toBe("cancelled");
      expect(order!.cancelReason).toBe("no_pickup");
      expect(order!.restockFeeCents).toBe(666); // 5% of 13310, half-up

      const refundRows = await world.ctx.db.select().from(refunds).where(eq(refunds.orderId, orderId));
      expect(refundRows).toHaveLength(1);
      expect(refundRows[0]!.amountCents).toBe(12_644);
      expect(refundRows[0]!.actorId).toBeNull(); // system action

      const [cust] = await world.ctx.db.select().from(customers).where(eq(customers.id, buyer.bidder.id));
      expect(cust!.strikes).toBe(1);

      const [item] = await world.ctx.db.select().from(items).where(eq(items.id, itemId));
      expect(item!.status).toBe("no_pickup_cancelled");

      const mails = await world.ctx.db
        .select()
        .from(notifications)
        .where(and(eq(notifications.customerId, buyer.bidder.id), eq(notifications.type, "no_pickup_cancelled")));
      expect(mails).toHaveLength(1);
      expect(mails[0]!.body).toContain("6.66"); // fee
      expect(mails[0]!.body).toContain("126.44"); // refund

      // Running again changes nothing (order no longer 'paid').
      await cancelNoShowDue(world.ctx);
      const refundsAfter = await world.ctx.db.select().from(refunds).where(eq(refunds.orderId, orderId));
      expect(refundsAfter).toHaveLength(1);
    } finally {
      world.setNow(null);
    }

    // Manual restock review: operations returns the item to draft. Runs after
    // the clock is restored — access tokens expire inside the 15-day warp.
    const restock = await world.server.app.inject({
      method: "POST",
      url: `/api/items/${itemId}/transition`,
      headers: auth(opsToken),
      payload: { to: "draft" },
    });
    expect(restock.statusCode).toBe(200);
    const [restocked] = await world.ctx.db.select().from(items).where(eq(items.id, itemId));
    expect(restocked!.status).toBe("draft");
  });

  it("skips clients who are mid-pickup (item already picking)", async () => {
    const buyer = await registerBidder("mid_mila");
    const { orderId, itemId } = await paidOrder(buyer.accessToken);
    const [order] = await world.ctx.db.select().from(orders).where(eq(orders.id, orderId));
    await world.server.app.inject({ method: "POST", url: "/api/public/pickup/checkin", payload: { code: order!.pickupCode! } });
    const queue = await world.server.app.inject({ method: "GET", url: "/api/pickup/queue", headers: auth(opsToken) });
    const ticket = (queue.json() as { tickets: Array<{ id: string; status: string; lines: Array<{ itemId: string }> }> }).tickets.find(
      (t) => t.status === "waiting" && t.lines.some((l) => l.itemId === itemId),
    )!;
    await world.server.app.inject({ method: "POST", url: `/api/pickup/tickets/${ticket.id}/claim`, headers: auth(opsToken) });

    world.setNow(new Date(Date.now() + 15 * 86_400_000));
    try {
      await cancelNoShowDue(world.ctx);
      const [after] = await world.ctx.db.select().from(orders).where(eq(orders.id, orderId));
      expect(after!.status).toBe("paid"); // untouched — they're in the building
    } finally {
      world.setNow(null);
    }
  });
});

describe("RBAC on the pickup surface", () => {
  it("content editor can neither view the queue nor operate it", async () => {
    const contentToken = await loginAs(world, "content@auction.test");
    const view = await world.server.app.inject({ method: "GET", url: "/api/pickup/queue", headers: auth(contentToken) });
    expect(view.statusCode).toBe(403);
  });

  it("support can view the queue but not claim tickets", async () => {
    const supportToken = await loginAs(world, "support@auction.test");
    const view = await world.server.app.inject({ method: "GET", url: "/api/pickup/queue", headers: auth(supportToken) });
    expect(view.statusCode).toBe(200);
    const claim = await world.server.app.inject({
      method: "POST",
      url: "/api/pickup/tickets/00000000-0000-0000-0000-000000000000/claim",
      headers: auth(supportToken),
    });
    expect(claim.statusCode).toBe(403);
  });
});
