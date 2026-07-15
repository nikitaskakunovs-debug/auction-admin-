import { items, orders, payments } from "@auction/db";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { KlixError } from "../engine/klix.js";
import { settleOrderPaid } from "../engine/settlement.js";

/**
 * Online payment (Klix hosted checkout: cards, BNPL "klix_pay_later",
 * Baltic banklinks). Bidder-facing flow:
 *
 *   POST /api/public/orders/:ref/pay      → { checkoutUrl }  (redirect there)
 *   …customer pays on the Klix page…
 *   Klix → POST /api/public/payments/klix/callback?payment=<id>  (server-to-server)
 *   browser → back to /account?paid=1&order=<ref>, which polls
 *   GET  /api/public/orders/:ref/payment  until the order flips to paid.
 *
 * Trust model per the Klix docs: the callback body is NEVER trusted — on any
 * callback (or poll) we re-fetch the purchase from Klix by id and settle only
 * when the provider reports status "paid". Settlement is idempotent.
 */

/** How long a created checkout stays reusable before we mint a fresh one. */
const CHECKOUT_REUSE_MS = 30 * 60 * 1000;

const SYSTEM_ACTOR = { id: null, label: "Klix" };

function mapProviderStatus(providerStatus: string): "created" | "paid" | "failed" | "expired" {
  if (providerStatus === "paid") return "paid";
  if (providerStatus === "expired") return "expired";
  if (["error", "blocked", "cancelled", "released", "chargeback"].includes(providerStatus)) return "failed";
  return "created"; // created / pending_execute / viewed / hold — still in flight
}

/** Checkout-page language per market when the bidder didn't state one. */
const MARKET_LANGUAGE: Record<string, string> = { LV: "lv", EE: "et", LT: "lt" };

