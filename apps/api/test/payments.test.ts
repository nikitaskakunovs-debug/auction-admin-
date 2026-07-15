import { notifications, orders, payments, refunds } from "@auction/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SimulatedInbankClient } from "../src/engine/inbank.js";
import { SimulatedKlixClient } from "../src/engine/klix.js";
import { auth, createWorld, loginAs, type TestWorld } from "./helpers.js";

/**
 * Klix checkout flow against the simulated driver: create purchase → redirect
 * URL → provider callback → GET-verify → settle. The simulated client is the
 * provider; tests flip its purchase status and hit the callback exactly the
 * way Klix would.
 */

let world: TestWorld;
let adminToken: string;
let klix: SimulatedKlixClient;
let inbank: SimulatedInbankClient;

beforeAll(async () => {
  world = await createWorld();
  adminToken = await loginAs(world, "super@auction.test");
  klix = world.ctx.klix as SimulatedKlixClient;
  inbank = world.ctx.inbank as SimulatedInbankClient;
  expect(klix).toBeInstanceOf(SimulatedKlixClient);
  expect(inbank).toBeInstanceOf(SimulatedInbankClient);
});
afterAll(async () => {
  await world.close();
});

async function registerBidder(alias: string) {
  const res = await world.server.app.inject({
    method: "POST",
    url: "/api/public/auth/register",
    payload: { email: `${alias}@pay.test`, alias, password: "Bidder123!", country: "LV" },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { accessToken: string; bidder: { id: string } };
}

/** Fixed-price purchase → order awaiting payment (deterministic). */
async function unpaidOrder(buyerToken: string, priceCents = 11_000): Promise<{ orderId: string; ref: string }> {
  const app = world.server.app;
  const sku = `PAY-${Math.random().toString(36).slice(2, 9)}`;
  const item = await app.inject({ method: "POST", url: "/api/items", headers: auth(adminToken), payload: { sku, title: `Pay ${sku}`, marketCode: "LV" } });
  const itemId = (item.json() as { item: { id: string } }).item.id;
  const listing = await app.inject({
    method: "POST",
    url: "/api/listings",
    headers: auth(adminToken),
    payload: { itemId, type: "fixed", title: `Pay ${sku}`, marketCode: "LV", priceCents, quantity: 1 },
  });
  const listingId = (listing.json() as { listing: { id: string } }).listing.id;
  await app.inject({ method: "POST", url: `/api/listings/${listingId}/publish`, headers: auth(adminToken) });
  const buy = await app.inject({ method: "POST", url: `/api/public/listings/${listingId}/buy`, headers: auth(buyerToken) });
  expect(buy.statusCode).toBe(200);
  const { orderRef } = buy.json() as { orderRef: string };
  const [order] = await world.ctx.db.select().from(orders).where(eq(orders.ref, orderRef));
  return { orderId: order!.id, ref: orderRef };
}

async function startCheckout(ref: string, token: string) {
  const res = await world.server.app.inject({
    method: "POST",
    url: `/api/public/orders/${ref}/pay`,
    headers: auth(token),
    payload: {},
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { checkoutUrl: string };
}

async function paymentRow(orderId: string) {
  const rows = await world.ctx.db.select().from(payments).where(eq(payments.orderId, orderId));
  return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

describe("checkout creation", () => {
  it("creates a Klix purchase and returns its checkout URL", async () => {
    const buyer = await registerBidder("pay_anna");
    const { orderId, ref } = await unpaidOrder(buyer.accessToken);
    const { checkoutUrl } = await startCheckout(ref, buyer.accessToken);
    expect(checkoutUrl).toContain("https://klix.simulated/checkout/");

    const [p] = await paymentRow(orderId);
    expect(p!.status).toBe("created");
    expect(p!.channel).toBe("web");
    expect(p!.amountCents).toBe(13_310); // 11000 + 10% premium + 21% VAT
    expect(p!.providerId).toBeTruthy();
    expect(p!.checkoutUrl).toBe(checkoutUrl);
  });

  it("reuses the open checkout on a second click instead of stacking purchases", async () => {
    const buyer = await registerBidder("pay_reuse");
    const { orderId, ref } = await unpaidOrder(buyer.accessToken);
    const first = await startCheckout(ref, buyer.accessToken);
    const second = await startCheckout(ref, buyer.accessToken);
    expect(second.checkoutUrl).toBe(first.checkoutUrl);
    expect((await paymentRow(orderId)).length).toBe(1);
  });

  it("rejects paying someone else's order and unknown refs", async () => {
    const owner = await registerBidder("pay_owner");
    const thief = await registerBidder("pay_thief");
    const { ref } = await unpaidOrder(owner.accessToken);
    const res = await world.server.app.inject({
      method: "POST",
      url: `/api/public/orders/${ref}/pay`,
      headers: auth(thief.accessToken),
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    const anon = await world.server.app.inject({ method: "POST", url: `/api/public/orders/${ref}/pay`, payload: {} });
    expect(anon.statusCode).toBe(401);
  });

  it("refuses orders that are not awaiting payment", async () => {
    const buyer = await registerBidder("pay_done");
    const { orderId, ref } = await unpaidOrder(buyer.accessToken);
    await world.server.app.inject({ method: "POST", url: `/api/orders/${orderId}/mark-paid`, headers: auth(adminToken) });
    const res = await world.server.app.inject({
      method: "POST",
      url: `/api/public/orders/${ref}/pay`,
      headers: auth(buyer.accessToken),
      payload: {},
    });
    expect(res.statusCode).toBe(409);
  });
});

describe("callback settlement (GET-verify trust model)", () => {
  it("paid purchase → callback settles the order with pickup code", async () => {
    const buyer = await registerBidder("pay_cb");
    const { orderId, ref } = await unpaidOrder(buyer.accessToken);
    await startCheckout(ref, buyer.accessToken);
    const [p] = await paymentRow(orderId);

    klix.setStatus(p!.providerId!, "paid");
    const cb = await world.server.app.inject({
      method: "POST",
      url: `/api/public/payments/klix/callback?payment=${p!.id}`,
    });
    expect(cb.statusCode).toBe(200);

    const [order] = await world.ctx.db.select().from(orders).where(eq(orders.id, orderId));
    expect(order!.status).toBe("paid");
    expect(order!.pickupCode).toMatch(/^\d{6}$/);
    expect(order!.pickupDeadlineAt).not.toBeNull();
    const [pAfter] = await paymentRow(orderId);
    expect(pAfter!.status).toBe("paid");
    expect(pAfter!.providerStatus).toBe("paid");
  });

  it("is idempotent — a duplicate callback changes nothing", async () => {
    const buyer = await registerBidder("pay_cb2");
    const { orderId, ref } = await unpaidOrder(buyer.accessToken);
    await startCheckout(ref, buyer.accessToken);
    const [p] = await paymentRow(orderId);
    klix.setStatus(p!.providerId!, "paid");

    for (let i = 0; i < 2; i++) {
      const cb = await world.server.app.inject({ method: "POST", url: `/api/public/payments/klix/callback?payment=${p!.id}` });
      expect(cb.statusCode).toBe(200);
    }
    const [order] = await world.ctx.db.select().from(orders).where(eq(orders.id, orderId));
    expect(order!.status).toBe("paid");
    const codeBefore = order!.pickupCode;
    const cb3 = await world.server.app.inject({ method: "POST", url: `/api/public/payments/klix/callback?payment=${p!.id}` });
    expect(cb3.statusCode).toBe(200);
    const [again] = await world.ctx.db.select().from(orders).where(eq(orders.id, orderId));
    expect(again!.pickupCode).toBe(codeBefore);
  });

  it("a callback for an unpaid purchase does NOT settle (spoofed callback is harmless)", async () => {
    const buyer = await registerBidder("pay_spoof");
    const { orderId, ref } = await unpaidOrder(buyer.accessToken);
    await startCheckout(ref, buyer.accessToken);
    const [p] = await paymentRow(orderId);
    // Purchase still "created" at the provider — an attacker hitting the
    // callback URL accomplishes nothing because we re-fetch before settling.
    const cb = await world.server.app.inject({ method: "POST", url: `/api/public/payments/klix/callback?payment=${p!.id}` });
    expect(cb.statusCode).toBe(200);
    const [order] = await world.ctx.db.select().from(orders).where(eq(orders.id, orderId));
    expect(order!.status).toBe("awaiting_payment");
    expect(order!.pickupCode).toBeNull();
  });

  it("expired purchase marks the payment expired, order stays payable", async () => {
    const buyer = await registerBidder("pay_exp");
    const { orderId, ref } = await unpaidOrder(buyer.accessToken);
    await startCheckout(ref, buyer.accessToken);
    const [p] = await paymentRow(orderId);
    klix.setStatus(p!.providerId!, "expired");
    await world.server.app.inject({ method: "POST", url: `/api/public/payments/klix/callback?payment=${p!.id}` });
    const [pAfter] = await paymentRow(orderId);
    expect(pAfter!.status).toBe("expired");
    const [order] = await world.ctx.db.select().from(orders).where(eq(orders.id, orderId));
    expect(order!.status).toBe("awaiting_payment");
  });
});

describe("storefront poll fallback", () => {
  it("poll reconciles a paid purchase even when the callback never arrived", async () => {
    const buyer = await registerBidder("pay_poll");
    const { orderId, ref } = await unpaidOrder(buyer.accessToken);
    await startCheckout(ref, buyer.accessToken);
    const [p] = await paymentRow(orderId);
    klix.setStatus(p!.providerId!, "paid");

    const res = await world.server.app.inject({
      method: "GET",
      url: `/api/public/orders/${ref}/payment`,
      headers: auth(buyer.accessToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ orderStatus: "paid", paymentStatus: "paid" });

    const [order] = await world.ctx.db.select().from(orders).where(eq(orders.id, orderId));
    expect(order!.status).toBe("paid");
    expect(order!.pickupCode).toMatch(/^\d{6}$/);
  });

  it("poll is owner-only", async () => {
    const owner = await registerBidder("pay_poll_own");
    const other = await registerBidder("pay_poll_other");
    const { ref } = await unpaidOrder(owner.accessToken);
    const res = await world.server.app.inject({
      method: "GET",
      url: `/api/public/orders/${ref}/payment`,
      headers: auth(other.accessToken),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("pay-by-link (email channel)", () => {
  /** Pull the one-click pay URL out of the buyer's "purchased" email. */
  async function payLinkFromEmail(ref: string): Promise<{ path: string; url: string }> {
    const rows = await world.ctx.db.select().from(notifications).where(eq(notifications.type, "purchased"));
    const n = rows.find((r) => r.body.includes(`/api/public/pay/${encodeURIComponent(ref)}`));
    expect(n, `no purchased email with a pay link for ${ref}`).toBeDefined();
    const url = n!.body.match(/https?:\/\/\S+/g)!.find((u) => u.includes("/api/public/pay/"))!;
    const parsed = new URL(url);
    return { path: parsed.pathname + parsed.search, url };
  }

  it("the purchase email carries a pay link that opens checkout without login", async () => {
    const buyer = await registerBidder("link_anna");
    const { orderId, ref } = await unpaidOrder(buyer.accessToken);
    const { path } = await payLinkFromEmail(ref);
    const res = await world.server.app.inject({ method: "GET", url: path }); // deliberately unauthenticated
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("https://klix.simulated/checkout/");
    const [p] = await paymentRow(orderId);
    expect(p!.channel).toBe("email");
  });

  it("web button and email link share ONE checkout — nothing to double-pay", async () => {
    const buyer = await registerBidder("link_share");
    const { orderId, ref } = await unpaidOrder(buyer.accessToken);
    const { checkoutUrl } = await startCheckout(ref, buyer.accessToken); // web first
    const { path } = await payLinkFromEmail(ref);
    const res = await world.server.app.inject({ method: "GET", url: path }); // email second
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(checkoutUrl); // the SAME Klix purchase
    expect((await paymentRow(orderId)).length).toBe(1);
  });

  it("email link on an already-paid order bounces to the account page, never a checkout", async () => {
    const buyer = await registerBidder("link_paid");
    const { orderId, ref } = await unpaidOrder(buyer.accessToken);
    await startCheckout(ref, buyer.accessToken);
    const [p] = await paymentRow(orderId);
    klix.setStatus(p!.providerId!, "paid");
    await world.server.app.inject({ method: "POST", url: `/api/public/payments/klix/callback?payment=${p!.id}` });

    const { path } = await payLinkFromEmail(ref);
    const res = await world.server.app.inject({ method: "GET", url: path });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("/account?paid=1");
    expect((await paymentRow(orderId)).length).toBe(1); // no new checkout appeared
  });

  it("a tampered or missing token is rejected", async () => {
    const buyer = await registerBidder("link_bad");
    const { ref } = await unpaidOrder(buyer.accessToken);
    const bad = await world.server.app.inject({ method: "GET", url: `/api/public/pay/${ref}?t=garbage` });
    expect(bad.statusCode).toBe(401);
    const none = await world.server.app.inject({ method: "GET", url: `/api/public/pay/${ref}` });
    expect(none.statusCode).toBe(401);
  });

  it("superseding a stale checkout cancels the old purchase at the provider", async () => {
    const buyer = await registerBidder("link_stale");
    const { orderId, ref } = await unpaidOrder(buyer.accessToken);
    const first = await startCheckout(ref, buyer.accessToken);
    const [p1] = await paymentRow(orderId);
    const { path } = await payLinkFromEmail(ref);
    try {
      world.setNow(new Date(Date.now() + 31 * 60 * 1000)); // past the reuse window
      // The session token has expired with the clock jump — the email pay
      // link (valid until the payment deadline) starts the fresh checkout.
      const res = await world.server.app.inject({ method: "GET", url: path });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).not.toBe(first.checkoutUrl);
      // The old link is dead at Klix itself — it can never take money again.
      expect(klix.inspect(p1!.providerId!)!.status).toBe("cancelled");
      const rows = await paymentRow(orderId);
      expect(rows.length).toBe(2);
      expect(rows.find((r) => r.id === p1!.id)!.status).toBe("expired");
    } finally {
      world.setNow(null);
    }
  });
});

describe("refunds through the provider", () => {
  /** Order paid via the full Klix flow; returns ids + the provider purchase id. */
  async function klixPaidOrder(alias: string) {
    const buyer = await registerBidder(alias);
    const { orderId, ref } = await unpaidOrder(buyer.accessToken);
    await startCheckout(ref, buyer.accessToken);
    const [p] = await paymentRow(orderId);
    klix.setStatus(p!.providerId!, "paid");
    await world.server.app.inject({ method: "POST", url: `/api/public/payments/klix/callback?payment=${p!.id}` });
    return { orderId, ref, providerId: p!.providerId! };
  }

  it("admin refund on a Klix-paid order returns the money via the provider", async () => {
    const { orderId, providerId } = await klixPaidOrder("ref_full");
    const res = await world.server.app.inject({
      method: "POST",
      url: `/api/orders/${orderId}/refund`,
      headers: auth(adminToken),
      payload: { amountCents: 13_310, reason: "item damaged in storage" },
    });
    expect(res.statusCode).toBe(200);
    // The simulated provider actually moved the money back.
    expect(klix.inspect(providerId)!.refundedCents).toBe(13_310);
    expect(klix.inspect(providerId)!.status).toBe("refunded");
    const [order] = await world.ctx.db.select().from(orders).where(eq(orders.id, orderId));
    expect(order!.status).toBe("refunded");
  });

  it("partial refund keeps the order paid and tracks the provider remainder", async () => {
    const { orderId, providerId } = await klixPaidOrder("ref_part");
    const res = await world.server.app.inject({
      method: "POST",
      url: `/api/orders/${orderId}/refund`,
      headers: auth(adminToken),
      payload: { amountCents: 3_000, reason: "goodwill partial refund" },
    });
    expect(res.statusCode).toBe(200);
    expect(klix.inspect(providerId)!.refundedCents).toBe(3_000);
    expect(klix.inspect(providerId)!.status).toBe("paid");
    const [order] = await world.ctx.db.select().from(orders).where(eq(orders.id, orderId));
    expect(order!.status).toBe("paid");
  });

  it("provider rejection blocks the refund — no phantom ledger row", async () => {
    const { orderId, providerId } = await klixPaidOrder("ref_reject");
    // Simulate a purchase Klix would refuse to refund (e.g. released/blocked).
    klix.setStatus(providerId, "blocked");
    const res = await world.server.app.inject({
      method: "POST",
      url: `/api/orders/${orderId}/refund`,
      headers: auth(adminToken),
      payload: { amountCents: 1_000, reason: "should not be recorded" },
    });
    expect(res.statusCode).toBe(502);
    expect((res.json() as { error: string }).error).toBe("klix_refund_failed");
    const rows = await world.ctx.db.select().from(refunds).where(eq(refunds.orderId, orderId));
    expect(rows.length).toBe(0);
  });

  it("over-total refund is rejected before any provider call", async () => {
    const { orderId, providerId } = await klixPaidOrder("ref_over");
    const res = await world.server.app.inject({
      method: "POST",
      url: `/api/orders/${orderId}/refund`,
      headers: auth(adminToken),
      payload: { amountCents: 99_999, reason: "way too much" },
    });
    expect(res.statusCode).toBe(422);
    expect(klix.inspect(providerId)!.refundedCents).toBe(0);
  });

  it("viaProvider=false records only — the provider is untouched", async () => {
    const { orderId, providerId } = await klixPaidOrder("ref_manual");
    const res = await world.server.app.inject({
      method: "POST",
      url: `/api/orders/${orderId}/refund`,
      headers: auth(adminToken),
      payload: { amountCents: 13_310, reason: "refunded in the Klix portal", viaProvider: false },
    });
    expect(res.statusCode).toBe(200);
    expect(klix.inspect(providerId)!.refundedCents).toBe(0);
    const [order] = await world.ctx.db.select().from(orders).where(eq(orders.id, orderId));
    expect(order!.status).toBe("refunded");
  });

  it("manually-paid orders (no Klix payment) refund record-only as before", async () => {
    const buyer = await registerBidder("ref_cash");
    const { orderId } = await unpaidOrder(buyer.accessToken);
    await world.server.app.inject({ method: "POST", url: `/api/orders/${orderId}/mark-paid`, headers: auth(adminToken) });
    const res = await world.server.app.inject({
      method: "POST",
      url: `/api/orders/${orderId}/refund`,
      headers: auth(adminToken),
      payload: { amountCents: 5_000, reason: "cash refund at the counter" },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("checkout hard-expiry", () => {
  it("the purchase carries the order's payment deadline as a strict due", async () => {
    const buyer = await registerBidder("due_check");
    const { orderId, ref } = await unpaidOrder(buyer.accessToken);
    await startCheckout(ref, buyer.accessToken);
    const [p] = await paymentRow(orderId);
    const [order] = await world.ctx.db.select().from(orders).where(eq(orders.id, orderId));
    const input = klix.inspect(p!.providerId!)!.input;
    expect(input.dueAt?.getTime()).toBe(order!.paymentDeadlineAt!.getTime());
  });
});

describe("Inbank BNPL (e-POS sessions)", () => {
  async function startInbank(ref: string, token: string) {
    const res = await world.server.app.inject({
      method: "POST",
      url: `/api/public/orders/${ref}/pay`,
      headers: auth(token),
      payload: { provider: "inbank" },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as { checkoutUrl: string };
  }

  it("creates a pos-session and records the inbank/web attempt", async () => {
    const buyer = await registerBidder("inb_anna");
    const { orderId, ref } = await unpaidOrder(buyer.accessToken);
    const { checkoutUrl } = await startInbank(ref, buyer.accessToken);
    expect(checkoutUrl).toContain("https://inbank.simulated/session/");
    const [p] = await paymentRow(orderId);
    expect(p!.provider).toBe("inbank");
    expect(p!.channel).toBe("web");
    expect(p!.status).toBe("created");
    expect(p!.amountCents).toBe(13_310);
    // Inbank receives the reference + our callback URL.
    const input = inbank.inspect(p!.providerId!)!.input;
    expect(input.reference).toBe(ref);
    expect(input.callbackUrl).toContain(`/api/public/payments/inbank/callback?payment=${p!.id}`);
  });

  it("'granted' (credit approved) does NOT settle — only 'completed' does", async () => {
    const buyer = await registerBidder("inb_granted");
    const { orderId, ref } = await unpaidOrder(buyer.accessToken);
    await startInbank(ref, buyer.accessToken);
    const [p] = await paymentRow(orderId);

    inbank.setStatus(p!.providerId!, "granted");
    await world.server.app.inject({ method: "POST", url: `/api/public/payments/inbank/callback?payment=${p!.id}` });
    let [order] = await world.ctx.db.select().from(orders).where(eq(orders.id, orderId));
    expect(order!.status).toBe("awaiting_payment"); // approval ≠ payment

    inbank.setStatus(p!.providerId!, "completed");
    const cb = await world.server.app.inject({ method: "POST", url: `/api/public/payments/inbank/callback?payment=${p!.id}` });
    expect(cb.statusCode).toBe(200);
    [order] = await world.ctx.db.select().from(orders).where(eq(orders.id, orderId));
    expect(order!.status).toBe("paid");
    expect(order!.pickupCode).toMatch(/^\d{6}$/);
    const [pAfter] = await paymentRow(orderId);
    expect(pAfter!.status).toBe("paid");
    expect(pAfter!.providerStatus).toBe("completed");
  });

  it("rejected session marks the attempt failed; the order stays payable", async () => {
    const buyer = await registerBidder("inb_reject");
    const { orderId, ref } = await unpaidOrder(buyer.accessToken);
    await startInbank(ref, buyer.accessToken);
    const [p] = await paymentRow(orderId);
    inbank.setStatus(p!.providerId!, "rejected");
    await world.server.app.inject({ method: "POST", url: `/api/public/payments/inbank/callback?payment=${p!.id}` });
    const [pAfter] = await paymentRow(orderId);
    expect(pAfter!.status).toBe("failed");
    const [order] = await world.ctx.db.select().from(orders).where(eq(orders.id, orderId));
    expect(order!.status).toBe("awaiting_payment");
    // The customer can immediately retry — with either provider.
    const retry = await startCheckout(ref, buyer.accessToken);
    expect(retry.checkoutUrl).toContain("klix.simulated");
  });

  it("switching provider supersedes the open Klix checkout (cancelled at Klix) — one open checkout ever", async () => {
    const buyer = await registerBidder("inb_switch");
    const { orderId, ref } = await unpaidOrder(buyer.accessToken);
    const klixFirst = await startCheckout(ref, buyer.accessToken);
    const [pKlix] = await paymentRow(orderId);
    expect(klixFirst.checkoutUrl).toContain("klix.simulated");

    const inbankSecond = await startInbank(ref, buyer.accessToken);
    expect(inbankSecond.checkoutUrl).toContain("inbank.simulated");
    // The Klix purchase is dead at the provider — its link can't take money.
    expect(klix.inspect(pKlix!.providerId!)!.status).toBe("cancelled");
    const rows = await paymentRow(orderId);
    expect(rows.filter((r) => r.status === "created").length).toBe(1);
    expect(rows.find((r) => r.id === pKlix!.id)!.status).toBe("expired");
  });

  it("a paid Klix checkout blocks opening an Inbank session (and vice versa)", async () => {
    const buyer = await registerBidder("inb_block");
    const { orderId, ref } = await unpaidOrder(buyer.accessToken);
    await startCheckout(ref, buyer.accessToken);
    const [pKlix] = await paymentRow(orderId);
    // Customer paid at Klix but neither callback nor poll has landed yet.
    klix.setStatus(pKlix!.providerId!, "paid");
    const res = await world.server.app.inject({
      method: "POST",
      url: `/api/public/orders/${ref}/pay`,
      headers: auth(buyer.accessToken),
      payload: { provider: "inbank" },
    });
    // The supersede path reconciles first, finds real money, and refuses —
    // settling the order in the process.
    expect(res.statusCode).toBe(409);
    const [order] = await world.ctx.db.select().from(orders).where(eq(orders.id, orderId));
    expect(order!.status).toBe("paid");
  });

  it("refund on an Inbank-paid order refuses the API path and records manually", async () => {
    const buyer = await registerBidder("inb_refund");
    const { orderId, ref } = await unpaidOrder(buyer.accessToken);
    await startInbank(ref, buyer.accessToken);
    const [p] = await paymentRow(orderId);
    inbank.setStatus(p!.providerId!, "completed");
    await world.server.app.inject({ method: "POST", url: `/api/public/payments/inbank/callback?payment=${p!.id}` });

    // viaProvider (default) must refuse — there is no Inbank refund API.
    const auto = await world.server.app.inject({
      method: "POST",
      url: `/api/orders/${orderId}/refund`,
      headers: auth(adminToken),
      payload: { amountCents: 13_310, reason: "customer returned the item" },
    });
    expect(auto.statusCode).toBe(409);
    expect((auto.json() as { error: string }).error).toBe("provider_refund_unsupported");
    expect((await world.ctx.db.select().from(refunds).where(eq(refunds.orderId, orderId))).length).toBe(0);

    // After crediting the contract in the Inbank portal: record-only works.
    const manual = await world.server.app.inject({
      method: "POST",
      url: `/api/orders/${orderId}/refund`,
      headers: auth(adminToken),
      payload: { amountCents: 13_310, reason: "credited in Inbank portal", viaProvider: false },
    });
    expect(manual.statusCode).toBe(200);
    const [order] = await world.ctx.db.select().from(orders).where(eq(orders.id, orderId));
    expect(order!.status).toBe("refunded");
  });

  it("config lists both providers", async () => {
    const res = await world.server.app.inject({ method: "GET", url: "/api/public/payments/config" });
    expect(res.json()).toMatchObject({ enabled: true, providers: { klix: true, inbank: true } });
  });
});

describe("Pay Later calculator support", () => {
  it("payments config exposes enablement + the widget brand id", async () => {
    const res = await world.server.app.inject({ method: "GET", url: "/api/public/payments/config" });
    expect(res.statusCode).toBe(200);
    // Simulate mode: enabled, but no real brand id → the web widget stays hidden.
    expect(res.json()).toMatchObject({ enabled: true, payLaterBrandId: null });

    const savedKlix = world.ctx.klix;
    const savedInbank = world.ctx.inbank;
    world.ctx.klix = null;
    world.ctx.inbank = null;
    try {
      const off = await world.server.app.inject({ method: "GET", url: "/api/public/payments/config" });
      expect(off.json()).toMatchObject({ enabled: false, payLaterBrandId: null, providers: { klix: false, inbank: false } });
    } finally {
      world.ctx.klix = savedKlix;
      world.ctx.inbank = savedInbank;
    }
  });

  it("payment-due emails carry the representative example, resolved at dispatch", async () => {
    const buyer = await registerBidder("pl_email");
    const { ref } = await unpaidOrder(buyer.accessToken);
    const { dispatchNotifications } = await import("../src/engine/notifications.js");
    await dispatchNotifications(world.ctx, 1000);
    const sent = world.email.sent.find((e) => e.text.includes(ref) && e.text.includes("[purchased]"));
    expect(sent).toBeDefined();
    // The placeholder resolved into the (simulated) legal wording…
    expect(sent!.text).toContain("Representative example");
    expect(sent!.text).toContain("monthly payments");
    // …and no raw token leaked into the email.
    expect(sent!.text).not.toContain("KLIX_PL_EXAMPLE");
  });

  it("placeholder is stripped cleanly when Klix is off at dispatch time", async () => {
    const buyer = await registerBidder("pl_email_off");
    const { ref } = await unpaidOrder(buyer.accessToken);
    const saved = world.ctx.klix;
    world.ctx.klix = null;
    try {
      const { dispatchNotifications } = await import("../src/engine/notifications.js");
      await dispatchNotifications(world.ctx, 1000);
    } finally {
      world.ctx.klix = saved;
    }
    const sent = world.email.sent.find((e) => e.text.includes(ref) && e.text.includes("[purchased]"));
    expect(sent).toBeDefined();
    expect(sent!.text).not.toContain("KLIX_PL_EXAMPLE");
    expect(sent!.text).not.toContain("Representative example");
  });

  it("public auction + listing detail expose the exact checkout total", async () => {
    const app = world.server.app;
    // Fixed listing: price 11000 + 21% VAT, no premium → 13310.
    const sku = `PLT-${Math.random().toString(36).slice(2, 9)}`;
    const item = await app.inject({ method: "POST", url: "/api/items", headers: auth(adminToken), payload: { sku, title: `PL ${sku}`, marketCode: "LV" } });
    const itemId = (item.json() as { item: { id: string } }).item.id;
    const listing = await app.inject({
      method: "POST",
      url: "/api/listings",
      headers: auth(adminToken),
      payload: { itemId, type: "fixed", title: `PL ${sku}`, marketCode: "LV", priceCents: 11_000, quantity: 1 },
    });
    const listingId = (listing.json() as { listing: { id: string } }).listing.id;
    await app.inject({ method: "POST", url: `/api/listings/${listingId}/publish`, headers: auth(adminToken) });
    const detail = await app.inject({ method: "GET", url: `/api/public/listings/${listingId}` });
    expect((detail.json() as { listing: { estimatedTotalCents: number } }).listing.estimatedTotalCents).toBe(13_310);
  });
});

describe("admin payment visibility", () => {
  it("reconcile persists the method the customer used (BNPL vs banklink) + the raw snapshot", async () => {
    const buyer = await registerBidder("vis_method");
    const { orderId, ref } = await unpaidOrder(buyer.accessToken);
    await startCheckout(ref, buyer.accessToken);
    const [p] = await paymentRow(orderId);
    // Customer picked Pay Later on the Klix checkout page.
    klix.setStatus(p!.providerId!, "paid", "klix_pay_later");
    await world.server.app.inject({ method: "POST", url: `/api/public/payments/klix/callback?payment=${p!.id}` });
    const [after] = await paymentRow(orderId);
    expect(after!.method).toBe("klix_pay_later");
    expect(after!.raw).toMatchObject({ transaction_data: { payment_method: "klix_pay_later" } });
    // …and it shows on the admin order detail.
    const detail = await world.server.app.inject({ method: "GET", url: `/api/orders/${orderId}`, headers: auth(adminToken) });
    const payments = (detail.json() as { payments: Array<{ method: string | null; raw: unknown }> }).payments;
    expect(payments[0]!.method).toBe("klix_pay_later");
  });

  it("GET /api/payments lists attempts across orders with provider/status filters, admin-only", async () => {
    const buyer = await registerBidder("vis_list");
    const { ref } = await unpaidOrder(buyer.accessToken);
    await startCheckout(ref, buyer.accessToken);

    const anon = await world.server.app.inject({ method: "GET", url: "/api/payments" });
    expect(anon.statusCode).toBe(401);
    const asBidder = await world.server.app.inject({ method: "GET", url: "/api/payments", headers: auth(buyer.accessToken) });
    expect([401, 403]).toContain(asBidder.statusCode);

    const all = await world.server.app.inject({ method: "GET", url: "/api/payments", headers: auth(adminToken) });
    expect(all.statusCode).toBe(200);
    const rows = (all.json() as { payments: Array<{ orderRef: string; provider: string; customerAlias: string; status: string }> }).payments;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.find((r) => r.orderRef === ref)).toMatchObject({ provider: "klix", customerAlias: "vis_list" });

    const inbankOnly = await world.server.app.inject({ method: "GET", url: "/api/payments?provider=inbank", headers: auth(adminToken) });
    const inbankRows = (inbankOnly.json() as { payments: Array<{ provider: string }> }).payments;
    expect(inbankRows.length).toBeGreaterThan(0); // earlier Inbank tests created attempts
    expect(inbankRows.every((r) => r.provider === "inbank")).toBe(true);

    const paidOnly = await world.server.app.inject({ method: "GET", url: "/api/payments?status=paid", headers: auth(adminToken) });
    const paidRows = (paidOnly.json() as { payments: Array<{ status: string }> }).payments;
    expect(paidRows.every((r) => r.status === "paid")).toBe(true);
  });

  it("Inbank attempts carry the inbank_installments method after reconcile", async () => {
    const buyer = await registerBidder("vis_inb");
    const { orderId, ref } = await unpaidOrder(buyer.accessToken);
    await world.server.app.inject({
      method: "POST",
      url: `/api/public/orders/${ref}/pay`,
      headers: auth(buyer.accessToken),
      payload: { provider: "inbank" },
    });
    const [p] = await paymentRow(orderId);
    inbank.setStatus(p!.providerId!, "completed", { creditContractUuid: "cc-123", period: 12 });
    await world.server.app.inject({ method: "POST", url: `/api/public/payments/inbank/callback?payment=${p!.id}` });
    const [after] = await paymentRow(orderId);
    expect(after!.method).toBe("inbank_installments");
    // The contract terms Inbank reported are preserved for admin.
    expect(after!.raw).toMatchObject({ creditContractUuid: "cc-123", period: 12 });
  });
});

describe("mode gating", () => {
  it("pay returns 503 when every provider is off", async () => {
    const buyer = await registerBidder("pay_off");
    const { ref } = await unpaidOrder(buyer.accessToken);
    const savedKlix = world.ctx.klix;
    const savedInbank = world.ctx.inbank;
    world.ctx.klix = null;
    world.ctx.inbank = null;
    try {
      const res = await world.server.app.inject({
        method: "POST",
        url: `/api/public/orders/${ref}/pay`,
        headers: auth(buyer.accessToken),
        payload: {},
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ error: "payments_unavailable" });
    } finally {
      world.ctx.klix = savedKlix;
      world.ctx.inbank = savedInbank;
    }
  });

  it("falls back to Inbank when only Inbank is on, and 503s an explicit klix request", async () => {
    const buyer = await registerBidder("pay_inb_only");
    const { ref } = await unpaidOrder(buyer.accessToken);
    const savedKlix = world.ctx.klix;
    world.ctx.klix = null;
    try {
      const explicit = await world.server.app.inject({
        method: "POST",
        url: `/api/public/orders/${ref}/pay`,
        headers: auth(buyer.accessToken),
        payload: { provider: "klix" },
      });
      expect(explicit.statusCode).toBe(503);
      const fallback = await world.server.app.inject({
        method: "POST",
        url: `/api/public/orders/${ref}/pay`,
        headers: auth(buyer.accessToken),
        payload: {},
      });
      expect(fallback.statusCode).toBe(200);
      expect((fallback.json() as { checkoutUrl: string }).checkoutUrl).toContain("inbank.simulated");
    } finally {
      world.ctx.klix = savedKlix;
    }
  });
});
