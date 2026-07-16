import { createHash, randomBytes } from "node:crypto";
import { trustedDevices } from "@auction/db";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../context.js";

/**
 * "Trust this device": after a full password+TOTP login the admin can mark the
 * browser as trusted, which skips the TOTP step on later logins (the password
 * is always still required). The browser holds a random token in an httpOnly
 * cookie; only its hash is stored. Any credential-shaped event — password
 * change or reset, 2FA re-enrollment, admin-side reset/deactivation — revokes
 * every trusted device for that user.
 */

export const TRUSTED_COOKIE = "admin_td";
// Same path as the refresh cookie: rides only on /api/auth/* requests.
const COOKIE_PATH = "/api/auth";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export async function issueTrustedDevice(ctx: AppContext, reply: FastifyReply, userId: string): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  await ctx.db.insert(trustedDevices).values({
    userId,
    tokenHash: sha256(token),
    expiresAt: new Date(ctx.now().getTime() + ctx.config.trustedDeviceTtlSec * 1000),
  });
  reply.setCookie(TRUSTED_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: ctx.config.isProduction,
    path: COOKIE_PATH,
    maxAge: ctx.config.trustedDeviceTtlSec,
  });
}

/** True when the request carries a live trusted-device token for this user. */
export async function isTrustedDevice(ctx: AppContext, req: FastifyRequest, userId: string): Promise<boolean> {
  const token = req.cookies?.[TRUSTED_COOKIE];
  if (!token) return false;
  const [row] = await ctx.db
    .select()
    .from(trustedDevices)
    .where(and(eq(trustedDevices.tokenHash, sha256(token)), isNull(trustedDevices.revokedAt)));
  return Boolean(row && row.userId === userId && row.expiresAt.getTime() > ctx.now().getTime());
}

/** Revoke every trusted device for a user (credential change, deactivation…).
 * Takes the db handle first so it also composes with a transaction (`tx`). */
export async function revokeAllTrustedDevices(
  db: Pick<AppContext["db"], "update">,
  userId: string,
  now: Date,
): Promise<void> {
  await db
    .update(trustedDevices)
    .set({ revokedAt: now })
    .where(and(eq(trustedDevices.userId, userId), isNull(trustedDevices.revokedAt)));
}
