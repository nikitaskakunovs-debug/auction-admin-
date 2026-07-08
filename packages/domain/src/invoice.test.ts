import { describe, expect, it } from "vitest";
import { computeInvoice } from "./invoice.js";
import { applyBasisPoints, formatEur } from "./money.js";

describe("computeInvoice — design-doc worked example", () => {
  it("€100 hammer, LV 21% VAT, 10% premium → €133.10", () => {
    const inv = computeInvoice({ hammerCents: 10_000, buyerPremiumBp: 1_000, vatRateBp: 2_100 });
    expect(inv.premiumCents).toBe(1_000); // €10.00
    expect(inv.netCents).toBe(11_000); // €110.00
    expect(inv.vatCents).toBe(2_310); // €23.10
    expect(inv.totalCents).toBe(13_310); // €133.10
  });

  it("adds shipping after VAT", () => {
    const inv = computeInvoice({
      hammerCents: 10_000,
      buyerPremiumBp: 1_000,
      vatRateBp: 2_100,
      shippingCents: 349,
    });
    expect(inv.totalCents).toBe(13_310 + 349);
  });

  it("Estonia 24% on the same hammer", () => {
    const inv = computeInvoice({ hammerCents: 10_000, buyerPremiumBp: 1_000, vatRateBp: 2_400 });
    expect(inv.vatCents).toBe(2_640);
    expect(inv.totalCents).toBe(13_640);
  });

  it("reverse charge zero-rates VAT and keeps everything else", () => {
    const inv = computeInvoice({
      hammerCents: 10_000,
      buyerPremiumBp: 1_000,
      vatRateBp: 2_100,
      reverseCharge: true,
    });
    expect(inv.vatCents).toBe(0);
    expect(inv.vatRateBp).toBe(0);
    expect(inv.reverseCharge).toBe(true);
    expect(inv.totalCents).toBe(11_000);
  });

  it("rounds premium and VAT half-up per component", () => {
    // hammer €0.05 → premium 0.5 cents → rounds to 1 cent
    const inv = computeInvoice({ hammerCents: 5, buyerPremiumBp: 1_000, vatRateBp: 2_100 });
    expect(inv.premiumCents).toBe(1);
    // net 6 cents * 21% = 1.26 → 1 cent
    expect(inv.vatCents).toBe(1);
    expect(inv.totalCents).toBe(7); // 6 net + 1 VAT
  });

  it("rejects fractional or negative money", () => {
    expect(() => computeInvoice({ hammerCents: 10.5, buyerPremiumBp: 1_000, vatRateBp: 2_100 })).toThrow();
    expect(() => computeInvoice({ hammerCents: -1, buyerPremiumBp: 1_000, vatRateBp: 2_100 })).toThrow();
  });
});

describe("money helpers", () => {
  it("applyBasisPoints rounds half-up", () => {
    expect(applyBasisPoints(5, 1_000)).toBe(1); // 0.5 → 1
    expect(applyBasisPoints(4, 1_000)).toBe(0); // 0.4 → 0
    expect(applyBasisPoints(10_000, 2_100)).toBe(2_100);
    expect(applyBasisPoints(0, 2_100)).toBe(0);
  });

  it("formatEur renders cents", () => {
    expect(formatEur(13_310)).toBe("€133.10");
    expect(formatEur(5)).toBe("€0.05");
    expect(formatEur(500_000)).toBe("€5,000.00");
    expect(formatEur(-150)).toBe("-€1.50");
  });
});
