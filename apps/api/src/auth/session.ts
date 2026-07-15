import { refreshTokens, type Db } from "@auction/db";
import { and, eq, isNull } from "drizzle-orm";

/**
 * Revoke every live refresh token for an admin. Called on password change,
 * deactivation, role change, and refresh-token theft detection — anything that
 * should end the user's other sessions. Access tokens already outstanding
 * expire on their own short TTL.
 */
export async function revokeAllUserRefreshTokens(db: Pick<Db, "update">, userId: string, now: Date): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: now })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
}
