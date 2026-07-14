import { randomInt } from "node:crypto";
import {
  counters,
  customers,
  items,
  orders,
  pickupTicketItems,
  pickupTickets,
  stockMovements,
  warehouseLocations,
  type Db,
} from "@auction/db";
import {
  assertItemTransition,
  assertTicketTransition,
  canTransitionItem,
  computePickProgress,
  dayKey,
  DEFAULT_PICK_SECONDS_PER_LINE,
  isTerminalPickLine,
  ticketNumberFromCounter,
  updateAvgPickSeconds,
  type ItemStatus,
  type PickLineStatus,
  type TicketStatus,
} from "@auction/domain";
import { and, eq, inArray, sql } from "drizzle-orm";
import { writeAudit, SYSTEM_ACTOR, type Actor } from "../audit.js";
import { BOARD_CHANNEL, type AppContext } from "../context.js";

/**
 * Pickup engine: check-in → ticket → pick → deliver → handover, plus the
 * waiting-room board payloads. Every mutation runs in one transaction and
 * republishes the board over Redis pub/sub → WebSocket.
 */

const ACTIVE_TICKET_STATUSES = ["waiting", "picking", "delivering"] as const;
const AVG_PICK_KEY = "pickup:avg_sec_per_line";

// ── Pickup codes ─────────────────────────────────────────────────────────────

/** 6-digit collection credential; regenerated on the rare active collision. */
export async function generatePickupCode(db: Db): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const [clash] = await db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.pickupCode, code), eq(orders.status, "paid")))
      .limit(1);
    if (!clash) return code;
  }
  throw new Error("could not allocate a unique pickup code");
}

// ── Board payload (PII-free by construction) ─────────────────────────────────

export interface BoardTicket {
  number: number;
  status: TicketStatus;
  /** 0..100 picked. */
  pct: number;
  etaSec: number;
  front: number;
  back: number;
}

export async function buildBoardPayload(ctx: AppContext): Promise<{ type: "board"; at: string; tickets: BoardTicket[] }> {
  const today = dayKey(ctx.now());
  const ticketRows = await ctx.db
    .select()
    .from(pickupTickets)
    .where(and(eq(pickupTickets.dayKey, today), inArray(pickupTickets.status, [...ACTIVE_TICKET_STATUSES])))
    .orderBy(pickupTickets.checkedInAt);

  const avgRaw = await ctx.redis.get(AVG_PICK_KEY);
  const avg = avgRaw ? Number(avgRaw) : DEFAULT_PICK_SECONDS_PER_LINE;

  const tickets: BoardTicket[] = [];
  for (const t of ticketRows) {
    const lines = await ctx.db
      .select({ status: pickupTicketItems.status, zone: warehouseLocations.zone })
      .from(pickupTicketItems)
      .leftJoin(items, eq(pickupTicketItems.itemId, items.id))
      .leftJoin(warehouseLocations, eq(items.locationId, warehouseLocations.id))
      .where(eq(pickupTicketItems.ticketId, t.id));
    const progress = computePickProgress(lines.map((l) => l.status as PickLineStatus), avg);
    tickets.push({
      number: t.number,
      status: t.status as TicketStatus,
      pct: progress.pct,
      etaSec: t.status === "waiting" ? progress.total * Math.max(1, avg) : progress.etaSec,
      front: lines.filter((l) => l.zone === "FRONT").length,
      back: lines.filter((l) => l.zone === "BACK").length,
    });
  }
  return { type: "board", at: ctx.now().toISOString(), tickets };
}

export async function publishBoard(ctx: AppContext): Promise<void> {
  const payload = await buildBoardPayload(ctx);
  await ctx.redis.publish(BOARD_CHANNEL, JSON.stringify(payload));
}

// ── Check-in ─────────────────────────────────────────────────────────────────

export type CheckInResult =
  | { ok: true; ticketId: string; number: number; alreadyCheckedIn: boolean; lineCount: number }
  | { ok: false; error: "code_not_found" | "nothing_to_collect" };

/** Kiosk path: the 6-digit code on the client's pickup pass is the credential. */
export async function checkInByCode(ctx: AppContext, code: string, via: "kiosk" | "desk", actor?: Actor): Promise<CheckInResult> {
  const [order] = await ctx.db
    .select({ customerId: orders.customerId })
    .from(orders)
    .where(and(eq(orders.pickupCode, code), eq(orders.status, "paid")))
    .limit(1);
  if (!order) return { ok: false, error: "code_not_found" };
  return checkInCustomer(ctx, order.customerId, via, actor);
}

