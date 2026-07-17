import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createWorld, loginAs, type TestWorld } from "./helpers.js";

/** Phase A2: saved views CRUD + the filtered/paginated orders list. */

let world: TestWorld;
let token: string;

beforeAll(async () => {
  world = await createWorld();
  token = await loginAs(world, "super@auction.test");
});
afterAll(async () => {
  await world.close();
});

const app = () => world.server.app;

describe("saved views", () => {
  it("creates, lists, renames, and deletes a view — scoped to the owner", async () => {
    const created = await app().inject({
      method: "POST",
      url: "/api/views",
      headers: auth(token),
      payload: { screen: "orders", name: "Unpaid > 3 days", filters: { status: "awaiting_payment", sort: "oldest" } },
    });
    expect(created.statusCode).toBe(200);
    const view = (created.json() as { view: { id: string; name: string } }).view;

    const listed = await app().inject({ method: "GET", url: "/api/views?screen=orders", headers: auth(token) });
    expect((listed.json() as { views: Array<{ id: string }> }).views.some((v) => v.id === view.id)).toBe(true);

    // Another admin does NOT see it.
    const other = await loginAs(world, "finance@auction.test");
    const theirs = await app().inject({ method: "GET", url: "/api/views?screen=orders", headers: auth(other) });
    expect((theirs.json() as { views: unknown[] }).views).toEqual([]);
    // …and cannot rename or delete it.
    const foreignPatch = await app().inject({ method: "PATCH", url: `/api/views/${view.id}`, headers: auth(other), payload: { name: "hijack" } });
    expect(foreignPatch.statusCode).toBe(404);

    const renamed = await app().inject({ method: "PATCH", url: `/api/views/${view.id}`, headers: auth(token), payload: { name: "Oldest unpaid" } });
    expect((renamed.json() as { view: { name: string } }).view.name).toBe("Oldest unpaid");

    const gone = await app().inject({ method: "DELETE", url: `/api/views/${view.id}`, headers: auth(token) });
    expect(gone.statusCode).toBe(200);
  });

  it("rejects unauthenticated and malformed requests", async () => {
    const anon = await app().inject({ method: "GET", url: "/api/views?screen=orders" });
    expect(anon.statusCode).toBe(401);
    const bad = await app().inject({ method: "POST", url: "/api/views", headers: auth(token), payload: { screen: "NOT OK!", name: "x", filters: {} } });
    expect(bad.statusCode).toBe(400);
  });
});

describe("filtered orders list", () => {
  it("returns counts alongside the page and honors filters", async () => {
    const res = await app().inject({ method: "GET", url: "/api/orders?limit=10", headers: auth(token) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { orders: unknown[]; total: number; counts: Record<string, number> };
    expect(typeof body.total).toBe("number");
    expect(typeof body.counts.all).toBe("number");
    expect(body.orders.length).toBeLessThanOrEqual(10);

    // Market filter returns only that market (or nothing).
    const lv = await app().inject({ method: "GET", url: "/api/orders?market=lv", headers: auth(token) });
    const lvBody = lv.json() as { orders: Array<{ marketCode: string }> };
    for (const o of lvBody.orders) expect(o.marketCode).toBe("LV");

    // Amount band excludes everything when min is absurd.
    const none = await app().inject({ method: "GET", url: "/api/orders?min=99999999", headers: auth(token) });
    expect((none.json() as { total: number }).total).toBe(0);

    // Sort by amount ascending is monotonic.
    const sorted = await app().inject({ method: "GET", url: "/api/orders?sort=amount_asc&limit=50", headers: auth(token) });
    const totals = (sorted.json() as { orders: Array<{ totalCents: number }> }).orders.map((o) => o.totalCents);
    expect([...totals].sort((a, b) => a - b)).toEqual(totals);
  });
});
