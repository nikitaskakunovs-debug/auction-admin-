import { orders, payments, refunds } from "@auction/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { writeAudit } from "../audit.js";
import type { AppContext } from "../context.js";
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
    await tx.insert(refunds).values({
      orderId,
      amountCents: input.amountCents,
      reason: input.reason,
      actorId: input.actor.id,
    });
    const fullyRefunded = already + input.amountCents === order.totalCents;
    if (fullyRefunded) await tx.update(orders).set({ status: "refunded" }).where(eq(orders.id, orderId));
    await writeAudit(tx, input.actor, "order", "refunded", order.ref, {
      amountCents: input.amountCents,
      reason: input.reason,
      ...providerMeta,
    });
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
