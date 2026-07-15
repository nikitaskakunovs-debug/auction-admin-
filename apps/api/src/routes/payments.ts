import { items, orders, payments } from "@auction/db";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { verifyPayLinkToken } from "../auth/jwt.js";
import type { AppContext } from "../context.js";
import { InbankError } from "../engine/inbank.js";
import { KlixError } from "../engine/klix.js";
import { settleOrderPaid } from "../engine/settlement.js";

/**
 * Online payment through two hosted providers:
 *  - Klix   — cards, banklinks, Klix Pay Later (BNPL)
 *  - Inbank — hire purchase / installments (BNPL) via the e-POS flow
 *
 * Bidder-facing flow (identical for both):
 *
 *   POST /api/public/orders/:ref/pay {provider} → { checkoutUrl } (redirect)
 *   …customer completes the flow on the provider's page…
 *   provider → POST /api/public/payments/<provider>/callback?payment=<id>
 *   browser → back to /account?paid=1&order=<ref>, which polls
 *   GET  /api/public/orders/:ref/payment  until the order flips to paid.
 *
 * Trust model (both providers document it identically): callbacks are hints,
 * never proof — on any callback or poll we re-fetch the purchase/session by
 * id and settle only on the provider's own paid-equivalent status ("paid"
 * for Klix, "completed" for Inbank). Settlement is idempotent.
 */

export type PayProvider = "klix" | "inbank";

/** How long a created checkout stays reusable before we mint a fresh one. */
const CHECKOUT_REUSE_MS = 30 * 60 * 1000;

const ACTORS: Record<PayProvider, { id: null; label: string }> = {
  klix: { id: null, label: "Klix" },
  inbank: { id: null, label: "Inbank" },
};

function mapKlixStatus(providerStatus: string): "created" | "paid" | "failed" | "expired" {
  if (providerStatus === "paid") return "paid";
  if (providerStatus === "expired") return "expired";
  if (["error", "blocked", "cancelled", "released", "chargeback"].includes(providerStatus)) return "failed";
  return "created"; // created / pending_execute / viewed / hold — still in flight
}

function mapInbankStatus(providerStatus: string): "created" | "paid" | "failed" | "expired" {
  // Docs: ONLY "completed" means the order is paid. "granted" is credit
  // approval — the contract may still need signing — so it stays in flight.
  if (providerStatus === "completed") return "paid";
  if (providerStatus === "expired") return "expired";
  if (["rejected", "cancelled", "failed", "terminated"].includes(providerStatus)) return "failed";
  return "created"; // pending / granted / processing — still in flight
}

