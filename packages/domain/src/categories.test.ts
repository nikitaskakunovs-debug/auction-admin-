import { describe, expect, it } from "vitest";
import { CATEGORIES, CATEGORY_CODES, categoryByCode, isKnownCategory } from "./categories.js";

describe("category taxonomy", () => {
  it("has unique codes and always includes the 'other' fallback", () => {
    expect(new Set(CATEGORY_CODES).size).toBe(CATEGORIES.length);
    expect(isKnownCategory("other")).toBe(true);
  });

  it("looks categories up by code and rejects unknowns", () => {
    expect(categoryByCode("tools")?.label).toBe("Tools & garage");
    expect(categoryByCode("spaceships")).toBeNull();
    expect(isKnownCategory("spaceships")).toBe(false);
  });
});
