/**
 * The 16-grade condition taxonomy (codes mirror packages/domain — the web app
 * keeps its public-API shapes self-contained). Labels and descriptions live in
 * the i18n dictionary as `cond.<code>` / `cond.<code>.d`. Grades listed in
 * SEE_NOTES always carry a conditionNotes text describing the specific issue.
 */

export const CONDITION_CODES = [
  "brand_new",
  "new_no_package",
  "open_package_new",
  "open_package_inspected",
  "new_with_issue",
  "new_cosmetic_imperfection",
  "lightly_used",
  "used",
  "used_with_issue",
  "previously_assembled",
  "display_model",
  "refurbished",
  "as_is_untested",
  "as_is_salvage",
  "as_is_expired",
  "as_is",
] as const;

const KNOWN = new Set<string>(CONDITION_CODES);

/** Translated label for taxonomy codes; legacy free-text grades pass through. */
export function conditionLabel(code: string, t: (key: string) => string): string {
  return KNOWN.has(code) ? t(`cond.${code}`) : code;
}

/** Короткий бейдж A+/A/A−/B/D для 16 кодов состояния — им подписаны чипы
 *  в фильтрах каталога и в справочнике состояний. */
export function conditionBadge(code: string): string {
  if (code === "brand_new" || code === "new_no_package") return "A+";
  if (code.startsWith("open_package") || code.startsWith("new_")) return "A";
  if (code === "lightly_used" || code === "refurbished" || code === "display_model") return "A−";
  if (code.startsWith("used") || code === "previously_assembled") return "B";
  return "D";
}
