import { items, orders, payments, refunds } from "@auction/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { writeAudit } from "../audit.js";
import type { AppContext } from "../context.js";
import { enqueueNotification } from "./notifications.js";
import { postRefundPaid, postRefundRequested } from "./ledger.js";
import { slackRefund } from "./slackNotify.js";

/**
 * Refunding money, in one place.
 *
 * This used to live inline in the refund route. R2 (returns at the counter)
 * needs exactly the same behaviour — including the provider rules, which are
 * the subtle part — so it moved here rather than being written twice:
 *
 *   • the ledger rules are pre-flighted BEFORE any provider call, because
 *     money must never leave Klix for a refund our own bookkeeping would then
 *     reject;
 *   • only what the provider confirms is recorded, so a rejected refund
 *     leaves no phantom row;
 *   • Inbank credit contracts cannot be refunded through an API at all — they
 *     are credited in Inbank's partner portal and then recorded here with
 *     viaProvider=false, never silently skipped.
 */

export interface RefundInput {
  amountCents: number;
  reason: string;
  /** Also push the money back through the provider that took it. */
  viaProvider: boolean;
  /**
   * Refund Pending поток (fin-architecture 5.2): как деньги идут обратно.
   *  - card (провайдер) и cash (касса/портал — уже в руках клиента) — деньги
   *    реально ушли, строка сразу paid, сторно выручки тут же;
   *  - bank — банковский перевод делает бухгалтер: строка встаёт в очередь
   *    requested, сторно ТОЛЬКО после отметки «выплачено» (markRefundPaid).
   * По умолчанию: viaProvider → card, иначе cash — прежние вызовы (касса
   * возвратов, портал Inbank) сохраняют прежнее мгновенное поведение.
   */
  method?: "card" | "cash" | "bank" | undefined;
  actor: { id: string | null; label: string };
}

export type RefundOutcome =
  | { ok: true; orderRef: string; fullyRefunded: boolean }
  | { ok: false; code: number; error: string; detail?: string };

export async function refundOrder(ctx: AppContext, orderId: string, input: RefundInput): Promise<RefundOutcome> {
  // ── Pre-flight, before any money moves ─────────────────────────────────────
  const [pre] = await ctx.db.select().from(orders).where(eq(orders.id, orderId));
  if (!pre) return { ok: false, code: 404, error: "not_found" };
  if (pre.status !== "paid" && pre.status !== "refunded") return { ok: false, code: 409, error: "order_not_paid" };
  const [sumRow] = await ctx.db
    .select({ refunded: sql<string>`coalesce(sum(${refunds.amountCents}), 0)` })
    .from(refunds)
    .where(eq(refunds.orderId, orderId));
  if (Number(sumRow!.refunded) + input.amountCents > pre.totalCents) {
    return { ok: false, code: 422, error: "refund_exceeds_total" };
  }

  // ── Provider leg ───────────────────────────────────────────────────────────
  let providerMeta: Record<string, unknown> = {};
  if (input.viaProvider) {
    const [paidPayment] = await ctx.db
      .select()
      .from(payments)
      .where(and(eq(payments.orderId, orderId), eq(payments.status, "paid")))
      .orderBy(desc(payments.createdAt))
      .limit(1);
    if (paidPayment?.provider === "inbank") {
      return {
        ok: false,
        code: 409,
        error: "provider_refund_unsupported",
        detail: "Paid via Inbank — credit the contract in the Inbank partner portal, then record with viaProvider=false",
      };
    }
    if (paidPayment?.providerId) {
      if (!ctx.klix) {
        return {
          ok: false,
          code: 503,
          error: "payments_unavailable",
          detail: "KLIX_MODE is off — refund in the Klix portal, then record with viaProvider=false",
        };
      }
      try {
        const purchase = await ctx.klix.refundPurchase(paidPayment.providerId, input.amountCents);
        await ctx.db
          .update(payments)
          .set({ providerStatus: purchase.status, updatedAt: ctx.now() })
          .where(eq(payments.id, paidPayment.id));
        providerMeta = { via: "klix", purchaseId: paidPayment.providerId };
      } catch (err) {
        return {
          ok: false,
          code: 502,
          error: "klix_refund_failed",
          detail: err instanceof Error ? err.message : "provider error",
        };
      }
    }
  }

  // ── Ledger ─────────────────────────────────────────────────────────────────
  // card/cash — деньги реально ушли: строка сразу paid, сторно выручки здесь
  // же. bank — платит бухгалтер: строка requested, сторно ждёт markRefundPaid.
  const method = input.method ?? (input.viaProvider ? "card" : "cash");
  const instant = method !== "bank";
  const result = await ctx.db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update");
    if (!order) return null;
    if (order.status !== "paid" && order.status !== "refunded") return "not_refundable" as const;
    const [row] = await tx
      .select({ refunded: sql<string>`coalesce(sum(${refunds.amountCents}), 0)` })
      .from(refunds)
      .where(eq(refunds.orderId, orderId));
    const already = Number(row!.refunded);
    if (already + input.amountCents > order.totalCents) return "over_max" as const;
    const [refund] = await tx
      .insert(refunds)
      .values({
        orderId,
        amountCents: input.amountCents,
        reason: input.reason,
        actorId: input.actor.id,
        method,
        status: instant ? "paid" : "requested",
        paidBy: instant ? input.actor.label : null,
        paidAt: instant ? ctx.now() : null,
      })
      .returning();
    if (instant) {
      await postRefundPaid(tx, { refund: refund!, order, pendingHeld: false }, ctx.now());
    } else {
      await postRefundRequested(tx, { refundId: refund!.id, orderRef: order.ref, amountCents: input.amountCents, method }, ctx.now());
    }
    const fullyRefunded = already + input.amountCents === order.totalCents;
    if (fullyRefunded && instant) await tx.update(orders).set({ status: "refunded" }).where(eq(orders.id, orderId));
    await writeAudit(tx, input.actor, "order", instant ? "refunded" : "refund_requested", order.ref, {
      amountCents: input.amountCents,
      reason: input.reason,
      method,
      ...providerMeta,
    });
    // Tell the customer their money is on the way back. Inside the same
    // transaction as the ledger row: an email about a refund that did not
    // happen is worse than no email. Для bank-цепочки письмо уйдёт при
    // «выплачено» — обещать деньги раньше платежа нельзя.
    if (instant) {
      const [lot] = await tx.select({ title: items.title }).from(items).where(eq(items.id, order.itemId));
      await enqueueNotification(ctx, tx, {
        customerId: order.customerId,
        type: "refunded",
        template: {
          alias: "",
          lotTitle: lot?.title ?? "",
          orderRef: order.ref,
          refundCents: input.amountCents,
          reason: input.reason,
        },
      });
    }
    return { order, fullyRefunded };
  });
  if (result === null) return { ok: false, code: 404, error: "not_found" };
  if (result === "not_refundable") return { ok: false, code: 409, error: "order_not_paid" };
  if (result === "over_max") return { ok: false, code: 422, error: "refund_exceeds_total" };

  slackRefund(ctx, {
    orderRef: result.order.ref,
    amountCents: input.amountCents,
    reason: input.reason,
    orderId,
  });
  return { ok: true, orderRef: result.order.ref, fullyRefunded: result.fullyRefunded };
}

