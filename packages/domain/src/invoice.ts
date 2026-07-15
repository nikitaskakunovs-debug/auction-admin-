import { applyBasisPoints, assertCents, type BasisPoints, type Cents } from "./money.js";

/**
 * Invoice math per the design doc:
 *
 *   hammer price
 * + buyer's premium (10%, config-driven per market)
 * + VAT on BOTH hammer and premium (per-market rate)
 * + shipping
 * ─────────────────
 * = total due
 *
 * Reverse charge (intra-EU B2B with a validated VAT number, seller country ≠
 * buyer country): VAT is 0 and the invoice must carry the Art. 196 note.
 */

export interface InvoiceInput {
  hammerCents: Cents;
  buyerPremiumBp: BasisPoints;
  vatRateBp: BasisPoints;
  shippingCents?: Cents;
  /** Zero-rates the VAT and flags the legal note. */
  reverseCharge?: boolean;
}

export interface InvoiceBreakdown {
  hammerCents: Cents;
  premiumCents: Cents;
  /** hammer + premium (the VAT base). */
  netCents: Cents;
  vatCents: Cents;
  vatRateBp: BasisPoints;
  shippingCents: Cents;
  totalCents: Cents;
  reverseCharge: boolean;
}

export function computeInvoice(input: InvoiceInput): InvoiceBreakdown {
  assertCents(input.hammerCents, "hammer");
  const shippingCents = input.shippingCents ?? 0;
  assertCents(shippingCents, "shipping");
  const reverseCharge = input.reverseCharge ?? false;

  const premiumCents = applyBasisPoints(input.hammerCents, input.buyerPremiumBp);
  const netCents = input.hammerCents + premiumCents;
  const vatCents = reverseCharge ? 0 : applyBasisPoints(netCents, input.vatRateBp);
  return {
    hammerCents: input.hammerCents,
    premiumCents,
    netCents,
    vatCents,
    vatRateBp: reverseCharge ? 0 : input.vatRateBp,
    shippingCents,
    totalCents: netCents + vatCents + shippingCents,
    reverseCharge,
  };
}
