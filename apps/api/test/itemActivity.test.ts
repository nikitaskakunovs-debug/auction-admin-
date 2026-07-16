import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createWorld, loginAs, type TestWorld } from "./helpers.js";

/** Phase 26: the per-item "who did what" timeline (audit + movement ledger). */

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

interface ActivityEvent {
  at: string;
  actor: string;
  kind: "audit" | "move";
  action: string;
  toLabel: string | null;
}

describe("GET /api/items/:id/activity", () => {
  it("returns the combined audit + movement timeline with actors, newest first", async () => {
    // Create → grade → putaway, all as the logged-in super admin.
    const created = await app().inject({
      method: "POST",
      url: "/api/items",
      headers: auth(token),
      payload: { sku: "ACT-TEST-001", title: "Activity test drill", marketCode: "LV" },
    });
    expect(created.statusCode).toBe(200);
    const item = (created.json() as { item: { id: string; sku: string } }).item;

    const patched = await app().inject({
      method: "PATCH",
      url: `/api/items/${item.id}`,
      headers: auth(token),
      payload: { condition: "good", conditionNotes: "" },
    });
    expect(patched.statusCode).toBe(200);

    const loc = await app().inject({
      method: "POST",
      url: "/api/warehouse/locations",
      headers: auth(token),
      payload: { zone: "FRONT", aisle: "Z9", rack: "R1", shelf: "S1" },
    });
    expect(loc.statusCode).toBe(200);
    const locationId = (loc.json() as { location: { id: string; label: string } }).location;

    const put = await app().inject({
      method: "POST",
      url: `/api/items/${item.id}/putaway`,
      headers: auth(token),
      payload: { locationId: locationId.id, reason: "test putaway" },
    });
    expect(put.statusCode).toBe(200);

    const res = await app().inject({ method: "GET", url: `/api/items/${item.id}/activity`, headers: auth(token) });
    expect(res.statusCode).toBe(200);
    const { events } = res.json() as { events: ActivityEvent[] };

    const actions = events.map((e) => e.action);
    expect(actions).toContain("created");
    expect(actions).toContain("updated");
    expect(actions).toContain("putaway");

    // Every entry names who did it — the logged-in admin, never blank.
    for (const e of events) expect(e.actor.length).toBeGreaterThan(0);

    // The putaway movement carries the destination bin label.
    const move = events.find((e) => e.kind === "move" && e.action === "putaway");
    expect(move?.toLabel).toBe(locationId.label);

    // Newest first.
    const times = events.map((e) => e.at);
    expect([...times].sort((a, b) => b.localeCompare(a))).toEqual(times);
  });

  it("404s for an unknown item", async () => {
    const res = await app().inject({
      method: "GET",
      url: "/api/items/00000000-0000-0000-0000-000000000000/activity",
      headers: auth(token),
    });
    expect(res.statusCode).toBe(404);
  });
});
