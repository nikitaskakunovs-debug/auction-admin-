import { describe, expect, it } from "vitest";
import { computeInvoice } from "./invoice.js";
import { applyBasisPoints, formatEur } from "./money.js";

describe("computeInvoice — цена финальная, разложение вниз", () => {
  it("€133.10 финальная, LV 21% PVN, 10% komisija → молоток €100", () => {
    const inv = computeInvoice({ grossCents: 13_310, buyerPremiumBp: 1_000, vatRateBp: 2_100 });
    expect(inv.netCents).toBe(11_000); // €110.00
    expect(inv.vatCents).toBe(2_310); // €23.10
    expect(inv.hammerCents).toBe(10_000); // €100.00
    expect(inv.premiumCents).toBe(1_000); // €10.00
    expect(inv.totalCents).toBe(13_310); // ровно то, что видел клиент
  });

  it("части всегда сходятся с финальной ценой копейка в копейку", () => {
    for (const gross of [1, 7, 99, 500_00, 123_457, 999_999]) {
      const inv = computeInvoice({ grossCents: gross, buyerPremiumBp: 1_000, vatRateBp: 2_100 });
      expect(inv.hammerCents + inv.premiumCents + inv.vatCents).toBe(gross);
      expect(inv.totalCents).toBe(gross);
    }
  });

  it("доставка добавляется поверх финальной цены товара", () => {
    const inv = computeInvoice({
      grossCents: 13_310,
      buyerPremiumBp: 1_000,
      vatRateBp: 2_100,
      shippingCents: 349,
    });
    expect(inv.totalCents).toBe(13_310 + 349);
  });

  it("Эстония 24% — из той же финальной цены другой НДС", () => {
    const inv = computeInvoice({ grossCents: 13_640, buyerPremiumBp: 1_000, vatRateBp: 2_400 });
    expect(inv.netCents).toBe(11_000);
    expect(inv.vatCents).toBe(2_640);
    expect(inv.totalCents).toBe(13_640);
  });

  it("reverse charge: юрлицо платит минус НДС-часть", () => {
    const inv = computeInvoice({
      grossCents: 13_310,
      buyerPremiumBp: 1_000,
      vatRateBp: 2_100,
      reverseCharge: true,
    });
    expect(inv.vatCents).toBe(0);
    expect(inv.vatRateBp).toBe(0);
    expect(inv.reverseCharge).toBe(true);
    expect(inv.totalCents).toBe(11_000); // net без НДС
    expect(inv.hammerCents + inv.premiumCents).toBe(11_000);
  });

  it("копеечные суммы не рассыпаются", () => {
    const inv = computeInvoice({ grossCents: 7, buyerPremiumBp: 1_000, vatRateBp: 2_100 });
    expect(inv.hammerCents + inv.premiumCents + inv.vatCents).toBe(7);
    expect(inv.totalCents).toBe(7);
  });

  it("rejects fractional or negative money", () => {
    expect(() => computeInvoice({ grossCents: 10.5, buyerPremiumBp: 1_000, vatRateBp: 2_100 })).toThrow();
    expect(() => computeInvoice({ grossCents: -1, buyerPremiumBp: 1_000, vatRateBp: 2_100 })).toThrow();
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
