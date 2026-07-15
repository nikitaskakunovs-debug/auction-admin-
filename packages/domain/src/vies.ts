/**
 * EU VAT (VIES) helpers — ported from the Shhh admin's admin-vies.jsx.
 *
 * Format validation runs anywhere; the actual VIES round-trip is a
 * SERVER-SIDE call to the EU checkVat service and lives in the API layer.
 * A validated, non-stale VIES check is the precondition for zero-rating an
 * invoice under the reverse-charge rule (Art. 196, Dir. 2006/112/EC).
 */

/** Per-member-state VAT number formats (after the 2-letter country prefix). */
export const VIES_FORMATS: Readonly<Record<string, RegExp>> = {
  AT: /^U\d{8}$/, BE: /^0\d{9}$/, BG: /^\d{9,10}$/, CY: /^\d{8}[A-Z]$/,
  CZ: /^\d{8,10}$/, DE: /^\d{9}$/, DK: /^\d{8}$/, EE: /^\d{9}$/,
  EL: /^\d{9}$/, ES: /^[A-Z0-9]\d{7}[A-Z0-9]$/, FI: /^\d{8}$/,
  FR: /^[A-Z0-9]{2}\d{9}$/, HR: /^\d{11}$/, HU: /^\d{8}$/, IE: /^[A-Z0-9]{8,9}$/,
  IT: /^\d{11}$/, LT: /^(\d{9}|\d{12})$/, LU: /^\d{8}$/, LV: /^\d{11}$/,
  MT: /^\d{8}$/, NL: /^\d{9}B\d{2}$/, PL: /^\d{10}$/, PT: /^\d{9}$/,
  RO: /^\d{2,10}$/, SE: /^\d{12}$/, SI: /^\d{8}$/, SK: /^\d{10}$/,
};

/** A completed VIES consultation older than this needs re-validation. */
export const VIES_STALE_DAYS = 90;

export interface ParsedVat {
  /** Two-letter member-state prefix, or null when unparseable. */
  cc: string | null;
  rest: string;
  clean: string;
}

export function viesParse(vatNo: string | null | undefined): ParsedVat | null {
  if (!vatNo) return null;
  const clean = String(vatNo).toUpperCase().replace(/[\s.-]/g, "");
  const m = clean.match(/^([A-Z]{2})(.+)$/);
  if (!m) return { cc: null, rest: clean, clean };
  return { cc: m[1]!, rest: m[2]!, clean };
}

export function viesFormatValid(vatNo: string | null | undefined): boolean {
  const p = viesParse(vatNo);
  if (!p || !p.cc) return false;
  const re = VIES_FORMATS[p.cc];
  return re ? re.test(p.rest) : p.rest.length >= 4; // unknown CC → lenient
}

export interface ViesCheck {
  valid: boolean;
  /** ISO timestamp of the consultation. */
  checkedAt: string;
  /** VIES consultation number — the audit proof for zero-rating. */
  consult: string;
}

export type ViesState = "valid" | "stale" | "unchecked" | "invalid" | "badformat";

export interface ViesAssessment {
  state: ViesState;
  daysSinceCheck: number | null;
}

export function viesAssess(
  vatNo: string | null | undefined,
  check: ViesCheck | null,
  nowMs: number,
): ViesAssessment | null {
  if (!vatNo) return null;
  const fmtOk = viesFormatValid(vatNo);
  if (!fmtOk && !check) return { state: "badformat", daysSinceCheck: null };
  if (!check) return { state: "unchecked", daysSinceCheck: null };
  if (!check.valid) return { state: "invalid", daysSinceCheck: null };
  const days = (nowMs - Date.parse(check.checkedAt)) / 86_400_000;
  if (days > VIES_STALE_DAYS) return { state: "stale", daysSinceCheck: days };
  return { state: "valid", daysSinceCheck: days };
}

/**
 * Reverse charge applies to an intra-EU B2B sale: buyer in a different EU
 * member state than the seller, with a currently-valid VIES consultation.
 */
export function qualifiesForReverseCharge(args: {
  sellerCountry: string;
  buyerVatNo: string | null | undefined;
  buyerVies: ViesCheck | null;
  nowMs: number;
}): boolean {
  const p = viesParse(args.buyerVatNo);
  if (!p || !p.cc) return false;
  if (!(p.cc in VIES_FORMATS)) return false;
  if (p.cc === args.sellerCountry.toUpperCase()) return false;
  const a = viesAssess(args.buyerVatNo, args.buyerVies, args.nowMs);
  return a !== null && a.state === "valid";
}
