import { randomInt } from "node:crypto";
import { promoCodes, promoRedemptions, segmentMembers, type Db } from "@auction/db";
import { and, eq, sql } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { getSettings } from "./settings.js";

/**
 * Промокоды (план v15, MD §1.5): ручные из админки и автоматические личные —
 * приветственный (welcome_auto), реферальный (referral_referred) и win-back.
 *
 * Скидка применяется при оформлении корзины «Pērc tagad»: итог заказа уже
 * СО скидкой, счёт раскладывает уменьшенную финальную цену той же
 * арифметикой движка. На аукционные ставки коды не действуют — торги есть
 * торги. Использование считается на оформление (одна корзина = одно
 * использование), сколько бы заказов из неё ни родилось.
 */

export type PromoFail =
  | "not_found"
  | "inactive"
  | "not_started"
  | "expired"
  | "not_yours"
  | "segment"
  | "usage_limit"
  | "user_limit"
  | "category"
  | "min_order"
  | "type_unsupported";

export interface CartLine {
  listingId: string;
  category: string | null;
  priceCents: number;
}

export interface PromoOk {
  ok: true;
  promo: typeof promoCodes.$inferSelect;
  discountCents: number;
  /** Скидка по строкам корзины (только затронутые строки). */
  perLine: Map<string, number>;
}

type Tx = Pick<Db, "select" | "insert" | "update">;

/** Код без похожих символов (0/O, 1/I): человек диктует его по телефону. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function randomCode(prefix: string): string {
  let tail = "";
  for (let i = 0; i < 6; i += 1) tail += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${prefix}-${tail}`;
}

/** Выпустить личный код. Повтор кода в базе — перегенерация, до 5 попыток. */
export async function issuePersonalCode(
  tx: Tx,
  args: {
    customerId: string;
    source: "welcome_auto" | "referral_referred" | "winback";
    prefix: string;
    percent: number;
    validFrom: Date;
    validTo: Date;
    category?: string | null;
  },
): Promise<typeof promoCodes.$inferSelect> {
  for (let attempt = 0; ; attempt += 1) {
    const [row] = await tx
      .insert(promoCodes)
      .values({
        code: randomCode(args.prefix),
        type: "percent",
        value: args.percent,
        source: args.source,
        customerId: args.customerId,
        usageLimitTotal: 1,
        usageLimitPerUser: 1,
        validFrom: args.validFrom,
        validTo: args.validTo,
        category: args.category ?? null,
      })
      .onConflictDoNothing()
      .returning();
    if (row) return row;
    if (attempt >= 4) throw new Error("promo code collision");
  }
}

/** Приветственный код клиента (welcome_auto или реферальный вариант). */
export async function findPersonalCode(
  tx: Tx,
  customerId: string,
  sources: string[],
): Promise<typeof promoCodes.$inferSelect | null> {
  const rows = await tx
    .select()
    .from(promoCodes)
    .where(eq(promoCodes.customerId, customerId));
  return rows.find((r) => sources.includes(r.source)) ?? null;
}

/**
 * Приветственный код −N% на первую покупку (IZ-P01, MD §1.5.1).
 * Выпускается при регистрации и кладётся в само письмо подтверждения почты —
 * сервисная часть письма, отдельной отправки нет (решение владельца).
 * Приглашённому по реферальной ссылке — повышенный процент вместо обычного,
 * не двумя кодами. Срок продлевается в момент подтверждения почты: отсчёт
 * идёт от подтверждения, как требует спецификация.
 */
export async function ensureWelcomeCode(
  ctx: AppContext,
  tx: Tx,
  customerId: string,
  opts: { referred?: boolean } = {},
): Promise<typeof promoCodes.$inferSelect> {
  const existing = await findPersonalCode(tx, customerId, ["welcome_auto", "referral_referred"]);
  if (existing) return existing;
  const s = await getSettings(ctx);
  const days = s.welcome_valid_days;
  const now = ctx.now();
  return issuePersonalCode(tx, {
    customerId,
    source: opts.referred ? "referral_referred" : "welcome_auto",
    prefix: opts.referred ? "DRAUGS" : "SVEIKI",
    percent: opts.referred ? s.referral_percent : s.welcome_percent,
    validFrom: now,
    validTo: new Date(now.getTime() + days * 86_400_000),
  });
}

