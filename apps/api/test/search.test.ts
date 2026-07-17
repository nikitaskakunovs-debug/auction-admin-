import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createWorld, loginAs, type TestWorld } from "./helpers.js";

/** Phase A1: the ⌘K global search endpoint. */

let world: TestWorld;
let superToken: string;

beforeAll(async () => {
  world = await createWorld();
  superToken = await loginAs(world, "super@auction.test");
  // A lot with a Latvian diacritic in the title for the accent-fold check.
  const res = await world.server.app.inject({
    method: "POST",
    url: "/api/items",
    headers: auth(superToken),
    payload: { sku: "SRCH-001", title: "Skrūvgriezis Makita 18V", marketCode: "LV" },
  });
  if (res.statusCode !== 200) throw new Error(`seed item failed: ${res.body}`);
});
afterAll(async () => {
  await world.close();
});

const app = () => world.server.app;

interface Group { kind: string; results: Array<Record<string, unknown>> }

describe("GET /api/search", () => {
  it("finds a lot by SKU", async () => {
    const res = await app().inject({ method: "GET", url: "/api/search?q=SRCH-001", headers: auth(superToken) });
    expect(res.statusCode).toBe(200);
    const { groups } = res.json() as { groups: Group[] };
    const lots = groups.find((g) => g.kind === "lots");
    expect(lots?.results.some((r) => r.sku === "SRCH-001")).toBe(true);
  });

  it("matches accent-insensitively — skruvgriezis finds Skrūvgriezis", async () => {
    const res = await app().inject({ method: "GET", url: "/api/search?q=skruvgriezis", headers: auth(superToken) });
    const { groups } = res.json() as { groups: Group[] };
    const lots = groups.find((g) => g.kind === "lots");
    expect(lots?.results.some((r) => r.sku === "SRCH-001")).toBe(true);
  });

  it("gates groups by role — a content editor sees no lots/orders/bidders", async () => {
    const token = await loginAs(world, "content@auction.test");
    const res = await app().inject({ method: "GET", url: "/api/search?q=SRCH-001", headers: auth(token) });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { groups: Group[] }).groups).toEqual([]);
  });

  it("requires auth and a minimum query length", async () => {
    const anon = await app().inject({ method: "GET", url: "/api/search?q=makita" });
    expect(anon.statusCode).toBe(401);
    const short = await app().inject({ method: "GET", url: "/api/search?q=m", headers: auth(superToken) });
    expect((short.json() as { groups: Group[] }).groups).toEqual([]);
  });
});