export function registerPaymentRoutes(app: FastifyInstance, ctx: AppContext): void {
  const requireBidder = (req: FastifyRequest, reply: FastifyReply): string | null => {
    if (!req.bidder) {
      void reply.code(401).send({ error: "unauthenticated" });
      return null;
    }
    return req.bidder.sub;
  };

  async function ownOrderByRef(ref: string, bidderId: string) {
    const [row] = await ctx.db
      .select({ order: orders, itemTitle: items.title })
      .from(orders)
      .innerJoin(items, eq(orders.itemId, items.id))
      .where(and(eq(orders.ref, ref), eq(orders.customerId, bidderId)));
    return row ?? null;
  }

  /**
   * Re-check one payment row against the provider and settle the order if the
   * purchase is paid. Used by both the Klix callback and the storefront poll.
   */
  async function reconcilePayment(payment: typeof payments.$inferSelect): Promise<string> {
    if (!ctx.klix || !payment.providerId) return payment.status;
    const purchase = await ctx.klix.getPurchase(payment.providerId);
    if (!purchase) return payment.status;
    const status = mapProviderStatus(purchase.status);
    if (status !== payment.status || purchase.status !== payment.providerStatus) {
      await ctx.db
        .update(payments)
        .set({ status, providerStatus: purchase.status, updatedAt: ctx.now() })
        .where(eq(payments.id, payment.id));
    }
    if (status === "paid") {
      // Idempotent: a second callback (or a poll racing the callback) finds
      // the order already paid and no-ops.
      await settleOrderPaid(ctx, payment.orderId, SYSTEM_ACTOR, {
        via: "klix",
        paymentId: payment.id,
        purchaseId: payment.providerId,
      });
    }
    return status;
  }

  const paySchema = z.object({ language: z.enum(["lv", "ru", "en", "et", "lt"]).optional() });

  /** Start (or resume) checkout for the bidder's own unpaid order. */
  app.post("/api/public/orders/:ref/pay", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    if (!ctx.klix) return reply.code(503).send({ error: "payments_unavailable" });
    const body = paySchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const { ref } = req.params as { ref: string };
    const row = await ownOrderByRef(ref, bidderId);
    if (!row) return reply.code(404).send({ error: "not_found" });
    if (row.order.status !== "awaiting_payment") return reply.code(409).send({ error: "order_not_awaiting_payment" });

    // Reuse a fresh, still-open checkout so double-clicks and page reloads
    // don't pile up purchases; anything older gets superseded.
    const [existing] = await ctx.db
      .select()
      .from(payments)
      .where(and(eq(payments.orderId, row.order.id), eq(payments.status, "created")))
      .orderBy(desc(payments.createdAt))
      .limit(1);
    if (existing?.checkoutUrl && ctx.now().getTime() - existing.createdAt.getTime() < CHECKOUT_REUSE_MS) {
      return { checkoutUrl: existing.checkoutUrl };
    }
    if (existing) {
      await ctx.db
        .update(payments)
        .set({ status: "expired", updatedAt: ctx.now() })
        .where(eq(payments.id, existing.id));
    }

    const language = body.data.language ?? MARKET_LANGUAGE[row.order.marketCode] ?? "en";
    const accountUrl = `${ctx.config.storefrontBaseUrl}/account`;
    const [payment] = await ctx.db
      .insert(payments)
      .values({ orderId: row.order.id, provider: "klix", amountCents: row.order.totalCents })
      .returning();
    try {
      const purchase = await ctx.klix.createPurchase({
        amountCents: row.order.totalCents,
        name: `${row.order.ref} — ${row.itemTitle}`.slice(0, 250),
        reference: row.order.ref,
        clientEmail: row.order.customerEmail,
        language,
        successCallback: `${ctx.config.publicBaseUrl}/api/public/payments/klix/callback?payment=${payment!.id}`,
        successRedirect: `${accountUrl}?paid=1&order=${encodeURIComponent(row.order.ref)}`,
        failureRedirect: `${accountUrl}?paid=0&order=${encodeURIComponent(row.order.ref)}`,
        cancelRedirect: `${accountUrl}?paid=cancel&order=${encodeURIComponent(row.order.ref)}`,
      });
      await ctx.db
        .update(payments)
        .set({ providerId: purchase.id, checkoutUrl: purchase.checkoutUrl, providerStatus: purchase.status, updatedAt: ctx.now() })
        .where(eq(payments.id, payment!.id));
      return { checkoutUrl: purchase.checkoutUrl };
    } catch (err) {
      await ctx.db
        .update(payments)
        .set({ status: "failed", providerStatus: "create_error", updatedAt: ctx.now() })
        .where(eq(payments.id, payment!.id));
      req.log?.error({ err, orderRef: ref }, "klix purchase creation failed");
      const status = err instanceof KlixError ? 502 : 500;
      return reply.code(status).send({ error: "payment_provider_error" });
    }
  });

  /**
   * Klix success callback (server-to-server). Deliberately unauthenticated —
   * the payment id is an unguessable UUID and the handler only acts on what
   * the provider itself reports when we re-fetch the purchase. Always 200 so
   * Klix doesn't retry forever on states we consider final.
   */
  app.post("/api/public/payments/klix/callback", async (req, reply) => {
    const { payment: paymentId } = req.query as { payment?: string };
    if (!paymentId || !/^[0-9a-f-]{36}$/i.test(paymentId)) return reply.code(400).send({ error: "bad_payment_id" });
    const [payment] = await ctx.db.select().from(payments).where(eq(payments.id, paymentId));
    if (!payment) return reply.code(404).send({ error: "not_found" });
    await reconcilePayment(payment);
    return { ok: true };
  });

  /**
   * Storefront poll after the redirect back. Reconciles against the provider
   * while the payment is still in flight, so a lost callback can't strand a
   * paid order.
   */
  app.get("/api/public/orders/:ref/payment", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const { ref } = req.params as { ref: string };
    const row = await ownOrderByRef(ref, bidderId);
    if (!row) return reply.code(404).send({ error: "not_found" });
    const [payment] = await ctx.db
      .select()
      .from(payments)
      .where(eq(payments.orderId, row.order.id))
      .orderBy(desc(payments.createdAt))
      .limit(1);
    let paymentStatus = payment?.status ?? null;
    if (payment && payment.status === "created" && row.order.status === "awaiting_payment") {
      paymentStatus = await reconcilePayment(payment);
    }
    const [fresh] = await ctx.db
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.id, row.order.id));
    return { orderStatus: fresh!.status, paymentStatus };
  });
}
