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

  it("отдаёт завершённые торги свежими вперёд", async () => {
    // Страница результатов живёт этой выдачей: при сортировке от старых к
    // новым свежие торги выпадали, как только завершённых становилось больше
    // лимита страницы.
    const app = world.server.app;
    const { auctions, items, listings } = await import("@auction/db");
    const now = Date.now();
    for (const [sku, endedHoursAgo] of [["END-OLD", 200], ["END-NEW", 1]] as const) {
      const [item] = await world.ctx.db
        .insert(items)
        .values({ sku, title: `Ended ${sku}`, marketCode: "LV", status: "unsold", category: "other", description: "", photos: [] })
        .returning({ id: items.id });
      const [listing] = await world.ctx.db
        .insert(listings)
        .values({ itemId: item!.id, type: "auction", title: `Ended ${sku}`, marketCode: "LV", startPriceCents: 1_000, status: "published" })
        .returning({ id: listings.id });
      await world.ctx.db.insert(auctions).values({
        listingId: listing!.id, status: "ended_no_bids",
        startsAt: new Date(now - (endedHoursAgo + 24) * 3_600_000),
        endsAt: new Date(now - endedHoursAgo * 3_600_000),
        closedAt: new Date(now - endedHoursAgo * 3_600_000),
        bidCount: 0, reserveMet: false,
      });
    }
    const res = await app.inject({ method: "GET", url: "/api/public/auctions?status=ended&limit=100" });
    const rows = (res.json() as { auctions: Array<{ sku: string; endsAt: string }> }).auctions;
    const iNew = rows.findIndex((a) => a.sku === "END-NEW");
    const iOld = rows.findIndex((a) => a.sku === "END-OLD");
    expect(iNew, "свежий в выдаче").toBeGreaterThanOrEqual(0);
    expect(iOld, "старый в выдаче").toBeGreaterThanOrEqual(0);
    expect(iNew, "свежий раньше старого").toBeLessThan(iOld);
  });

  /**
   * Каждая из двенадцати категорий должна быть проходимой насквозь: предмет
   * заводится с кодом, лот публикуется, витрина находит его по этому коду и не
   * находит по чужому.
   *
   * Написан после того, как в админке поле категории писало не в ту переменную:
   * всё, что заводилось через этот экран, уходило в базу с «other», и на
   * витрине каждая категория стояла пустой. Со стороны API всё было в порядке —
   * поэтому одной проверки API мало, но она хотя бы фиксирует контракт, на
   * который опирается экран.
   */
  it("проводит каждую из двенадцати категорий от предмета до витрины", async () => {
    const app = world.server.app;
    const { CATEGORY_CODES } = await import("@auction/domain");

    expect(CATEGORY_CODES).toHaveLength(12);

    for (const code of CATEGORY_CODES) {
      const title = `Kategorijas parbaude ${code}`;
      await publishFixed(title, code);

      const hit = await app.inject({ method: "GET", url: `/api/public/listings?category=${code}` });
      expect(hit.statusCode, `${code}: витрина отвечает`).toBe(200);
      const rows = (hit.json() as { listings: Array<{ title: string; category: string }> }).listings;
      expect(rows.some((l) => l.title === title), `${code}: лот виден в своей категории`).toBe(true);
      expect(rows.every((l) => l.category === code), `${code}: чужих лотов в выдаче нет`).toBe(true);
    }
  });
});
