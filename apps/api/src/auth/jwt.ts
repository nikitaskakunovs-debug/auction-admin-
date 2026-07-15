import { createHmac, timingSafeEqual } from "node:crypto";

/** Minimal HS256 JWT — sign + verify, no external deps. */

const ISSUER = "baltic-auction";
const AUDIENCE = "baltic-admin";

export interface AccessClaims {
  sub: string; // admin user id or customer id, per kind
  /** Token audience: admin panel vs public bidder. Never interchangeable. */
  kind: "admin" | "bidder";
  email: string;
  name: string;
  /** Admin role id; bidders carry "bidder". */
  role: string;
  iss: string;
  aud: string;
  exp: number; // epoch seconds
  iat: number;
}

/**
 * A short-lived token that proves password step 1 passed but grants NOTHING
 * except the ability to complete the second factor. `step` says whether the
 * user must enroll TOTP (first login) or enter a code (already enrolled).
 */
export interface ChallengeClaims {
  sub: string;
  kind: "challenge";
  step: "totp" | "enroll";
  iss: string;
  aud: string;
  exp: number;
  iat: number;
}

const b64url = (buf: Buffer | string): string => Buffer.from(buf).toString("base64url");

function hmac(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

function sign(payload: object, secret: string): string {
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  return `${head}.${body}.${hmac(`${head}.${body}`, secret)}`;
}

/** Verify signature + structural header, returning the raw claims or null. */
function verify(token: string, secret: string, nowMs: number): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts as [string, string, string];
  // Pin the algorithm: reject anything but HS256 (defence against alg
  // confusion / "none"), even though we always recompute with HS256 below.
  let header: { alg?: string; typ?: string };
  try {
    header = JSON.parse(Buffer.from(head, "base64url").toString()) as { alg?: string };
  } catch {
    return null;
  }
  if (header.alg !== "HS256") return null;
  const expected = hmac(`${head}.${body}`, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString()) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (claims.iss !== ISSUER || claims.aud !== AUDIENCE) return null;
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= nowMs) return null;
  return claims;
}

export function signAccessToken(
  claims: Omit<AccessClaims, "exp" | "iat" | "iss" | "aud">,
  secret: string,
  ttlSec: number,
  nowMs = Date.now(),
): string {
  const iat = Math.floor(nowMs / 1000);
  const payload: AccessClaims = { ...claims, iss: ISSUER, aud: AUDIENCE, iat, exp: iat + ttlSec };
  return sign(payload, secret);
}

export function verifyAccessToken(token: string, secret: string, nowMs = Date.now()): AccessClaims | null {
  const claims = verify(token, secret, nowMs);
  if (!claims) return null;
  if (claims.kind !== "admin" && claims.kind !== "bidder") return null;
  return claims as unknown as AccessClaims;
}

/**
 * A pay-by-link token (embedded in "you won" / reminder emails). Grants ONE
 * ability: opening the Klix checkout for that specific order — it is not a
 * session and reads nothing. Expires with the order's payment deadline.
 */
export interface PayLinkClaims {
  /** The order ref (A-1042). */
  sub: string;
  kind: "pay";
  iss: string;
  aud: string;
  exp: number;
  iat: number;
}

export function signPayLinkToken(orderRef: string, secret: string, expiresAtMs: number, nowMs = Date.now()): string {
  const payload: PayLinkClaims = {
    sub: orderRef,
    kind: "pay",
    iss: ISSUER,
    aud: AUDIENCE,
    iat: Math.floor(nowMs / 1000),
    exp: Math.floor(expiresAtMs / 1000),
  };
  return sign(payload, secret);
}

export function verifyPayLinkToken(token: string, secret: string, nowMs = Date.now()): PayLinkClaims | null {
  const claims = verify(token, secret, nowMs);
  if (!claims || claims.kind !== "pay") return null;
  return claims as unknown as PayLinkClaims;
}

export function signChallengeToken(
  sub: string,
  step: "totp" | "enroll",
  secret: string,
  ttlSec: number,
  nowMs = Date.now(),
): string {
  const iat = Math.floor(nowMs / 1000);
  const payload: ChallengeClaims = { sub, kind: "challenge", step, iss: ISSUER, aud: AUDIENCE, iat, exp: iat + ttlSec };
  return sign(payload, secret);
}

export function verifyChallengeToken(token: string, secret: string, nowMs = Date.now()): ChallengeClaims | null {
  const claims = verify(token, secret, nowMs);
  if (!claims || claims.kind !== "challenge") return null;
  if (claims.step !== "totp" && claims.step !== "enroll") return null;
  return claims as unknown as ChallengeClaims;
}
