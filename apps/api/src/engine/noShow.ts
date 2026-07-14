import { customers, items, markets, orders, refunds } from "@auction/db";
import { assertItemTransition, computeNoShowSettlement, type ItemStatus } from "@auction/domain";
import { and, eq, gt, lte, sql } from "drizzle-orm";
import { writeAudit, SYSTEM_ACTOR } from "../audit.js";
import type { AppContext } from "../context.js";
import { enqueueNotification, pickupReminderDedupeKey } from "./notifications.js";

/**
 * The no-show flow (design decision 2026-07): paid orders must be collected
 * within the market's pickup window (14 days default). Reminders at 3 days
 * and 1 day out; past the deadline the order is cancelled, a restock fee
 * (5% of the paid total by default) is retained, the remainder is recorded
 * as a refund, the client gets a strike, and the item enters the manual
 * restock queue (`no_pickup_cancelled`).
 */

/** Enqueue pickup reminders for paid orders approaching their deadline. */
export async function remindPickupDue(ctx: AppContext): Promise<void> {
  const now = ctx.now();
  const windows: Array<{ key: "3d" | "1d"; ms: number }> = [
    { key: "3d", ms: 3 * 24 * 3_600_000 },
    { key: "1d", ms: 1 * 24 * 3_600_000 },
  ];
  for (const w of windows) {
    const due = await ctx.db
      .select({
        id: orders.id,
        ref: orders.ref,
        customerId: orders.customerId,
        totalCents: orders.totalCents,
        deadline: orders.pickupDeadlineAt,
        pickupCode: orders.pickupCode,
      })
      .from(orders)
      .where(
        and(
          eq(orders.status, "paid"),
          gt(orders.pickupDeadlineAt, now),
          lte(orders.pickupDeadlineAt, new Date(now.getTime() + w.ms)),
        ),
      );
    for (const o of due) {
      await enqueueNotification(ctx.db, {
        customerId: o.customerId,
        type: "pickup_reminder",
        template: {
          alias: "",
          lotTitle: "",
          orderRef: o.ref,
          totalCents: o.totalCents,
          deadline: o.deadline ?? undefined,
          pickupCode: o.pickupCode ?? undefined,
        },
        dedupeKey: pickupReminderDedupeKey(o.id, w.key),
      });
    }
  }
}

/**
 * Cancel paid orders past their pickup deadline. Items mid-pickup (a live
 * ticket has them in `picking`) are skipped — the client is literally in the
 * building. Everything happens in one transaction per order.
 */
export async function cancelNoShowDue(ctx: AppContext): Promise<void> {
  const now = ctx.now();
  const due = await ctx.db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.status, "paid"), lte(orders.pickupDeadlineAt, now)));

  for (const candidate of due) {
    await ctx.db.transaction(async (tx) => {
      const [order] = await tx.select().from(orders).where(eq(orders.id, candidate.id)).for("update");
      if (!order || order.status !== "paid" || !order.pickupDeadlineAt || order.pickupDeadlineAt.getTime() > now.getTime()) return;
      const [item] = await tx.select().from(items).where(eq(items.id, order.itemId)).for("update");
      // Only items still resting in the warehouse are no-shows.
      if (!item || item.status !== "paid") return;

      const [market] = await tx.select().from(markets).where(eq(markets.code, order.marketCode));
      const settlement = computeNoShowSettlement(order.totalCents, market?.restockFeeBp ?? 500);

      assertItemTransition(item.status as ItemStatus, "no_pickup_cancelled");
      await tx
        .update(orders)
        .set({
          status: "cancelled",
          cancelledAt: now,
          cancelReason: "no_pickup",
          restockFeeCents: settlement.feeCents,
        })
        .where(eq(orders.id, order.id));
      await tx.update(items).set({ status: "no_pickup_cancelled", updatedAt: now }).where(eq(items.id, item.id));
      if (settlement.refundCents > 0) {
        await tx.insert(refunds).values({
          orderId: order.id,
          amountCents: settlement.refundCents,
          reason: `auto: not collected by deadline — restock fee ${settlement.feeCents} cents retained`,
          actorId: null,
        });
      }
      await tx
        .update(customers)
        .set({ strikes: sql`${customers.strikes} + 1` })
        .where(eq(customers.id, order.customerId));
      await enqueueNotification(tx, {
        customerId: order.customerId,
        type: "no_pickup_cancelled",
        template: {
          alias: "",
          lotTitle: "",
          orderRef: order.ref,
          feeCents: settlement.feeCents,
          refundCents: settlement.refundCents,
        },
        dedupeKey: `no_pickup_cancelled:${order.id}`,
      });
      await writeAudit(tx, SYSTEM_ACTOR, "order", "auto_cancelled_no_pickup", order.ref, {
        orderId: order.id,
        customerId: order.customerId,
        feeCents: settlement.feeCents,
        refundCents: settlement.refundCents,
      });
    });
  }
}
