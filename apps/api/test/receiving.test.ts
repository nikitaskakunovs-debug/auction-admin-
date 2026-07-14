import { stockMovements } from "@auction/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createWorld, loginAs, type TestWorld } from "./helpers.js";

let world: TestWorld;
let opsToken: string;
let contentToken: string;

beforeAll(async () => {
  world = await createWorld();
  opsToken = await loginAs(world, "ops@auction.test");
  contentToken = await loginAs(world, "content@auction.test");
});
afterAll(async () => {
  await world.close();
});

async function createConsignment(supplier = "Baltic Liquidations OÜ"): Promise<{ id: string; ref: string }> {
  const res = await world.server.app.inject({
    method: "POST",
    url: "/api/consignments",
    headers: auth(opsToken),
    payload: { supplier, marketCode: "LV", expectedCount: 2 },
  });
  expect(res.statusCode).toBe(200);
  const { consignment } = res.json() as { consignment: { id: string; ref: string } };
  return consignment;
}

describe("receiving (consignments + intake)", () => {
  it("creates a delivery with a CON ref, receives units with auto-SKUs and intake movements", async () => {
    const app = world.server.app;
    const con = await createConsignment();
    expect(con.ref).toMatch(/^CON-\d{4,}$/);

    const r1 = await app.inject({
      method: "POST",
      url: `/api/consignments/${con.id}/receive`,
      headers: auth(opsToken),
      payload: { title: "Bosch GSR 18V drill, boxed", condition: "open_package_new", weightGrams: 1800 },
    });
    expect(r1.statusCode).toBe(200);
    const item1 = (r1.json() as { item: { id: string; sku: string; status: string; marketCode: string } }).item;
    expect(item1.sku).toMatch(/^LOT-\d{6,}$/);
    expect(item1.status).toBe("draft");
    expect(item1.marketCode).toBe("LV");

    const r2 = await app.inject({
      method: "POST",
      url: `/api/consignments/${con.id}/receive`,
      headers: auth(opsToken),
      payload: { title: "Kärcher pressure washer", condition: "used", conditionNotes: "Hose scuffed; nozzle missing." },
    });
    const item2 = (r2.json() as { item: { id: string; sku: string } }).item;
    expect(item2.sku).not.toBe(item1.sku);

    // Every receive writes an intake movement with the delivery in the reason.
    const moves = await world.ctx.db.select().from(stockMovements).where(eq(stockMovements.itemId, item1.id));
    expect(moves).toHaveLength(1);
    expect(moves[0]!.type).toBe("intake");
    expect(moves[0]!.reason).toContain(con.ref);

    // The detail endpoint shows both, and the list counts them.
    const detail = await app.inject({ method: "GET", url: `/api/consignments/${con.id}`, headers: auth(opsToken) });
    expect((detail.json() as { items: unknown[] }).items).toHaveLength(2);
    const list = await app.inject({ method: "GET", url: "/api/consignments", headers: auth(opsToken) });
    const row = (list.json() as { consignments: Array<{ id: string; receivedCount: number }> }).consignments.find(
      (c) => c.id === con.id,
    );
    expect(row?.receivedCount).toBe(2);
  });

  it("enforces SEE-NOTES grades and refuses receiving into a closed delivery", async () => {
    const app = world.server.app;
    const con = await createConsignment("Notes & Close OÜ");

    const bare = await app.inject({
      method: "POST",
      url: `/api/consignments/${con.id}/receive`,
      headers: auth(opsToken),
      payload: { title: "Scratched microwave", condition: "used" },
    });
    expect(bare.statusCode).toBe(400);
    expect((bare.json() as { error: string }).error).toBe("condition_notes_required");

    const close = await app.inject({ method: "POST", url: `/api/consignments/${con.id}/close`, headers: auth(opsToken) });
    expect(close.statusCode).toBe(200);
    expect((close.json() as { consignment: { status: string } }).consignment.status).toBe("closed");

    const after = await app.inject({
      method: "POST",
      url: `/api/consignments/${con.id}/receive`,
      headers: auth(opsToken),
      payload: { title: "Too late", condition: "brand_new" },
    });
    expect(after.statusCode).toBe(409);

    // Closing twice is a conflict, not a silent success.
    const again = await app.inject({ method: "POST", url: `/api/consignments/${con.id}/close`, headers: auth(opsToken) });
    expect(again.statusCode).toBe(409);
  });

  it("looks items up by scanned uuid and by typed SKU", async () => {
    const app = world.server.app;
    const con = await createConsignment("Lookup OÜ");
    const rec = await app.inject({
      method: "POST",
      url: `/api/consignments/${con.id}/receive`,
      headers: auth(opsToken),
      payload: { title: "Lookup target", condition: "brand_new" },
    });
    const item = (rec.json() as { item: { id: string; sku: string } }).item;

    const byId = await app.inject({ method: "GET", url: `/api/items/lookup?code=${item.id}`, headers: auth(opsToken) });
    expect(byId.statusCode).toBe(200);
    expect((byId.json() as { item: { sku: string }; consignmentRef: string }).consignmentRef).toBe(con.ref);

    const bySku = await app.inject({
      method: "GET",
      url: `/api/items/lookup?code=${item.sku.toLowerCase()}`,
      headers: auth(opsToken),
    });
    expect(bySku.statusCode).toBe(200);
    expect((bySku.json() as { item: { id: string } }).item.id).toBe(item.id);

    const missing = await app.inject({ method: "GET", url: "/api/items/lookup?code=LOT-999999", headers: auth(opsToken) });
    expect(missing.statusCode).toBe(404);
  });

  it("renders printable QR labels for items, consignments, and bins", async () => {
    const app = world.server.app;
    const con = await createConsignment("Labels OÜ");
    const rec = await app.inject({
      method: "POST",
      url: `/api/consignments/${con.id}/receive`,
      headers: auth(opsToken),
      payload: { title: "Labelled kettle", condition: "brand_new" },
    });
    const item = (rec.json() as { item: { id: string; sku: string } }).item;

    const label = await app.inject({ method: "GET", url: `/api/items/${item.id}/label`, headers: auth(opsToken) });
    expect(label.statusCode).toBe(200);
    expect(label.headers["content-type"]).toContain("text/html");
    expect(label.body).toContain(item.sku);
    expect(label.body).toContain("<svg");

    const sheet = await app.inject({ method: "GET", url: `/api/consignments/${con.id}/labels`, headers: auth(opsToken) });
    expect(sheet.statusCode).toBe(200);
    expect(sheet.body).toContain(item.sku);

    const bins = await app.inject({ method: "GET", url: "/api/warehouse/locations/labels", headers: auth(opsToken) });
    expect(bins.statusCode).toBe(200);
    expect(bins.body).toContain("FRONT-A1-R1-S1");
  });

  it("receiving requires warehouse.manage (content editor refused)", async () => {
    const app = world.server.app;
    const denied = await app.inject({
      method: "POST",
      url: "/api/consignments",
      headers: auth(contentToken),
      payload: { supplier: "Nope", marketCode: "LV" },
    });
    expect(denied.statusCode).toBe(403);
  });
});
