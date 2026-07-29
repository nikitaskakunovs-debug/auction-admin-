import { customerFees, customers, items, listings } from "@auction/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createWorld, loginAs, type TestWorld } from "./helpers.js";

/** A3 — power list queries, bidder tags, bulk listing actions, badges. */

let world: TestWorld;
let adminToken: string; // super_admin
let contentToken: string; // content_editor — almost no permissions

beforeAll(async () => {
  world = await createWorld();
  adminToken = await loginAs(world, "super@auction.test");
  contentToken = await loginAs(world, "content@auction.test");
});
afterAll(async () => {
  await world.close();
});

const get = <T>(url: string, token = adminToken) =>
  world.server.app.inject({ method: "GET", url, headers: auth(token) }).then((r) => ({ status: r.statusCode, body: r.json() as T }));

describe("items power query", () => {
  beforeAll(async () => {
    await world.ctx.db.insert(items).values([
      { sku: "PL-100", title: "Power drill", marketCode: "LV", category: "tools", condition: "used_good", status: "draft" },
      { sku: "PL-101", title: "Power saw", marketCode: "LV", category: "tools", condition: "damaged_functional", status: "listed" },
      { sku: "PL-102", title: "Garden hose", marketCode: "EE", category: "garden", condition: "brand_new", status: "draft" },
    ]);
  });

  it("filters by market/category/statuses with totals and status counts", async () => {
    const r = await get<{ items: Array<{ sku: string }>; total: number; counts: Record<string, number> }>(
      "/api/items?market=LV&category=tools&limit=10&offset=0",
    );
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(2);
    expect(r.body.items.map((i) => i.sku).sort()).toEqual(["PL-100", "PL-101"]);
    // Counts keyed by status, ignoring any status filter itself.
    expect(r.body.counts.draft).toBe(1);
    expect(r.body.counts.listed).toBe(1);

    const drafts = await get<{ items: Array<{ sku: string }>; total: number; counts: Record<string, number> }>(
      "/api/items?market=LV&category=tools&statuses=draft",
    );
    expect(drafts.body.total).toBe(1);
    expect(drafts.body.counts.listed).toBe(1); // pill label survives the filter
  });

  it("paginates", async () => {
    const page1 = await get<{ items: unknown[]; total: number }>("/api/items?category=tools&limit=1&offset=0");
    const page2 = await get<{ items: unknown[]; total: number }>("/api/items?category=tools&limit=1&offset=1");
    expect(page1.body.items).toHaveLength(1);
    expect(page2.body.items).toHaveLength(1);
    expect(page1.body.total).toBe(2);
  });
});

