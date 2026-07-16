import { createHash, randomBytes } from "node:crypto";
import { passwordResets } from "@auction/db";
import { and, eq, isNull } from "drizzle-orm";
import type { Redis } from "ioredis";
import type { AppContext } from "../context.js";

/**
 * Shared password-reset machinery for admins and customers. The emailed token
 * is random and single-use; only its SHA-256 lands in the database, so a DB
 * leak cannot forge reset links. Request handlers must always answer a flat
 * "ok" regardless of whether the account exists — the send happens out of the
 * request path so timing doesn't leak existence either.
 */

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Max reset emails per address per window — stops mailbox bombing. */
const REQUEST_CEILING = 3;
const REQUEST_WINDOW_SEC = 900;

export async function resetRequestAllowed(redis: Redis, email: string): Promise<boolean> {
  const key = `pwreset:req:${email.toLowerCase()}`;
  const count = await redis.incr(key);
  await redis.expire(key, REQUEST_WINDOW_SEC);
  return count <= REQUEST_CEILING;
}

export async function createResetToken(
  ctx: AppContext,
  subject: { userId: string } | { customerId: string },
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await ctx.db.insert(passwordResets).values({
    userId: "userId" in subject ? subject.userId : null,
    customerId: "customerId" in subject ? subject.customerId : null,
    tokenHash: sha256(token),
    expiresAt: new Date(ctx.now().getTime() + ctx.config.passwordResetTtlSec * 1000),
  });
  return token;
}

export interface ResetSubject {
  rowId: string;
  userId: string | null;
  customerId: string | null;
}

/** Look up a presented token; valid = exists, unexpired, never used. */
export async function findValidResetToken(ctx: AppContext, token: string): Promise<ResetSubject | null> {
  const [row] = await ctx.db
    .select()
    .from(passwordResets)
    .where(and(eq(passwordResets.tokenHash, sha256(token)), isNull(passwordResets.usedAt)));
  if (!row || row.expiresAt.getTime() <= ctx.now().getTime()) return null;
  return { rowId: row.id, userId: row.userId, customerId: row.customerId };
}

/** Burn the token (single use). */
export async function markResetTokenUsed(ctx: AppContext, rowId: string): Promise<void> {
  await ctx.db.update(passwordResets).set({ usedAt: ctx.now() }).where(eq(passwordResets.id, rowId));
}

/** Bilingual reset email, matching the notification templates' tone. The
 * `[password_reset]` tag is machine-readable (tests) and harmless to read. */
export function resetEmail(link: string, ttlMinutes: number): { subject: string; text: string } {
  return {
    subject: "Paroles atjaunošana / Password reset — Izsoli.lv",
    text:
      `Lai iestatītu jaunu paroli, atveriet saiti (derīga ${ttlMinutes} min):\n` +
      `To set a new password, open this link (valid for ${ttlMinutes} min):\n\n` +
      `${link}\n\n` +
      `Ja jūs to nepieprasījāt, ignorējiet šo e-pastu — parole netiks mainīta.\n` +
      `If you didn't request this, ignore this email — your password will not change.\n\n` +
      `[password_reset]`,
  };
}
