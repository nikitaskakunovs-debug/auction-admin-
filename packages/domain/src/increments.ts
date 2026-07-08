import { assertCents, type Cents } from "./money.js";

/**
 * Bid increment table. A bid at current price P must rise by at least the
 * increment of the tier P falls into. Tiers are config-driven per market;
 * this default matches the approved design doc:
 *
 *   €0–49.99 → €1 · €50–199.99 → €5 · €200–499.99 → €10
 *   €500–999.99 → €25 · €1000–4999.99 → €50 · €5000+ → €100
 */
export interface IncrementTier {
  /** Inclusive lower bound of the tier, in cents. */
  fromCents: Cents;
  incrementCents: Cents;
}

export type IncrementTable = readonly IncrementTier[];

export const DEFAULT_INCREMENT_TABLE: IncrementTable = [
  { fromCents: 0, incrementCents: 100 },
  { fromCents: 5_000, incrementCents: 500 },
  { fromCents: 20_000, incrementCents: 1_000 },
  { fromCents: 50_000, incrementCents: 2_500 },
  { fromCents: 100_000, incrementCents: 5_000 },
  { fromCents: 500_000, incrementCents: 10_000 },
];

export function validateIncrementTable(table: IncrementTable): void {
  if (table.length === 0) throw new RangeError("increment table must not be empty");
  if (table[0]!.fromCents !== 0) throw new RangeError("increment table must start at 0 cents");
  let prev = -1;
  for (const tier of table) {
    assertCents(tier.fromCents, "tier fromCents");
    assertCents(tier.incrementCents, "tier incrementCents");
    if (tier.incrementCents === 0) throw new RangeError("increment must be positive");
    if (tier.fromCents <= prev) throw new RangeError("increment tiers must be strictly ascending");
    prev = tier.fromCents;
  }
}

/** The increment that applies at the given current price. */
export function incrementAt(priceCents: Cents, table: IncrementTable = DEFAULT_INCREMENT_TABLE): Cents {
  assertCents(priceCents, "price");
  let result = table[0]!.incrementCents;
  for (const tier of table) {
    if (priceCents >= tier.fromCents) result = tier.incrementCents;
    else break;
  }
  return result;
}