describe("bidder tags + customers power query", () => {
  let tagVip: string;
  let tagRisk: string;
  let cAnna: string;
  let cBoris: string;

  beforeAll(async () => {
    const tags = await get<{ tags: Array<{ id: string; name: string; color: string }> }>("/api/customer-tags");
    expect(tags.status).toBe(200);
    // The A3 starter set is seeded once.
    expect(tags.body.tags.map((t) => t.name)).toContain("VIP");
    tagVip = tags.body.tags.find((t) => t.name === "VIP")!.id;
    tagRisk = tags.body.tags.find((t) => t.name === "Risk")!.id;

    const [a] = await world.ctx.db.insert(customers).values({ email: "anna@pl.test", alias: "anna_lv", country: "LV" }).returning({ id: customers.id });
    cAnna = a!.id;

    // Boris gets a real order so his outstanding restock fee has its FK anchor.
    const reg = await world.server.app.inject({
      method: "POST",
      url: "/api/public/auth/register",
      payload: { email: "boris@pl.test", alias: "boris_ee", password: "Bidder123!", country: "EE" },
    });
    expect(reg.statusCode).toBe(200);
    const borisToken = (reg.json() as { accessToken: string }).accessToken;
    const [b] = await world.ctx.db.select({ id: customers.id }).from(customers).where(eq(customers.email, "boris@pl.test"));
    cBoris = b!.id;

    const item = await world.server.app.inject({
      method: "POST",
      url: "/api/items",
      headers: auth(adminToken),
      payload: { sku: "PL-FEE", title: "Fee item", marketCode: "LV" },
    });
    const itemId = (item.json() as { item: { id: string } }).item.id;
    const listing = await world.server.app.inject({
      method: "POST",
      url: "/api/listings",
      headers: auth(adminToken),
      payload: { itemId, type: "fixed", title: "Fee listing", marketCode: "LV", priceCents: 3000, quantity: 1 },
    });
    const listingId = (listing.json() as { listing: { id: string } }).listing.id;
    await world.server.app.inject({ method: "POST", url: `/api/listings/${listingId}/publish`, headers: auth(adminToken) });
    const buy = await world.server.app.inject({ method: "POST", url: `/api/public/listings/${listingId}/buy`, headers: auth(borisToken) });
    expect(buy.statusCode).toBe(200);
    const { orderRef } = buy.json() as { orderRef: string };
    const { orders } = await import("@auction/db");
    const [order] = await world.ctx.db.select().from(orders).where(eq(orders.ref, orderRef));
    await world.ctx.db.insert(customerFees).values({
      customerId: cBoris,
      orderId: order!.id,
      orderRef,
      type: "unpaid_restock",
      amountCents: 4200,
      status: "outstanding",
    });
  });

  it("assigns tags per bidder and rejects unknown tag ids", async () => {
    const ok = await world.server.app.inject({
      method: "POST",
      url: `/api/customers/${cAnna}/tags`,
      headers: auth(adminToken),
      payload: { tagIds: [tagVip] },
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { customer: { tags: string[] } }).customer.tags).toEqual([tagVip]);

    const bad = await world.server.app.inject({
      method: "POST",
      url: `/api/customers/${cAnna}/tags`,
      headers: auth(adminToken),
      payload: { tagIds: [cAnna] }, // a uuid, but not a tag
    });
    expect(bad.statusCode).toBe(422);
  });

  it("bulk add/remove updates only rows that change", async () => {
    const r = await world.server.app.inject({
      method: "POST",
      url: "/api/customers/bulk/tags",
      headers: auth(adminToken),
      payload: { ids: [cAnna, cBoris], add: [tagVip, tagRisk] },
    });
    expect(r.statusCode).toBe(200);
    // Anna already had VIP → she still changes (gains Risk); both update.
    expect((r.json() as { updated: number }).updated).toBe(2);

    const again = await world.server.app.inject({
      method: "POST",
      url: "/api/customers/bulk/tags",
      headers: auth(adminToken),
      payload: { ids: [cAnna, cBoris], add: [tagVip] },
    });
    expect((again.json() as { updated: number }).updated).toBe(0); // no-op skips
  });

  it("filters by tag / country / debt with status counts", async () => {
    const byTag = await get<{ customers: Array<{ alias: string }>; total: number }>(`/api/customers?tag=${tagVip}`);
    expect(byTag.body.total).toBe(2);

    const byCountry = await get<{ customers: Array<{ alias: string; outstandingFeeCents: number }>; total: number }>(
      "/api/customers?country=EE",
    );
    expect(byCountry.body.total).toBe(1);
    expect(byCountry.body.customers[0]!.alias).toBe("boris_ee");
    expect(byCountry.body.customers[0]!.outstandingFeeCents).toBe(4200);

    const byDebt = await get<{ customers: Array<{ alias: string }>; counts: { all: number; active: number } }>(
      "/api/customers?debt=has",
    );
    expect(byDebt.body.customers.map((c) => c.alias)).toEqual(["boris_ee"]);
    expect(byDebt.body.counts.all).toBe(1);
  });

  it("tag vocabulary management needs settings.edit", async () => {
    const denied = await world.server.app.inject({
      method: "POST",
      url: "/api/customer-tags",
      headers: auth(contentToken),
      payload: { name: "Nope", color: "blue" },
    });
    expect(denied.statusCode).toBe(403);

    const created = await world.server.app.inject({
      method: "POST",
      url: "/api/customer-tags",
      headers: auth(adminToken),
      payload: { name: "Collector", color: "blue" },
    });
    expect(created.statusCode).toBe(200);
    const dupe = await world.server.app.inject({
      method: "POST",
      url: "/api/customer-tags",
      headers: auth(adminToken),
      payload: { name: "Collector", color: "red" },
    });
    expect(dupe.statusCode).toBe(409);
  });
});