const mapProviderStatus = (provider: string, providerStatus: string) =>
  provider === "inbank" ? mapInbankStatus(providerStatus) : mapKlixStatus(providerStatus);

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

  interface ProviderState {
    status: string;
    /** Payment method used (Klix) — how BNPL/banklink/card is told apart. */
    method: string | null;
    /** Full provider object — persisted so admin sees terms/contract data. */
    raw: Record<string, unknown>;
  }

  /** Fetch the provider-side state of a payment row (null = unknown/gone). */
  async function fetchProviderState(payment: typeof payments.$inferSelect): Promise<ProviderState | null> {
    if (!payment.providerId) return null;
    if (payment.provider === "inbank") {
      if (!ctx.inbank) return null;
      const session = await ctx.inbank.getSession(payment.providerId);
      return session ? { status: session.status, method: "inbank_installments", raw: session.raw } : null;
    }
    if (!ctx.klix) return null;
    const purchase = await ctx.klix.getPurchase(payment.providerId);
    return purchase ? { status: purchase.status, method: purchase.method, raw: purchase.raw } : null;
  }

  /**
   * Re-check one payment row against its provider and settle the order if
   * the purchase/session is paid. Used by the callbacks and the poll.
   */
  async function reconcilePayment(payment: typeof payments.$inferSelect): Promise<string> {
    const state = await fetchProviderState(payment);
    if (state === null) return payment.status;
    const providerStatus = state.status;
    const status = mapProviderStatus(payment.provider, providerStatus);
    if (status !== payment.status || providerStatus !== payment.providerStatus || state.method !== payment.method) {
      await ctx.db
        .update(payments)
        .set({ status, providerStatus, method: state.method ?? payment.method, raw: state.raw, updatedAt: ctx.now() })
        .where(eq(payments.id, payment.id));
    }
    if (status === "paid") {
      // Idempotent: a second callback (or a poll racing the callback) finds
      // the order already paid and no-ops.
      await settleOrderPaid(ctx, payment.orderId, ACTORS[payment.provider as PayProvider] ?? ACTORS.klix, {
        via: payment.provider,
        paymentId: payment.id,
        purchaseId: payment.providerId,
      });
    }
    return status;
  }

  /**
   * ONE open checkout per order — across every entry point (web button,
   * email pay link) AND across providers. That is the double-payment guard:
   * a single provider purchase/session can only be paid once, and switching
   * provider (or going stale after 30 min) supersedes the previous checkout
   * — cancelled at the provider where supported (Klix) — before a fresh one
   * is created. `channel` records which door the customer came through.
   */
  async function openCheckout(
    row: { order: typeof orders.$inferSelect; itemTitle: string },
    provider: PayProvider,
    channel: "web" | "email",
    language: string,
  ): Promise<{ ok: true; checkoutUrl: string } | { ok: false; status: number; error: string }> {
    if ((provider === "klix" && !ctx.klix) || (provider === "inbank" && !ctx.inbank)) {
      return { ok: false, status: 503, error: "payments_unavailable" };
    }
    const [existing] = await ctx.db
      .select()
      .from(payments)
      .where(and(eq(payments.orderId, row.order.id), eq(payments.status, "created")))
      .orderBy(desc(payments.createdAt))
      .limit(1);
    if (
      existing?.checkoutUrl &&
      existing.provider === provider &&
      // A fulfilment change reprices the order — a checkout carrying a stale
      // amount must never be reused, only superseded.
      existing.amountCents === row.order.totalCents &&
      ctx.now().getTime() - existing.createdAt.getTime() < CHECKOUT_REUSE_MS
    ) {
      return { ok: true, checkoutUrl: existing.checkoutUrl };
    }
    if (existing) {
      // Supersede the previous checkout (stale, or the customer switched
      // provider). First make sure it wasn't just paid — never mask real
      // money — then kill it at the provider where an API exists (Klix;
      // Inbank sessions can't be cancelled remotely, but a superseded row
      // is dropped locally and a late "completed" on it still settles the
      // order idempotently or surfaces as an extra paid attempt in admin).
      const status = await reconcilePayment(existing);
      if (status === "paid") return { ok: false, status: 409, error: "order_not_awaiting_payment" };
      if (existing.provider === "klix" && existing.providerId && ctx.klix) {
        try {
          await ctx.klix.cancelPurchase(existing.providerId);
        } catch {
          // already dead at the provider, or transient — the reconcile above
          // is the safety net either way
        }
      }
      await ctx.db
        .update(payments)
        .set({ status: "expired", updatedAt: ctx.now() })
        .where(and(eq(payments.id, existing.id), eq(payments.status, "created")));
    }

    const accountUrl = `${ctx.config.storefrontBaseUrl}/account`;
    const ref = encodeURIComponent(row.order.ref);
    const [payment] = await ctx.db
      .insert(payments)
      .values({ orderId: row.order.id, provider, channel, amountCents: row.order.totalCents })
      .returning();
    const callbackUrl = `${ctx.config.publicBaseUrl}/api/public/payments/${provider}/callback?payment=${payment!.id}`;
    try {
      let checkoutUrl: string | null;
      let providerId: string;
      let providerStatus: string;
      if (provider === "inbank") {
        const session = await ctx.inbank!.createSession({
          amountCents: row.order.totalCents,
          reference: row.order.ref,
          redirectUrl: `${accountUrl}?paid=1&order=${ref}`,
          cancelUrl: `${accountUrl}?paid=cancel&order=${ref}`,
          callbackUrl,
        });
        checkoutUrl = session.redirectUrl;
        providerId = session.id;
        providerStatus = session.status;
      } else {
        const purchase = await ctx.klix!.createPurchase({
          amountCents: row.order.totalCents,
          name: `${row.order.ref} — ${row.itemTitle}`.slice(0, 250),
          reference: row.order.ref,
          clientEmail: row.order.customerEmail,
          language,
          successCallback: callbackUrl,
          successRedirect: `${accountUrl}?paid=1&order=${ref}`,
          failureRedirect: `${accountUrl}?paid=0&order=${ref}`,
          cancelRedirect: `${accountUrl}?paid=cancel&order=${ref}`,
          // Hard-expire the checkout at the payment deadline so a stale link
          // can't collect money for an order that was cancelled as unpaid.
          dueAt:
            row.order.paymentDeadlineAt && row.order.paymentDeadlineAt.getTime() > ctx.now().getTime()
              ? row.order.paymentDeadlineAt
              : null,
        });
        checkoutUrl = purchase.checkoutUrl;
        providerId = purchase.id;
        providerStatus = purchase.status;
      }
      await ctx.db
        .update(payments)
        .set({ providerId, checkoutUrl, providerStatus, updatedAt: ctx.now() })
        .where(eq(payments.id, payment!.id));
      return { ok: true, checkoutUrl: checkoutUrl! };
    } catch (err) {
      await ctx.db
        .update(payments)
        .set({ status: "failed", providerStatus: "create_error", updatedAt: ctx.now() })
        .where(eq(payments.id, payment!.id));
      app.log?.error({ err, orderRef: row.order.ref, provider }, "checkout creation failed");
      return { ok: false, status: err instanceof KlixError || err instanceof InbankError ? 502 : 500, error: "payment_provider_error" };
    }
  }

  /**
   * Public payment capabilities for the storefront: whether online payments
   * are on and the Brand ID the Klix Pay Later calculator widget needs (the
   * Brand ID is public — it appears in every merchant's page source; only
   * the Secret key is confidential and never leaves the server).
   */
  app.get("/api/public/payments/config", async () => ({
    enabled: ctx.klix !== null || ctx.inbank !== null,
    payLaterBrandId: ctx.klix !== null && ctx.config.klix?.brandId ? ctx.config.klix.brandId : null,
    providers: {
      klix: ctx.klix !== null,
      inbank: ctx.inbank !== null,
    },
  }));

  /** The provider the email pay link (no explicit choice) lands on. */
  const defaultProvider = (): PayProvider | null => (ctx.klix ? "klix" : ctx.inbank ? "inbank" : null);

  const paySchema = z.object({
    language: z.enum(["lv", "ru", "en", "et", "lt"]).optional(),
    provider: z.enum(["klix", "inbank"]).optional(),
  });

  /** Start (or resume) checkout for the bidder's own unpaid order. */
  app.post("/api/public/orders/:ref/pay", async (req, reply) => {
    const bidderId = requireBidder(req, reply);
    if (!bidderId) return;
    const body = paySchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const provider = body.data.provider ?? defaultProvider();
    if (!provider) return reply.code(503).send({ error: "payments_unavailable" });
    const { ref } = req.params as { ref: string };
    const row = await ownOrderByRef(ref, bidderId);
    if (!row) return reply.code(404).send({ error: "not_found" });
    if (row.order.status !== "awaiting_payment") return reply.code(409).send({ error: "order_not_awaiting_payment" });
    const language = body.data.language ?? MARKET_LANGUAGE[row.order.marketCode] ?? "en";
    const result = await openCheckout(row, provider, "web", language);
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
    const provider = defaultProvider();
    if (!provider) return reply.redirect(accountUrl);
    const language = MARKET_LANGUAGE[row.order.marketCode] ?? "en";
    const result = await openCheckout(row, provider, "email", language);
    if (!result.ok) {
      return result.error === "order_not_awaiting_payment"
        ? reply.redirect(`${accountUrl}?paid=1&order=${encodeURIComponent(ref)}`)
        : reply.redirect(`${accountUrl}?paid=0&order=${encodeURIComponent(ref)}`);
    }
    return reply.redirect(result.checkoutUrl);
  });

  /**
   * Provider callbacks (server-to-server). Deliberately unauthenticated —
   * the payment id is an unguessable UUID and the handler only acts on what
   * the provider itself reports when we re-fetch the purchase/session.
   * Always 200 on known payments so providers don't retry forever on states
   * we consider final. Inbank's callback also accepts GET — their docs allow
   * both browser-borne and server-to-server notifications.
   */
  const callbackHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const { payment: paymentId } = req.query as { payment?: string };
    if (!paymentId || !/^[0-9a-f-]{36}$/i.test(paymentId)) return reply.code(400).send({ error: "bad_payment_id" });
    const [payment] = await ctx.db.select().from(payments).where(eq(payments.id, paymentId));
    if (!payment) return reply.code(404).send({ error: "not_found" });
    await reconcilePayment(payment);
    return { ok: true };
  };
  app.post("/api/public/payments/klix/callback", callbackHandler);
  app.post("/api/public/payments/inbank/callback", callbackHandler);
  app.get("/api/public/payments/inbank/callback", callbackHandler);

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
    // provider lets the storefront tell a slow BNPL approval ("processing,
    // you'll get an email") apart from an abandoned card payment.
    return { orderStatus: fresh!.status, paymentStatus, provider: payment?.provider ?? null };
  });
}
