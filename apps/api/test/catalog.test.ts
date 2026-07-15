import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createWorld, loginAs, type TestWorld } from "./helpers.js";

let world: TestWorld;
let lister: string;

beforeAll(async () => {
  world = await createWorld();
  lister = await loginAs(world, "listings@auction.test");
});
afterAll(async () => {
  await world.close();
});

async function publishFixed(title: string, category: string): Promise<string> {
  const app = world.server.app;
  const sku = `CAT-${Math.random().toString(36).slice(2, 9)}`;
  const item = await app.inject({
    method: "POST",
    url: "/api/items",
    headers: auth(lister),
    payload: { sku, title, marketCode: "LV", condition: "brand_new", category },
  });
  expect(item.statusCode).toBe(200);
  const itemId = (item.json() as { item: { id: string } }).item.id;
  const listing = await app.inject({
    method: "POST",
    url: "/api/listings",
    headers: auth(lister),
    payload: { itemId, type: "fixed", title, marketCode: "LV", priceCents: 4_000, quantity: 1 },
  });
  const listingId = (listing.json() as { listing: { id: string } }).listing.id;
  await app.inject({ method: "POST", url: `/api/listings/${listingId}/publish`, headers: auth(lister) });
  return listingId;
}

describe("public catalog browse", () => {
  it("filters fixed listings by search text and category, exposes category, and pages", async () => {
    const app = world.server.app;
    await publishFixed("Makita angle grinder 125mm", "tools");
    await publishFixed("Makita cordless vacuum", "appliances");
    await publishFixed("Velvet armchair, green", "furniture");

    const byText = await app.inject({ method: "GET", url: "/api/public/listings?q=makita" });
    const textHits = (byText.json() as { listings: Array<{ title: string; category: string }> }).listings;
    expect(textHits).toHaveLength(2);
    expect(textHits.every((l) => l.title.toLowerCase().includes("makita"))).toBe(true);

    const byCat = await app.inject({ method: "GET", url: "/api/public/listings?category=tools" });
    const catHits = (byCat.json() as { listings: Array<{ category: string }> }).listings;
    expect(catHits).toHaveLength(1);
    expect(catHits[0]!.category).toBe("tools");

    const both = await app.inject({ method: "GET", url: "/api/public/listings?q=makita&category=appliances" });
    expect((both.json() as { listings: unknown[] }).listings).toHaveLength(1);

    const paged = await app.inject({ method: "GET", url: "/api/public/listings?limit=2" });
    const page = paged.json() as { listings: unknown[]; hasMore: boolean };
    expect(page.listings).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    const rest = await app.inject({ method: "GET", url: "/api/public/listings?limit=2&offset=2" });
    expect((rest.json() as { hasMore: boolean }).hasMore).toBe(false);
  });

  it("rejects unknown categories at item creation", async () => {
    const res = await world.server.app.inject({
      method: "POST",
      url: "/api/items",
      headers: auth(lister),
      payload: { sku: "CAT-BAD", title: "Bad category", marketCode: "LV", category: "spaceships" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("filters auctions by category and search", async () => {
    const app = world.server.app;
    const { createLiveAuction } = await import("./helpers.js");
    const { itemId, auctionId } = await createLiveAuction(world, lister);
    await app.inject({
      method: "PATCH",
      url: `/api/items/${itemId}`,
      headers: auth(lister),
      payload: { category: "electronics" },
    });

    const byCat = await app.inject({ method: "GET", url: "/api/public/auctions?category=electronics" });
    const hits = (byCat.json() as { auctions: Array<{ id: string; category: string }> }).auctions;
    expect(hits.some((a) => a.id === auctionId)).toBe(true);
    expect(hits.every((a) => a.category === "electronics")).toBe(true);

    const none = await app.inject({ method: "GET", url: "/api/public/auctions?category=fashion" });
    expect((none.json() as { auctions: unknown[] }).auctions).toHaveLength(0);
  });
});
