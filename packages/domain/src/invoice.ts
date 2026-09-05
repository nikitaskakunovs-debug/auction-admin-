import { assertCents, type BasisPoints, type Cents } from "./money.js";

/**
 * Расчёт счёта: цена, которую видит клиент, — ФИНАЛЬНАЯ.
 *
 * Ставка на торгах и цена «Pirkt tagad» уже включают комиссию покупателя и
 * НДС; чекаут сумму не увеличивает, а раскладывает:
 *
 *   финальная цена (gross)
 *   = товар (hammer) + комиссия (premium) + НДС на обе части
 *
 * Разложение вниз от gross, копейка в копейку: net = gross/(1+НДС),
 * hammer = net/(1+комиссия), остальное — разности, чтобы сумма частей всегда
 * равнялась тому, что человек видел на экране.
 *
 * Reverse charge (ЕС B2B с проверенным VIES-номером, страна продавца ≠
 * страна покупателя): НДС 0, к оплате идёт net — юрлицо платит меньше
 * витринной цены ровно на НДС-часть; в счёте пометка ст. 196.
 */

export interface InvoiceInput {
  /** Финальная цена, которую видел клиент (ставка или цена покупки). */
  grossCents: Cents;
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

/** Целочисленное деление на (1 + bp/10000) с полукруглым округлением. */
function stripBasisPoints(grossCents: Cents, bp: BasisPoints): Cents {
  return Math.round((grossCents * 10_000) / (10_000 + bp));
}

export function computeInvoice(input: InvoiceInput): InvoiceBreakdown {
  assertCents(input.grossCents, "gross");
  const shippingCents = input.shippingCents ?? 0;
  assertCents(shippingCents, "shipping");
  const reverseCharge = input.reverseCharge ?? false;

  const netCents = stripBasisPoints(input.grossCents, input.vatRateBp);
  const vatCents = input.grossCents - netCents;
  const hammerCents = stripBasisPoints(netCents, input.buyerPremiumBp);
  const premiumCents = netCents - hammerCents;
  return {
    hammerCents,
    premiumCents,
    netCents,
    vatCents: reverseCharge ? 0 : vatCents,
    vatRateBp: reverseCharge ? 0 : input.vatRateBp,
    shippingCents,
    // Reverse charge: юрлицо платит без НДС-части — net + доставка.
    totalCents: (reverseCharge ? netCents : input.grossCents) + shippingCents,
    reverseCharge,
  };
}
