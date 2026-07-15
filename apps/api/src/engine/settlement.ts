import { items, markets, orders } from "@auction/db";
import { assertItemTransition, type ItemStatus } from "@auction/domain";
import { eq } from "drizzle-orm";
import { writeAudit } from "../audit.js";
import type { AppContext } from "../context.js";
import { enqueueNotification } from "./notifications.js";
import { generatePickupCode } from "./pickup.js";

export type SettleResult =
  | { outcome: "settled"; order: typeof orders.$inferSelect }
  | { outcome: "not_found" }
  | { outcome: "not_awaiting"; status: string };

/**
 * Mark an awaiting_payment order as paid: pickup code + deadline, item →
 * paid, order_paid + pickup_ready notifications, audit entry. Shared by the
 * admin mark-paid action and the Klix payment callback; safe to call twice —
 * the second call reports `not_awaiting` and changes nothing.
 */
export async function settleOrderPaid(
  ctx: AppContext,
  orderId: string,
  actor: { id: string | null; label: string },
  meta: Record<string, unknown> = {},
): Promise<SettleResult> {
  // Allocated outside the tx (reads only); uniqueness is among active paid
  // orders, and the odds of a same-instant collision are negligible.
  const pickupCode = await generatePickupCode(ctx.db);
  return ctx.db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update");
    if (!order) return { outcome: "not_found" as const };
    if (order.status !== "awaiting_payment") return { outcome: "not_awaiting" as const, status: order.status };
    const [item] = await tx.select().from(items).where(eq(items.id, order.itemId)).for("update");
    assertItemTransition(item!.status as ItemStatus, "paid");
    const [market] = await tx.select().from(markets).where(eq(markets.code, order.marketCode));
    const deadlineDays = market?.pickupDeadlineDays ?? 14;
    const pickupDeadlineAt = new Date(ctx.now().getTime() + deadlineDays * 24 * 3_600_000);
    await tx
      .update(orders)
      .set({ status: "paid", paidAt: ctx.now(), pickupCode, pickupDeadlineAt })
      .where(eq(orders.id, orderId));
    await tx.update(items).set({ status: "paid", updatedAt: ctx.now() }).where(eq(items.id, item!.id));
    await enqueueNotification(tx, {
      customerId: order.customerId,
      type: "order_paid",
      template: { alias: "", lotTitle: "", orderRef: order.ref, totalCents: order.totalCents },
    });
    // Pickup pass: collection code + deadline (design: 14 days, then 5% fee).
    await enqueueNotification(tx, {
      customerId: order.customerId,
      type: "pickup_ready",
      template: { alias: "", lotTitle: "", orderRef: order.ref, pickupCode, deadline: pickupDeadlineAt },
    });
    await writeAudit(tx, actor, "order", "marked_paid", order.ref, { totalCents: order.totalCents, ...meta });
    return { outcome: "settled" as const, order };
  });
}
