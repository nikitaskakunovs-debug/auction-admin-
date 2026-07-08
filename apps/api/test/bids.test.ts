import { auctions } from "@auction/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createBidder, createLiveAuction, createWorld, loginAs, type TestWorld } from "./helpers.js";

let world: TestWorld;
let token: string;

beforeAll(async () => {
  world = await createWorld();
  token = await loginAs(world, "super@auction.test");
});
afterAll(async () => {
  await world.close();
});

async function bid(auctionId: string, customerId: string, maxCents: number) {
  return world.server.app.inject({
    method: "POST",
    url: `/api/auctions/${auctionId}/bids`,
    headers: auth(token),
    payload: { customerId, maxCents },
  });
}

describe("bid placement through the API", () => {
  it("runs a proxy battle with correct prices and ledger", async () => {
    const { auctionId } = await createLiveAuction(world, token, { startPriceCents: 1_000 });
    const alice = await createBidder(world, "alice_api");
    const bob = await createBidder(world, "bob_api");

    let res = await bid(auctionId, alice, 5_000);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { currentPriceCents: number }).currentPriceCents).toBe(1_000);

    res = await bid(auctionId, bob, 3_000);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { currentPriceCents: number; leaderAlias: string };
    expect(body.currentPriceCents).toBe(3_100); // bob's 3000 + €1, alice defends
    expect(body.leaderAlias).toBe("alice_api");

    // Bid below minimum → 422 with the exact minimum.
    res = await bid(auctionId, bob, 3_150);
    expect(res.statusCode).toBe(422);
    expect((res.json() as { minAcceptableCents: number }).minAcceptableCents).toBe(3_200);

    // Detail endpoint: ledger present, proxy max NEVER serialized.
    const detail = await world.server.app.inject({
      method: "GET",
      url: `/api/auctions/${auctionId}`,
      headers: auth(token),
    });
    const dbody = detail.json() as { auction: Record<string, unknown>; bids: unknown[] };
    expect(dbody.auction).not.toHaveProperty("leaderMaxCents");
    expect(dbody.auction).not.toHaveProperty("leaderSeq");
    expect(dbody.bids.length).toBe(3); // alice open, bob outbid, alice auto-defence
  });

  it("blocked bidders are rejected", async () => {
    const { auctionId } = await createLiveAuction(world, token);
    const banned = await createBidder(world, "banned_1", { blocked: true });
    const res = await bid(auctionId, banned, 5_000);
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe("BIDDER_BLOCKED");
  });

  it("anti-snipe: a bid inside the window pushes endsAt out", async () => {
    const { auctionId } = await createLiveAuction(world, token, { endsInMs: 30_000, antiSnipeSec: 60 });
    const carol = await createBidder(world, "carol_snipe");
    const before = await world.ctx.db.select().from(auctions).where(eq(auctions.id, auctionId));
    const res = await bid(auctionId, carol, 2_000);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { extended: boolean; endsAt: string };
    expect(body.extended).toBe(true);
    expect(new Date(body.endsAt).getTime()).toBeGreaterThan(before[0]!.endsAt.getTime());
    const after = await world.ctx.db.select().from(auctions).where(eq(auctions.id, auctionId));
    expect(after[0]!.extensions).toBe(1);
  });

  it("no anti-snipe outside the window", async () => {
    const { auctionId } = await createLiveAuction(world, token, { endsInMs: 3_600_000 });
    const dave = await createBidder(world, "dave_calm");
    const res = await bid(auctionId, dave, 2_000);
    expect((res.json() as { extended: boolean }).extended).toBe(false);
  });

  it("rejects bids on an ended auction", async () => {
    const { auctionId } = await createLiveAuction(world, token, { endsInMs: 50 });
    const eve = await createBidder(world, "eve_late");
    await new Promise((r) => setTimeout(r, 80));
    const res = await bid(auctionId, eve, 2_000);
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe("AUCTION_ENDED");
  });

  it("reserve: shows reserve_met only when the max covers it", async () => {
    const { auctionId } = await createLiveAuction(world, token, { startPriceCents: 1_000, reserveCents: 10_000 });
    const fred = await createBidder(world, "fred_res");
    let res = await bid(auctionId, fred, 5_000);
    expect((res.json() as { reserveMet: boolean }).reserveMet).toBe(false);
    res = await bid(auctionId, fred, 12_000);
    const body = res.json() as { reserveMet: boolean; currentPriceCents: number };
    expect(body.reserveMet).toBe(true);
    expect(body.currentPriceCents).toBe(10_000); // jumped to the reserve
  });

  it("voiding a bidder's bids rebuilds the auction state", async () => {
    const { auctionId } = await createLiveAuction(world, token, { startPriceCents: 1_000 });
    const gina = await createBidder(world, "gina_v");
    const hank = await createBidder(world, "hank_v");
    await bid(auctionId, gina, 4_000);
    await bid(auctionId, hank, 9_000); // hank leads at 4100

    const detail = await world.server.app.inject({ method: "GET", url: `/api/auctions/${auctionId}`, headers: auth(token) });
    const hankBid = (detail.json() as { bids: Array<{ id: string; alias: string; auto: boolean }> }).bids.find(
      (b) => b.alias === "hank_v" && !b.auto,
    )!;

    const res = await world.server.app.inject({
      method: "POST",
      url: `/api/auctions/${auctionId}/bids/${hankBid.id}/void`,
      headers: auth(token),
      payload: { reason: "suspected shill account" },
    });
    expect(res.statusCode).toBe(200);

    const [after] = await world.ctx.db.select().from(auctions).where(eq(auctions.id, auctionId));
    // gina is leader again at her opening price.
    expect(after!.leaderCustomerId).toBe(gina);
    expect(after!.currentPriceCents).toBe(1_000);
  });
});
