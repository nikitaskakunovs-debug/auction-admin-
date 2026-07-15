import { notifications, orders, payments, refunds } from "@auction/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

beforeAll(async () => {
  world = await createWorld();
  adminToken = await loginAs(world, "super@auction.test");
  klix = world.ctx.klix as SimulatedKlixClient;
  expect(klix).toBeInstanceOf(SimulatedKlixClient);
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

describe("mode gating", () => {
  it("pay returns 503 when KLIX_MODE=off", async () => {
    const buyer = await registerBidder("pay_off");
    const { ref } = await unpaidOrder(buyer.accessToken);
    const saved = world.ctx.klix;
    world.ctx.klix = null;
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
      world.ctx.klix = saved;
    }
  });
});