/**
 * Create (or return) the customer's active ticket bundling every paid,
 * uncollected order. Idempotent: re-scanning the pass returns the same
 * ticket instead of minting a duplicate number.
 */
export async function checkInCustomer(ctx: AppContext, customerId: string, via: "kiosk" | "desk", actor?: Actor): Promise<CheckInResult> {
  const result = await ctx.db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(pickupTickets)
      .where(and(eq(pickupTickets.customerId, customerId), inArray(pickupTickets.status, [...ACTIVE_TICKET_STATUSES])))
      .limit(1);
    if (existing) {
      const lines = await tx.select({ id: pickupTicketItems.id }).from(pickupTicketItems).where(eq(pickupTicketItems.ticketId, existing.id));
      return { ok: true as const, ticketId: existing.id, number: existing.number, alreadyCheckedIn: true, lineCount: lines.length };
    }

    // Collectable = paid order whose item is still sitting in the warehouse.
    const collectable = await tx
      .select({ orderId: orders.id, itemId: orders.itemId, itemStatus: items.status })
      .from(orders)
      .innerJoin(items, eq(orders.itemId, items.id))
      .where(and(eq(orders.customerId, customerId), eq(orders.status, "paid"), eq(items.status, "paid")));
    if (collectable.length === 0) return { ok: false as const, error: "nothing_to_collect" as const };

    // Daily board number via the counters row lock (same pattern as invoices).
    const today = dayKey(ctx.now());
    const counterKey = `pickup:${today}`;
    await tx.insert(counters).values({ key: counterKey, value: 0 }).onConflictDoNothing();
    const [counter] = await tx
      .update(counters)
      .set({ value: sql`${counters.value} + 1` })
      .where(eq(counters.key, counterKey))
      .returning({ value: counters.value });
    const number = ticketNumberFromCounter(counter!.value);

    const [ticket] = await tx
      .insert(pickupTickets)
      .values({ number, dayKey: today, customerId, checkedInVia: via, checkedInAt: ctx.now() })
      .returning();
    for (const c of collectable) {
      await tx.insert(pickupTicketItems).values({ ticketId: ticket!.id, orderId: c.orderId, itemId: c.itemId });
    }
    await writeAudit(tx, actor ?? SYSTEM_ACTOR, "pickup", "checked_in", `#${number}`, {
      ticketId: ticket!.id,
      via,
      orders: collectable.length,
    });
    return { ok: true as const, ticketId: ticket!.id, number, alreadyCheckedIn: false, lineCount: collectable.length };
  });
  if (result.ok) await publishBoard(ctx);
  return result;
}

// ── Worker actions ───────────────────────────────────────────────────────────

export type TicketActionResult = { ok: true } | { ok: false; error: string };

export async function claimTicket(ctx: AppContext, ticketId: string, actor: Actor): Promise<TicketActionResult> {
  const result = await ctx.db.transaction(async (tx): Promise<TicketActionResult> => {
    const [ticket] = await tx.select().from(pickupTickets).where(eq(pickupTickets.id, ticketId)).for("update");
    if (!ticket) return { ok: false, error: "not_found" };
    assertTicketTransition(ticket.status as TicketStatus, "picking");
    const lines = await tx.select().from(pickupTicketItems).where(eq(pickupTicketItems.ticketId, ticketId));
    for (const line of lines) {
      const [item] = await tx.select().from(items).where(eq(items.id, line.itemId)).for("update");
      assertItemTransition(item!.status as ItemStatus, "picking");
      await tx.update(items).set({ status: "picking", updatedAt: ctx.now() }).where(eq(items.id, line.itemId));
    }
    await tx
      .update(pickupTickets)
      .set({ status: "picking", claimedById: actor.id, pickingStartedAt: ctx.now() })
      .where(eq(pickupTickets.id, ticketId));
    await writeAudit(tx, actor, "pickup", "claimed", `#${ticket.number}`, { ticketId });
    return { ok: true };
  });
  if (result.ok) await publishBoard(ctx);
  return result;
}

/** Check a line off (picked) or flag it (missing/damaged). Picking an item
 * empties its bin: location cleared + a `pick` movement in the ledger. */
