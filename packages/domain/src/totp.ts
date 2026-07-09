import { createHmac } from "node:crypto";

/**
 * RFC 6238 TOTP (and its RFC 4226 HOTP core) for admin two-factor auth, plus
 * RFC 4648 base32 for the shared-secret encoding authenticator apps expect.
 *
 * Everything here is a pure function of its inputs (secret bytes + time), so
 * the algorithm is unit-tested against the published RFC 4226 test vectors.
 * Secret and recovery-code *generation* (which needs randomness) lives in the
 * API layer; verification lives here.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 encode (no padding — authenticator apps accept it). */
export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** RFC 4648 base32 decode; tolerant of lowercase, spaces and `=` padding. */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/g, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error("invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 4226 HOTP: a 6-(or n-)digit code for a secret and moving counter. */
export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const buf = Buffer.alloc(8);
  // Counter is a 64-bit big-endian integer; JS bit ops are 32-bit, so split.
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac("sha1", secret).update(buf).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return (binary % 10 ** digits).toString().padStart(digits, "0");
}

export const TOTP_PERIOD_SEC = 30;

/** RFC 6238 TOTP code for a moment in time (default 30s step). */
export function totp(secret: Buffer, unixSeconds: number, period = TOTP_PERIOD_SEC, digits = 6): string {
  return hotp(secret, Math.floor(unixSeconds / period), digits);
}

/**
 * Verify a user-entered TOTP code, allowing ±`window` steps of clock drift
 * (default ±1 = a 90s tolerance). Comparison walks a fixed set of counters so
 * a wrong code costs the same work as a right one.
 */
export function verifyTotp(
  secret: Buffer,
  token: string,
  unixSeconds: number,
  opts: { window?: number; period?: number; digits?: number } = {},
): boolean {
  const period = opts.period ?? TOTP_PERIOD_SEC;
  const digits = opts.digits ?? 6;
  const window = opts.window ?? 1;
  const trimmed = token.replace(/\s+/g, "");
  if (!/^\d+$/.test(trimmed) || trimmed.length !== digits) return false;
  const counter = Math.floor(unixSeconds / period);
  let ok = false;
  for (let i = -window; i <= window; i++) {
    // No early break: keep the loop's timing independent of where a match is.
    if (constantTimeEqual(hotp(secret, counter + i, digits), trimmed)) ok = true;
  }
  return ok;
}

/** Length-safe constant-time string compare for short numeric codes. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** otpauth:// provisioning URI for QR display in an authenticator app. */
export function otpauthUri(params: { secretBase32: string; account: string; issuer: string }): string {
  // Issuer and account are each encoded, but the separating colon stays
  // literal (the Google Authenticator "Issuer:account" label convention).
  const label = `${encodeURIComponent(params.issuer)}:${encodeURIComponent(params.account)}`;
  const q = new URLSearchParams({
    secret: params.secretBase32,
    issuer: params.issuer,
    algorithm: "SHA1",
    digits: "6",
    period: String(TOTP_PERIOD_SEC),
  });
  return `otpauth://totp/${label}?${q.toString()}`;
}
