import { marketingSettings } from "@auction/db";
import { inArray } from "drizzle-orm";
import type { AppContext } from "../context.js";

/**
 * Настройки финансового слоя (fin-architecture). Решение владельца: КАЖДЫЙ
 * порог и значение правится из админки, в коде — только умолчания. Хранение —
 * та же таблица marketing_settings (key/value), свой список ключей.
 */
export const FIN_SETTING_DEFAULTS = {
  /** Допуск расхождения банк/выписка, центы (раздел 2: банк ±0,10 €). */
  tolerance_bank_cents: 10,
  /** Допуск для карточных провайдеров (Klix), центы. */
  tolerance_card_cents: 1,
  /** Допуск для кассы — наличные сходятся до цента. */
  tolerance_cash_cents: 0,
  /** SLA ручного возврата: дней от запроса до «выплачено» (раздел 5.2). */
  refund_sla_days: 3,
  /** Clearing-окно Klix: дней «в пути» до флага clearing_overdue (раздел 4). */
  clearing_klix_days: 2,
  /** Clearing-окно Inbank, дней. */
  clearing_inbank_days: 4,
  /** Сгорание баллов: месяцев с начисления (решение владельца — 12). */
  points_expiry_months: 12,
  /** Служебная метка старта режима сгорания (epoch ms): начисления ДО неё
   *  не сгорают никогда — решение владельца «только новые начисления».
   *  0 = ещё не запускался; первый прогон крона записывает текущий момент. */
  points_expiry_start_ms: 0,
  /** За сколько дней предупредить клиента о сгорании баллов. */
  points_expiry_warn_days: 30,
  /** Поставщику: рабочих дней на ответ по расхождению приёмки; после срока
   *  акт считается принятым (решение владельца — 5). */
  supplier_discrepancy_days: 5,
  /** Поставщику: через сколько дней после приёмки непроданное попадает
   *  в письмо «что делать с остатком». */
  supplier_unsold_days: 60,
  /** День месяца, когда уходит сводка поставщику (0 — не слать). */
  supplier_report_day: 1,
  /** Порог дистанционных продаж EE+LT в год, центы (€10 000, раздел 8.2). */
  eu_threshold_cents: 1_000_000,
  /** Уровень предупреждения о пороге, б.п. (8000 = флаг при 80%). */
  eu_alert_bp: 8000,
  /** Сколько дней заявка в рассрочку держит заказ от автоотмены. Банк решает
   *  часами, но брошенная заявка не должна морозить лот навсегда. */
  bnpl_pending_max_days: 7,
  /** Хранение: сколько дней после оплаты вещь лежит бесплатно. */
  storage_free_days: 7,
  /** Хранение: плата за сутки сверх бесплатных дней, центы. */
  storage_per_day_cents: 100,
  /** Хранение: потолок в деньгах, центы. Действует вместе с долевым. */
  storage_cap_cents: 3_000,
  /** Хранение: потолок долей от суммы заказа, б.п. (5000 = половина).
   *  За забытую вещь за 20 € не должно набежать 40 € долга. */
  storage_cap_bp: 5_000,
} as const;

export type FinSettingKey = keyof typeof FIN_SETTING_DEFAULTS;
export const FIN_SETTING_KEYS = Object.keys(FIN_SETTING_DEFAULTS) as FinSettingKey[];

const CACHE_MS = 60_000;
let cache: { at: number; values: Record<FinSettingKey, number> } | null = null;

export async function getFinSettings(ctx: AppContext): Promise<Record<FinSettingKey, number>> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.values;
  const rows = await ctx.db
    .select({ key: marketingSettings.key, value: marketingSettings.value })
    .from(marketingSettings)
    .where(inArray(marketingSettings.key, FIN_SETTING_KEYS));
  const values = { ...FIN_SETTING_DEFAULTS } as Record<FinSettingKey, number>;
  for (const r of rows) {
    const n = Number(r.value);
    if (Number.isFinite(n) && n >= 0) values[r.key as FinSettingKey] = n;
  }
  cache = { at: now, values };
  return values;
}

export async function getFinSetting(ctx: AppContext, key: FinSettingKey): Promise<number> {
  return (await getFinSettings(ctx))[key];
}

export async function setFinSetting(ctx: AppContext, key: FinSettingKey, value: number, actor?: string): Promise<void> {
  await ctx.db
    .insert(marketingSettings)
    .values({ key, value, updatedAt: ctx.now(), updatedBy: actor ?? null })
    .onConflictDoUpdate({
      target: marketingSettings.key,
      set: { value, updatedAt: ctx.now(), updatedBy: actor ?? null },
    });
  cache = null;
}

/** Для тестов: сбросить кэш между «сессиями». */
export function invalidateFinSettingsCache(): void {
  cache = null;
}
