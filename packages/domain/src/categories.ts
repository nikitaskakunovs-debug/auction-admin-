/**
 * Product categories — one flat, deliberately small list. Codes are stable
 * identifiers stored on items; storefront translations live in the web i18n
 * layer (`cat.<code>`), English labels here are the admin-side source.
 */

export interface CategoryDef {
  code: string;
  label: string;
}

export const CATEGORIES: readonly CategoryDef[] = [
  { code: "electronics", label: "Electronics" },
  { code: "appliances", label: "Home appliances" },
  { code: "furniture", label: "Furniture" },
  { code: "tools", label: "Tools & garage" },
  { code: "home_garden", label: "Home & garden" },
  { code: "jewellery_watches", label: "Jewellery & watches" },
  { code: "art_antiques", label: "Art & antiques" },
  { code: "sports_outdoors", label: "Sports & outdoors" },
  { code: "kids_toys", label: "Kids & toys" },
  { code: "fashion", label: "Fashion" },
  { code: "food_household", label: "Food & household" },
  { code: "other", label: "Other" },
] as const;

export const CATEGORY_CODES: readonly string[] = CATEGORIES.map((c) => c.code);

const byCode = new Map(CATEGORIES.map((c) => [c.code, c]));

export function categoryByCode(code: string): CategoryDef | null {
  return byCode.get(code) ?? null;
}

export function isKnownCategory(code: string): boolean {
  return byCode.has(code);
}
