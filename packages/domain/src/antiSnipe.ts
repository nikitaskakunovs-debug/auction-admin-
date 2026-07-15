/**
 * Anti-snipe: a bid landing inside the closing window pushes the end time
 * out so other bidders get a fair chance to respond. Window is configurable
 * per listing (default 60s per the design doc); 0 disables it.
 */

export interface AntiSnipeInput {
  /** Current auction end, epoch ms. */
  endsAtMs: number;
  /** When the bid was accepted, epoch ms. */
  bidAtMs: number;
  /** Sniping window in seconds; a bid within this window extends the auction. */
  windowSec: number;
  /** Cap on total extensions; null/undefined = unlimited. */
  maxExtensions?: number | null;
  /** Extensions already applied to this auction. */
  extensionsSoFar?: number;
}

export interface AntiSnipeResult {
  endsAtMs: number;
  extended: boolean;
}

export function applyAntiSnipe(input: AntiSnipeInput): AntiSnipeResult {
  const { endsAtMs, bidAtMs, windowSec } = input;
  const extensionsSoFar = input.extensionsSoFar ?? 0;
  const maxExtensions = input.maxExtensions ?? null;

  if (windowSec <= 0) return { endsAtMs, extended: false };
  if (bidAtMs >= endsAtMs) return { endsAtMs, extended: false }; // bid after close is the caller's bug
  if (endsAtMs - bidAtMs > windowSec * 1000) return { endsAtMs, extended: false };
  if (maxExtensions !== null && extensionsSoFar >= maxExtensions) return { endsAtMs, extended: false };

  // Push the close out to a full window after this bid.
  const proposed = bidAtMs + windowSec * 1000;
  if (proposed <= endsAtMs) return { endsAtMs, extended: false };
  return { endsAtMs: proposed, extended: true };
}
