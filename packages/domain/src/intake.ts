/**
 * Receiving conventions. Sequences come from the db `counters` row lock;
 * these functions own the human-readable formats printed on labels, so the
 * convention lives (and is tested) in one place.
 */

/** Auto-generated item SKU: LOT-000123. Six digits ≈ headroom for years. */
export function formatSku(seq: number): string {
  if (!Number.isInteger(seq) || seq < 0) throw new Error(`invalid sku sequence: ${seq}`);
  return `LOT-${String(seq).padStart(6, "0")}`;
}

/** Consignment (inbound delivery) reference: CON-0042. */
export function formatConsignmentRef(seq: number): string {
  if (!Number.isInteger(seq) || seq < 0) throw new Error(`invalid consignment sequence: ${seq}`);
  return `CON-${String(seq).padStart(4, "0")}`;
}
