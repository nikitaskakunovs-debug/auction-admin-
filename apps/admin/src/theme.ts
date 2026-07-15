/**
 * Operator design tokens — ported from the Shhh admin (admin-ui.jsx): dark
 * sidebar, light dense data workspace, one accent blue.
 */
export const AT = {
  app: "#F4F4F2",
  panel: "#FFFFFF",
  side: "#0F0F0E",
  sideRule: "rgba(255,255,255,0.10)",
  sideInk: "#FFFFFF",
  sideSoft: "rgba(255,255,255,0.55)",
  ink: "#0A0A0A",
  inkSoft: "#6B6B68",
  rule: "rgba(10,10,10,0.10)",
  ruleSoft: "rgba(10,10,10,0.06)",
  accent: "#2D4BFF",
  accentSoft: "#EAEEFF",
  surfaceAlt: "#F4F4F2",
  ok: "#1F8A4C",
  okSoft: "#E4F4EA",
  warn: "#C2410C",
  warnSoft: "#FCEFD9",
  danger: "#D0282E",
  dangerSoft: "#FBE3E3",
  radius: 12,
  radiusSm: 8,
  body: '"Geist", system-ui, sans-serif',
  mono: '"Geist Mono", ui-monospace, monospace',
} as const;

export type Tone = "ok" | "warn" | "danger" | "neutral" | "accent";

export const toneColors: Record<Tone, { bg: string; fg: string }> = {
  ok: { bg: AT.okSoft, fg: AT.ok },
  warn: { bg: AT.warnSoft, fg: AT.warn },
  danger: { bg: AT.dangerSoft, fg: AT.danger },
  neutral: { bg: AT.surfaceAlt, fg: AT.inkSoft },
  accent: { bg: AT.accentSoft, fg: AT.accent },
};

export const AUCTION_STATUS_TONE: Record<string, { label: string; tone: Tone }> = {
  scheduled: { label: "Scheduled", tone: "neutral" },
  live: { label: "Live", tone: "ok" },
  ended_won: { label: "Won", tone: "accent" },
  ended_reserve_not_met: { label: "Reserve not met", tone: "warn" },
  ended_no_bids: { label: "No bids", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "danger" },
};

export const ITEM_STATUS_TONE: Record<string, { label: string; tone: Tone }> = {
  draft: { label: "Draft", tone: "neutral" },
  listed: { label: "Listed", tone: "accent" },
  live: { label: "Live", tone: "ok" },
  won: { label: "Won", tone: "accent" },
  awaiting_payment: { label: "Awaiting payment", tone: "warn" },
  paid: { label: "Paid", tone: "ok" },
  picking: { label: "Picking", tone: "accent" },
  packed: { label: "Packed", tone: "accent" },
  shipped: { label: "Shipped", tone: "accent" },
  delivered: { label: "Delivered", tone: "ok" },
  closed: { label: "Closed", tone: "neutral" },
  unsold: { label: "Unsold", tone: "warn" },
  unpaid_cancelled: { label: "Unpaid · cancelled", tone: "danger" },
  no_pickup_cancelled: { label: "No pickup · cancelled", tone: "danger" },
};

export const ORDER_STATUS_TONE: Record<string, { label: string; tone: Tone }> = {
  awaiting_payment: { label: "Awaiting payment", tone: "warn" },
  paid: { label: "Paid", tone: "ok" },
  cancelled: { label: "Cancelled", tone: "danger" },
  refunded: { label: "Refunded", tone: "neutral" },
};
