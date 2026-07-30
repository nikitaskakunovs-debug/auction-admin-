import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import { useAuctionEvents } from "./useAuctionEvents.js";

/**
 * A3 sidebar pills — screen id → count of work waiting there. One fetch on
 * load, refreshed by the live events that can change the numbers plus a slow
 * interval (covers email failures, which have no WS event).
 */
export function useBadges(enabled: boolean): Record<string, number> {
  const [badges, setBadges] = useState<Record<string, number>>({});

  const refresh = useCallback(() => {
    void api.get<{ badges: Record<string, number> }>("/api/badges").then((r) => setBadges(r.badges)).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    refresh();
    const t = setInterval(refresh, 5 * 60_000);
    return () => clearInterval(t);
  }, [enabled, refresh]);

  useAuctionEvents(enabled ? "admin" : null, (ev) => {
    if (
      ev.type === "pickup_checkin" ||
      ev.type === "grade_review_pending" ||
      ev.type === "grade_edited" ||
      ev.type === "grade_rejected" ||
      ev.type === "item_comment" ||
      ev.type === "bug_reply"
    ) {
      refresh();
    }
  });

  return badges;
}

/** Screens whose pill means "needs attention" (orange) rather than "work waiting" (blue). */
export const WARN_BADGES = new Set(["receiving", "notifications"]);
