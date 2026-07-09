import { customers, invoices, items, listings, orders } from "@auction/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buyNow } from "../src/engine/purchase.js";
import { auth, createBidder, createWorld, loginAs, type TestWorld } from "./helpers.js";

let world: TestWorld;
let adminToken: string;

beforeAll(async () => {
  world = await createWorld();
  adminToken = await loginAs(world, "super@auction.test");
});
afterAll(async () => {
  await world.close();
});

/** Create a published fixed-price listing with the given quantity. */
async function createFixedListing(opts: { priceCents?: number; quantity?: number } = {}): Promise<{ listingId: string; itemId: string; sku: string }> {
  const app = world.server.app;
  const sku = `FX-${Math.random().toString(36).slice(2, 9)}`;
  const item = await app.inject({ method: "POST", url: "/api/items", headers: auth(adminToken), payload: { sku, title: `Fixed ${sku}`, marketCode: "LV" } });
  const itemId = (item.json() as { item: { id: string } }).item.id;
  const listing = await app.inject({
    method: "POST",
    url: "/api/listings",
    headers: auth(adminToken),
    payload: { itemId, type: "fixed", title: `Fixed ${sku}`, marketCode: "LV", priceCents: opts.priceCents ?? 10_000, quantity: opts.quantity ?? 1 },
  });
  const listingId = (listing.json() as { listing: { id: string } }).listing.id;
  await app.inject({ method: "POST", url: `/api/listings/${listingId}/publish`, headers: auth(adminToken) });
  return { listingId, itemId, sku };
}

async function registerBidder(alias: string, extra: Record<string, unknown> = {}) {
  const res = await world.server.app.inject({
    method: "POST",
    url: "/api/public/auth/register",
    payload: { email: `${alias}@buy.test`, alias, password: "Bidder123!", country: "LV" },
  });
  const body = res.json() as { accessToken: string; bidder: { id: string } };
  if (Object.keys(extra).length) await world.ctx.db.update(customers).set(extra).where(eq(customers.id, body.bidder.id));
  return body;
}