/** Подтверждение почты: часы кода начинают тикать отсюда, не с регистрации. */
export async function extendWelcomeOnVerify(ctx: AppContext, tx: Tx, customerId: string): Promise<void> {
  const code = await findPersonalCode(tx, customerId, ["welcome_auto", "referral_referred"]);
  if (!code || code.usedCount > 0) return;
  const s = await getSettings(ctx);
  await tx
    .update(promoCodes)
    .set({ validTo: new Date(ctx.now().getTime() + s.welcome_valid_days * 86_400_000) })
    .where(eq(promoCodes.id, code.id));
}

/** Проверка кода против корзины. Ничего не списывает — только считает. */
export async function validatePromo(
  ctx: AppContext,
  args: { code: string; customerId: string; lines: CartLine[] },
): Promise<PromoOk | { ok: false; reason: PromoFail }> {
  const code = args.code.trim().toUpperCase();
  if (!code) return { ok: false, reason: "not_found" };
  const [promo] = await ctx.db.select().from(promoCodes).where(eq(promoCodes.code, code));
  if (!promo) return { ok: false, reason: "not_found" };
  if (!promo.isActive) return { ok: false, reason: "inactive" };
  const now = ctx.now().getTime();
  if (promo.validFrom && promo.validFrom.getTime() > now) return { ok: false, reason: "not_started" };
  if (promo.validTo && promo.validTo.getTime() < now) return { ok: false, reason: "expired" };
  if (promo.customerId && promo.customerId !== args.customerId) return { ok: false, reason: "not_yours" };
  if (promo.type === "free_shipping") return { ok: false, reason: "type_unsupported" };
  if (promo.segmentId) {
    const [member] = await ctx.db
      .select({ customerId: segmentMembers.customerId })
      .from(segmentMembers)
      .where(and(eq(segmentMembers.segmentId, promo.segmentId), eq(segmentMembers.customerId, args.customerId)));
    if (!member) return { ok: false, reason: "segment" };
  }
  if (promo.usageLimitTotal !== null && promo.usedCount >= promo.usageLimitTotal) {
    return { ok: false, reason: "usage_limit" };
  }
  if (promo.usageLimitPerUser !== null) {
    const [mine] = await ctx.db
      .select({ n: sql<string>`count(*)` })
      .from(promoRedemptions)
      .where(and(eq(promoRedemptions.promoId, promo.id), eq(promoRedemptions.customerId, args.customerId)));
    if (Number(mine?.n ?? 0) >= promo.usageLimitPerUser) return { ok: false, reason: "user_limit" };
  }

  const eligible = promo.category ? args.lines.filter((l) => l.category === promo.category) : args.lines;
  if (eligible.length === 0) return { ok: false, reason: "category" };
  const subtotal = eligible.reduce((s, l) => s + l.priceCents, 0);
  if (promo.minOrderCents !== null && subtotal < promo.minOrderCents) return { ok: false, reason: "min_order" };

  const raw = promo.type === "percent"
    ? Math.round((subtotal * promo.value) / 100)
    : Math.min(promo.value, subtotal);
  const discountCents = Math.min(raw, subtotal);
  // Распределение по строкам пропорционально цене, остаток — первой строке:
  // сумма долей обязана сойтись со скидкой цент в цент.
  const perLine = new Map<string, number>();
  let assigned = 0;
  for (const [idx, l] of eligible.entries()) {
    const share = idx === eligible.length - 1
      ? discountCents - assigned
      : Math.floor((discountCents * l.priceCents) / subtotal);
    perLine.set(l.listingId, Math.min(share, l.priceCents));
    assigned += share;
  }
  return { ok: true, promo, discountCents, perLine };
}

/** Зафиксировать использование: одна корзина = одно использование. */
export async function recordRedemption(
  tx: Tx,
  args: { promoId: string; customerId: string; orderRef: string; discountCents: number },
): Promise<void> {
  await tx.insert(promoRedemptions).values(args);
  await tx
    .update(promoCodes)
    .set({ usedCount: sql`${promoCodes.usedCount} + 1` })
    .where(eq(promoCodes.id, args.promoId));
}
