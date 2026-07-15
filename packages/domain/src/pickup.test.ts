import { describe, expect, it } from "vitest";
import {
  assertTicketTransition,
  canTransitionTicket,
  comparePickPath,
  computeNoShowSettlement,
  computePickProgress,
  dayKey,
  locationLabel,
  ticketNumberFromCounter,
  updateAvgPickSeconds,
  type PickLocation,
} from "./pickup.js";
import { assertItemTransition, canTransitionItem } from "./states.js";

describe("ticket state machine", () => {
  it("follows waiting → picking → delivering → completed", () => {
    assertTicketTransition("waiting", "picking");
    assertTicketTransition("picking", "delivering");
    assertTicketTransition("delivering", "completed");
  });

  it("allows cancel from any non-terminal state, not from terminal ones", () => {
    expect(canTransitionTicket("waiting", "cancelled")).toBe(true);
    expect(canTransitionTicket("picking", "cancelled")).toBe(true);
    expect(canTransitionTicket("delivering", "cancelled")).toBe(true);
    expect(canTransitionTicket("completed", "cancelled")).toBe(false);
    expect(canTransitionTicket("cancelled", "waiting")).toBe(false);
  });

  it("rejects skipping stages", () => {
    expect(canTransitionTicket("waiting", "delivering")).toBe(false);
    expect(canTransitionTicket("waiting", "completed")).toBe(false);
    expect(() => assertTicketTransition("picking", "completed")).toThrow(/illegal ticket transition/);
  });
});

describe("item lifecycle additions for pickup", () => {
  it("paid → no_pickup_cancelled → draft (restock review) is legal", () => {
    assertItemTransition("paid", "no_pickup_cancelled");
    assertItemTransition("no_pickup_cancelled", "draft");
    assertItemTransition("no_pickup_cancelled", "listed");
  });

  it("pickup handover: picking → delivered, and ticket-cancel rollback picking → paid", () => {
    expect(canTransitionItem("picking", "delivered")).toBe(true);
    expect(canTransitionItem("picking", "paid")).toBe(true);
  });

  it("still refuses nonsense", () => {
    expect(canTransitionItem("no_pickup_cancelled", "paid")).toBe(false);
    expect(canTransitionItem("delivered", "picking")).toBe(false);
  });
});

describe("no-show settlement (5% of the full paid total)", () => {
  it("splits €133.10 into €6.66 fee (rounded half-up) + €126.44 refund", () => {
    // 13310 * 500 / 10000 = 665.5 → 666
    const s = computeNoShowSettlement(13_310, 500);
    expect(s.feeCents).toBe(666);
    expect(s.refundCents).toBe(12_644);
    expect(s.feeCents + s.refundCents).toBe(13_310);
  });

  it("handles zero fee and full fee", () => {
    expect(computeNoShowSettlement(10_000, 0)).toEqual({ feeCents: 0, refundCents: 10_000 });
    expect(computeNoShowSettlement(10_000, 10_000)).toEqual({ feeCents: 10_000, refundCents: 0 });
  });

  it("rejects invalid input", () => {
    expect(() => computeNoShowSettlement(-1, 500)).toThrow();
    expect(() => computeNoShowSettlement(100.5, 500)).toThrow();
    expect(() => computeNoShowSettlement(100, 10_001)).toThrow();
  });
});

describe("ticket numbering", () => {
  it("starts at 100 and wraps after 900 per day", () => {
    expect(ticketNumberFromCounter(1)).toBe(100);
    expect(ticketNumberFromCounter(900)).toBe(999);
    expect(ticketNumberFromCounter(901)).toBe(100);
  });

  it("dayKey is the UTC date", () => {
    expect(dayKey(new Date("2026-07-14T23:59:00Z"))).toBe("2026-07-14");
  });
});

describe("progress + ETA", () => {
  it("counts terminal lines (picked/missing/damaged) as done", () => {
    const p = computePickProgress(["picked", "missing", "pending", "pending"], 60);
    expect(p).toEqual({ total: 4, done: 2, pct: 50, etaSec: 120 });
  });

  it("empty ticket is 100% with zero ETA", () => {
    expect(computePickProgress([]).pct).toBe(100);
    expect(computePickProgress([]).etaSec).toBe(0);
  });

  it("EWMA moves toward observations and ignores garbage", () => {
    expect(updateAvgPickSeconds(90, 30)).toBe(78);
    expect(updateAvgPickSeconds(90, -5)).toBe(90);
    expect(updateAvgPickSeconds(90, Number.NaN)).toBe(90);
  });
});

describe("pick-path sorting", () => {
  const loc = (zone: string, aisle: string, rack: string, shelf: string): PickLocation => ({ zone, aisle, rack, shelf });

  it("FRONT before BACK, then natural aisle/rack/shelf order, unlocated last", () => {
    const list: Array<PickLocation | null> = [
      null,
      loc("BACK", "A1", "R1", "S1"),
      loc("FRONT", "A2", "R1", "S1"),
      loc("FRONT", "A10", "R1", "S1"),
      loc("FRONT", "A2", "R1", "S1"),
    ];
    const sorted = [...list].sort(comparePickPath);
    expect(sorted.map((l) => (l ? locationLabel(l) : "—"))).toEqual([
      "FRONT-A2-R1-S1",
      "FRONT-A2-R1-S1",
      "FRONT-A10-R1-S1", // numeric-aware: A2 < A10
      "BACK-A1-R1-S1",
      "—",
    ]);
  });
});
