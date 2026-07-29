import { adminUsers, auditLog, items, orders, pickupTicketItems, pickupTickets, stockMovements, warehouseLocations, workerStatus } from "@auction/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createWorld, loginAs, type TestWorld } from "./helpers.js";

let world: TestWorld;
let adminToken: string; // super_admin — pickup.operate + warehouse.manage
let opsToken: string; // operations — pickup.operate + warehouse.manage
let superId: string;
let opsId: string;

beforeAll(async () => {
  world = await createWorld();
  adminToken = await loginAs(world, "super@auction.test");
  opsToken = await loginAs(world, "ops@auction.test");
  const [superRow] = await world.ctx.db.select().from(adminUsers).where(eq(adminUsers.email, "super@auction.test"));
  const [opsRow] = await world.ctx.db.select().from(adminUsers).where(eq(adminUsers.email, "ops@auction.test"));
  superId = superRow!.id;
  opsId = opsRow!.id;
});
afterAll(async () => {
  await world.close();
});

async function registerBidder(alias: string) {
  const res = await world.server.app.inject({
    method: "POST",
    url: "/api/public/auth/register",
    payload: { email: `${alias}@wops.test`, alias, password: "Bidder123!", country: "LV" },
  });
  return res.json() as { accessToken: string; bidder: { id: string } };
}

/** Fixed-price purchase → paid order (same deterministic path as pickup.test). */
async function paidOrder(buyerToken: string, priceCents = 10_000): Promise<{ orderId: string; itemId: string; pickupCode: string }> {
  const app = world.server.app;
  const sku = `WO-${Math.random().toString(36).slice(2, 9)}`;
  const item = await app.inject({ method: "POST", url: "/api/items", headers: auth(adminToken), payload: { sku, title: `WOps ${sku}`, marketCode: "LV" } });
  const itemId = (item.json() as { item: { id: string } }).item.id;
  const listing = await app.inject({
    method: "POST",
    url: "/api/listings",
    headers: auth(adminToken),
    payload: { itemId, type: "fixed", title: `WOps ${sku}`, marketCode: "LV", priceCents, quantity: 1 },
  });
  const listingId = (listing.json() as { listing: { id: string } }).listing.id;
  await app.inject({ method: "POST", url: `/api/listings/${listingId}/publish`, headers: auth(adminToken) });
  const buy = await app.inject({ method: "POST", url: `/api/public/listings/${listingId}/buy`, headers: auth(buyerToken) });
  expect(buy.statusCode).toBe(200);
  const { orderRef } = buy.json() as { orderRef: string };
  const [order] = await world.ctx.db.select().from(orders).where(eq(orders.ref, orderRef));
  const paid = await app.inject({ method: "POST", url: `/api/orders/${order!.id}/mark-paid`, headers: auth(opsToken) });
  expect(paid.statusCode).toBe(200);
  const [paidRow] = await world.ctx.db.select().from(orders).where(eq(orders.id, order!.id));
  return { orderId: order!.id, itemId, pickupCode: paidRow!.pickupCode! };
}

type QueueTicket = {
  id: string;
  number: number;
  status: string;
  claimedById: string | null;
  claimedByName: string | null;
  pickingStartedAt: string | null;
  passToId: string | null;
  passToName: string | null;
  passReason: string | null;
  lines: Array<{ id: string; itemId: string; status: string }>;
};

async function queueTicket(number: number): Promise<QueueTicket> {
  const res = await world.server.app.inject({ method: "GET", url: "/api/pickup/queue", headers: auth(opsToken) });
  expect(res.statusCode).toBe(200);
  const ticket = (res.json() as { tickets: QueueTicket[] }).tickets.find((t) => t.number === number);
  expect(ticket).toBeDefined();
  return ticket!;
}

/** Check a customer in via the kiosk and return the ticket from the queue. */
async function checkedInTicket(buyerToken: string, orderCount = 1): Promise<QueueTicket> {
  const codes: string[] = [];
  for (let i = 0; i < orderCount; i++) codes.push((await paidOrder(buyerToken)).pickupCode);
  const res = await world.server.app.inject({ method: "POST", url: "/api/public/pickup/checkin", payload: { code: codes[0] } });
  expect(res.statusCode).toBe(200);
  const { ticketNumber } = res.json() as { ticketNumber: number };
  return queueTicket(ticketNumber);
}

