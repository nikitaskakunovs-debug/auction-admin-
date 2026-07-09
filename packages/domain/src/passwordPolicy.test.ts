import { describe, expect, it } from "vitest";
import { MIN_PASSWORD_LENGTH, validatePassword } from "./passwordPolicy.js";

describe("password policy", () => {
  it("accepts a strong passphrase", () => {
    expect(validatePassword("Correct-Horse-42").ok).toBe(true);
  });

  it("rejects passwords shorter than the minimum", () => {
    const r = validatePassword("Ab1!xy");
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain(String(MIN_PASSWORD_LENGTH));
  });

  it("requires at least three character classes", () => {
    // long but all lowercase → only one class
    expect(validatePassword("abcdefghijklmnop").ok).toBe(false);
  });

  it("blocks common passwords", () => {
    expect(validatePassword("password123").ok).toBe(false);
  });

  it("rejects a single repeated character", () => {
    expect(validatePassword("aaaaaaaaaaaaaa").ok).toBe(false);
  });

  it("forbids embedding the account email or name", () => {
    expect(validatePassword("ntsAdmin-2026!", { email: "nts@auction.test" }).ok).toBe(false);
    expect(validatePassword("Nikita-Strong-9", { name: "nikita" }).ok).toBe(false);
  });
});
