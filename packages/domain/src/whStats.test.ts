import { describe, expect, it } from "vitest";
import { activeSeconds, breakSeconds, pctDelta, picksPerHour } from "./whStats.js";

const at = (h: number, m: number) => new Date(Date.UTC(2026, 6, 29, h, m, 0));

describe("breakSeconds", () => {
  it("sums each break until the next status change", () => {
    const changes = [
      { status: "working", at: at(8, 0) },
      { status: "coffee", at: at(10, 0) },
      { status: "working", at: at(10, 15) },
      { status: "lunch", at: at(12, 30) },
      { status: "working", at: at(13, 4) },
    ];
    expect(breakSeconds(changes, at(17, 0))).toBe(15 * 60 + 34 * 60);
  });

  it("runs an unfinished break to the window end", () => {
    const changes = [
      { status: "working", at: at(8, 0) },
      { status: "coffee", at: at(16, 40) },
    ];
    expect(breakSeconds(changes, at(17, 0))).toBe(20 * 60);
  });

  it("is zero with no breaks and ignores 'done'", () => {
    expect(breakSeconds([{ status: "working", at: at(8, 0) }, { status: "done", at: at(17, 0) }], at(18, 0))).toBe(0);
    expect(breakSeconds([], at(17, 0))).toBe(0);
  });
});

describe("activeSeconds", () => {
  it("is span minus breaks", () => {
    expect(activeSeconds(at(8, 0), at(16, 0), 3600)).toBe(7 * 3600);
  });
  it("never goes negative", () => {
    expect(activeSeconds(at(8, 0), at(8, 30), 3600)).toBe(0);
  });
  it("is null without a measurable span", () => {
    expect(activeSeconds(null, at(16, 0), 0)).toBeNull();
    expect(activeSeconds(at(8, 0), null, 0)).toBeNull();
    expect(activeSeconds(at(8, 0), at(8, 0), 0)).toBeNull();
  });
});

describe("picksPerHour", () => {
  it("rates over a real span", () => {
    expect(picksPerHour(31, 6 * 3600)).toBe(5.2);
  });
  it("refuses to extrapolate short spans", () => {
    expect(picksPerHour(2, 5 * 60)).toBeNull();
    expect(picksPerHour(10, null)).toBeNull();
  });
});

describe("pctDelta", () => {
  it("whole percent vs previous", () => {
    expect(pctDelta(128, 114)).toBe(12);
    expect(pctDelta(90, 100)).toBe(-10);
  });
  it("null with no base", () => {
    expect(pctDelta(5, 0)).toBeNull();
  });
});
