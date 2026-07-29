import { adminUsers, auditLog, items, pickupTicketItems, pickupTickets, stockMovements, warehouseLocations } from "@auction/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createWorld, loginAs, type TestWorld } from "./helpers.js";

/**
 * W3 — productivity stats + bin browser. All fixtures are written with
 * explicit timestamps on one fixed day so the aggregates are deterministic.
 */

let world: TestWorld;
let adminToken: string; // super_admin — has stats.view
let opsToken: string; // operations — deliberately NOT granted stats.view
let superId: string;
let opsId: string;

const DAY = "2026-03-10";
const at = (h: number, m: number) => new Date(`${DAY}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`);

beforeAll(async () => {
  world = await createWorld();
  world.setNow(at(17, 0)); // freeze "now" at end of the working day
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

async function insertItem(sku: string, extra: Partial<typeof items.$inferInsert> = {}): Promise<string> {
  const [row] = await world.ctx.db
    .insert(items)
    .values({ sku, title: `Stats ${sku}`, marketCode: "LV", ...extra })
    .returning({ id: items.id });
  return row!.id;
}

const move = (itemId: string, type: string, actor: { id: string; name: string } | null, createdAt: Date, toLocationId: string | null = null) =>
  world.ctx.db.insert(stockMovements).values({
    itemId,
    type,
    actorId: actor?.id ?? null,
    actorLabel: actor?.name ?? "System",
    toLocationId,
    createdAt,
  });

const statusChange = (actorId: string, status: string, createdAt: Date) =>
  world.ctx.db.insert(auditLog).values({ actorId, actorLabel: "x", type: "pickup", action: "worker_status", target: status, createdAt });

describe("warehouse stats", () => {
  let binId: string;

  beforeAll(async () => {
    const app = world.server.app;
    const ops = { id: opsId, name: "Ops" };
    const sup = { id: superId, name: "Super" };

    const bin = await app.inject({
      method: "POST",
      url: "/api/warehouse/locations",
      headers: auth(adminToken),
      payload: { zone: "STATS", aisle: "A1", rack: "R1", shelf: "S1", capacity: 2 },
    });
    expect(bin.statusCode).toBe(200);
    binId = (bin.json() as { location: { id: string } }).location.id;

    // Ops: 2 intakes, 1 putaway, 1 grade. Super: 1 intake. System: 1 intake
    // (must be excluded from every number).
    const i1 = await insertItem("ST-001");
    const i2 = await insertItem("ST-002");
    const i3 = await insertItem("ST-003", { gradedById: opsId, gradedAt: at(8, 26), condition: "used_good" });
    const i4 = await insertItem("ST-004");
    await move(i1, "intake", ops, at(8, 11));
    await move(i2, "intake", ops, at(8, 12));
    await move(i1, "putaway", ops, at(8, 14), binId);
    await move(i3, "intake", sup, at(9, 0));
    await move(i4, "intake", null, at(9, 30));
    await world.ctx.db.update(items).set({ locationId: binId }).where(eq(items.id, i1));

    // One completed pickup ticket claimed by ops: 10 min pick, one picked line.
    const bidder = await app.inject({
      method: "POST",
      url: "/api/public/auth/register",
      payload: { email: "stats@wstats.test", alias: "statsbuyer", password: "Bidder123!", country: "LV" },
    });
    expect(bidder.statusCode).toBe(200);
    const buyerToken = (bidder.json() as { accessToken: string }).accessToken;

    const itemRes = await app.inject({ method: "POST", url: "/api/items", headers: auth(adminToken), payload: { sku: "ST-BUY", title: "Stats buy", marketCode: "LV" } });
    const buyItemId = (itemRes.json() as { item: { id: string } }).item.id;
    const listing = await app.inject({
      method: "POST",
      url: "/api/listings",
      headers: auth(adminToken),
      payload: { itemId: buyItemId, type: "fixed", title: "Stats buy", marketCode: "LV", priceCents: 5_000, quantity: 1 },
    });
    const listingId = (listing.json() as { listing: { id: string } }).listing.id;
    await app.inject({ method: "POST", url: `/api/listings/${listingId}/publish`, headers: auth(adminToken) });
    const buy = await app.inject({ method: "POST", url: `/api/public/listings/${listingId}/buy`, headers: auth(buyerToken) });
    expect(buy.statusCode).toBe(200);
    const { orderRef } = buy.json() as { orderRef: string };
    const { orders } = await import("@auction/db");
    const [order] = await world.ctx.db.select().from(orders).where(eq(orders.ref, orderRef));
    await app.inject({ method: "POST", url: `/api/orders/${order!.id}/mark-paid`, headers: auth(opsToken) });
    const [paidRow] = await world.ctx.db.select().from(orders).where(eq(orders.id, order!.id));
    const checkin = await app.inject({ method: "POST", url: "/api/public/pickup/checkin", payload: { code: paidRow!.pickupCode } });
    expect(checkin.statusCode).toBe(200);

    // Backdate the ticket into a completed 09:40→09:50 pick by ops.
    const [ticket] = await world.ctx.db.select().from(pickupTickets).where(eq(pickupTickets.customerId, order!.customerId));
    await world.ctx.db
      .update(pickupTickets)
      .set({ status: "completed", claimedById: opsId, pickingStartedAt: at(9, 40), completedAt: at(9, 50) })
      .where(eq(pickupTickets.id, ticket!.id));
    await world.ctx.db
      .update(pickupTicketItems)
      .set({ status: "picked", pickedById: opsId, pickedAt: at(9, 45) })
      .where(eq(pickupTicketItems.ticketId, ticket!.id));

    // Ops status log: working 08:00 → coffee 10:00 → working 10:15 = 15 min break.
    await statusChange(opsId, "working", at(8, 0));
    await statusChange(opsId, "coffee", at(10, 0));
    await statusChange(opsId, "working", at(10, 15));
  });

  it("is manager-only: operations role gets 403", async () => {
    const res = await world.server.app.inject({ method: "GET", url: `/api/warehouse/stats?from=${DAY}&to=${DAY}`, headers: auth(opsToken) });
    expect(res.statusCode).toBe(403);
    const tl = await world.server.app.inject({ method: "GET", url: `/api/warehouse/stats/timeline?userId=${opsId}&day=${DAY}`, headers: auth(opsToken) });
    expect(tl.statusCode).toBe(403);
  });

  it("rejects a backwards range", async () => {
    const res = await world.server.app.inject({ method: "GET", url: "/api/warehouse/stats?from=2026-03-10&to=2026-03-09", headers: auth(adminToken) });
    expect(res.statusCode).toBe(400);
  });

  it("aggregates per worker, excludes the scheduler, computes breaks from the status log", async () => {
    const res = await world.server.app.inject({ method: "GET", url: `/api/warehouse/stats?from=${DAY}&to=${DAY}`, headers: auth(adminToken) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      totals: { received: number; putaways: number; graded: number; picks: number; ticketsClosed: number; avgPickSec: number | null };
      prev: { received: number };
      workers: Array<{ userId: string; name: string; received: number; putaway: number; graded: number; picks: number; tickets: number; avgPickSec: number | null; picksPerHour: number | null; breakSec: number }>;
      byDay: Array<{ day: string; received: number; putaway: number; picks: number; graded: number }>;
    };

    // System's intake is invisible: 2 (ops) + 1 (super) = 3, not 4.
    expect(body.totals.received).toBe(3);
    expect(body.totals.putaways).toBe(1);
    expect(body.totals.graded).toBe(1);
    expect(body.totals.picks).toBe(1);
    expect(body.totals.ticketsClosed).toBe(1);
    expect(body.totals.avgPickSec).toBe(600);
    expect(body.prev.received).toBe(0);

    const ops = body.workers.find((w) => w.userId === opsId)!;
    expect(ops.received).toBe(2);
    expect(ops.putaway).toBe(1);
    expect(ops.graded).toBe(1);
    expect(ops.picks).toBe(1);
    expect(ops.tickets).toBe(1);
    expect(ops.avgPickSec).toBe(600);
    expect(ops.breakSec).toBe(15 * 60);
    // Span 08:11→09:45 minus the 15 min break = 79 min active → 0.8 picks/hr.
    expect(ops.picksPerHour).toBe(0.8);

    const sup = body.workers.find((w) => w.userId === superId)!;
    expect(sup.received).toBe(1);
    // A single action has no measurable span — the rate must be null, not ∞.
    expect(sup.picksPerHour).toBeNull();

    expect(body.workers.some((w) => w.name === "System")).toBe(false);

    const day = body.byDay.find((d) => d.day === DAY)!;
    expect(day.received).toBe(3);
    expect(day.putaway).toBe(1);
    expect(day.picks).toBe(1);
    expect(day.graded).toBe(1);
  });

  it("returns one worker's day as a chronological timeline", async () => {
    const res = await world.server.app.inject({
      method: "GET",
      url: `/api/warehouse/stats/timeline?userId=${opsId}&day=${DAY}`,
      headers: auth(adminToken),
    });
    expect(res.statusCode).toBe(200);
    const { entries, name } = res.json() as { name: string; entries: Array<{ at: string; kind: string; sku?: string; detail?: string }> };
    expect(name.length).toBeGreaterThan(0);

    const kinds = entries.map((e) => e.kind);
    for (const k of ["intake", "putaway", "grade", "pick", "ticket_done", "status"]) expect(kinds).toContain(k);
    // Strictly chronological.
    const times = entries.map((e) => e.at);
    expect([...times].sort()).toEqual(times);
    // The putaway carries the bin label, the pick its ticket number.
    expect(entries.find((e) => e.kind === "putaway")!.detail).toBe("STATS-A1-R1-S1");
    expect(entries.find((e) => e.kind === "pick")!.detail).toMatch(/^#\d+/);
    expect(entries.find((e) => e.kind === "ticket_done")!.detail).toContain("10 min");
  });

  it("browses bins with counts, capacity, and last activity — open to warehouse roles", async () => {
    const res = await world.server.app.inject({ method: "GET", url: "/api/warehouse/bins", headers: auth(opsToken) });
    expect(res.statusCode).toBe(200);
    const { bins } = res.json() as {
      bins: Array<{ id: string; label: string; capacity: number | null; itemCount: number; lastActivity: { type: string; actorLabel: string; at: string } | null }>;
    };
    const bin = bins.find((b) => b.id === binId)!;
    expect(bin.label).toBe("STATS-A1-R1-S1");
    expect(bin.capacity).toBe(2);
    expect(bin.itemCount).toBe(1);
    expect(bin.lastActivity).not.toBeNull();
    expect(bin.lastActivity!.type).toBe("putaway");
    expect(bin.lastActivity!.actorLabel).toBe("Ops");
    // Seeded bins with no movements report null activity, zero items.
    const seeded = bins.find((b) => b.label === "FRONT-A1-R1-S1")!;
    expect(seeded.itemCount).toBe(0);
    expect(seeded.lastActivity).toBeNull();
  });

  it("returns one bin's contents and in/out activity", async () => {
    const res = await world.server.app.inject({ method: "GET", url: `/api/warehouse/bins/${binId}`, headers: auth(opsToken) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      bin: { label: string };
      contents: Array<{ sku: string; sinceAt: string }>;
      activity: Array<{ sku: string; type: string; inbound: boolean }>;
    };
    expect(body.contents).toHaveLength(1);
    expect(body.contents[0]!.sku).toBe("ST-001");
    expect(body.contents[0]!.sinceAt).toBe(at(8, 14).toISOString());
    expect(body.activity.some((a) => a.sku === "ST-001" && a.type === "putaway" && a.inbound)).toBe(true);

    const missing = await world.server.app.inject({ method: "GET", url: `/api/warehouse/bins/${opsId}`, headers: auth(opsToken) });
    expect(missing.statusCode).toBe(404);
  });

  it("edits capacity through the locations PATCH", async () => {
    const res = await world.server.app.inject({
      method: "PATCH",
      url: `/api/warehouse/locations/${binId}`,
      headers: auth(adminToken),
      payload: { capacity: 5 },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { location: { capacity: number | null } }).location.capacity).toBe(5);

    const cleared = await world.server.app.inject({
      method: "PATCH",
      url: `/api/warehouse/locations/${binId}`,
      headers: auth(adminToken),
      payload: { capacity: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect((cleared.json() as { location: { capacity: number | null } }).location.capacity).toBeNull();

    const [row] = await world.ctx.db.select().from(warehouseLocations).where(eq(warehouseLocations.id, binId));
    expect(row!.capacity).toBeNull();
  });
});
