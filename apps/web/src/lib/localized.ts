import type { Lang } from "@/lib/i18n";

/** Текст из CMS заведён на lv/ru/en. */
export type Localized = { lv: string; ru: string; en: string };

/**
 * Значение с запасным вариантом: запрошенный язык → LV (домашний) → EN.
 * Живёт отдельно от компонентов: это же нужно серверу в generateMetadata,
 * а из модуля с "use client" серверу вызывать нельзя.
 */
export function pickLocalized(l: Localized, lang: Lang): string {
  return (l as Record<string, string>)[lang] || l.lv || l.en;
}
