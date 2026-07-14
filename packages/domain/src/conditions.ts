/**
 * Condition taxonomy — ported verbatim from the warehouse's laminated
 * CONDITION REFERENCE sheet. Codes are stable identifiers stored on items;
 * labels/descriptions here are the English source (storefront translations
 * live in the web i18n layer). Conditions marked `requiresNotes` are the
 * sheet's "(SEE NOTES)" grades: staff MUST describe the specific issue.
 */

export interface ConditionDef {
  code: string;
  label: string;
  description: string;
  requiresNotes: boolean;
}

export const CONDITIONS: readonly ConditionDef[] = [
  {
    code: "brand_new",
    label: "Brand new",
    description:
      "Untouched — may be shrink-sealed, sticker-sealed or have cardboard tabs and retail tags. As you would expect it in a retail store.",
    requiresNotes: false,
  },
  {
    code: "new_no_package",
    label: "New item (no package / repackaged)",
    description: "No retail packaging, but all contents are in excellent condition with no signs of use or damage.",
    requiresNotes: false,
  },
  {
    code: "open_package_new",
    label: "Open package — contents brand new",
    description: "Packaging may be distressed (crushed, ripped or torn) but the contents are brand new internally.",
    requiresNotes: false,
  },
  {
    code: "open_package_inspected",
    label: "Open package — appears new, contents handled/inspected",
    description:
      "Packaging has been opened (likely distressed) and the contents have been handled, but are in a new-like condition (not brand new or untouched).",
    requiresNotes: false,
  },
  {
    code: "new_with_issue",
    label: "New item — with issue",
    description:
      "Can be brand new but has an issue such as a missing accessory or shipping crack. Not used for blemishes (scratches, scuffs, marks).",
    requiresNotes: true,
  },
  {
    code: "lightly_used",
    label: "Lightly used or worn",
    description:
      "Light signs of previous use — hair, dust, dirt or water marks that could be cleaned with minor effort. May also show light cosmetic usage.",
    requiresNotes: true,
  },
  {
    code: "used",
    label: "Used",
    description: "Heavier signs of use, harder to clean, more intense blemishes, stains, dents.",
    requiresNotes: true,
  },
  {
    code: "previously_assembled",
    label: "Previously assembled / installed",
    description: "Mostly furniture that has been previously built (may show screw marks, minor scuffs, etc.).",
    requiresNotes: false,
  },
  {
    code: "display_model",
    label: "Display / demo model",
    description:
      "Typically electronics, shoes or furniture used as store displays (may have fixtures attached or commercial restrictions).",
    requiresNotes: false,
  },
  {
    code: "refurbished",
    label: "Refurbished / recertified",
    description:
      "Repackaged by the manufacturer to a fully functional, like-new state; usually marked on the packaging. May still have cosmetic blemishes.",
    requiresNotes: false,
  },
  {
    code: "as_is_untested",
    label: "As-is (returned / untested)",
    description:
      "May have serious issues but is of high value, used when there is no means of testing (e.g. a high-end espresso machine that might be new and complete but does not function).",
    requiresNotes: false,
  },
  {
    code: "as_is_salvage",
    label: "As-is (salvage)",
    description:
      "Sold as parts, or for customers who want to attempt repair themselves (e.g. a 3D printer that does not function or has missing parts but sought-after components).",
    requiresNotes: false,
  },
  {
    code: "as_is_expired",
    label: "As-is (expired)",
    description: "Typically foods and chemicals — the item may still retain value or use after the expiration date.",
    requiresNotes: false,
  },
  {
    code: "used_with_issue",
    label: "Previously handled/used — with issue",
    description: "In a used condition AND with an issue on top (missing components, damage, etc.).",
    requiresNotes: true,
  },
  {
    code: "new_cosmetic_imperfection",
    label: "New — cosmetic imperfection",
    description: "A new item with a scratch, scuff, chip or other blemish.",
    requiresNotes: true,
  },
  {
    code: "as_is",
    label: "As-is",
    description:
      "Only when no other as-is condition applies — reserved for specific product scenarios (e.g. antiques, memorabilia).",
    requiresNotes: false,
  },
] as const;

export const CONDITION_CODES: readonly string[] = CONDITIONS.map((c) => c.code);

const byCode = new Map(CONDITIONS.map((c) => [c.code, c]));

export function conditionByCode(code: string): ConditionDef | null {
  return byCode.get(code) ?? null;
}

/** "(SEE NOTES)" grades demand a written note describing the issue. */
export function conditionRequiresNotes(code: string): boolean {
  return byCode.get(code)?.requiresNotes ?? false;
}

/** Unknown codes (legacy items graded before this taxonomy) stay displayable. */
export function isKnownCondition(code: string): boolean {
  return byCode.has(code);
}
