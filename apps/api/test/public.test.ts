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
    const refresh = (token: string) =>
      world.server.app.inject({ method: "POST", url: "/api/public/auth/refresh", payload: { refreshToken: token } });

    const r1 = await refresh(refreshToken);
    expect(r1.statusCode).toBe(200);
    // Гонка вкладок: тот же токен сразу после ротации ещё минуту жив —
    // опоздавшая вкладка получает собственную свежую пару, а не разлогин.
    const r2 = await refresh(refreshToken);
    expect(r2.statusCode).toBe(200);
    // Но лишь минуту: спустя две минуты это уже не гонка, а повтор.
    world.setNow(new Date(Date.now() + 2 * 60_000));
    const r3 = await refresh(refreshToken);
    expect(r3.statusCode).toBe(401);

    // Выход гасит токен и в базе: обновиться погашенной парой нельзя,
    // даже внутри минутного окна — живой преемницы у неё нет.
    const pair = r1.json() as { refreshToken: string };
    const out = await world.server.app.inject({
      method: "POST",
      url: "/api/public/auth/logout",
      payload: { refreshToken: pair.refreshToken },
    });
    expect(out.statusCode).toBe(200);
    const dead = await refresh(pair.refreshToken);
    expect(dead.statusCode).toBe(401);
    world.setNow(null);
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

  it("the admin customers API never serializes bidder password hashes", async () => {
    // A registered bidder has a password hash in the DB.
    await world.server.app.inject({
      method: "POST",
      url: "/api/public/auth/register",
      payload: { email: "hash-check@public.test", alias: "hash_check", password: "Bidder123!" },
    });
    const list = await world.server.app.inject({ method: "GET", url: "/api/customers", headers: auth(adminToken) });
    expect(list.body).not.toContain("passwordHash");
    expect(list.body).not.toContain("scrypt$");

    const { customers: rows } = list.json() as { customers: Array<{ id: string }> };
    const target = rows.find((c) => (c as { alias?: string }).alias === "hash_check")!;
    const detail = await world.server.app.inject({ method: "GET", url: `/api/customers/${target.id}`, headers: auth(adminToken) });
    expect(detail.body).not.toContain("passwordHash");
    expect(detail.body).not.toContain("scrypt$");
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
    // Смотрит сам лидер: его минимум — чистый шаг выше собственного
    // максимума (€50), а не «цена + шаг» соперника, который движок ему
    // всё равно отвергнет.
    expect(body.minNextBidCents).toBe(5_100);
    expect(body.bids[0]!.isYou).toBe(true);
    expect(res.body).not.toContain("customerId");

    // Гостю — обычный минимум по шагу и никаких чужих максимумов.
    const anon = await world.server.app.inject({ method: "GET", url: `/api/public/auctions/${auctionId}` });
    const anonBody = anon.json() as { minNextBidCents: number; myMaxCents: number | null };
    expect(anonBody.minNextBidCents).toBe(1_100); // +€1 tier
    expect(anonBody.myMaxCents).toBeNull();
    expect(anon.body).not.toContain("maxCents");
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

    // The leader raising their own max is accepted: price stays put, and the
    // response says so via priceChanged — the UI explains instead of lying.
    const raise = (await bidAs(b.accessToken, 12_000)).json() as {
      youLead: boolean; priceChanged: boolean; currentPriceCents: number;
    };
    expect(raise).toMatchObject({ youLead: true, priceChanged: false, currentPriceCents: 5_500 });

    // At or below their own max — a refusal that names the minimum raise.
    const low = await bidAs(b.accessToken, 9_000);
    expect(low.statusCode).toBe(422);
    expect(low.json()).toMatchObject({ code: "NOT_ABOVE_OWN_MAX", minAcceptableCents: 12_001 });

    // The leader's own detail view quotes a personal minimum: a clean step
    // above their own max — not the challenger's "price + step" the engine
    // would refuse from them. Challengers keep the standard minimum.
    const detailUrl = `/api/public/auctions/${auctionId}`;
    const asLeader = (await world.server.app.inject({ method: "GET", url: detailUrl, headers: auth(b.accessToken) }))
      .json() as { minNextBidCents: number; myMaxCents: number | null };
    expect(asLeader).toMatchObject({ minNextBidCents: 12_500, myMaxCents: 12_000 });
    const asRival = (await world.server.app.inject({ method: "GET", url: detailUrl, headers: auth(a.accessToken) }))
      .json() as { minNextBidCents: number; myMaxCents: number | null };
    expect(asRival).toMatchObject({ minNextBidCents: 6_000, myMaxCents: null });

    // Каждая принятая ставка несёт свой event_id аналитики от сервера:
    // браузерный пиксель и серверная копия Meta склеиваются по нему, а
    // повторная обработка того же ответа нового не рождает.
    const e1 = (await bidAs(a.accessToken, 13_000)).json() as { eventId?: string };
    const e2 = (await bidAs(b.accessToken, 15_000)).json() as { eventId?: string };
    expect(e1.eventId).toMatch(/^place_bid-/);
    expect(e2.eventId).toMatch(/^place_bid-/);
    expect(e1.eventId).not.toBe(e2.eventId);

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
