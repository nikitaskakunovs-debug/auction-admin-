import { describe, expect, it } from "vitest";
import { formatConsignmentRef, formatSku } from "./intake.js";

describe("receiving formats", () => {
  it("pads SKUs to six digits and grows past the pad", () => {
    expect(formatSku(101)).toBe("LOT-000101");
    expect(formatSku(1234567)).toBe("LOT-1234567");
  });

  it("pads consignment refs to four digits", () => {
    expect(formatConsignmentRef(1)).toBe("CON-0001");
    expect(formatConsignmentRef(12345)).toBe("CON-12345");
  });

  it("rejects non-sequence input", () => {
    expect(() => formatSku(-1)).toThrow();
    expect(() => formatConsignmentRef(1.5)).toThrow();
  });
});
