import { describe, expect, it } from "vitest";
import type { BidState, IncomingBid } from "./proxy.js";
import { minNextBidCents, resolveBid } from "./proxy.js";

const fresh = (over: Partial<BidState> = {}): BidState => ({
  startPriceCents: 1_000, // €10
  reserveCents: null,
  currentPriceCents: null,
  leader: null,
  ...over,
});

let seqCounter = 0;
const bid = (bidderId: string, maxCents: number): IncomingBid => ({ bidderId, maxCents, seq: ++seqCounter });

function accept(state: BidState, b: IncomingBid) {
  const r = resolveBid(state, b);
  if (!r.ok) throw new Error(`expected acceptance, got ${r.code}`);
  return r;
}

describe("first bid", () => {
  it("rejects below start price", () => {
    const r = resolveBid(fresh(), bid("alice", 999));
    expect(r).toMatchObject({ ok: false, code: "BELOW_START_PRICE", minAcceptableCents: 1_000 });
  });

  it("opens at the start price even with a much higher max", () => {
    const r = accept(fresh(), bid("alice", 50_000));
    expect(r.state.currentPriceCents).toBe(1_000);
    expect(r.state.leader?.bidderId).toBe("alice");
    expect(r.state.leader?.maxCents).toBe(50_000);
    expect(r.ledger).toEqual([{ bidderId: "alice", amountCents: 1_000, auto: false, outbid: false }]);
  });

  it("bid exactly at start price is accepted", () => {
    const r = accept(fresh(), bid("alice", 1_000));
    expect(r.state.currentPriceCents).toBe(1_000);
  });

  it("jumps straight to the reserve when the first max covers it", () => {
    const r = accept(fresh({ reserveCents: 5_000 }), bid("alice", 8_000));
    expect(r.state.currentPriceCents).toBe(5_000);
    expect(r.reserveMet).toBe(true);
  });

  it("stays at start price with reserve not met", () => {
    const r = accept(fresh({ reserveCents: 5_000 }), bid("alice", 3_000));
    expect(r.state.currentPriceCents).toBe(1_000);
    expect(r.reserveMet).toBe(false);
  });

  it("rejects a zero or invalid amount", () => {
    expect(resolveBid(fresh(), bid("alice", 0)).ok).toBe(false);
    expect(resolveBid(fresh(), bid("alice", 10.5)).ok).toBe(false);
    expect(resolveBid(fresh(), bid("alice", -100)).ok).toBe(false);
  });
});

describe("challenger vs leading proxy", () => {
  it("rejects below current price + increment", () => {
    const s = accept(fresh(), bid("alice", 50_000)).state; // price 1000, inc €1
    const r = resolveBid(s, bid("bob", 1_099));
    expect(r).toMatchObject({ ok: false, code: "BELOW_MINIMUM", minAcceptableCents: 1_100 });
  });

  it("leader defends: price rises one increment above the challenger's max", () => {
    const s = accept(fresh(), bid("alice", 50_000)).state;
    const r = accept(s, bid("bob", 2_000));
    // bob max €20, inc at €20 is €1 → price €21, alice still leads
    expect(r.state.currentPriceCents).toBe(2_100);
    expect(r.state.leader?.bidderId).toBe("alice");
    expect(r.leaderChanged).toBe(false);
    expect(r.ledger).toEqual([
      { bidderId: "bob", amountCents: 2_000, auto: false, outbid: true },
      { bidderId: "alice", amountCents: 2_100, auto: true, outbid: false },
    ]);
  });

  it("defence is capped at the leader's max", () => {
    const s = accept(fresh(), bid("alice", 2_050)).state; // alice max €20.50
    const r = accept(s, bid("bob", 2_000));
    // €20 + €1 = €21 > alice's €20.50 → capped at 2050
    expect(r.state.currentPriceCents).toBe(2_050);
    expect(r.state.leader?.bidderId).toBe("alice");
  });

  it("exact tie: the earlier bid wins at the tied amount", () => {
    const s = accept(fresh(), bid("alice", 2_000)).state;
    const r = accept(s, bid("bob", 2_000));
    expect(r.state.currentPriceCents).toBe(2_000);
    expect(r.state.leader?.bidderId).toBe("alice");
    expect(r.leaderChanged).toBe(false);
  });

  it("challenger overtakes: price is one increment above the old leader's max", () => {
    const s = accept(fresh(), bid("alice", 2_000)).state;
    const r = accept(s, bid("bob", 10_000));
    // alice pushed to her €20 max, inc at €20 = €1 → bob leads at €21
    expect(r.state.currentPriceCents).toBe(2_100);
    expect(r.state.leader?.bidderId).toBe("bob");
    expect(r.leaderChanged).toBe(true);
    expect(r.ledger).toEqual([
      { bidderId: "alice", amountCents: 2_000, auto: true, outbid: true },
      { bidderId: "bob", amountCents: 2_100, auto: false, outbid: false },
    ]);
  });

  it("overtake price is capped at the challenger's own max", () => {
    const s = accept(fresh(), bid("alice", 2_000)).state;
    const r = accept(s, bid("bob", 2_050)); // above minNext (1100) and above alice's max
    expect(r.state.currentPriceCents).toBe(2_050); // 2000+100 capped at 2050
    expect(r.state.leader?.bidderId).toBe("bob");
  });

  it("increment straddles a tier boundary correctly", () => {
    // Current price lands at €49.60; tier is still €1 below €50.
    const s = accept(fresh(), bid("alice", 100_000)).state; // price €10
    const r = accept(s, bid("bob", 4_950)); // bob max €49.50, inc at €49.50 = €1 → €50.50
    expect(r.state.currentPriceCents).toBe(5_050);
    // Next challenger must clear €50.50 + €5 (tier 2)
    expect(minNextBidCents(r.state)).toBe(5_550);
  });
});

