import { auditLog, customers } from "@auction/db";
import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createLiveAuction, createWorld, loginAs, type TestWorld } from "./helpers.js";

let world: TestWorld;
let adminToken: string;
let opsToken: string;
let contentToken: string;

beforeAll(async () => {
  world = await createWorld();
  adminToken = await loginAs(world, "super@auction.test");
  opsToken = await loginAs(world, "ops@auction.test");
  contentToken = await loginAs(world, "content@auction.test");
});
afterAll(async () => {
  await world.close();
});

async function registerBidder(alias: string) {
  const res = await world.server.app.inject({
    method: "POST",
    url: "/api/public/auth/register",
    payload: { email: `${alias}@mod.test`, alias, password: "Bidder123!", country: "LV" },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { accessToken: string; bidder: { id: string } };
}

async function publishedFixedListing(itemPayload: Record<string, unknown>): Promise<{ itemId: string; listingId: string }> {
  const app = world.server.app;
  const sku = `MOD-${Math.random().toString(36).slice(2, 9)}`;
  const item = await app.inject({ method: "POST", url: "/api/items", headers: auth(adminToken), payload: { sku, title: `Mod ${sku}`, marketCode: "LV", ...itemPayload } });
  expect(item.statusCode).toBe(200);
  const itemId = (item.json() as { item: { id: string } }).item.id;
  const listing = await app.inject({
    method: "POST",
    url: "/api/listings",
    headers: auth(adminToken),
    payload: { itemId, type: "fixed", title: `Mod ${sku}`, marketCode: "LV", priceCents: 5_000, quantity: 1 },
  });
  const listingId = (listing.json() as { listing: { id: string } }).listing.id;
  await app.inject({ method: "POST", url: `/api/listings/${listingId}/publish`, headers: auth(adminToken) });
  return { itemId, listingId };
}

describe("zero-tolerance account suspension", () => {
  it("requires a reason, suspends bidding + buying, and writes the audit trail", async () => {
    const app = world.server.app;
    const bidder = await registerBidder("angry_arnis");

    // No reason → refused.
    const bare = await app.inject({ method: "POST", url: `/api/customers/${bidder.bidder.id}/block`, headers: auth(opsToken), payload: {} });
    expect(bare.statusCode).toBe(400);

    const res = await app.inject({
      method: "POST",
      url: `/api/customers/${bidder.bidder.id}/block`,
      headers: auth(opsToken),
      payload: { reason: "Threatened staff at the pickup desk (zero-tolerance policy)" },
    });
    expect(res.statusCode).toBe(200);
    const { customer } = res.json() as { customer: { blocked: boolean; blockedReason: string | null; blockedAt: string | null } };
    expect(customer.blocked).toBe(true);
    expect(customer.blockedReason).toContain("zero-tolerance");
    expect(customer.blockedAt).not.toBeNull();

    const [audit] = await world.ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "blocked"))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect(audit?.type).toBe("customer");
    expect((audit?.detail as { reason: string }).reason).toContain("Threatened");

    // Bidding is refused.
    const { auctionId } = await createLiveAuction(world, adminToken);
    const bid = await app.inject({
      method: "POST",
      url: `/api/public/auctions/${auctionId}/bids`,
      headers: auth(bidder.accessToken),
      payload: { maxCents: 2_000 },
    });
    expect(bid.statusCode).toBe(422);
    expect((bid.json() as { code: string }).code).toBe("BIDDER_BLOCKED");

    // Buying is refused too.
    const { listingId } = await publishedFixedListing({});
    const buy = await app.inject({ method: "POST", url: `/api/public/listings/${listingId}/buy`, headers: auth(bidder.accessToken) });
    expect(buy.statusCode).toBe(422);
    expect((buy.json() as { code: string }).code).toBe("BIDDER_BLOCKED");

    // Reinstate (reason mandatory) → bidding works again.
    const noReason = await app.inject({ method: "POST", url: `/api/customers/${bidder.bidder.id}/unblock`, headers: auth(opsToken), payload: {} });
    expect(noReason.statusCode).toBe(400);
    const unblock = await app.inject({
      method: "POST",
      url: `/api/customers/${bidder.bidder.id}/unblock`,
      headers: auth(opsToken),
      payload: { reason: "Apologised in person; first incident" },
    });
    expect(unblock.statusCode).toBe(200);
    const restored = (unblock.json() as { customer: { blocked: boolean; blockedReason: string | null } }).customer;
    expect(restored.blocked).toBe(false);
    expect(restored.blockedReason).toBeNull();

    const rebid = await app.inject({
      method: "POST",
      url: `/api/public/auctions/${auctionId}/bids`,
      headers: auth(bidder.accessToken),
      payload: { maxCents: 2_000 },
    });
    expect(rebid.statusCode).toBe(200);
  });

  it("the generic PATCH cannot flip blocked — only the audited endpoints can", async () => {
    const app = world.server.app;
    const bidder = await registerBidder("patch_paula");
    const res = await app.inject({
      method: "PATCH",
      url: `/api/customers/${bidder.bidder.id}`,
      headers: auth(adminToken),
      payload: { blocked: true, notes: "trying the old toggle" },
    });
    expect(res.statusCode).toBe(200); // unknown key is stripped, notes still saved
    const [row] = await world.ctx.db.select({ blocked: customers.blocked }).from(customers).where(eq(customers.id, bidder.bidder.id));
    expect(row!.blocked).toBe(false);
  });

  it("content editors cannot suspend accounts (RBAC)", async () => {
    const bidder = await registerBidder("rbac_rita");
    const res = await world.server.app.inject({
      method: "POST",
      url: `/api/customers/${bidder.bidder.id}/block`,
      headers: auth(contentToken),
      payload: { reason: "should not be allowed" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("condition taxonomy validation", () => {
  it("SEE-NOTES grades demand condition notes on create and on grade change", async () => {
    const app = world.server.app;
    const sku = `COND-${Math.random().toString(36).slice(2, 9)}`;

    const bare = await app.inject({
      method: "POST",
      url: "/api/items",
      headers: auth(adminToken),
      payload: { sku, title: "Scratched kettle", marketCode: "LV", condition: "used" },
    });
    expect(bare.statusCode).toBe(400);
    expect((bare.json() as { error: string }).error).toBe("condition_notes_required");

    const ok = await app.inject({
      method: "POST",
      url: "/api/items",
      headers: auth(adminToken),
      payload: { sku, title: "Scratched kettle", marketCode: "LV", condition: "used", conditionNotes: "Deep scratch on the lid, limescale inside." },
    });
    expect(ok.statusCode).toBe(200);
    const itemId = (ok.json() as { item: { id: string } }).item.id;

    const regrade = await app.inject({
      method: "PATCH",
      url: `/api/items/${itemId}`,
      headers: auth(adminToken),
      payload: { condition: "new_with_issue" },
    });
    expect(regrade.statusCode).toBe(400);

    const regradeOk = await app.inject({
      method: "PATCH",
      url: `/api/items/${itemId}`,
      headers: auth(adminToken),
      payload: { condition: "new_with_issue", conditionNotes: "Missing power cord." },
    });
    expect(regradeOk.statusCode).toBe(200);
    expect((regradeOk.json() as { item: { conditionNotes: string } }).item.conditionNotes).toBe("Missing power cord.");

    // Grades without the SEE-NOTES marker (and legacy free-text) need no notes.
    const plain = await app.inject({
      method: "PATCH",
      url: `/api/items/${itemId}`,
      headers: auth(adminToken),
      payload: { condition: "brand_new", conditionNotes: "" },
    });
    expect(plain.statusCode).toBe(200);
  });

  it("public listing payloads carry the condition code and notes", async () => {
    const app = world.server.app;
    const { listingId } = await publishedFixedListing({
      condition: "used_with_issue",
      conditionNotes: "One hinge bent; sold with spare screws.",
    });
    const res = await app.inject({ method: "GET", url: `/api/public/listings/${listingId}` });
    expect(res.statusCode).toBe(200);
    const { listing } = res.json() as { listing: { condition: string; conditionNotes: string } };
    expect(listing.condition).toBe("used_with_issue");
    expect(listing.conditionNotes).toContain("hinge");
  });
});
