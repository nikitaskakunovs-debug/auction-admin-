import { createHmac, timingSafeEqual } from "node:crypto";

/** Minimal HS256 JWT — sign + verify, no external deps. */

export interface AccessClaims {
  sub: string; // admin user id or customer id, per kind
  /** Token audience: admin panel vs public bidder. Never interchangeable. */
  kind: "admin" | "bidder";
  email: string;
  name: string;
  /** Admin role id; bidders carry "bidder". */
  role: string;
  exp: number; // epoch seconds
  iat: number;
}

const b64url = (buf: Buffer | string): string =>
  Buffer.from(buf).toString("base64url");

function hmac(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function signAccessToken(
  claims: Omit<AccessClaims, "exp" | "iat">,
  secret: string,
  ttlSec: number,
  nowMs = Date.now(),
): string {
  const iat = Math.floor(nowMs / 1000);
  const payload: AccessClaims = { ...claims, iat, exp: iat + ttlSec };
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  return `${head}.${body}.${hmac(`${head}.${body}`, secret)}`;
}

export function verifyAccessToken(token: string, secret: string, nowMs = Date.now()): AccessClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts as [string, string, string];
  const expected = hmac(`${head}.${body}`, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let claims: AccessClaims;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString()) as AccessClaims;
  } catch {
    return null;
  }
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= nowMs) return null;
  return claims;
}