describe("fixed-price buy it now", () => {
  it("browse lists published fixed listings; buy creates an order + invoice and closes the listing", async () => {
    const { listingId, itemId } = await createFixedListing({ priceCents: 10_000, quantity: 1 });

    const browse = await world.server.app.inject({ method: "GET", url: "/api/public/listings" });
    expect(browse.statusCode).toBe(200);
    const found = (browse.json() as { listings: Array<{ id: string; priceCents: number }> }).listings.find((l) => l.id === listingId)!;
    expect(found.priceCents).toBe(10_000);
    // Hygiene: no reserve/max/email leakage on the fixed-price surface.
    expect(browse.body).not.toContain("reserveCents");
    expect(browse.body).not.toContain("@");

    const buyer = await registerBidder("buy_anna");
    const res = await world.server.app.inject({
      method: "POST",
      url: `/api/public/listings/${listingId}/buy`,
      headers: auth(buyer.accessToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { orderRef: string; totalCents: number };
    // €100 + 0 premium + 21% VAT = €121.00 (no buyer's premium on fixed price).
    expect(body.totalCents).toBe(12_100);

    const [order] = await world.ctx.db.select().from(orders).where(eq(orders.ref, body.orderRef));
    expect(order!.premiumCents).toBe(0);
    expect(order!.vatCents).toBe(2_100);
    expect(order!.status).toBe("awaiting_payment");

    const [inv] = await world.ctx.db.select().from(invoices).where(eq(invoices.orderId, order!.id));
    expect(inv).toBeDefined();

    const [item] = await world.ctx.db.select().from(items).where(eq(items.id, itemId));
    expect(item!.status).toBe("awaiting_payment");

    const [listing] = await world.ctx.db.select().from(listings).where(eq(listings.id, listingId));
    expect(listing!.quantity).toBe(0);
    expect(listing!.status).toBe("archived");

    // A second buy on the now-sold listing is rejected as unavailable.
    const buyer2 = await registerBidder("buy_bob");
    const again = await world.server.app.inject({
      method: "POST",
      url: `/api/public/listings/${listingId}/buy`,
      headers: auth(buyer2.accessToken),
    });
    expect(again.statusCode).toBe(409);
    expect((again.json() as { code: string }).code).toBe("NOT_AVAILABLE");
    // And it no longer appears in the public browse.
    const browse2 = await world.server.app.inject({ method: "GET", url: "/api/public/listings" });
    expect((browse2.json() as { listings: Array<{ id: string }> }).listings.some((l) => l.id === listingId)).toBe(false);
  });

  it("stock-safe under concurrency: two buyers race a single unit, exactly one wins", async () => {
    const { listingId } = await createFixedListing({ priceCents: 5_000, quantity: 1 });
    const a = await registerBidder(`race_a_${Math.random().toString(36).slice(2, 6)}`);
    const b = await registerBidder(`race_b_${Math.random().toString(36).slice(2, 6)}`);
    const [ra, rb] = await Promise.all([
      buyNow(world.ctx, { listingId, customerId: a.bidder.id }),
      buyNow(world.ctx, { listingId, customerId: b.bidder.id }),
    ]);
    const wins = [ra, rb].filter((r) => r.ok).length;
    expect(wins).toBe(1);
    const [listing] = await world.ctx.db.select().from(listings).where(eq(listings.id, listingId));
    expect(listing!.quantity).toBe(0);
    // Exactly one order exists for the listing.
    const ordersForListing = await world.ctx.db.select().from(orders).where(eq(orders.listingId, listingId));
    expect(ordersForListing.length).toBe(1);
  });

  it("requires a bidder token and rejects blocked bidders", async () => {
    const { listingId } = await createFixedListing();
    const anon = await world.server.app.inject({ method: "POST", url: `/api/public/listings/${listingId}/buy` });
    expect(anon.statusCode).toBe(401);

    const admin = await world.server.app.inject({ method: "POST", url: `/api/public/listings/${listingId}/buy`, headers: auth(adminToken) });
    expect(admin.statusCode).toBe(401); // admin token is not a bidder token

    const blocked = await registerBidder("buy_blocked", { blocked: true });
    const res = await world.server.app.inject({ method: "POST", url: `/api/public/listings/${listingId}/buy`, headers: auth(blocked.accessToken) });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe("BIDDER_BLOCKED");
  });

  it("reverse charge applies for a validated EU-VAT buyer", async () => {
    const { listingId } = await createFixedListing({ priceCents: 10_000 });
    const buyer = await registerBidder("buy_ee", {
      country: "EE",
      vatNo: "EE123456789",
      vies: { valid: true, checkedAt: new Date().toISOString(), consult: "WEE1" },
    });
    const res = await world.server.app.inject({ method: "POST", url: `/api/public/listings/${listingId}/buy`, headers: auth(buyer.accessToken) });
    expect(res.statusCode).toBe(200);
    const [order] = await world.ctx.db.select().from(orders).where(eq(orders.ref, (res.json() as { orderRef: string }).orderRef));
    expect(order!.reverseCharge).toBe(true);
    expect(order!.vatCents).toBe(0);
    expect(order!.totalCents).toBe(10_000);
  });

  it("cannot buy an auction-type listing through the fixed-price endpoint", async () => {
    // Build an auction listing and try to buy it.
    const sku = `AU-${Math.random().toString(36).slice(2, 7)}`;
    const item = await world.server.app.inject({ method: "POST", url: "/api/items", headers: auth(adminToken), payload: { sku, title: sku, marketCode: "LV" } });
    const itemId = (item.json() as { item: { id: string } }).item.id;
    const listing = await world.server.app.inject({ method: "POST", url: "/api/listings", headers: auth(adminToken), payload: { itemId, type: "auction", title: sku, marketCode: "LV", startPriceCents: 1_000 } });
    const listingId = (listing.json() as { listing: { id: string } }).listing.id;
    await world.server.app.inject({ method: "POST", url: `/api/listings/${listingId}/publish`, headers: auth(adminToken) });

    const buyer = await registerBidder(`au_${Math.random().toString(36).slice(2, 6)}`);
    const res = await world.server.app.inject({ method: "POST", url: `/api/public/listings/${listingId}/buy`, headers: auth(buyer.accessToken) });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe("NOT_FIXED_PRICE");
  });
});
