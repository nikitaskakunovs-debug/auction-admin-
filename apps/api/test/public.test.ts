import { customers } from "@auction/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createLiveAuction, createWorld, loginAs, type TestWorld } from "./helpers.js";

let world: TestWorld;
let adminToken: string;

beforeAll(async () => {
  world = await createWorld();
  adminToken = await loginAs(world, "super@auction.test");
});
afterAll(async () => {
  await world.close();
});

async function registerBidder(alias: string) {
  const res = await world.server.app.inject({
    method: "POST",
    url: "/api/public/auth/register",
    payload: { email: `${alias}@public.test`, alias, password: "Bidder123!", country: "LV" },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { accessToken: string; refreshToken: string; bidder: { id: string; alias: string } };
}

describe("bidder accounts", () => {
  it("registers, logs in, and refresh rotates", async () => {
    const reg = await registerBidder("pub_anna");
    expect(reg.bidder.alias).toBe("pub_anna");

    const dup = await world.server.app.inject({
      method: "POST",
      url: "/api/public/auth/register",
      payload: { email: "pub_anna@public.test", alias: "other", password: "Bidder123!" },
    });
    expect(dup.statusCode).toBe(409);

    const login = await world.server.app.inject({
      method: "POST",
      url: "/api/public/auth/login",
      payload: { email: "pub_anna@public.test", password: "Bidder123!" },
    });
    expect(login.statusCode).toBe(200);

    const { refreshToken } = login.json() as { refreshToken: string };
    const r1 = await world.server.app.inject({ method: "POST", url: "/api/public/auth/refresh", payload: { refreshToken } });
    expect(r1.statusCode).toBe(200);
    const r2 = await world.server.app.inject({ method: "POST", url: "/api/public/auth/refresh", payload: { refreshToken } });
    expect(r2.statusCode).toBe(401);
  });

  it("bidder tokens are rejected by admin endpoints", async () => {
    const { accessToken } = await registerBidder("pub_sneaky");
    for (const url of ["/api/items", "/api/orders", "/api/team", "/api/dashboard", "/api/auth/me"]) {
      const res = await world.server.app.inject({ method: "GET", url, headers: auth(accessToken) });
      expect([401, 403]).toContain(res.statusCode);
    }
  });

  it("admin tokens are rejected by bidder-only endpoints", async () => {
    const res = await world.server.app.inject({
      method: "GET",
      url: "/api/public/auth/me",
      headers: auth(adminToken),
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("public browsing hygiene", () => {
  it("listings never expose reserve amounts or emails; hasReserve/reserveMet only", async () => {
    await createLiveAuction(world, adminToken, { startPriceCents: 1_000, reserveCents: 77_700 });
    const res = await world.server.app.inject({ method: "GET", url: "/api/public/auctions" });
    expect(res.statusCode).toBe(200);
    const body = res.body;
    expect(body).not.toContain("77700");
    expect(body).not.toContain("reserveCents");
    expect(body).not.toContain("leaderMax");
    expect(body).not.toContain("@"); // no emails anywhere
    const { auctions: list } = res.json() as { auctions: Array<{ hasReserve: boolean; reserveMet: boolean }> };
    const withReserve = list.find((a) => a.hasReserve)!;
    expect(withReserve.reserveMet).toBe(false);
  });

  it("detail returns a sanitized ledger and the exact minimum next bid", async () => {
    const { auctionId } = await createLiveAuction(world, adminToken, { startPriceCents: 1_000 });
    const bidder = await registerBidder("pub_ledger");
    const bidRes = await world.server.app.inject({
      method: "POST",
      url: `/api/public/auctions/${auctionId}/bids`,
      headers: auth(bidder.accessToken),
      payload: { maxCents: 5_000 },
    });
    expect(bidRes.statusCode).toBe(200);

    const res = await world.server.app.inject({
      method: "GET",
      url: `/api/public/auctions/${auctionId}`,
      headers: auth(bidder.accessToken),
    });
    const body = res.json() as {
      minNextBidCents: number;
      auction: { currentPriceCents: number };
      bids: Array<{ alias: string; amountCents: number; isYou: boolean }>;
    };
    expect(body.auction.currentPriceCents).toBe(1_000);
    expect(body.minNextBidCents).toBe(1_100); // +€1 tier
    expect(body.bids[0]!.isYou).toBe(true);
    expect(res.body).not.toContain("maxCents");
    expect(res.body).not.toContain("customerId");
  });
});

describe("the real bid path", () => {
  it("two bidders fight through the public API with proxy semantics", async () => {
    const { auctionId } = await createLiveAuction(world, adminToken, { startPriceCents: 1_000 });
    const a = await registerBidder("pub_fight_a");
    const b = await registerBidder("pub_fight_b");

    const bidAs = (t: string, maxCents: number) =>
      world.server.app.inject({
        method: "POST",
        url: `/api/public/auctions/${auctionId}/bids`,
        headers: auth(t),
        payload: { maxCents },
      });

    let r = (await bidAs(a.accessToken, 5_000)).json() as { youLead: boolean; currentPriceCents: number };
    expect(r).toMatchObject({ youLead: true, currentPriceCents: 1_000 });

    r = (await bidAs(b.accessToken, 3_000)).json() as { youLead: boolean; currentPriceCents: number };
    expect(r).toMatchObject({ youLead: false, currentPriceCents: 3_100 });

    // a's max is €50; the €50–199.99 tier increments by €5 → b leads at €55.
    r = (await bidAs(b.accessToken, 9_000)).json() as { youLead: boolean; currentPriceCents: number };
    expect(r).toMatchObject({ youLead: true, currentPriceCents: 5_500 });

    // Unauthenticated bids are rejected.
    const anon = await world.server.app.inject({
      method: "POST",
      url: `/api/public/auctions/${auctionId}/bids`,
      payload: { maxCents: 99_000 },
    });
    expect(anon.statusCode).toBe(401);
  });

  it("blocked bidders cannot bid", async () => {
    const { auctionId } = await createLiveAuction(world, adminToken);
    const blocked = await registerBidder("pub_blocked");
    await world.ctx.db.update(customers).set({ blocked: true }).where(eq(customers.id, blocked.bidder.id));
    const res = await world.server.app.inject({
      method: "POST",
      url: `/api/public/auctions/${auctionId}/bids`,
      headers: auth(blocked.accessToken),
      payload: { maxCents: 5_000 },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe("BIDDER_BLOCKED");
  });

  it("my-bids reflects leading vs outbid", async () => {
    const { auctionId } = await createLiveAuction(world, adminToken, { startPriceCents: 1_000 });
    const a = await registerBidder("pub_mine_a");
    const b = await registerBidder("pub_mine_b");
    await world.server.app.inject({
      method: "POST",
      url: `/api/public/auctions/${auctionId}/bids`,
      headers: auth(a.accessToken),
      payload: { maxCents: 2_000 },
    });
    await world.server.app.inject({
      method: "POST",
      url: `/api/public/auctions/${auctionId}/bids`,
      headers: auth(b.accessToken),
      payload: { maxCents: 8_000 },
    });
    const mine = await world.server.app.inject({ method: "GET", url: "/api/public/me/bids", headers: auth(a.accessToken) });
    const body = mine.json() as { bids: Array<{ id: string; youLead: boolean }> };
    const entry = body.bids.find((x) => x.id === auctionId)!;
    expect(entry.youLead).toBe(false);
  });
});
