import { randomInt } from "node:crypto";
import { giftCards } from "@auction/db";
import { eq } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { moveCredit } from "./credits.js";
import { enqueueNotification } from "./notifications.js";
import { getSetting } from "./settings.js";

/**
 * Подарочные карты (MD §3). Продажа — на месте/по договорённости, выдача из
 * админки; погашение зачисляет номинал в кредит клиента (тот же механизм, что
 * аванс) — дальше кредит сам уменьшает следующую оплату. Карта одноразовая:
 * остаток живёт в кредите, а не на карте.
 */

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type GiftCardFail = "not_found" | "inactive" | "redeemed" | "expired";

export async function issueGiftCard(
  ctx: AppContext,
  args: { initialCents: number; note?: string; issuedBy?: string },
): Promise<typeof giftCards.$inferSelect> {
  const validDays = await getSetting(ctx, "gift_card_valid_days");
  const expiresAt = validDays > 0 ? new Date(ctx.now().getTime() + validDays * 86_400_000) : null;
  for (let attempt = 0; ; attempt += 1) {
    let tail = "";
    for (let i = 0; i < 8; i += 1) tail += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    const [row] = await ctx.db
      .insert(giftCards)
      .values({
        code: `DAVANA-${tail}`,
        initialCents: args.initialCents,
        balanceCents: args.initialCents,
        expiresAt,
        note: args.note ?? null,
        issuedBy: args.issuedBy ?? null,
      })
      .onConflictDoNothing()
      .returning();
    if (row) return row;
    if (attempt >= 4) throw new Error("gift card code collision");
  }
}

/** Погасить карту в кредит клиента. Идемпотентность даёт блокировка строки:
 *  второе погашение того же кода видит redeemedAt и получает отказ. */
export async function redeemGiftCard(
  ctx: AppContext,
  args: { code: string; customerId: string },
): Promise<{ ok: true; amountCents: number; creditBalanceCents: number } | { ok: false; reason: GiftCardFail }> {
  const code = args.code.trim().toUpperCase();
  return ctx.db.transaction(async (tx) => {
    const [card] = await tx.select().from(giftCards).where(eq(giftCards.code, code)).for("update");
    if (!card) return { ok: false as const, reason: "not_found" as const };
    if (!card.isActive) return { ok: false as const, reason: "inactive" as const };
    if (card.redeemedAt || card.balanceCents <= 0) return { ok: false as const, reason: "redeemed" as const };
    if (card.expiresAt && card.expiresAt.getTime() < ctx.now().getTime()) {
      return { ok: false as const, reason: "expired" as const };
    }
    const { balanceCents } = await moveCredit(
      tx,
      args.customerId,
      { kind: "grant", amountCents: card.initialCents, note: `Dāvanu karte ${card.code}` },
      ctx.now(),
    );
    await tx
      .update(giftCards)
      .set({ customerId: args.customerId, redeemedAt: ctx.now(), balanceCents: 0 })
      .where(eq(giftCards.id, card.id));
    await enqueueNotification(ctx, tx, {
      customerId: args.customerId,
      type: "gift_card_received",
      template: { alias: "", lotTitle: "", amountCents: card.initialCents },
      dedupeKey: `gift:${card.id}`,
    });
    return { ok: true as const, amountCents: card.initialCents, creditBalanceCents: balanceCents };
  });
}