describe("reserve interaction", () => {
  it("overtake lifts the price to the reserve when the new max covers it", () => {
    const s0 = fresh({ reserveCents: 10_000 });
    const s1 = accept(s0, bid("alice", 3_000)).state; // price 1000, reserve not met
    const r = accept(s1, bid("bob", 12_000));
    // alice pushed to 3000, +inc(3000)=100 → 3100, but bob covers reserve → 10000
    expect(r.state.currentPriceCents).toBe(10_000);
    expect(r.state.leader?.bidderId).toBe("bob");
    expect(r.reserveMet).toBe(true);
  });

  it("defence does not lift to the reserve when the leader's max is below it", () => {
    const s0 = fresh({ reserveCents: 10_000 });
    const s1 = accept(s0, bid("alice", 5_000)).state;
    const r = accept(s1, bid("bob", 2_000));
    expect(r.state.currentPriceCents).toBe(2_100);
    expect(r.reserveMet).toBe(false);
  });

  it("defence lifts to the reserve when the defending leader's max covers it", () => {
    const s0 = fresh({ reserveCents: 2_500 });
    const s1 = accept(s0, bid("alice", 5_000)).state; // price = reserve 2500 (covered on first bid)
    expect(s1.currentPriceCents).toBe(2_500);
    const r = accept(s1, bid("bob", 2_600));
    // bob 2600 < alice 5000 → defended: 2600 + inc(2600)=100 → 2700
    expect(r.state.currentPriceCents).toBe(2_700);
    expect(r.state.leader?.bidderId).toBe("alice");
  });
});

describe("leader raising their own max", () => {
  it("does not raise the price", () => {
    const s1 = accept(fresh(), bid("alice", 2_000)).state;
    const s2 = accept(s1, bid("bob", 1_500)).state; // price 1600, alice leads
    const r = accept(s2, bid("alice", 9_000));
    expect(r.state.currentPriceCents).toBe(1_600);
    expect(r.state.leader?.maxCents).toBe(9_000);
    expect(r.priceChanged).toBe(false);
    expect(r.ledger).toEqual([]);
  });

  it("rejects a raise that is not above the current max", () => {
    const s = accept(fresh(), bid("alice", 2_000)).state;
    const r = resolveBid(s, bid("alice", 2_000));
    expect(r).toMatchObject({ ok: false, code: "NOT_ABOVE_OWN_MAX", minAcceptableCents: 2_001 });
  });

  it("raise that newly covers the reserve jumps the price to the reserve", () => {
    const s0 = fresh({ reserveCents: 8_000 });
    const s1 = accept(s0, bid("alice", 3_000)).state; // price 1000, not met
    const r = accept(s1, bid("alice", 8_500));
    expect(r.state.currentPriceCents).toBe(8_000);
    expect(r.reserveMet).toBe(true);
    expect(r.ledger).toHaveLength(1); // visible jump row
  });
});

describe("multi-bid battle (integration of the pure resolver)", () => {
  it("plays a realistic sequence with a consistent monotone price", () => {
    let s = fresh({ startPriceCents: 500 }); // €5 start
    const seq: Array<[string, number]> = [
      ["a", 500], // opens at 5.00
      ["b", 700], // b leads at min(700, 500+100)=600
      ["a", 2_000], // a retakes: min(2000, 700+100)=800
      ["c", 1_900], // defended: 1900+100=2000 capped at a's 2000 → tie-free: 2000
      ["b", 5_000], // b overtakes: a pushed to 2000, +100 → 2100... but current already 2000 → max(2000, 2100)=2100
    ];
    const prices: number[] = [];
    for (const [who, max] of seq) {
      const r = resolveBid(s, bid(who, max));
      if (!r.ok) throw new Error(`unexpected reject at ${who} ${max}: ${r.code}`);
      s = r.state;
      prices.push(s.currentPriceCents!);
    }
    expect(prices).toEqual([500, 600, 800, 2_000, 2_100]);
    expect(s.leader?.bidderId).toBe("b");
    // Price never decreased.
    for (let i = 1; i < prices.length; i++) expect(prices[i]!).toBeGreaterThanOrEqual(prices[i - 1]!);
  });
});
