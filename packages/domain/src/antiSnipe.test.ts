import { describe, expect, it } from "vitest";
import { applyAntiSnipe } from "./antiSnipe.js";

const T0 = 1_800_000_000_000; // arbitrary epoch base

describe("applyAntiSnipe", () => {
  it("does nothing when the bid is outside the window", () => {
    const r = applyAntiSnipe({ endsAtMs: T0 + 120_000, bidAtMs: T0, windowSec: 60 });
    expect(r).toEqual({ endsAtMs: T0 + 120_000, extended: false });
  });

  it("extends to bidTime + window when inside the window", () => {
    const r = applyAntiSnipe({ endsAtMs: T0 + 30_000, bidAtMs: T0, windowSec: 60 });
    expect(r).toEqual({ endsAtMs: T0 + 60_000, extended: true });
  });

  it("boundary: bid exactly window seconds before close does not move the end", () => {
    // proposed == endsAt → no extension recorded
    const r = applyAntiSnipe({ endsAtMs: T0 + 60_000, bidAtMs: T0, windowSec: 60 });
    expect(r).toEqual({ endsAtMs: T0 + 60_000, extended: false });
  });

  it("a bid one ms inside the window extends by one ms", () => {
    const r = applyAntiSnipe({ endsAtMs: T0 + 59_999, bidAtMs: T0, windowSec: 60 });
    expect(r).toEqual({ endsAtMs: T0 + 60_000, extended: true });
  });

  it("window 0 disables anti-snipe", () => {
    const r = applyAntiSnipe({ endsAtMs: T0 + 1_000, bidAtMs: T0, windowSec: 0 });
    expect(r.extended).toBe(false);
  });

  it("respects maxExtensions", () => {
    const r = applyAntiSnipe({
      endsAtMs: T0 + 10_000,
      bidAtMs: T0,
      windowSec: 60,
      maxExtensions: 3,
      extensionsSoFar: 3,
    });
    expect(r.extended).toBe(false);
  });

  it("extends while below maxExtensions", () => {
    const r = applyAntiSnipe({
      endsAtMs: T0 + 10_000,
      bidAtMs: T0,
      windowSec: 60,
      maxExtensions: 3,
      extensionsSoFar: 2,
    });
    expect(r.extended).toBe(true);
  });

  it("ignores a bid timestamped after the close (caller bug guard)", () => {
    const r = applyAntiSnipe({ endsAtMs: T0, bidAtMs: T0 + 1, windowSec: 60 });
    expect(r.extended).toBe(false);
  });
});