export async function setLineStatus(
  ctx: AppContext,
  ticketId: string,
  lineId: string,
  status: Exclude<PickLineStatus, "pending">,
  actor: Actor,
): Promise<TicketActionResult> {
  const result = await ctx.db.transaction(async (tx): Promise<TicketActionResult> => {
    const [ticket] = await tx.select().from(pickupTickets).where(eq(pickupTickets.id, ticketId)).for("update");
    if (!ticket) return { ok: false, error: "not_found" };
    if (ticket.status !== "picking") return { ok: false, error: "ticket_not_picking" };
    const [line] = await tx
      .select()
      .from(pickupTicketItems)
      .where(and(eq(pickupTicketItems.id, lineId), eq(pickupTicketItems.ticketId, ticketId)))
      .for("update");
    if (!line) return { ok: false, error: "line_not_found" };
    if (line.status !== "pending") return { ok: false, error: "line_already_done" };

    await tx
      .update(pickupTicketItems)
      .set({ status, pickedAt: ctx.now(), pickedById: actor.id })
      .where(eq(pickupTicketItems.id, lineId));

    if (status === "picked") {
      const [item] = await tx.select().from(items).where(eq(items.id, line.itemId)).for("update");
      await tx.insert(stockMovements).values({
        itemId: line.itemId,
        type: "pick",
        fromLocationId: item!.locationId,
        toLocationId: null,
        actorId: actor.id,
        actorLabel: actor.label,
        reason: `pickup ticket #${ticket.number}`,
      });
      await tx.update(items).set({ locationId: null, updatedAt: ctx.now() }).where(eq(items.id, line.itemId));
    } else {
      // Exceptions are loud: support resolves the flagged line afterwards.
      await writeAudit(tx, actor, "pickup", `line_${status}`, `#${ticket.number}`, { ticketId, itemId: line.itemId });
    }
    return { ok: true };
  });
  if (result.ok) await publishBoard(ctx);
  return result;
}

export async function markDelivering(ctx: AppContext, ticketId: string, actor: Actor): Promise<TicketActionResult> {
  const result = await ctx.db.transaction(async (tx): Promise<TicketActionResult> => {
    const [ticket] = await tx.select().from(pickupTickets).where(eq(pickupTickets.id, ticketId)).for("update");
    if (!ticket) return { ok: false, error: "not_found" };
    assertTicketTransition(ticket.status as TicketStatus, "delivering");
    const lines = await tx.select().from(pickupTicketItems).where(eq(pickupTicketItems.ticketId, ticketId));
    if (lines.some((l) => !isTerminalPickLine(l.status as PickLineStatus))) return { ok: false, error: "lines_pending" };
    await tx.update(pickupTickets).set({ status: "delivering", deliveringAt: ctx.now() }).where(eq(pickupTickets.id, ticketId));
    await writeAudit(tx, actor, "pickup", "delivering", `#${ticket.number}`, { ticketId });
    return { ok: true };
  });
  if (result.ok) {
    // Feed the rolling ETA average with this ticket's observed pick pace.
    const [ticket] = await ctx.db.select().from(pickupTickets).where(eq(pickupTickets.id, ticketId));
    if (ticket?.pickingStartedAt && ticket.deliveringAt) {
      const lines = await ctx.db.select({ id: pickupTicketItems.id }).from(pickupTicketItems).where(eq(pickupTicketItems.ticketId, ticketId));
      if (lines.length > 0) {
        const observed = (ticket.deliveringAt.getTime() - ticket.pickingStartedAt.getTime()) / 1000 / lines.length;
        const avgRaw = await ctx.redis.get(AVG_PICK_KEY);
        const avg = avgRaw ? Number(avgRaw) : DEFAULT_PICK_SECONDS_PER_LINE;
        await ctx.redis.set(AVG_PICK_KEY, String(updateAvgPickSeconds(avg, observed)));
      }
    }
    await publishBoard(ctx);
  }
  return result;
}

/**
 * Counter handover. The client proves ownership with the 6-digit pickup code
 * from their pass (any order on the ticket matches). Picked items are handed
 * over → `delivered`; missing/damaged lines stay flagged for support.
 */
