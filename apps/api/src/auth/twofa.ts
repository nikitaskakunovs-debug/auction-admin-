import { createHash, randomBytes } from "node:crypto";
import { adminRecoveryCodes, adminUsers, type Db } from "@auction/db";
import { base32Decode, base32Encode, otpauthUri, verifyTotp } from "@auction/domain";
import { and, eq, isNull } from "drizzle-orm";
import type { Redis } from "ioredis";

const RECOVERY_CODE_COUNT = 10;
const PENDING_TTL_SEC = 900; // 15 min to complete enrollment

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** A fresh 160-bit base32 TOTP secret (authenticator-app standard length). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function buildOtpauthUri(secretBase32: string, account: string, issuer: string): string {
  return otpauthUri({ secretBase32, account, issuer });
}

/** Verify a 6-digit TOTP against a base32 secret at the given wall-clock. */
export function verifyTotpCode(secretBase32: string, code: string, nowMs: number): boolean {
  let secret: Buffer;
  try {
    secret = base32Decode(secretBase32);
  } catch {
    return false;
  }
  return verifyTotp(secret, code, Math.floor(nowMs / 1000), { window: 1 });
}

// ── Pending enrollment secret (Redis, not the column) ────────────────────────
// Kept out of the admin_users row until the user proves possession, so an
// abandoned re-enrollment never overwrites a working secret and locks them out.

const pendingKey = (userId: string) => `2fa:pending:${userId}`;

export async function stashPendingSecret(redis: Redis, userId: string, secret: string): Promise<void> {
  await redis.set(pendingKey(userId), secret, "EX", PENDING_TTL_SEC);
}

export async function readPendingSecret(redis: Redis, userId: string): Promise<string | null> {
  return redis.get(pendingKey(userId));
}

export async function clearPendingSecret(redis: Redis, userId: string): Promise<void> {
  await redis.del(pendingKey(userId));
}

// ── Recovery codes ───────────────────────────────────────────────────────────

/** Human-friendly recovery code, e.g. "K7QF2-9RMTX". */
function formatRecoveryCode(): string {
  const raw = base32Encode(randomBytes(7)).slice(0, 10);
  return `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
}

/** Normalise before hashing so dashes/case/spacing don't matter at redemption. */
const normalizeRecoveryCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * Replace a user's recovery codes with a fresh set. Returns the plaintext
 * codes to show ONCE; only their hashes are persisted.
 */
export async function replaceRecoveryCodes(db: Db, userId: string): Promise<string[]> {
  const plaintext = Array.from({ length: RECOVERY_CODE_COUNT }, formatRecoveryCode);
  await db.transaction(async (tx) => {
    await tx.delete(adminRecoveryCodes).where(eq(adminRecoveryCodes.userId, userId));
    for (const code of plaintext) {
      await tx.insert(adminRecoveryCodes).values({ userId, codeHash: sha256(normalizeRecoveryCode(code)) });
    }
  });
  return plaintext;
}

/**
 * Redeem a recovery code: if it matches an unused row, burn it and return true.
 * Uses a conditional UPDATE so concurrent redemptions can't reuse one code.
 */
export async function consumeRecoveryCode(db: Db, userId: string, code: string, now: Date): Promise<boolean> {
  const hash = sha256(normalizeRecoveryCode(code));
  const [row] = await db
    .select({ id: adminRecoveryCodes.id })
    .from(adminRecoveryCodes)
    .where(
      and(eq(adminRecoveryCodes.userId, userId), eq(adminRecoveryCodes.codeHash, hash), isNull(adminRecoveryCodes.usedAt)),
    );
  if (!row) return false;
  const updated = await db
    .update(adminRecoveryCodes)
    .set({ usedAt: now })
    .where(and(eq(adminRecoveryCodes.id, row.id), isNull(adminRecoveryCodes.usedAt)))
    .returning({ id: adminRecoveryCodes.id });
  return updated.length > 0;
}

/** Enable 2FA for a user with a proven secret, minting recovery codes. */
export async function enableTotp(db: Db, userId: string, secret: string): Promise<string[]> {
  await db.update(adminUsers).set({ totpSecret: secret, totpEnabled: true }).where(eq(adminUsers.id, userId));
  return replaceRecoveryCodes(db, userId);
}
