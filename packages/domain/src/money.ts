/**
 * All monetary amounts in the platform are integer euro cents.
 * Floating point never touches money.
 */

export type Cents = number;

/** Basis points: 10000 bp = 100%. VAT 21% = 2100 bp, buyer premium 10% = 1000 bp. */
export type BasisPoints = number;

export function assertCents(value: number, label = "amount"): void {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be an integer number of cents, got ${value}`);
  }
  if (value < 0) {
    throw new RangeError(`${label} must not be negative, got ${value}`);
  }
}

/** value * bp / 10000, rounded half-up to the nearest cent. */
export function applyBasisPoints(value: Cents, bp: BasisPoints): Cents {
  assertCents(value);
  if (!Number.isSafeInteger(bp) || bp < 0) {
    throw new RangeError(`basis points must be a non-negative integer, got ${bp}`);
  }
  // Integer arithmetic: floor(x + 0.5) == half-up for non-negative x.
  return Math.floor((value * bp + 5000) / 10000);
}

export function formatEur(cents: Cents): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = (abs % 100).toString().padStart(2, "0");
  return `${sign}€${whole.toLocaleString("en-US")}.${frac}`;
}
