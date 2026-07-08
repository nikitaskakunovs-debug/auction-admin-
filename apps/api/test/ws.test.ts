import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { auth, createBidder, createLiveAuction, createWorld, loginAs, type TestWorld } from "./helpers.js";

let world: TestWorld;
let token: string;
let baseUrl: string;

beforeAll(async () => {
  world = await createWorld();
  token = await loginAs(world, "super@auction.test");
  await world.server.app.listen({ host: "127.0.0.1", port: 0 });
  const addr = world.server.app.server.address();
  if (typeof addr === "object" && addr) baseUrl = `ws://127.0.0.1:${addr.port}`;
});
afterAll(async () => {
  await world.close();
});

function connect(query = `token=${token}`): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${baseUrl}/ws?${query}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function nextMessage(ws: WebSocket, filter: (m: Record<string, unknown>) => boolean, timeoutMs = 5_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for ws message")), timeoutMs);
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as Record<string, unknown>;
      if (filter(msg)) {
        clearTimeout(timer);
        resolve(msg);
      }
    });
  });
}

describe("WebSocket live events", () => {
  it("rejects unauthenticated connections", async () => {
    const closed = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${baseUrl}/ws`);
      ws.on("close", (code) => resolve(code));
      ws.on("error", () => undefined);
    });
    expect(closed).toBe(4001);
  });

  it("subscribers get public-safe bid events (no reserve, no proxy max)", async () => {
    const { auctionId } = await createLiveAuction(world, token, {
      startPriceCents: 1_000,
      reserveCents: 99_000,
    });
    const bidder = await createBidder(world, "ws_bidder");

    const ws = await connect();
    ws.send(JSON.stringify({ type: "subscribe", auctionId }));
    await nextMessage(ws, (m) => m.type === "subscribed");

    const eventPromise = nextMessage(ws, (m) => m.type === "bid");
    const res = await world.server.app.inject({
      method: "POST",
      url: `/api/auctions/${auctionId}/bids`,
      headers: auth(token),
      payload: { customerId: bidder, maxCents: 50_000 },
    });
    expect(res.statusCode).toBe(200);

    const ev = await eventPromise;
    expect(ev.auctionId).toBe(auctionId);
    const data = ev.data as Record<string, unknown>;
    expect(data.currentPriceCents).toBe(1_000);
    expect(data.leaderAlias).toBe("ws_bidder");
    expect(data.reserveMet).toBe(false);
    // Hygiene: the payload must never leak hidden values.
    const flat = JSON.stringify(ev);
    expect(flat).not.toContain("reserveCents");
    expect(flat).not.toContain("maxCents");
    expect(flat).not.toContain("leaderMax");
    ws.close();
  });

  it("admin firehose receives events for every auction", async () => {
    const { auctionId } = await createLiveAuction(world, token);
    const bidder = await createBidder(world, "ws_admin_feed");
    const ws = await connect();
    ws.send(JSON.stringify({ type: "subscribe_admin" }));
    await nextMessage(ws, (m) => m.type === "subscribed");
    const eventPromise = nextMessage(ws, (m) => m.type === "bid" && m.auctionId === auctionId);
    await world.server.app.inject({
      method: "POST",
      url: `/api/auctions/${auctionId}/bids`,
      headers: auth(token),
      payload: { customerId: bidder, maxCents: 3_000 },
    });
    await eventPromise;
    ws.close();
  });
});
