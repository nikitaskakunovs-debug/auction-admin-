import { describe, expect, it } from "vitest";
import { qualifiesForReverseCharge, viesAssess, viesFormatValid, viesParse } from "./vies.js";

const NOW = Date.parse("2026-07-08T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

describe("viesParse", () => {
  it("normalizes spacing, dots and dashes", () => {
    expect(viesParse(" lv 4000-345.678 9 ")).toEqual({ cc: "LV", rest: "40003456789", clean: "LV40003456789" });
  });
  it("handles missing prefix", () => {
    expect(viesParse("40003456789")?.cc).toBeNull();
  });
  it("handles empty input", () => {
    expect(viesParse("")).toBeNull();
    expect(viesParse(null)).toBeNull();
  });
});

describe("viesFormatValid — member-state formats", () => {
  const valid = [
    "LV40003456789", // 11 digits
    "EE123456789", // 9 digits
    "LT123456789", // 9 digits
    "LT123456789012", // or 12
    "DE123456789",
    "NL123456789B01",
    "ATU12345678",
    "BE0123456789",
    "PL1234567890",
    "SE123456789012",
  ];
  const invalid = [
    "LV4000345678", // 10 digits
    "EE12345678", // 8 digits
    "LT1234567890", // 10 digits (must be 9 or 12)
    "DE12345678",
    "NL123456789A01",
    "AT12345678", // missing U
    "", // empty
    "40003456789", // no prefix
  ];
  it.each(valid)("accepts %s", (v) => expect(viesFormatValid(v)).toBe(true));
  it.each(invalid)("rejects %s", (v) => expect(viesFormatValid(v)).toBe(false));
});

describe("viesAssess", () => {
  it("returns null without a VAT number", () => {
    expect(viesAssess(null, null, NOW)).toBeNull();
  });
  it("badformat when malformed and never checked", () => {
    expect(viesAssess("LV123", null, NOW)?.state).toBe("badformat");
  });
  it("unchecked when well-formed but never checked", () => {
    expect(viesAssess("LV40003456789", null, NOW)?.state).toBe("unchecked");
  });
  it("invalid when the consultation said no", () => {
    const a = viesAssess("LV40003456789", { valid: false, checkedAt: daysAgo(1), consult: "WLVX" }, NOW);
    expect(a?.state).toBe("invalid");
  });
  it("valid within 90 days, stale after", () => {
    expect(viesAssess("LV40003456789", { valid: true, checkedAt: daysAgo(89), consult: "W1" }, NOW)?.state).toBe("valid");
    expect(viesAssess("LV40003456789", { valid: true, checkedAt: daysAgo(91), consult: "W1" }, NOW)?.state).toBe("stale");
  });
});

describe("qualifiesForReverseCharge", () => {
  const validCheck = { valid: true, checkedAt: daysAgo(5), consult: "WEE123" };
  it("true for a validated buyer in another member state", () => {
    expect(
      qualifiesForReverseCharge({ sellerCountry: "LV", buyerVatNo: "EE123456789", buyerVies: validCheck, nowMs: NOW }),
    ).toBe(true);
  });
  it("false for a domestic buyer", () => {
    expect(
      qualifiesForReverseCharge({ sellerCountry: "LV", buyerVatNo: "LV40003456789", buyerVies: validCheck, nowMs: NOW }),
    ).toBe(false);
  });
  it("false without a VAT number", () => {
    expect(qualifiesForReverseCharge({ sellerCountry: "LV", buyerVatNo: null, buyerVies: null, nowMs: NOW })).toBe(false);
  });
  it("false when unchecked or stale or invalid", () => {
    expect(
      qualifiesForReverseCharge({ sellerCountry: "LV", buyerVatNo: "EE123456789", buyerVies: null, nowMs: NOW }),
    ).toBe(false);
    expect(
      qualifiesForReverseCharge({
        sellerCountry: "LV",
        buyerVatNo: "EE123456789",
        buyerVies: { valid: true, checkedAt: daysAgo(120), consult: "W1" },
        nowMs: NOW,
      }),
    ).toBe(false);
    expect(
      qualifiesForReverseCharge({
        sellerCountry: "LV",
        buyerVatNo: "EE123456789",
        buyerVies: { valid: false, checkedAt: daysAgo(1), consult: "W1" },
        nowMs: NOW,
      }),
    ).toBe(false);
  });
  it("false for a non-EU prefix", () => {
    expect(
      qualifiesForReverseCharge({ sellerCountry: "LV", buyerVatNo: "GB999999973", buyerVies: validCheck, nowMs: NOW }),
    ).toBe(false);
  });
});
