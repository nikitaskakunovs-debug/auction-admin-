import { items, orders, payments } from "@auction/db";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { verifyPayLinkToken } from "../auth/jwt.js";
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

  /**
   * One open checkout per order, shared by EVERY entry point (storefront
   * button and email pay link). Both channels landing on the same Klix
   * purchase is the double-payment guard: one purchase can only be paid
   * once. A stale open checkout (>30 min) is superseded — cancelled at the
   * provider first, so its link stops accepting money — before a fresh one
   * is created. `channel` records which door the customer came through.
   */
  async function openCheckout(
    row: { order: typeof orders.$inferSelect; itemTitle: string },
    channel: "web" | "email",
    language: string,
  ): Promise<{ ok: true; checkoutUrl: string } | { ok: false; status: number; error: string }> {
    if (!ctx.klix) return { ok: false, status: 503, error: "payments_unavailable" };
    const [existing] = await ctx.db
      .select()
      .from(payments)
      .where(and(eq(payments.orderId, row.order.id), eq(payments.status, "created")))
      .orderBy(desc(payments.createdAt))
      .limit(1);
    if (existing?.checkoutUrl && ctx.now().getTime() - existing.createdAt.getTime() < CHECKOUT_REUSE_MS) {
      return { ok: true, checkoutUrl: existing.checkoutUrl };
    }
    if (existing) {
      // Kill the stale checkout at Klix before superseding it locally, so
      // an old tab or old email link can't pay the order a second time.
      // Best-effort: if the purchase meanwhile got paid, the cancel fails
      // and the callback/poll will settle it — never mask real money.
      if (existing.providerId) {
        try {
          await ctx.klix.cancelPurchase(existing.providerId);
        } catch {
          const status = await reconcilePayment(existing);
          if (status === "paid") return { ok: false, status: 409, error: "order_not_awaiting_payment" };
        }
      }
      await ctx.db
        .update(payments)
        .set({ status: "expired", updatedAt: ctx.now() })
        .where(and(eq(payments.id, existing.id), eq(payments.status, "created")));
    }

    const accountUrl = `${ctx.config.storefrontBaseUrl}/account`;
    const [payment] = await ctx.db
      .insert(payments)
      .values({ orderId: row.order.id, provider: "klix", channel, amountCents: row.order.totalCents })
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
        // Hard-expire the checkout at the payment deadline so a stale link
        // can't collect money for an order that was cancelled as unpaid.
        dueAt:
          row.order.paymentDeadlineAt && row.order.paymentDeadlineAt.getTime() > ctx.now().getTime()
            ? row.order.paymentDeadlineAt
            : null,
      });
      await ctx.db
        .update(payments)
        .set({ providerId: purchase.id, checkoutUrl: purchase.checkoutUrl, providerStatus: purchase.status, updatedAt: ctx.now() })
        .where(eq(payments.id, payment!.id));
      return { ok: true, checkoutUrl: purchase.checkoutUrl! };
    } catch (err) {
      await ctx.db
        .update(payments)
        .set({ status: "failed", providerStatus: "create_error", updatedAt: ctx.now() })
        .where(eq(payments.id, payment!.id));
      app.log?.error({ err, orderRef: row.order.ref }, "klix purchase creation failed");
      return { ok: false, status: err instanceof KlixError ? 502 : 500, error: "payment_provider_error" };
    }
  }

  /**
   * Public payment capabilities for the storefront: whether online payments
   * are on and the Brand ID the Klix Pay Later calculator widget needs (the
   * Brand ID is public — it appears in every merchant's page source; only
   * the Secret key is confidential and never leaves the server).
   */
  app.get("/api/public/payments/config", async () => ({
    enabled: ctx.klix !== null,
    payLaterBrandId: ctx.klix !== null && ctx.config.klix?.brandId ? ctx.config.klix.brandId : null,
  }));

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
    const language = body.data.language ?? MARKET_LANGUAGE[row.order.marketCode] ?? "en";
    const result = await openCheckout(row, "web", language);
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return { checkoutUrl: result.checkoutUrl };
  });

  /**
   * Pay-by-link from the won / reminder emails: one click straight into the
   * Klix checkout, no login. The signed token (see engine/payLink.ts)
   * authorizes exactly this order and expires with the payment deadline.
   * Already-paid orders bounce to the account page instead of a checkout —
   * the email link can never charge twice.
   */
  app.get("/api/public/pay/:ref", async (req, reply) => {
    const { ref } = req.params as { ref: string };
    const { t } = req.query as { t?: string };
    const accountUrl = `${ctx.config.storefrontBaseUrl}/account`;
    const claims = t ? verifyPayLinkToken(t, ctx.config.jwtSecret, ctx.now().getTime()) : null;
    if (!claims || claims.sub !== ref) return reply.code(401).send({ error: "invalid_pay_link" });
    const [row] = await ctx.db
      .select({ order: orders, itemTitle: items.title })
      .from(orders)
      .innerJoin(items, eq(orders.itemId, items.id))
      .where(eq(orders.ref, ref));
    if (!row) return reply.code(404).send({ error: "not_found" });
    if (row.order.status === "paid") {
      return reply.redirect(`${accountUrl}?paid=1&order=${encodeURIComponent(ref)}`);
    }
    if (row.order.status !== "awaiting_payment") {
      return reply.redirect(accountUrl);
    }
    if (!ctx.klix) return reply.redirect(accountUrl);
    const language = MARKET_LANGUAGE[row.order.marketCode] ?? "en";
    const result = await openCheckout(row, "email", language);
    if (!result.ok) {
      return result.error === "order_not_awaiting_payment"
        ? reply.redirect(`${accountUrl}?paid=1&order=${encodeURIComponent(ref)}`)
        : reply.redirect(`${accountUrl}?paid=0&order=${encodeURIComponent(ref)}`);
    }
    return reply.redirect(result.checkoutUrl);
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
