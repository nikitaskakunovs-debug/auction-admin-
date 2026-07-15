import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, hotp, otpauthUri, totp, verifyTotp, TOTP_PERIOD_SEC } from "./totp.js";

// RFC 4226 Appendix D reference secret ("12345678901234567890").
const RFC_SECRET = Buffer.from("12345678901234567890", "ascii");

describe("HOTP (RFC 4226 test vectors)", () => {
  const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
  it.each(expected.map((code, i) => [i, code] as const))("counter %i → %s", (counter, code) => {
    expect(hotp(RFC_SECRET, counter)).toBe(code);
  });
});

describe("TOTP", () => {
  it("derives the code from the 30s time-step counter", () => {
    // At t=59s the step is floor(59/30)=1 → HOTP counter 1 = 287082.
    expect(totp(RFC_SECRET, 59)).toBe("287082");
    // t=0 → counter 0 = 755224.
    expect(totp(RFC_SECRET, 0)).toBe("755224");
  });

  it("verifies the current code and rejects a wrong one", () => {
    const now = 1_700_000_000;
    expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, now), now)).toBe(true);
    expect(verifyTotp(RFC_SECRET, "000000", now)).toBe(false);
  });

  it("tolerates ±1 step of clock drift but not more", () => {
    const now = 1_700_000_000;
    const prev = totp(RFC_SECRET, now - TOTP_PERIOD_SEC);
    const next = totp(RFC_SECRET, now + TOTP_PERIOD_SEC);
    const wayOff = totp(RFC_SECRET, now + TOTP_PERIOD_SEC * 3);
    expect(verifyTotp(RFC_SECRET, prev, now)).toBe(true);
    expect(verifyTotp(RFC_SECRET, next, now)).toBe(true);
    expect(verifyTotp(RFC_SECRET, wayOff, now)).toBe(false);
  });

  it("rejects malformed tokens (non-numeric / wrong length)", () => {
    const now = 1_700_000_000;
    expect(verifyTotp(RFC_SECRET, "12ab56", now)).toBe(false);
    expect(verifyTotp(RFC_SECRET, "1234", now)).toBe(false);
    expect(verifyTotp(RFC_SECRET, "", now)).toBe(false);
  });
});

describe("base32 (RFC 4648)", () => {
  it("round-trips arbitrary bytes", () => {
    for (const s of ["", "f", "fo", "foo", "foob", "fooba", "foobar"]) {
      expect(base32Decode(base32Encode(Buffer.from(s))).toString()).toBe(s);
    }
  });

  it("matches known RFC 4648 encodings", () => {
    // RFC 4648 §10 test vectors (unpadded).
    expect(base32Encode(Buffer.from("f"))).toBe("MY");
    expect(base32Encode(Buffer.from("fo"))).toBe("MZXQ");
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
  });

  it("decodes lowercase / padded / spaced input", () => {
    expect(base32Decode("mzxw6ytboi").toString()).toBe("foobar");
    expect(base32Decode("MZXW 6YTB OI==").toString()).toBe("foobar");
  });
});

describe("otpauth URI", () => {
  it("encodes issuer, account and secret for authenticator apps", () => {
    const uri = otpauthUri({ secretBase32: "JBSWY3DPEHPK3PXP", account: "ops@auction.test", issuer: "Baltic Auctions" });
    expect(uri.startsWith("otpauth://totp/Baltic%20Auctions:ops%40auction.test?")).toBe(true);
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(uri).toContain("issuer=Baltic+Auctions");
    expect(uri).toContain("period=30");
  });
});