describe("worker status", () => {
  it("upserts today's row in place, lists it with the name, audits each change", async () => {
    const first = await world.server.app.inject({
      method: "POST",
      url: "/api/warehouse/status",
      headers: auth(opsToken),
      payload: { status: "working" },
    });
    expect(first.statusCode).toBe(200);

    const second = await world.server.app.inject({
      method: "POST",
      url: "/api/warehouse/status",
      headers: auth(opsToken),
      payload: { status: "coffee" },
    });
    expect(second.statusCode).toBe(200);

    // Upsert: still exactly one row for the (user, day) pair.
    const rows = await world.ctx.db.select().from(workerStatus).where(eq(workerStatus.userId, opsId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("coffee");

    const today = await world.server.app.inject({ method: "GET", url: "/api/warehouse/status/today", headers: auth(opsToken) });
    expect(today.statusCode).toBe(200);
    const { workers } = today.json() as {
      workers: Array<{ userId: string; name: string; status: string; sinceAt: string; currentTicketNumber: number | null }>;
    };
    const me = workers.find((w) => w.userId === opsId)!;
    expect(me.name.length).toBeGreaterThan(0);
    expect(me.status).toBe("coffee");
    expect(me.sinceAt).toBeTruthy();
    expect(me.currentTicketNumber).toBeNull();

    // Every change is audited (type pickup / action worker_status).
    const audits = await world.ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "worker_status"), eq(auditLog.actorId, opsId)));
    expect(audits).toHaveLength(2);
    expect(audits.map((a) => a.target).sort()).toEqual(["coffee", "working"]);

    // Rejects unknown statuses.
    const bad = await world.server.app.inject({
      method: "POST",
      url: "/api/warehouse/status",
      headers: auth(opsToken),
      payload: { status: "napping" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("requires warehouse.manage or pickup.operate", async () => {
    const contentToken = await loginAs(world, "content@auction.test");
    const post = await world.server.app.inject({
      method: "POST",
      url: "/api/warehouse/status",
      headers: auth(contentToken),
      payload: { status: "working" },
    });
    expect(post.statusCode).toBe(403);
    const get = await world.server.app.inject({ method: "GET", url: "/api/warehouse/status/today", headers: auth(contentToken) });
    expect(get.statusCode).toBe(403);
  });
});

describe("ticket handoff: pass back to the queue", () => {
  it("only the claimer may pass; reason is required; the ticket becomes claimable again", async () => {
    const buyer = await registerBidder("pass_queue");
    const ticket = await checkedInTicket(buyer.accessToken);
    const claim = await world.server.app.inject({ method: "POST", url: `/api/pickup/tickets/${ticket.id}/claim`, headers: auth(opsToken) });
    expect(claim.statusCode).toBe(200);

    // Reason shorter than 2 chars → 400.
    const noReason = await world.server.app.inject({
      method: "POST",
      url: `/api/pickup/tickets/${ticket.id}/pass`,
      headers: auth(opsToken),
      payload: { reason: "x" },
    });
    expect(noReason.statusCode).toBe(400);

    // Super admin has pickup.operate but is not the claimer → 403.
    const notClaimer = await world.server.app.inject({
      method: "POST",
      url: `/api/pickup/tickets/${ticket.id}/pass`,
      headers: auth(adminToken),
      payload: { reason: "taking over" },
    });
    expect(notClaimer.statusCode).toBe(403);
    expect((notClaimer.json() as { error: string }).error).toBe("not_claimer");

    const pass = await world.server.app.inject({
      method: "POST",
      url: `/api/pickup/tickets/${ticket.id}/pass`,
      headers: auth(opsToken),
      payload: { reason: "lunch break" },
    });
    expect(pass.statusCode).toBe(200);

    const after = await queueTicket(ticket.number);
    expect(after.status).toBe("waiting");
    expect(after.claimedById).toBeNull();
    expect(after.claimedByName).toBeNull();
    expect(after.pickingStartedAt).not.toBeNull(); // timer survives the pass
    expect(after.passToId).toBeNull();

    const audit = await world.ctx.db.select().from(auditLog).where(eq(auditLog.action, "ticket_passed_to_queue"));
    expect(audit).toHaveLength(1);
    expect((audit[0]!.detail as { reason: string }).reason).toBe("lunch break");

    // A colleague can now claim it (items are already `picking` — no error).
    const reclaim = await world.server.app.inject({ method: "POST", url: `/api/pickup/tickets/${ticket.id}/claim`, headers: auth(adminToken) });
    expect(reclaim.statusCode).toBe(200);
    const reclaimed = await queueTicket(ticket.number);
    expect(reclaimed.claimedById).toBe(superId);
  });
});

describe("ticket handoff: direct pass → accept / decline", () => {
  it("offers the ticket, keeps picked lines, and only the target may accept", async () => {
    const buyer = await registerBidder("pass_direct");
    const ticket = await checkedInTicket(buyer.accessToken, 2);
    expect(ticket.lines).toHaveLength(2);
    await world.server.app.inject({ method: "POST", url: `/api/pickup/tickets/${ticket.id}/claim`, headers: auth(opsToken) });

    // Ops (status row exists from the first suite) now shows as picking this ticket.
    const board = await world.server.app.inject({ method: "GET", url: "/api/warehouse/status/today", headers: auth(opsToken) });
    const { workers } = board.json() as { workers: Array<{ userId: string; currentTicketNumber: number | null }> };
    expect(workers.find((w) => w.userId === opsId)!.currentTicketNumber).toBe(ticket.number);

    // Pick the first line before handing off.
    const picked = await world.server.app.inject({
      method: "POST",
      url: `/api/pickup/tickets/${ticket.id}/lines/${ticket.lines[0]!.id}`,
      headers: auth(opsToken),
      payload: { status: "picked" },
    });
    expect(picked.statusCode).toBe(200);

    // Passing to an unknown admin is refused.
    const badTarget = await world.server.app.inject({
      method: "POST",
      url: `/api/pickup/tickets/${ticket.id}/pass`,
      headers: auth(opsToken),
      payload: { toUserId: "00000000-0000-0000-0000-000000000000", reason: "shift end" },
    });
    expect(badTarget.statusCode).toBe(422);

    const pass = await world.server.app.inject({
      method: "POST",
      url: `/api/pickup/tickets/${ticket.id}/pass`,
      headers: auth(opsToken),
      payload: { toUserId: superId, reason: "shift end" },
    });
    expect(pass.statusCode).toBe(200);

    // Ticket stays picking with the current claimer; the offer is visible.
    const offered = await queueTicket(ticket.number);
    expect(offered.status).toBe("picking");
    expect(offered.claimedById).toBe(opsId);
    expect(offered.claimedByName).toBeTruthy();
    expect(offered.passToId).toBe(superId);
    expect(offered.passToName).toBeTruthy();
    expect(offered.passReason).toBe("shift end");

    // Only the pass target may accept — the claimer itself cannot.
    const wrongAccept = await world.server.app.inject({ method: "POST", url: `/api/pickup/tickets/${ticket.id}/accept`, headers: auth(opsToken) });
    expect(wrongAccept.statusCode).toBe(403);

    const accept = await world.server.app.inject({ method: "POST", url: `/api/pickup/tickets/${ticket.id}/accept`, headers: auth(adminToken) });
    expect(accept.statusCode).toBe(200);

    const after = await queueTicket(ticket.number);
    expect(after.claimedById).toBe(superId);
    expect(after.passToId).toBeNull();
    expect(after.passReason).toBeNull();
    // The picked line carried over untouched.
    const lines = await world.ctx.db.select().from(pickupTicketItems).where(eq(pickupTicketItems.ticketId, ticket.id));
    expect(lines.filter((l) => l.status === "picked")).toHaveLength(1);

    const audit = await world.ctx.db.select().from(auditLog).where(eq(auditLog.action, "ticket_pass_accepted"));
    expect(audit).toHaveLength(1);
  });

  it("decline clears the offer and keeps the original claimer", async () => {
    const buyer = await registerBidder("pass_decline");
    const ticket = await checkedInTicket(buyer.accessToken);
    await world.server.app.inject({ method: "POST", url: `/api/pickup/tickets/${ticket.id}/claim`, headers: auth(opsToken) });
    await world.server.app.inject({
      method: "POST",
      url: `/api/pickup/tickets/${ticket.id}/pass`,
      headers: auth(opsToken),
      payload: { toUserId: superId, reason: "printer jam" },
    });

    // A bystander (not the pass target) cannot decline.
    const wrongDecline = await world.server.app.inject({ method: "POST", url: `/api/pickup/tickets/${ticket.id}/decline`, headers: auth(opsToken) });
    expect(wrongDecline.statusCode).toBe(403);

    const decline = await world.server.app.inject({ method: "POST", url: `/api/pickup/tickets/${ticket.id}/decline`, headers: auth(adminToken) });
    expect(decline.statusCode).toBe(200);

    const after = await queueTicket(ticket.number);
    expect(after.status).toBe("picking");
    expect(after.claimedById).toBe(opsId);
    expect(after.passToId).toBeNull();
    expect(after.passReason).toBeNull();

    const audit = await world.ctx.db.select().from(auditLog).where(eq(auditLog.action, "ticket_pass_declined"));
    expect(audit).toHaveLength(1);
    expect((audit[0]!.detail as { reason: string }).reason).toBe("printer jam");
  });
});

describe("pull from shelf + quarantine", () => {
  it("quarantine pull creates QUAR-01, moves the item, hides it from ready-to-list, and blocks publish", async () => {
    // A draft item put away on a normal shelf.
    const sku = `QQ-${Math.random().toString(36).slice(2, 9)}`;
    const created = await world.server.app.inject({
      method: "POST",
      url: "/api/items",
      headers: auth(adminToken),
      payload: { sku, title: `Quarantine ${sku}`, marketCode: "LV" },
    });
    const itemId = (created.json() as { item: { id: string } }).item.id;
    const loc = await world.server.app.inject({
      method: "POST",
      url: "/api/warehouse/locations",
      headers: auth(adminToken),
      payload: { zone: "BACK", aisle: "Q1", rack: "R1", shelf: "S1" },
    });
    const shelfId = (loc.json() as { location: { id: string } }).location.id;
    await world.server.app.inject({
      method: "POST",
      url: `/api/items/${itemId}/putaway`,
      headers: auth(opsToken),
      payload: { locationId: shelfId, reason: "intake" },
    });

    const pull = await world.server.app.inject({
      method: "POST",
      url: `/api/items/${itemId}/pull`,
      headers: auth(opsToken),
      payload: { reason: "damaged", note: "cracked screen", toQuarantine: true },
    });
    expect(pull.statusCode).toBe(200);

    // QUAR-01 exists in the QUARANTINE zone and now holds the item.
    const [quar] = await world.ctx.db.select().from(warehouseLocations).where(eq(warehouseLocations.label, "QUAR-01"));
    expect(quar).toBeDefined();
    expect(quar!.zone).toBe("QUARANTINE");
    const [item] = await world.ctx.db.select().from(items).where(eq(items.id, itemId));
    expect(item!.locationId).toBe(quar!.id);

    // The pull is ledgered (adjust, shelf → quarantine, tagged reason).
    const moves = await world.ctx.db.select().from(stockMovements).where(eq(stockMovements.itemId, itemId));
    const adjust = moves.find((m) => m.type === "adjust")!;
    expect(adjust.fromLocationId).toBe(shelfId);
    expect(adjust.toLocationId).toBe(quar!.id);
    expect(adjust.reason).toBe("pull:damaged — cracked screen");

    // Audited with the quarantine flag.
    const audit = await world.ctx.db.select().from(auditLog).where(and(eq(auditLog.action, "pulled"), eq(auditLog.target, sku)));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.detail).toMatchObject({ reason: "damaged", quarantine: true });

    // Hidden from the listing desk's ready-to-list feed…
    const ready = await world.server.app.inject({ method: "GET", url: "/api/items?status=draft", headers: auth(adminToken) });
    const readyIds = (ready.json() as { items: Array<{ id: string }> }).items.map((i) => i.id);
    expect(readyIds).not.toContain(itemId);

    // …and publish is a hard 409.
    const listing = await world.server.app.inject({
      method: "POST",
      url: "/api/listings",
      headers: auth(adminToken),
      payload: { itemId, type: "fixed", title: `Quarantine ${sku}`, marketCode: "LV", priceCents: 5_000 },
    });
    const listingId = (listing.json() as { listing: { id: string } }).listing.id;
    const publish = await world.server.app.inject({ method: "POST", url: `/api/listings/${listingId}/publish`, headers: auth(adminToken) });
    expect(publish.statusCode).toBe(409);
    expect((publish.json() as { error: string }).error).toBe("item_quarantined");

    // Second quarantine pull reuses the same bin (find-or-create).
    const other = await world.server.app.inject({
      method: "POST",
      url: "/api/items",
      headers: auth(adminToken),
      payload: { sku: `${sku}B`, title: "Second pull", marketCode: "LV" },
    });
    const otherId = (other.json() as { item: { id: string } }).item.id;
    const pull2 = await world.server.app.inject({
      method: "POST",
      url: `/api/items/${otherId}/pull`,
      headers: auth(opsToken),
      payload: { reason: "rephoto", toQuarantine: true },
    });
    expect(pull2.statusCode).toBe(200);
    const bins = await world.ctx.db.select().from(warehouseLocations).where(eq(warehouseLocations.label, "QUAR-01"));
    expect(bins).toHaveLength(1);
  });

  it("a plain pull (no quarantine) just empties the shelf", async () => {
    const sku = `QP-${Math.random().toString(36).slice(2, 9)}`;
    const created = await world.server.app.inject({
      method: "POST",
      url: "/api/items",
      headers: auth(adminToken),
      payload: { sku, title: `Plain pull ${sku}`, marketCode: "LV" },
    });
    const itemId = (created.json() as { item: { id: string } }).item.id;

    const pull = await world.server.app.inject({
      method: "POST",
      url: `/api/items/${itemId}/pull`,
      headers: auth(opsToken),
      payload: { reason: "recount" },
    });
    expect(pull.statusCode).toBe(200);
    const [item] = await world.ctx.db.select().from(items).where(eq(items.id, itemId));
    expect(item!.locationId).toBeNull();
    // Still listable: it shows up in ready-to-list.
    const ready = await world.server.app.inject({ method: "GET", url: "/api/items?status=draft", headers: auth(adminToken) });
    expect((ready.json() as { items: Array<{ id: string }> }).items.map((i) => i.id)).toContain(itemId);
  });

  it("requires warehouse.manage", async () => {
    const supportToken = await loginAs(world, "support@auction.test");
    const res = await world.server.app.inject({
      method: "POST",
      url: "/api/items/00000000-0000-0000-0000-000000000000/pull",
      headers: auth(supportToken),
      payload: { reason: "other" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("TV board progress", () => {
  it("exposes pickedCount/totalCount per ticket — numbers only", async () => {
    const buyer = await registerBidder("board_bars");
    const ticket = await checkedInTicket(buyer.accessToken, 2);
    await world.server.app.inject({ method: "POST", url: `/api/pickup/tickets/${ticket.id}/claim`, headers: auth(opsToken) });
    await world.server.app.inject({
      method: "POST",
      url: `/api/pickup/tickets/${ticket.id}/lines/${ticket.lines[0]!.id}`,
      headers: auth(opsToken),
      payload: { status: "picked" },
    });

    const board = await world.server.app.inject({ method: "GET", url: "/api/public/pickup/board" });
    expect(board.statusCode).toBe(200);
    const payload = board.json() as { tickets: Array<{ number: number; pickedCount: number; totalCount: number }> };
    const row = payload.tickets.find((t) => t.number === ticket.number)!;
    expect(row.pickedCount).toBe(1);
    expect(row.totalCount).toBe(2);
    // Still PII-free.
    expect(board.body).not.toContain("@");
    expect(board.body).not.toContain("board_bars");
  });
});

describe("check-in publishes an admin event", () => {
  it("pushes pickup_checkin over the admin channel", async () => {
    const { Redis } = await import("ioredis");
    const sub = new Redis(world.ctx.config.redisUrl);
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    await sub.subscribe("admin:events");
    sub.on("message", (_ch, msg) => events.push(JSON.parse(msg) as { type: string; data: Record<string, unknown> }));

    try {
      const buyer = await registerBidder("event_evie");
      const { pickupCode } = await paidOrder(buyer.accessToken);
      const res = await world.server.app.inject({ method: "POST", url: "/api/public/pickup/checkin", payload: { code: pickupCode } });
      expect(res.statusCode).toBe(200);
      const { ticketNumber } = res.json() as { ticketNumber: number };
      const [ticket] = await world.ctx.db
        .select()
        .from(pickupTickets)
        .where(and(eq(pickupTickets.number, ticketNumber), eq(pickupTickets.status, "waiting")));

      // Pub/sub delivery is async — poll briefly.
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline && !events.some((e) => e.type === "pickup_checkin")) {
        await new Promise((r) => setTimeout(r, 25));
      }
      const ev = events.find((e) => e.type === "pickup_checkin")!;
      expect(ev).toBeDefined();
      expect(ev.data).toMatchObject({ ticketId: ticket!.id, number: ticketNumber });
    } finally {
      await sub.quit().catch(() => undefined);
    }
  });
});
