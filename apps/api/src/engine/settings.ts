import { marketingSettings } from "@auction/db";
import { eq, inArray } from "drizzle-orm";
import type { AppContext } from "../context.js";

/**
 * Настройки маркетинга (план v15, MD §9): каждое число, которое раньше было
 * бы зашито в текст или код — процент скидки, срок действия, потолок баллов —
 * живёт здесь и правится из админки без деплоя. В коде остаются только
 * умолчания на случай пустой базы.
 *
 * Кэш минуту в памяти процесса: настройки читаются в каждом письме и кроне,
 * но меняются раз в месяц.
 */
export const SETTING_DEFAULTS = {
  /** Приветственная скидка на первую покупку, % (MD §1.5.1). */
  welcome_percent: 10,
  /** Срок действия приветственного кода, дней. */
  welcome_valid_days: 7,
  /** День напоминания о неиспользованном коде (IZ-P02). */
  welcome_reminder_day: 3,
  /** Скидка приглашённому по реферальной ссылке, % (MD §1.6.1). */
  referral_percent: 15,
  /** Баллы рефереру за подтверждённую регистрацию приглашённого, центы. */
  referral_signup_points_cents: 500,
  /** Баллы рефереру за первый оплаченный заказ приглашённого, центы. */
  referral_order_points_cents: 1000,
  /** Порог «спящего» клиента для win-back, дней (MD §1.6.2). */
  winback_days: 90,
  /** Win-back скидка обычному сегменту, %. */
  winback_percent: 15,
  /** Win-back скидка сегменту «high value» (топ-20% по тратам), %. */
  winback_percent_high: 20,
  /** Срок действия win-back кода, дней. */
  winback_valid_days: 14,
  /** Начисление баллов: центов балла за 1 € оплаты (100 = 1 балл/€1). */
  points_per_eur_cents: 100,
  /** Потолок оплаты баллами, базисные пункты от итога заказа. Решение
   *  владельца: баллами нельзя закрыть заказ целиком — стандартно 50%. */
  points_redeem_max_bp: 5000,
  /** Реактивационное письмо «14 дней без покупки» (IZ-P03), дней. */
  inactive_nudge_days: 14,
  /** Запрос отзыва: дней после выдачи/доставки (IZ-P07). */
  review_request_days: 3,
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;
export const SETTING_KEYS = Object.keys(SETTING_DEFAULTS) as SettingKey[];

const CACHE_MS = 60_000;
let cache: { at: number; values: Record<SettingKey, number> } | null = null;

export async function getSettings(ctx: AppContext): Promise<Record<SettingKey, number>> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.values;
  const rows = await ctx.db
    .select({ key: marketingSettings.key, value: marketingSettings.value })
    .from(marketingSettings)
    .where(inArray(marketingSettings.key, SETTING_KEYS));
  const values = { ...SETTING_DEFAULTS } as Record<SettingKey, number>;
  for (const r of rows) {
    const n = Number(r.value);
    // Мусор в базе не должен ронять письма: нечисло тихо падает в умолчание.
    if (Number.isFinite(n) && n >= 0) values[r.key as SettingKey] = n;
  }
  cache = { at: now, values };
  return values;
}

export async function getSetting(ctx: AppContext, key: SettingKey): Promise<number> {
  return (await getSettings(ctx))[key];
}

export async function setSetting(ctx: AppContext, key: SettingKey, value: number, actor?: string): Promise<void> {
  await ctx.db
    .insert(marketingSettings)
    .values({ key, value, updatedAt: ctx.now(), updatedBy: actor ?? null })
    .onConflictDoUpdate({
      target: marketingSettings.key,
      set: { value, updatedAt: ctx.now(), updatedBy: actor ?? null },
    });
  cache = null;
}

/** Для тестов: сбросить кэш, чтобы setSetting другой «сессии» был виден. */
export function invalidateSettingsCache(): void {
  cache = null;
}
