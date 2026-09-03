import { items, markets, orders, referrals } from "@auction/db";
import { assertItemTransition, type ItemStatus } from "@auction/domain";
import { and, eq } from "drizzle-orm";
import { slackOrderPaid } from "./slackNotify.js";
import { writeAudit } from "../audit.js";
import { earnPointsForOrder, movePoints } from "./loyalty.js";
import { purchaseToMeta } from "./metaPurchase.js";
import type { AppContext } from "../context.js";
import { enqueueNotification } from "./notifications.js";
import { generatePickupCode } from "./pickup.js";
import { getSettings } from "./settings.js";
import { postSalePaid } from "./ledger.js";

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
  const result = await ctx.db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update");
    if (!order) return { outcome: "not_found" as const };
    if (order.status !== "awaiting_payment") return { outcome: "not_awaiting" as const, status: order.status };
    const [item] = await tx.select().from(items).where(eq(items.id, order.itemId)).for("update");
    assertItemTransition(item!.status as ItemStatus, "paid");
    // Carrier orders get no pickup credential — they leave via Omniva/DPD,
    // never through the warehouse pickup boards or the no-show machinery.
    const forPickup = order.fulfilment === "pickup";
    const [market] = await tx.select().from(markets).where(eq(markets.code, order.marketCode));
    const deadlineDays = market?.pickupDeadlineDays ?? 14;
    const pickupDeadlineAt = forPickup ? new Date(ctx.now().getTime() + deadlineDays * 24 * 3_600_000) : null;
    await tx
      .update(orders)
      .set({ status: "paid", paidAt: ctx.now(), pickupCode: forPickup ? pickupCode : null, pickupDeadlineAt })
      .where(eq(orders.id, orderId));
    await tx.update(items).set({ status: "paid", updatedAt: ctx.now() }).where(eq(items.id, item!.id));

    // Баллы лояльности (MD §5a): 1 балл за каждый полный евро РЕАЛЬНОЙ
    // оплаты — за часть, закрытую баллами, новых баллов не даём. Абзац о
    // начислении едет в этом же письме об оплате (IZ-P06, транзакционное).
    const paidCents = order.totalCents - order.pointsAppliedCents;
    const earned = await earnPointsForOrder(ctx, tx, {
      customerId: order.customerId,
      orderRef: order.ref,
      paidCents,
    }).catch(() => null);

    // Реферальная награда, ступень 2 (MD §1.6.1): первый ОПЛАЧЕННЫЙ заказ
    // приглашённого — пригласивший получает вторую часть. Fraud-флаг держит
    // и её до ручной проверки.
    await (async () => {
      const [r] = await tx
        .select()
        .from(referrals)
        .where(and(eq(referrals.referredCustomerId, order.customerId), eq(referrals.status, "signup_rewarded")))
        .for("update");
      if (!r || r.fraudFlag) return;
      const s = await getSettings(ctx);
      if (s.referral_order_points_cents > 0) {
        await movePoints(tx, r.referrerCustomerId, {
          reason: "referral_order",
          amountCents: s.referral_order_points_cents,
          referralId: r.id,
          orderRef: order.ref,
        }, ctx.now());
      }
      await tx
        .update(referrals)
        .set({ status: "order_rewarded", orderRewardedAt: ctx.now() })
        .where(eq(referrals.id, r.id));
    })().catch(() => undefined);

    // Финансовый журнал (раздел 11): компоненты продажи + COGS + clearing —
    // в той же транзакции, где оплата стала фактом: заказ без проводок или
    // проводки без заказа появиться не могут.
    await postSalePaid(tx, {
      order,
      itemCostCents: item!.costCents,
      earnedPointsCents: earned?.earnedCents ?? 0,
      provider: typeof meta.provider === "string" ? meta.provider : typeof meta.via === "string" ? meta.via : undefined,
    }, ctx.now());

    await enqueueNotification(ctx, tx, {
      customerId: order.customerId,
      type: "order_paid",
      template: {
        alias: "", lotTitle: "", orderRef: order.ref, totalCents: order.totalCents,
        ...(earned ? { pointsEarnedCents: earned.earnedCents, pointsBalanceCents: earned.balanceCents } : {}),
      },
    });
    if (forPickup) {
      // Pickup pass: collection code + deadline (design: 14 days, 5% fee).
      await enqueueNotification(ctx, tx, {
        customerId: order.customerId,
        type: "pickup_ready",
        template: { alias: "", lotTitle: "", orderRef: order.ref, pickupCode, deadline: pickupDeadlineAt! },
      });
    }
    await writeAudit(tx, actor, "order", "marked_paid", order.ref, { totalCents: order.totalCents, fulfilment: order.fulfilment, ...meta });
    return { outcome: "settled" as const, order };
  });
  if (result.outcome === "settled") {
    slackOrderPaid(ctx, {
      orderRef: result.order.ref,
      totalCents: result.order.totalCents,
      via: typeof meta.provider === "string" ? meta.provider : "manuāli",
      orderId: result.order.id,
    });
    // Meta CAPI: покупка отправляется ИМЕННО отсюда — из единственного места,
    // где оплата действительно подтверждена. Браузер шлёт свою копию с тем же
    // event_id, Meta склеивает их в одну конверсию. Если человек закрыл
    // вкладку сразу после банка, серверная копия всё равно дойдёт.
    void purchaseToMeta(ctx, result.order).catch(() => undefined);
  }
  return result;
}
