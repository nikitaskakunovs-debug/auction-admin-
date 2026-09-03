import { loyaltyAccounts, loyaltyLedger, type Db } from "@auction/db";
import { eq, gt, sql, and } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { getSettings } from "./settings.js";

/**
 * Баллы лояльности (MD §5a). Те же инварианты, что у аванса (credits.ts):
 *  - баланс меняется только вместе со строкой журнала;
 *  - минус больше остатка отвергается, а не обрезается молча;
 *  - курс прост, чтобы объясняться одной фразой: 1 балл = 1 € = 100 центов.
 *
 * Решение владельца: баллами нельзя закрыть заказ целиком — потолок задаёт
 * настройка points_redeem_max_bp (стандартно 50% итога), правится из админки.
 */
type Tx = Pick<Db, "select" | "insert" | "update">;

export type LoyaltyReason = "purchase" | "referral_signup" | "referral_order" | "manual" | "redemption" | "expiry";

export class InsufficientPointsError extends Error {
  constructor(public readonly balanceCents: number) {
    super("insufficient points");
  }
}

export async function getOrCreateLoyalty(
  tx: Tx,
  customerId: string,
): Promise<{ id: string; balanceCents: number }> {
  const [existing] = await tx.select().from(loyaltyAccounts).where(eq(loyaltyAccounts.customerId, customerId));
  if (existing) return { id: existing.id, balanceCents: existing.balanceCents };
  const [row] = await tx
    .insert(loyaltyAccounts)
    .values({ customerId })
    .onConflictDoNothing()
    .returning({ id: loyaltyAccounts.id });
  if (row) return { id: row.id, balanceCents: 0 };
  const [raced] = await tx.select().from(loyaltyAccounts).where(eq(loyaltyAccounts.customerId, customerId));
  return { id: raced!.id, balanceCents: raced!.balanceCents };
}

/** Провести движение баллов. Отрицательная сумма — списание. */
export async function movePoints(
  tx: Tx,
  customerId: string,
  move: { reason: LoyaltyReason; amountCents: number; orderRef?: string | null; referralId?: string | null; note?: string },
  now: Date,
): Promise<{ balanceCents: number }> {
  const account = await getOrCreateLoyalty(tx, customerId);
  const next = account.balanceCents + move.amountCents;
  if (next < 0) throw new InsufficientPointsError(account.balanceCents);
  await tx.update(loyaltyAccounts).set({ balanceCents: next, updatedAt: now }).where(eq(loyaltyAccounts.id, account.id));
  await tx.insert(loyaltyLedger).values({
    accountId: account.id,
    reason: move.reason,
    amountCents: move.amountCents,
    orderRef: move.orderRef ?? null,
    referralId: move.referralId ?? null,
    note: move.note ?? "",
  });
  return { balanceCents: next };
}

/* ── §6.5: уровни (bronze / silver / gold) ──────────────────────────────── */

export type LoyaltyTier = "bronze" | "silver" | "gold";

export interface TierInfo {
  tier: LoyaltyTier;
  /** Заработано баллов за всё время (только плюсовые движения), центы. */
  lifetimeEarnedCents: number;
  /** Сколько не хватает до следующего уровня; null на золоте. */
  toNextCents: number | null;
  /** Множитель начисления уровня, базисные пункты (10000 = ×1). */
  earnBp: number;
}

/** Уровень считается от ЗАРАБОТАННОГО за всё время — потраченное уровень не
 *  снижает: статус — признание истории, а не текущего остатка. */
export async function tierFor(ctx: AppContext, tx: Tx, customerId: string): Promise<TierInfo> {
  const s = await getSettings(ctx);
  const account = await getOrCreateLoyalty(tx, customerId);
  const [row] = await tx
    .select({ earned: sql<string>`coalesce(sum(${loyaltyLedger.amountCents}), 0)` })
    .from(loyaltyLedger)
    .where(and(eq(loyaltyLedger.accountId, account.id), gt(loyaltyLedger.amountCents, 0)));
  const lifetimeEarnedCents = Number(row?.earned ?? 0);
  if (lifetimeEarnedCents >= s.tier_gold_cents) {
    return { tier: "gold", lifetimeEarnedCents, toNextCents: null, earnBp: s.tier_gold_earn_bp };
  }
  if (lifetimeEarnedCents >= s.tier_silver_cents) {
    return {
      tier: "silver", lifetimeEarnedCents,
      toNextCents: s.tier_gold_cents - lifetimeEarnedCents,
      earnBp: s.tier_silver_earn_bp,
    };
  }
  return {
    tier: "bronze", lifetimeEarnedCents,
    toNextCents: s.tier_silver_cents - lifetimeEarnedCents,
    earnBp: 10_000,
  };
}

/** Начисление за оплаченный заказ: целые баллы (€) от ОПЛАЧЕННОЙ суммы —
 *  после скидок, аванса и уже списанных баллов (за потраченные баллы новых
 *  баллов не даём). Возвращает начисление и новый баланс для письма. */
export async function earnPointsForOrder(
  ctx: AppContext,
  tx: Tx,
  args: { customerId: string; orderRef: string; paidCents: number },
): Promise<{ earnedCents: number; balanceCents: number } | null> {
  if (args.paidCents <= 0) return null;
  const s = await getSettings(ctx);
  if (s.points_per_eur_cents <= 0) return null;
  // 1 балл за каждый ПОЛНЫЙ евро оплаты; балл = 100 центов скидки.
  // §6.5: уровень даёт множитель (серебро ×1,25, золото ×1,5 по умолчанию).
  const { earnBp } = await tierFor(ctx, tx, args.customerId);
  const base = Math.floor(args.paidCents / 100) * s.points_per_eur_cents;
  const earnedCents = Math.floor((base * earnBp) / 10_000);
  if (earnedCents <= 0) return null;
  const { balanceCents } = await movePoints(
    tx,
    args.customerId,
    { reason: "purchase", amountCents: earnedCents, orderRef: args.orderRef },
    ctx.now(),
  );
  return { earnedCents, balanceCents };
}

/** Сколько баллов МОЖНО списать в заказ с данным итогом и остатком к оплате. */
export async function redeemablePointsCents(
  ctx: AppContext,
  tx: Tx,
  args: { customerId: string; orderTotalCents: number; alreadyAppliedCents: number; remainingCents: number },
): Promise<number> {
  const s = await getSettings(ctx);
  const account = await getOrCreateLoyalty(tx, args.customerId);
  const capTotal = Math.floor((args.orderTotalCents * s.points_redeem_max_bp) / 10_000);
  const capLeft = Math.max(0, capTotal - args.alreadyAppliedCents);
  // Целыми евро: дробный балл не существует (MD §5a).
  const raw = Math.min(account.balanceCents, capLeft, args.remainingCents);
  return Math.floor(raw / 100) * 100;
}
