import { describe, expect, it } from "vitest";
import { DEFAULT_INCREMENT_TABLE, incrementAt, validateIncrementTable } from "./increments.js";

describe("incrementAt — design-doc tier table", () => {
  // Every tier boundary, both sides, in cents.
  const cases: Array<[price: number, expected: number]> = [
    [0, 100],
    [1, 100],
    [4_999, 100], // €49.99 → €1
    [5_000, 500], // €50 → €5
    [19_999, 500], // €199.99 → €5
    [20_000, 1_000], // €200 → €10
    [49_999, 1_000], // €499.99 → €10
    [50_000, 2_500], // €500 → €25
    [99_999, 2_500], // €999.99 → €25
    [100_000, 5_000], // €1,000 → €50
    [499_999, 5_000], // €4,999.99 → €50
    [500_000, 10_000], // €5,000 → €100
    [123_456_700, 10_000], // way above the last tier
  ];
  it.each(cases)("price %i cents → increment %i cents", (price, expected) => {
    expect(incrementAt(price)).toBe(expected);
  });

  it("rejects negative and non-integer prices", () => {
    expect(() => incrementAt(-1)).toThrow();
    expect(() => incrementAt(10.5)).toThrow();
  });
});

describe("validateIncrementTable", () => {
  it("accepts the default table", () => {
    expect(() => validateIncrementTable(DEFAULT_INCREMENT_TABLE)).not.toThrow();
  });
  it("rejects an empty table", () => {
    expect(() => validateIncrementTable([])).toThrow();
  });
  it("rejects a table not starting at 0", () => {
    expect(() => validateIncrementTable([{ fromCents: 100, incrementCents: 100 }])).toThrow();
  });
  it("rejects non-ascending tiers", () => {
    expect(() =>
      validateIncrementTable([
        { fromCents: 0, incrementCents: 100 },
        { fromCents: 5_000, incrementCents: 500 },
        { fromCents: 5_000, incrementCents: 1_000 },
      ]),
    ).toThrow();
  });
  it("rejects a zero increment", () => {
    expect(() => validateIncrementTable([{ fromCents: 0, incrementCents: 0 }])).toThrow();
  });
});