/**
 * «Выплачено» для bank-возврата (очередь бухгалтера, fin.refunds_manage):
 * ТОЛЬКО здесь происходит сторно выручки и снятие liability — по решению
 * архитектуры сторно не бывает раньше реального движения денег.
 */
export async function markRefundPaid(
  ctx: AppContext,
  refundId: string,
  actor: { id: string | null; label: string },
): Promise<{ ok: true } | { ok: false; error: "not_found" | "not_pending" }> {
  return await ctx.db.transaction(async (tx) => {
    const [refund] = await tx.select().from(refunds).where(eq(refunds.id, refundId)).for("update");
    if (!refund) return { ok: false as const, error: "not_found" as const };
    if (refund.status !== "requested" && refund.status !== "awaiting_manual") {
      return { ok: false as const, error: "not_pending" as const };
    }
    const [order] = await tx.select().from(orders).where(eq(orders.id, refund.orderId)).for("update");
    if (!order) return { ok: false as const, error: "not_found" as const };
    await tx
      .update(refunds)
      .set({ status: "paid", paidBy: actor.label, paidAt: ctx.now() })
      .where(eq(refunds.id, refundId));
    await postRefundPaid(tx, { refund, order, pendingHeld: true }, ctx.now());
    // Полностью ли заказ возвращён — считаем по ВЫПЛАЧЕННЫМ строкам (эта
    // строка уже переведена в paid выше и входит в сумму).
    const [row] = await tx
      .select({ paidSum: sql<string>`coalesce(sum(${refunds.amountCents}), 0)` })
      .from(refunds)
      .where(and(eq(refunds.orderId, order.id), sql`${refunds.status} IN ('paid','closed')`));
    if (Number(row!.paidSum) >= order.totalCents) {
      await tx.update(orders).set({ status: "refunded" }).where(eq(orders.id, order.id));
    }
    await writeAudit(tx, actor, "order", "refund_paid", order.ref, {
      refundId,
      amountCents: refund.amountCents,
      method: refund.method,
    });
    const [lot] = await tx.select({ title: items.title }).from(items).where(eq(items.id, order.itemId));
    await enqueueNotification(ctx, tx, {
      customerId: order.customerId,
      type: "refunded",
      template: {
        alias: "",
        lotTitle: lot?.title ?? "",
        orderRef: order.ref,
        refundCents: refund.amountCents,
        reason: refund.reason,
      },
    });
    return { ok: true as const };
  });
}

/** Терминальное «closed»: банк подтвердил списание (сверка по выписке). */
export async function closeRefund(
  ctx: AppContext,
  refundId: string,
  actor: { id: string | null; label: string },
): Promise<boolean> {
  const [row] = await ctx.db
    .update(refunds)
    .set({ status: "closed" })
    .where(and(eq(refunds.id, refundId), eq(refunds.status, "paid")))
    .returning({ id: refunds.id, orderId: refunds.orderId });
  if (row) await writeAudit(ctx.db, actor, "order", "refund_closed", row.orderId, { refundId });
  return Boolean(row);
}
