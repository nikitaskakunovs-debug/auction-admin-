import { useSyncExternalStore } from "react";

/**
 * Phase B — one breakpoint for the whole admin. Below this the shell swaps
 * the fixed sidebar for a MENU drawer, tabs/split collapse to a single pane,
 * and the power lists reflow into cards.
 */
const QUERY = "(max-width: 760px)";

const mql = typeof window !== "undefined" && "matchMedia" in window ? window.matchMedia(QUERY) : null;

function subscribe(onChange: () => void): () => void {
  if (!mql) return () => undefined;
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, () => mql?.matches ?? false);
}
