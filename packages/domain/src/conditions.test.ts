import { describe, expect, it } from "vitest";
import {
  CONDITIONS,
  CONDITION_CODES,
  conditionByCode,
  conditionRequiresNotes,
  isKnownCondition,
} from "./conditions.js";

describe("condition taxonomy", () => {
  it("has the 16 grades from the reference sheet, codes unique", () => {
    expect(CONDITIONS).toHaveLength(16);
    expect(new Set(CONDITION_CODES).size).toBe(16);
  });

  it("flags exactly the SEE NOTES grades as requiring notes", () => {
    const seeNotes = CONDITIONS.filter((c) => c.requiresNotes).map((c) => c.code);
    expect(seeNotes.sort()).toEqual(
      ["lightly_used", "new_cosmetic_imperfection", "new_with_issue", "used", "used_with_issue"].sort(),
    );
  });

  it("looks up grades by code", () => {
    expect(conditionByCode("brand_new")?.label).toBe("Brand new");
    expect(conditionByCode("nope")).toBeNull();
  });

  it("requiresNotes helper is safe on unknown codes", () => {
    expect(conditionRequiresNotes("used")).toBe(true);
    expect(conditionRequiresNotes("brand_new")).toBe(false);
    expect(conditionRequiresNotes("legacy-good")).toBe(false);
  });

  it("isKnownCondition distinguishes taxonomy codes from legacy free text", () => {
    expect(isKnownCondition("as_is_salvage")).toBe(true);
    expect(isKnownCondition("very good")).toBe(false);
  });

  it("every grade has a non-empty label and description", () => {
    for (const c of CONDITIONS) {
      expect(c.label.length).toBeGreaterThan(2);
      expect(c.description.length).toBeGreaterThan(10);
    }
  });
});