describe("listings power query + bulk actions", () => {
  const mkListing = async (title: string, type: "auction" | "fixed" = "auction") => {
    const item = await world.server.app.inject({
      method: "POST",
      url: "/api/items",
      headers: auth(adminToken),
      payload: { sku: `PLL-${title}`, title: `Item ${title}`, marketCode: "LV" },
    });
    const itemId = (item.json() as { item: { id: string } }).item.id;
    const res = await world.server.app.inject({
      method: "POST",
      url: "/api/listings",
      headers: auth(adminToken),
      payload: {
        itemId, type, title, marketCode: "LV",
        ...(type === "auction" ? { startPriceCents: 1000 } : { priceCents: 2000 }),
      },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { listing: { id: string } }).listing.id;
  };

  it("searches by title with totals + counts and paginates", async () => {
    await mkListing("BulkA");
    await mkListing("BulkB");
    const r = await get<{ listings: Array<{ title: string }>; total: number; counts: Record<string, number> }>(
      "/api/listings?q=Bulk&limit=1&offset=0",
    );
    expect(r.body.total).toBe(2);
    expect(r.body.listings).toHaveLength(1);
    expect(r.body.counts.draft).toBe(2);
  });

  it("bulk publishes with an auction schedule; failures are reported per id", async () => {
    const l1 = await mkListing("BulkPub1");
    const l2 = await mkListing("BulkPub2");
    const now = world.ctx.now().getTime();
    const r = await world.server.app.inject({
      method: "POST",
      url: "/api/listings/bulk/publish",
      headers: auth(adminToken),
      payload: {
        ids: [l1, l2, "00000000-0000-4000-8000-000000000000"],
        schedule: { startsAt: new Date(now + 60_000).toISOString(), endsAt: new Date(now + 3_660_000).toISOString() },
      },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { published: number; scheduled: number; failed: Array<{ id: string; error: string }> };
    expect(body.published).toBe(2);
    expect(body.scheduled).toBe(2);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0]!.error).toBe("not_found");

    const [row] = await world.ctx.db.select().from(listings).where(eq(listings.id, l1));
    expect(row!.status).toBe("published");
  });

  it("bulk archive touches drafts only", async () => {
    const draft = await mkListing("BulkArch1");
    const published = await mkListing("BulkArch2");
    await world.server.app.inject({ method: "POST", url: `/api/listings/${published}/publish`, headers: auth(adminToken) });
    const r = await world.server.app.inject({
      method: "POST",
      url: "/api/listings/bulk/archive",
      headers: auth(adminToken),
      payload: { ids: [draft, published] },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ archived: 1, skipped: 1 });
    const [pub] = await world.ctx.db.select().from(listings).where(eq(listings.id, published));
    expect(pub!.status).toBe("published"); // untouched
  });
});

describe("payments + invoices pagination", () => {
  it("payments respond with total and the unfiltered summary tiles", async () => {
    const r = await get<{ payments: unknown[]; total: number; summary: { todayCents: number; weekCents: number; pendingCount: number } }>(
      "/api/payments?limit=5",
    );
    expect(r.status).toBe(200);
    expect(typeof r.body.total).toBe("number");
    expect(typeof r.body.summary.todayCents).toBe("number");
  });

  it("invoices accept q/from/to/limit", async () => {
    const r = await get<{ invoices: unknown[]; total: number }>("/api/invoices?q=ZZZ-NOPE&limit=5");
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(0);
  });
});

describe("badges", () => {
  it("returns permission-scoped counts", async () => {
    const r = await get<{ badges: Record<string, number> }>("/api/badges");
    expect(r.status).toBe(200);
    // Super admin sees every key; nothing is pending in a fresh world.
    for (const key of ["pickup", "receiving", "inventory", "notifications"]) {
      expect(r.body.badges).toHaveProperty(key);
    }

    const limited = await get<{ badges: Record<string, number> }>("/api/badges", contentToken);
    expect(limited.status).toBe(200);
    // Content editor holds none of the pill permissions.
    expect(Object.keys(limited.body.badges)).toHaveLength(0);
  });

  it("counts pending grading reviews", async () => {
    await world.ctx.db.insert(items).values({ sku: "PL-BDG", title: "Badge item", marketCode: "LV", gradeStatus: "pending_review" });
    const r = await get<{ badges: Record<string, number> }>("/api/badges");
    expect(r.body.badges.receiving).toBe(1);
  });
});
