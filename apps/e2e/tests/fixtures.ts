import { type APIRequestContext, expect } from "@playwright/test";

const API = "http://localhost:4000";

/** Unique-ish suffix without Date.now() collisions across a serial run. */
let counter = 0;
export function uniq(prefix: string): string {
  counter += 1;
  return `${prefix}${counter}_${Math.random().toString(36).slice(2, 7)}`;
}

async function adminToken(request: APIRequestContext, email = "super@auction.test"): Promise<string> {
  const res = await request.post(`${API}/api/auth/login`, { data: { email, password: "Admin123!" } });
  expect(res.ok(), `admin login ${email}`).toBeTruthy();
  return (await res.json()).accessToken as string;
}

const authHeaders = (token: string) => ({ authorization: `Bearer ${token}` });

/**
 * Provision a fresh auction via the admin API and wait until the scheduler
 * has opened it (status live). Returns the public auction id.
 */
export async function createLiveAuction(
  request: APIRequestContext,
  opts: { startPriceCents?: number; endsInSec?: number; reserveCents?: number; antiSnipeSec?: number } = {},
): Promise<{ auctionId: string; sku: string; title: string }> {
  const token = await adminToken(request);
  const sku = uniq("E2E-");
  const title = `E2E lot ${sku}`;
  const h = authHeaders(token);

  const item = await request.post(`${API}/api/items`, { headers: h, data: { sku, title, marketCode: "LV" } });
  expect(item.ok(), "create item").toBeTruthy();
  const itemId = (await item.json()).item.id as string;

  const listing = await request.post(`${API}/api/listings`, {
    headers: h,
    data: {
      itemId,
      type: "auction",
      title,
      marketCode: "LV",
      startPriceCents: opts.startPriceCents ?? 1_000,
      ...(opts.reserveCents ? { reserveCents: opts.reserveCents } : {}),
      ...(opts.antiSnipeSec !== undefined ? { antiSnipeSec: opts.antiSnipeSec } : {}),
    },
  });
  expect(listing.ok(), "create listing").toBeTruthy();
  const listingId = (await listing.json()).listing.id as string;

  const pub = await request.post(`${API}/api/listings/${listingId}/publish`, { headers: h });
  expect(pub.ok(), "publish listing").toBeTruthy();

  const now = Date.now();
  const auction = await request.post(`${API}/api/auctions`, {
    headers: h,
    data: {
      listingId,
      startsAt: new Date(now - 2_000).toISOString(),
      endsAt: new Date(now + (opts.endsInSec ?? 3600) * 1000).toISOString(),
    },
  });
  expect(auction.ok(), "create auction").toBeTruthy();
  const auctionId = (await auction.json()).auction.id as string;

  // The scheduler opens due auctions on its ~1s tick.
  await expect
    .poll(async () => {
      const r = await request.get(`${API}/api/public/auctions/${auctionId}`);
      return r.ok() ? (await r.json()).auction.status : "unknown";
    }, { timeout: 15_000, message: "auction did not open" })
    .toBe("live");

  return { auctionId, sku, title };
}

/** Register a bidder directly via the public API (for the "other" bidder). */
export async function registerBidderApi(
  request: APIRequestContext,
  alias: string,
): Promise<{ token: string; id: string; alias: string }> {
  const res = await request.post(`${API}/api/public/auth/register`, {
    data: { email: `${alias}@e2e.test`, alias, password: "Bidder123!", country: "LV" },
  });
  expect(res.ok(), `register bidder ${alias}`).toBeTruthy();
  const body = await res.json();
  return { token: body.accessToken, id: body.bidder.id, alias: body.bidder.alias };
}

export async function placeBidApi(
  request: APIRequestContext,
  token: string,
  auctionId: string,
  maxCents: number,
): Promise<void> {
  const res = await request.post(`${API}/api/public/auctions/${auctionId}/bids`, {
    headers: authHeaders(token),
    data: { maxCents },
  });
  expect(res.ok(), "place bid via api").toBeTruthy();
}

/** Provision a published fixed-price listing via the admin API. */
export async function createFixedListing(
  request: APIRequestContext,
  opts: { priceCents?: number } = {},
): Promise<{ listingId: string; sku: string; title: string }> {
  const token = await adminToken(request);
  const h = authHeaders(token);
  const sku = uniq("FX-");
  const title = `E2E fixed ${sku}`;

  const item = await request.post(`${API}/api/items`, { headers: h, data: { sku, title, marketCode: "LV" } });
  const itemId = (await item.json()).item.id as string;
  const listing = await request.post(`${API}/api/listings`, {
    headers: h,
    data: { itemId, type: "fixed", title, marketCode: "LV", priceCents: opts.priceCents ?? 12_000 },
  });
  expect(listing.ok(), "create fixed listing").toBeTruthy();
  const listingId = (await listing.json()).listing.id as string;
  const pub = await request.post(`${API}/api/listings/${listingId}/publish`, { headers: h });
  expect(pub.ok(), "publish fixed listing").toBeTruthy();
  return { listingId, sku, title };
}

export async function markOrderPaid(request: APIRequestContext, orderRef: string): Promise<void> {
  const token = await adminToken(request, "ops@auction.test");
  const h = authHeaders(token);
  const list = await request.get(`${API}/api/orders?status=awaiting_payment`, { headers: h });
  const order = (await list.json()).orders.find((o: { ref: string }) => o.ref === orderRef);
  expect(order, `order ${orderRef} awaiting payment`).toBeTruthy();
  const res = await request.post(`${API}/api/orders/${order.id}/mark-paid`, { headers: h });
  expect(res.ok(), "mark paid").toBeTruthy();
}
