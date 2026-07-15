import { auctions, bids } from "@auction/db";
import { resolveBid, type BidState } from "@auction/domain";
import { asc, and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { placeBid } from "../src/engine/bids.js";
import { createBidder, createLiveAuction, createWorld, loginAs, type TestWorld } from "./helpers.js";

let world: TestWorld;
let token: string;

beforeAll(async () => {
  world = await createWorld();
  token = await loginAs(world, "super@auction.test");
});
afterAll(async () => {
  await world.close();
});

describe("concurrency: 60 simultaneous bidders on one auction", () => {
  it("loses no bids, doubles none, and ends in a replay-consistent state", async () => {
    const START = 1_000;
    const { auctionId } = await createLiveAuction(world, token, { startPriceCents: START, endsInMs: 3_600_000 });

    const BIDDERS = 60;
    const bidderIds: string[] = [];
    for (let i = 0; i < BIDDERS; i++) bidderIds.push(await createBidder(world, `load_${i}`));

    // Deterministic but scrambled maxes: 1..60 * €7.77 spread.
    const maxes = bidderIds.map((_, i) => START + ((i * 37) % BIDDERS) * 777 + 500);

    // Fire all 60 at once against the engine.
    const results = await Promise.all(
      bidderIds.map((customerId, i) => placeBid(world.ctx, { auctionId, customerId, maxCents: maxes[i]! })),
    );

    const accepted = results.filter((r) => r.ok);
    const rejected = results.filter((r) => !r.ok);
    // Everyone whose max was below the moving minimum is legitimately
    // rejected; there must be at least one acceptance and every rejection
    // must be a domain rejection, not a lost update or deadlock.
    expect(accepted.length).toBeGreaterThan(0);
    for (const r of rejected) {
      expect(["BELOW_MINIMUM", "BELOW_START_PRICE", "NOT_ABOVE_OWN_MAX"]).toContain((r as { code: string }).code);
    }

    const [finalAuction] = await world.ctx.db.select().from(auctions).where(eq(auctions.id, auctionId));
    const ledger = await world.ctx.db
      .select()
      .from(bids)
      .where(eq(bids.auctionId, auctionId))
      .orderBy(asc(bids.seq));

    // 1. seq is gap-free and unique 1..N — no lost or doubled writes.
    expect(ledger.map((b) => b.seq)).toEqual(Array.from({ length: ledger.length }, (_, i) => i + 1));
    expect(finalAuction!.bidCount).toBe(ledger.length);

    // 2. The recorded ledger is replay-consistent: pushing the accepted
    //    manual bids through the pure resolver in ledger order reproduces
    //    the exact final price and leader.
    let state: BidState = { startPriceCents: START, reserveCents: null, currentPriceCents: null, leader: null };
    for (const row of ledger.filter((b) => !b.auto)) {
      const r = resolveBid(state, { bidderId: row.customerId, maxCents: row.maxCents, seq: row.seq });
      if (r.ok) state = r.state;
    }
    expect(finalAuction!.currentPriceCents).toBe(state.currentPriceCents);
    expect(finalAuction!.leaderCustomerId).toBe(state.leader!.bidderId);

    // 3. The final price is visible-bid consistent: it equals the highest
    //    ledger amount.
    const maxLedger = Math.max(...ledger.map((b) => b.amountCents));
    expect(finalAuction!.currentPriceCents).toBe(maxLedger);

    // 4. The winner is among the bidders with the globally highest max.
    const highestMax = Math.max(...maxes);
    const winnersIdx = maxes
      .map((m, i) => [m, i] as const)
      .filter(([m]) => m === highestMax)
      .map(([, i]) => bidderIds[i]);
    expect(winnersIdx).toContain(finalAuction!.leaderCustomerId);

    // 5. Exactly one non-voided leader row is not outbid per bidder ordering:
    //    the winner's latest row.
    const winnerRows = ledger.filter((b) => b.customerId === finalAuction!.leaderCustomerId);
    expect(winnerRows.at(-1)!.outbid).toBe(false);
  }, 60_000);

  it("two racing bidders on a fresh auction never both open at start price", async () => {
    for (let round = 0; round < 5; round++) {
      const { auctionId } = await createLiveAuction(world, token, { startPriceCents: 2_000 });
      const a = await createBidder(world, `race_a_${round}`);
      const b = await createBidder(world, `race_b_${round}`);
      const [ra, rb] = await Promise.all([
        placeBid(world.ctx, { auctionId, customerId: a, maxCents: 5_000 }),
        placeBid(world.ctx, { auctionId, customerId: b, maxCents: 5_000 }),
      ]);
      expect(ra.ok && rb.ok).toBe(true);
      const rows = await world.ctx.db
        .select()
        .from(bids)
        .where(and(eq(bids.auctionId, auctionId)))
        .orderBy(asc(bids.seq));
      // Exactly one opening row at 2000; the tie resolves to the earlier seq
      // at the tied amount (5000) for the second.
      expect(rows.filter((r) => r.amountCents === 2_000).length).toBe(1);
      const [finalAuction] = await world.ctx.db.select().from(auctions).where(eq(auctions.id, auctionId));
      expect(finalAuction!.currentPriceCents).toBe(5_000);
    }
  }, 30_000);
});
