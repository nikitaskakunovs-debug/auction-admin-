import { loyaltyAccounts, loyaltyLedger } from "@auction/db";
import { asc, eq, gt } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { getFinSettings, setFinSetting } from "./finSettings.js";
import { postLedger } from "./ledger.js";
import { movePoints } from "./loyalty.js";

/**
 * Сгорание баллов (fin-architecture 7.2, решение владельца): срок жизни
 * начисления — points_expiry_months (12). FIFO: списания всегда гасят самые
 * старые начисления, сгорает только то, что осталось от начислений старше
 * порога. Действует ТОЛЬКО на начисления после старта режима (первый прогон
 * записывает points_expiry_start_ms) — старые баллы клиентов не трогаем.
 *
 * Сгоревшее — доход breakage: liability_loyalty_points ↓,
 * revenue_loyalty_breakage ↑ (раздел 7.2).
 */
export async function runPointsExpiry(ctx: AppContext): Promise<{ accounts: number; expiredCents: number }> {
  const s = await getFinSettings(ctx);
  if (s.points_expiry_months <= 0) return { accounts: 0, expiredCents: 0 };
  let startMs = s.points_expiry_start_ms;
  if (startMs <= 0) {
    startMs = ctx.now().getTime();
    await setFinSetting(ctx, "points_expiry_start_ms", startMs, "system");
    return { accounts: 0, expiredCents: 0 }; // первый прогон только ставит метку
  }
  const cutoff = new Date(ctx.now().getTime());
  cutoff.setUTCMonth(cutoff.getUTCMonth() - s.points_expiry_months);

  const accounts = await ctx.db
    .select({ id: loyaltyAccounts.id, customerId: loyaltyAccounts.customerId, balanceCents: loyaltyAccounts.balanceCents })
    .from(loyaltyAccounts)
    .where(gt(loyaltyAccounts.balanceCents, 0));

  let touched = 0;
  let totalExpired = 0;
  for (const acc of accounts) {
    const rows = await ctx.db
      .select({ amountCents: loyaltyLedger.amountCents, createdAt: loyaltyLedger.createdAt })
      .from(loyaltyLedger)
      .where(eq(loyaltyLedger.accountId, acc.id))
      .orderBy(asc(loyaltyLedger.createdAt));
    const consumed = rows.reduce((sum, r) => sum + (r.amountCents < 0 ? -r.amountCents : 0), 0);
    // FIFO-проход по начислениям: списания гасят самые старые. Сгорает
    // непогашенный остаток начислений из окна [start, cutoff).
    let cumBefore = 0;
    let expirable = 0;
    for (const r of rows) {
      if (r.amountCents <= 0) continue;
      const eaten = Math.min(r.amountCents, Math.max(0, consumed - cumBefore));
      const remaining = r.amountCents - eaten;
      cumBefore += r.amountCents;
      if (remaining > 0 && r.createdAt.getTime() >= startMs && r.createdAt < cutoff) expirable += remaining;
    }
    const expire = Math.min(expirable, acc.balanceCents);
    if (expire <= 0) continue;
    await ctx.db.transaction(async (tx) => {
      await movePoints(tx, acc.customerId, {
        reason: "expiry",
        amountCents: -expire,
        note: `punkti nodeguši (${s.points_expiry_months} mēn.)`,
      }, ctx.now());
      await postLedger(
        tx,
        [
          { account: "liability_loyalty_points", amountCents: -expire, refType: "loyalty_expiry", refId: acc.customerId, memo: "Punktu termiņš beidzies" },
          { account: "revenue_loyalty_breakage", amountCents: expire, refType: "loyalty_expiry", refId: acc.customerId, memo: "Breakage ieņēmumi" },
        ],
        ctx.now(),
      );
    });
    touched++;
    totalExpired += expire;
  }
  return { accounts: touched, expiredCents: totalExpired };
}
