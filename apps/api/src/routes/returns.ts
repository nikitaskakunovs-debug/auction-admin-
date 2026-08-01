import {
  counters,
  items,
  orders,
  payments,
  pickupTicketItems,
  pickupTickets,
  refunds,
  returnCases,
  shipments,
  stockMovements,
} from "@auction/db";
import { assertItemTransition, canTransitionItem, type ItemStatus } from "@auction/domain";
import { and, desc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { writeAudit, type Actor } from "../audit.js";
import { requirePermission, type PermissionService } from "../auth/rbac.js";
import type { AppContext } from "../context.js";
import { refundOrder } from "../engine/refund.js";

/**
 * R2 — returns at the counter.
 *
 * The buyer walks back in with the goods, so the whole flow lives at the desk
 * ("Lete"): find the person, pick something they actually collected, record
 * why it came back, decide, and say where the goods go. One confirmation
 * refunds the money, moves the item and leaves a case behind.
 *
 * Two rules shape everything here:
 *
 *   • money moves only through `refundOrder` — the case never writes to
 *     `refunds` itself, and if the engine refuses (Inbank contracts cannot be
 *     refunded through an API) nothing else happens either. A half-completed
 *     return, with the item moved but the money still with us, is worse than
 *     an error message telling the operator to use the partner portal.
 *   • the 14-day claims window is a question, not a wall: past it the door
 *     stays open but `overrideReason` becomes mandatory and is audited.
 *
 * Permissions follow the desk's split: opening a case is counter work
 * (`pickup.operate`), deciding one costs money (`orders.refund`).
 */

const RETURN_WINDOW_DAYS = 14;
const DAY_MS = 86_400_000;

const REASONS = ["not_as_described", "damaged", "changed_mind", "other"] as const;
const DECISIONS = ["refund_full", "refund_partial", "rejected"] as const;
const DESTINATIONS = ["quarantine", "stock", "write_off", "kept_by_buyer"] as const;

const actor = (req: { admin?: { sub: string; name: string } }): Actor => ({
  id: req.admin?.sub ?? null,
  label: req.admin?.name ?? "Unknown",
});

/** Row-locked sequence, same shape as receiving.ts (not exported there). */
async function nextCounter(tx: Pick<AppContext["db"], "update" | "insert">, key: string): Promise<number> {
  await tx.insert(counters).values({ key, value: 0 }).onConflictDoNothing();
  const [row] = await tx
    .update(counters)
    .set({ value: sql`${counters.value} + 1` })
    .where(eq(counters.key, key))
    .returning({ value: counters.value });
  return row!.value;
}

/** Return case reference: RET-0042 (formatted here — intake.ts owns SKUs and
 * consignments and gains nothing from a third format). */
const formatReturnRef = (seq: number): string => `RET-${String(seq).padStart(4, "0")}`;

const isUuid = (v: unknown): v is string => z.string().uuid().safeParse(v).success;

// ── When did the goods change hands? ─────────────────────────────────────────

interface CollectedLine {
  orderId: string;
  itemId: string;
  paidAt: Date | null;
}

/**
 * The 14-day clock runs from the physical handover, not from payment, so this
 * hunts for the most reliable record of that moment (per order):
 *
 *   1. the item's `handover` stock movement — written per item inside the same
 *      transaction that flips it to `delivered` (engine/pickup.ts
 *      completeTicket), which is as close to "the box left the counter" as the
 *      system gets;
 *   2. the completed pickup ticket's `completedAt` — the same instant, kept as
 *      a fallback in case the ledger row is ever missing (a hand-fixed item, an
 *      import);
 *   3. for carrier orders there is no handover at our counter at all: the
 *      parcel's delivery is recorded on the shipment when tracking reports
 *      `delivered`, so its `updatedAt` is the best available proxy;
 *   4. finally `paidAt`. This is a genuine fallback for legacy or hand-repaired
 *      rows only — it makes the window start too early, which can only ever
 *      cost the customer days, so the operator's override is the safety net.
 */
async function handoverDates(ctx: AppContext, lines: CollectedLine[]): Promise<Map<string, Date | null>> {
  const out = new Map<string, Date | null>();
  if (lines.length === 0) return out;
  const orderIds = [...new Set(lines.map((l) => l.orderId))];
  const itemIds = [...new Set(lines.map((l) => l.itemId))];

  const movements = await ctx.db
    .select({ itemId: stockMovements.itemId, at: stockMovements.createdAt })
    .from(stockMovements)
    .where(and(inArray(stockMovements.itemId, itemIds), eq(stockMovements.type, "handover")))
    .orderBy(desc(stockMovements.createdAt));
  const byItem = new Map<string, Date>();
  for (const m of movements) if (!byItem.has(m.itemId)) byItem.set(m.itemId, m.at);

  const ticketRows = await ctx.db
    .select({ orderId: pickupTicketItems.orderId, at: pickupTickets.completedAt })
    .from(pickupTicketItems)
    .innerJoin(pickupTickets, eq(pickupTicketItems.ticketId, pickupTickets.id))
    .where(and(inArray(pickupTicketItems.orderId, orderIds), eq(pickupTickets.status, "completed")))
    .orderBy(desc(pickupTickets.completedAt));
  const byTicket = new Map<string, Date>();
  for (const t of ticketRows) if (t.at && !byTicket.has(t.orderId)) byTicket.set(t.orderId, t.at);

  const parcels = await ctx.db
    .select({ orderId: shipments.orderId, at: shipments.updatedAt })
    .from(shipments)
    .where(and(inArray(shipments.orderId, orderIds), eq(shipments.status, "delivered")))
    .orderBy(desc(shipments.updatedAt));
  const byParcel = new Map<string, Date>();
  for (const p of parcels) if (!byParcel.has(p.orderId)) byParcel.set(p.orderId, p.at);

  for (const l of lines) {
    out.set(l.orderId, byItem.get(l.itemId) ?? byTicket.get(l.orderId) ?? byParcel.get(l.orderId) ?? l.paidAt);
  }
  return out;
}

/** Whole days left of the claims window; negative once it has expired. */
function windowFor(handoverAt: Date | null, now: Date): { daysLeft: number; withinWindow: boolean } {
  // Nothing recorded at all — don't invent an expiry the staff would have to
  // override; the case simply counts as inside the window.
  if (!handoverAt) return { daysLeft: RETURN_WINDOW_DAYS, withinWindow: true };
  const daysLeft = RETURN_WINDOW_DAYS - Math.floor((now.getTime() - handoverAt.getTime()) / DAY_MS);
  return { daysLeft, withinWindow: daysLeft >= 0 };
}

/** Money already given back, per order. */
async function refundedByOrder(ctx: AppContext, orderIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (orderIds.length === 0) return out;
  const rows = await ctx.db
    .select({ orderId: refunds.orderId, sum: sql<string>`coalesce(sum(${refunds.amountCents}), 0)` })
    .from(refunds)
    .where(inArray(refunds.orderId, orderIds))
    .groupBy(refunds.orderId);
  for (const r of rows) out.set(r.orderId, Number(r.sum));
  return out;
}

export function registerReturnRoutes(app: FastifyInstance, ctx: AppContext, perms: PermissionService): void {
  const guard = (p: Parameters<typeof requirePermission>[1]) => ({ preHandler: requirePermission(perms, p) });

  // ── What can this person bring back? ───────────────────────────────────────

  /**
   * Everything the customer has actually collected — the desk's picking list.
   * Collected means the order is paid *and* the item reached delivered/closed;
   * an unfulfilled order is not a return, it is a cancellation.
   */
  app.get("/api/desk/returnable", guard("pickup.operate"), async (req, reply) => {
    const { customerId } = req.query as { customerId?: string };
    if (!isUuid(customerId)) return reply.code(400).send({ error: "customer_id_required" });

    const rows = await ctx.db
      .select({
        orderId: orders.id,
        orderRef: orders.ref,
        totalCents: orders.totalCents,
        paidAt: orders.paidAt,
        itemId: items.id,
        sku: items.sku,
        title: items.title,
      })
      .from(orders)
      .innerJoin(items, eq(orders.itemId, items.id))
      .where(
        and(
          eq(orders.customerId, customerId),
          eq(orders.status, "paid"),
          inArray(items.status, ["delivered", "closed"]),
        ),
      )
      .orderBy(desc(orders.paidAt))
      .limit(50);
    if (rows.length === 0) return { lines: [] as unknown[] };

    const orderIds = rows.map((r) => r.orderId);
    const handovers = await handoverDates(ctx, rows);
    const refunded = await refundedByOrder(ctx, orderIds);
    const cases = await ctx.db
      .select({ orderId: returnCases.orderId, itemId: returnCases.itemId })
      .from(returnCases)
      .where(inArray(returnCases.orderId, orderIds));

    const now = ctx.now();
    const lines = rows
      .map((r) => {
        const deliveredAt = handovers.get(r.orderId) ?? null;
        const { daysLeft, withinWindow } = windowFor(deliveredAt, now);
        return {
          orderId: r.orderId,
          orderRef: r.orderRef,
          itemId: r.itemId,
          sku: r.sku,
          title: r.title,
          totalCents: r.totalCents,
          refundableCents: Math.max(0, r.totalCents - (refunded.get(r.orderId) ?? 0)),
          deliveredAt,
          daysLeft,
          withinWindow,
          // A case opened against the order without naming an item still
          // covers this line — one order is one item today.
          alreadyReturned: cases.some((c) => c.orderId === r.orderId && (c.itemId === null || c.itemId === r.itemId)),
        };
      })
      .sort((a, b) => (b.deliveredAt?.getTime() ?? 0) - (a.deliveredAt?.getTime() ?? 0));

    return { lines };
  });

  // ── Open a case ────────────────────────────────────────────────────────────

  const openBody = z.object({
    orderId: z.string().uuid(),
    itemId: z.string().uuid().optional(),
    reason: z.enum(REASONS),
    note: z.string().max(2000).default(""),
    overrideReason: z.string().max(2000).default(""),
  });

  app.post("/api/returns", guard("pickup.operate"), async (req, reply) => {
    const body = openBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const d = body.data;

    const [order] = await ctx.db.select().from(orders).where(eq(orders.id, d.orderId));
    if (!order) return reply.code(404).send({ error: "not_found" });
    // `refunded` counts as paid: a partially refunded order is still a sale.
    if (order.status !== "paid" && order.status !== "refunded") {
      return reply.code(409).send({ error: "order_not_paid" });
    }
    const [existing] = await ctx.db
      .select({ id: returnCases.id })
      .from(returnCases)
      .where(and(eq(returnCases.orderId, order.id), eq(returnCases.status, "open")))
      .limit(1);
    if (existing) return reply.code(409).send({ error: "already_open" });

    const itemId = d.itemId ?? order.itemId;
    const handovers = await handoverDates(ctx, [{ orderId: order.id, itemId, paidAt: order.paidAt }]);
    const { withinWindow } = windowFor(handovers.get(order.id) ?? null, ctx.now());

    // Past 14 days the door does not disappear — it asks why, and the answer
    // is stored on the case and in the audit trail.
    const overrideReason = d.overrideReason.trim();
    if (!withinWindow && overrideReason.length < 3) {
      return reply.code(422).send({ error: "override_reason_required" });
    }

    const created = await ctx.db.transaction(async (tx) => {
      const ref = formatReturnRef(await nextCounter(tx, "return_ref"));
      const [row] = await tx
        .insert(returnCases)
        .values({
          ref,
          orderId: order.id,
          orderRef: order.ref,
          itemId,
          customerId: order.customerId,
          customerAlias: order.customerAlias,
          reason: d.reason,
          note: d.note,
          status: "open",
          withinWindow,
          overrideReason: withinWindow ? "" : overrideReason,
          openedById: req.admin!.sub,
          openedByLabel: req.admin!.name,
        })
        .returning();
      await writeAudit(tx, actor(req), "order", "return_opened", ref, {
        orderRef: order.ref,
        reason: d.reason,
        withinWindow,
        overrideReason: withinWindow ? undefined : overrideReason,
      });
      return row!;
    });

    return { case: created };
  });

  // ── The queue ──────────────────────────────────────────────────────────────

  app.get("/api/returns", guard("pickup.view"), async (req) => {
    const q = req.query as { status?: string; customerId?: string; limit?: string };
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
    const base: SQL[] = [];
    if (isUuid(q.customerId)) base.push(eq(returnCases.customerId, q.customerId) as SQL);
    const status = q.status === "open" || q.status === "resolved" ? q.status : null;

    const rows = await ctx.db
      .select({ c: returnCases, itemSku: items.sku, itemTitle: items.title })
      .from(returnCases)
      .leftJoin(items, eq(returnCases.itemId, items.id))
      .where(and(...base, status ? eq(returnCases.status, status) : undefined))
      .orderBy(desc(returnCases.createdAt))
      .limit(limit);

    // Counts ignore the status filter — they drive the pill row above the list.
    const countRows = await ctx.db
      .select({ status: returnCases.status, n: sql<string>`count(*)` })
      .from(returnCases)
      .where(and(...base))
      .groupBy(returnCases.status);
    const counts = { open: 0, resolved: 0 };
    for (const c of countRows) {
      if (c.status === "open") counts.open = Number(c.n);
      if (c.status === "resolved") counts.resolved = Number(c.n);
    }

    return {
      cases: rows.map((r) => ({ ...r.c, itemSku: r.itemSku ?? "", itemTitle: r.itemTitle ?? "" })),
      counts,
    };
  });

  // ── One case, with the customer's history ──────────────────────────────────

  app.get("/api/returns/:id", guard("pickup.view"), async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) return reply.code(404).send({ error: "not_found" });
    const [row] = await ctx.db.select().from(returnCases).where(eq(returnCases.id, id));
    if (!row) return reply.code(404).send({ error: "not_found" });

    const [item] = row.itemId
      ? await ctx.db
          .select({ id: items.id, sku: items.sku, title: items.title, status: items.status })
          .from(items)
          .where(eq(items.id, row.itemId))
      : [];
    const [order] = await ctx.db
      .select({ id: orders.id, ref: orders.ref, totalCents: orders.totalCents, status: orders.status })
      .from(orders)
      .where(eq(orders.id, row.orderId));
    const refunded = await refundedByOrder(ctx, [row.orderId]);

    /**
     * The point of this screen: whoever decides sees what this customer has
     * brought back before. Three "changed mind" refunds in a month is a
     * different conversation from a first damaged lot.
     */
    const history = row.customerId
      ? await ctx.db
          .select({
            ref: returnCases.ref,
            itemTitle: items.title,
            decision: returnCases.decision,
            resolvedAt: returnCases.resolvedAt,
          })
          .from(returnCases)
          .leftJoin(items, eq(returnCases.itemId, items.id))
          .where(
            and(
              eq(returnCases.customerId, row.customerId),
              eq(returnCases.status, "resolved"),
              ne(returnCases.id, row.id),
            ),
          )
          .orderBy(desc(returnCases.resolvedAt))
          .limit(20)
      : [];

    return {
      case: row,
      item: item ?? null,
      order: order
        ? { ...order, refundedCents: refunded.get(row.orderId) ?? 0 }
        : { id: row.orderId, ref: row.orderRef, totalCents: 0, status: "unknown", refundedCents: 0 },
      history: history.map((h) => ({ ...h, itemTitle: h.itemTitle ?? "" })),
    };
  });

  // ── Decide ─────────────────────────────────────────────────────────────────

  const resolveBody = z.object({
    decision: z.enum(DECISIONS),
    refundCents: z.number().int().optional(),
    destination: z.enum(DESTINATIONS),
    /** Push the money back through the provider that took it (Klix). */
    viaProvider: z.boolean().default(true),
    note: z.string().max(2000).default(""),
  });

  app.post("/api/returns/:id/resolve", guard("orders.refund"), async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) return reply.code(404).send({ error: "not_found" });
    const body = resolveBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const d = body.data;

    const [row] = await ctx.db.select().from(returnCases).where(eq(returnCases.id, id));
    if (!row) return reply.code(404).send({ error: "not_found" });
    if (row.status !== "open") return reply.code(409).send({ error: "case_not_open" });
    const [order] = await ctx.db.select().from(orders).where(eq(orders.id, row.orderId));
    if (!order) return reply.code(404).send({ error: "not_found" });

    const already = (await refundedByOrder(ctx, [order.id])).get(order.id) ?? 0;
    const remaining = Math.max(0, order.totalCents - already);

    let amountCents = 0;
    if (d.decision === "rejected") {
      // Nothing moves: no money, and the buyer keeps the goods they brought in
      // (staff hand them back over the counter).
      if (d.destination !== "kept_by_buyer") return reply.code(422).send({ error: "invalid_destination" });
    } else if (d.decision === "refund_full") {
      amountCents = remaining;
      if (amountCents <= 0) return reply.code(422).send({ error: "invalid_amount" });
    } else {
      amountCents = d.refundCents ?? 0;
      if (amountCents <= 0 || amountCents > remaining) return reply.code(422).send({ error: "invalid_amount" });
    }

    // Read the settling payment before refunding: it is what tells cash from
    // Klix from an Inbank contract, and the engine doesn't report it back.
    const [paidPayment] = await ctx.db
      .select({ provider: payments.provider, providerId: payments.providerId })
      .from(payments)
      .where(and(eq(payments.orderId, order.id), eq(payments.status, "paid")))
      .orderBy(desc(payments.createdAt))
      .limit(1);

    let refund: { ok: boolean; amountCents: number } | null = null;
    if (amountCents > 0) {
      const outcome = await refundOrder(ctx, order.id, {
        amountCents,
        reason: `${row.ref} — return (${row.reason})`,
        viaProvider: d.viaProvider,
        actor: actor(req),
      });
      // The engine refused: pass its verdict straight through and change
      // nothing. An Inbank order lands here telling the operator to credit the
      // contract in the partner portal and re-run with viaProvider=false —
      // far better than a case marked resolved with the money still with us.
      if (!outcome.ok) {
        if (outcome.error === "klix_refund_failed") req.log?.error({ orderId: order.id }, "klix refund failed");
        return reply
          .code(outcome.code)
          .send(outcome.detail ? { error: outcome.error, detail: outcome.detail } : { error: outcome.error });
      }
      refund = { ok: true, amountCents };
    }

    /**
     * How the money went back. Deliberately derived rather than asked for:
     * Inbank can only ever be the portal, a provider-backed payment can only
     * ever be Klix, and everything else at the desk is cash out of the till
     * (a card-terminal reversal is recorded the same way — the till is the
     * operator's concern, the ledger's is that it left).
     */
    const refundMethod =
      amountCents === 0
        ? "none"
        : paidPayment?.provider === "inbank"
          ? "inbank_portal"
          : d.viaProvider && paidPayment?.providerId
            ? "klix"
            : "cash";

    const updated = await ctx.db.transaction(async (tx) => {
      let itemNote = "";
      // Goods coming back into our custody, or being written off. `kept_by_buyer`
      // touches nothing — the item is with the customer either way.
      if (row.itemId && d.destination !== "kept_by_buyer") {
        const target: ItemStatus = d.destination === "write_off" ? "closed" : "returned";
        const [item] = await tx.select().from(items).where(eq(items.id, row.itemId)).for("update");
        if (item && canTransitionItem(item.status as ItemStatus, target)) {
          assertItemTransition(item.status as ItemStatus, target);
          await tx.update(items).set({ status: target, updatedAt: ctx.now() }).where(eq(items.id, item.id));
          if (target === "returned") {
            // The lot is physically put away by the warehouse afterwards, which
            // writes its own putaway movement — so the bin is left alone here
            // and quarantine-vs-stock lives on the case as the destination the
            // warehouse acts on.
            await tx.insert(stockMovements).values({
              itemId: item.id,
              type: "restock",
              fromLocationId: null,
              toLocationId: null,
              actorId: actor(req).id,
              actorLabel: actor(req).label,
              reason: `return ${row.ref} → ${d.destination}`,
            });
          }
        } else {
          // Someone already moved it (or it is gone). Refusing the whole
          // resolve here would strand a refund that has already left, so the
          // case records the discrepancy instead of throwing.
          itemNote = `Item not moved: status was ${item?.status ?? "missing"}.`;
        }
      }

      const note = [row.note, d.note.trim(), itemNote].filter((s) => s.length > 0).join("\n");
      const [saved] = await tx
        .update(returnCases)
        .set({
          status: "resolved",
          decision: d.decision,
          refundCents: amountCents,
          destination: d.destination,
          refundMethod,
          note,
          resolvedById: req.admin!.sub,
          resolvedByLabel: req.admin!.name,
          resolvedAt: ctx.now(),
        })
        .where(eq(returnCases.id, row.id))
        .returning();
      // No amount in the detail: the activity feed is readable with
      // audit.view, which most roles hold, and the response hook only strips
      // cost-named keys (same reasoning as suppliers.ts). The money is in the
      // refunds ledger and on the case, both of which are money-gated.
      await writeAudit(tx, actor(req), "order", "return_resolved", row.ref, {
        ref: row.ref,
        orderRef: row.orderRef,
        decision: d.decision,
        destination: d.destination,
      });
      return saved!;
    });

    // Slack: refundOrder already mirrors the refund itself (slackRefund).
    // A return-specific message would mean adding a hook to slackNotify.ts,
    // which this change does not own — left for that file's owner.
    return { case: updated, refund };
  });
}
