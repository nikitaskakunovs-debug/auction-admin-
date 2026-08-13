/** Комиссия покупателя и НДС — те же значения и та же арифметика, что в движке
 *  (packages/domain/src/config.ts и invoice.ts). Держим копию здесь, чтобы
 *  страница лота могла показать разбивку для ЛЮБОЙ суммы ставки, а не только
 *  для текущей цены, которую отдаёт API в estimatedTotalCents. */

export interface MarketFees {
  buyerPremiumBp: number;
  vatRateBp: number;
}

const MARKETS: Record<string, MarketFees> = {
  LV: { buyerPremiumBp: 1000, vatRateBp: 2100 },
  EE: { buyerPremiumBp: 1000, vatRateBp: 2400 },
  LT: { buyerPremiumBp: 1000, vatRateBp: 2100 },
};

export function marketFees(code: string): MarketFees {
  return MARKETS[code] ?? MARKETS.LV!;
}

/** Полукруглое округление, как applyBasisPoints в движке. */
export function applyBasisPoints(value: number, bp: number): number {
  return Math.floor((value * bp + 5000) / 10000);
}

export interface Invoice {
  hammerCents: number;
  premiumCents: number;
  vatCents: number;
  totalCents: number;
}

/** НДС считается на сумму молотка и комиссии — как в computeInvoice. */
export function computeInvoice(hammerCents: number, market: string): Invoice {
  const { buyerPremiumBp, vatRateBp } = marketFees(market);
  const premiumCents = applyBasisPoints(hammerCents, buyerPremiumBp);
  const vatCents = applyBasisPoints(hammerCents + premiumCents, vatRateBp);
  return { hammerCents, premiumCents, vatCents, totalCents: hammerCents + premiumCents + vatCents };
}

/** Шаг ставки движка (центы). */
export function increment(cents: number): number {
  if (cents >= 500_000) return 10_000;
  if (cents >= 100_000) return 5_000;
  if (cents >= 50_000) return 2_500;
  if (cents >= 20_000) return 1_000;
  if (cents >= 5_000) return 500;
  return 100;
}