export async function completeTicket(ctx: AppContext, ticketId: string, code: string, actor: Actor): Promise<TicketActionResult> {
  const result = await ctx.db.transaction(async (tx): Promise<TicketActionResult> => {
    const [ticket] = await tx.select().from(pickupTickets).where(eq(pickupTickets.id, ticketId)).for("update");
    if (!ticket) return { ok: false, error: "not_found" };
    assertTicketTransition(ticket.status as TicketStatus, "completed");

    const lines = await tx.select().from(pickupTicketItems).where(eq(pickupTicketItems.ticketId, ticketId));
    const lineOrders = await tx
      .select({ id: orders.id, pickupCode: orders.pickupCode })
      .from(orders)
      .where(inArray(orders.id, lines.map((l) => l.orderId)));
    if (!lineOrders.some((o) => o.pickupCode !== null && o.pickupCode === code)) {
      await writeAudit(tx, actor, "pickup", "handover_code_rejected", `#${ticket.number}`, { ticketId });
      return { ok: false, error: "invalid_pickup_code" };
    }

    for (const line of lines.filter((l) => l.status === "picked")) {
      const [item] = await tx.select().from(items).where(eq(items.id, line.itemId)).for("update");
      assertItemTransition(item!.status as ItemStatus, "delivered");
      await tx.update(items).set({ status: "delivered", updatedAt: ctx.now() }).where(eq(items.id, line.itemId));
      await tx.insert(stockMovements).values({
        itemId: line.itemId,
        type: "handover",
        fromLocationId: null,
        toLocationId: null,
        actorId: actor.id,
        actorLabel: actor.label,
        reason: `pickup ticket #${ticket.number}`,
      });
    }
    await tx.update(pickupTickets).set({ status: "completed", completedAt: ctx.now() }).where(eq(pickupTickets.id, ticketId));
    await writeAudit(tx, actor, "pickup", "completed", `#${ticket.number}`, {
      ticketId,
      handedOver: lines.filter((l) => l.status === "picked").length,
      flagged: lines.filter((l) => l.status === "missing" || l.status === "damaged").length,
    });
    return { ok: true };
  });
  if (result.ok) await publishBoard(ctx);
  return result;
}

/** Client left / desk error: roll items back to `paid` so the no-show clock
 * keeps running. Already-picked items lose their bin and surface in the
 * "needs putaway" filter until a worker returns them to a shelf. */
export async function cancelTicket(ctx: AppContext, ticketId: string, reason: string, actor: Actor): Promise<TicketActionResult> {
  const result = await ctx.db.transaction(async (tx): Promise<TicketActionResult> => {
    const [ticket] = await tx.select().from(pickupTickets).where(eq(pickupTickets.id, ticketId)).for("update");
    if (!ticket) return { ok: false, error: "not_found" };
    assertTicketTransition(ticket.status as TicketStatus, "cancelled");
    const lines = await tx.select().from(pickupTicketItems).where(eq(pickupTicketItems.ticketId, ticketId));
    for (const line of lines) {
      const [item] = await tx.select().from(items).where(eq(items.id, line.itemId)).for("update");
      if (canTransitionItem(item!.status as ItemStatus, "paid") && item!.status === "picking") {
        await tx.update(items).set({ status: "paid", updatedAt: ctx.now() }).where(eq(items.id, line.itemId));
      }
    }
    await tx
      .update(pickupTickets)
      .set({ status: "cancelled", cancelledAt: ctx.now(), cancelReason: reason })
      .where(eq(pickupTickets.id, ticketId));
    await writeAudit(tx, actor, "pickup", "cancelled", `#${ticket.number}`, { ticketId, reason });
    return { ok: true };
  });
  if (result.ok) await publishBoard(ctx);
  return result;
}

// ── Queue view for the admin Pickup screen ───────────────────────────────────

export async function ticketQueue(ctx: AppContext): Promise<unknown[]> {
  const today = dayKey(ctx.now());
  const ticketRows = await ctx.db
    .select({ ticket: pickupTickets, customerAlias: customers.alias, customerEmail: customers.email })
    .from(pickupTickets)
    .innerJoin(customers, eq(pickupTickets.customerId, customers.id))
    .where(eq(pickupTickets.dayKey, today))
    .orderBy(pickupTickets.checkedInAt);

  const out: unknown[] = [];
  for (const row of ticketRows) {
    const lines = await ctx.db
      .select({
        id: pickupTicketItems.id,
        status: pickupTicketItems.status,
        orderId: pickupTicketItems.orderId,
        itemId: pickupTicketItems.itemId,
        sku: items.sku,
        title: items.title,
        legacyLocation: items.location,
        zone: warehouseLocations.zone,
        aisle: warehouseLocations.aisle,
        rack: warehouseLocations.rack,
        shelf: warehouseLocations.shelf,
        locationLabel: warehouseLocations.label,
        orderRef: orders.ref,
      })
      .from(pickupTicketItems)
      .innerJoin(items, eq(pickupTicketItems.itemId, items.id))
      .innerJoin(orders, eq(pickupTicketItems.orderId, orders.id))
      .leftJoin(warehouseLocations, eq(items.locationId, warehouseLocations.id))
      .where(eq(pickupTicketItems.ticketId, row.ticket.id));
    out.push({ ...row.ticket, customerAlias: row.customerAlias, customerEmail: row.customerEmail, lines });
  }
  return out;
}
