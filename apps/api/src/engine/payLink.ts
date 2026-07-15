import { signPayLinkToken } from "../auth/jwt.js";
import type { AppContext } from "../context.js";

/** Fallback pay-link lifetime when the order carries no payment deadline. */
const DEFAULT_LINK_TTL_MS = 30 * 24 * 3_600_000;

/**
 * The "pay online" URL embedded in won / purchased / payment-reminder emails.
 * One click opens the checkout for that order — no login required, the
 * signed token authorizes exactly that one action and dies with the payment
 * deadline. Returns null while every provider is off so emails never carry
 * dead links.
 */
export function buildPayUrl(ctx: AppContext, orderRef: string, deadline: Date | null | undefined): string | null {
  if (!ctx.klix && !ctx.inbank) return null;
  const expiresAtMs = deadline?.getTime() ?? ctx.now().getTime() + DEFAULT_LINK_TTL_MS;
  const token = signPayLinkToken(orderRef, ctx.config.jwtSecret, expiresAtMs, ctx.now().getTime());
  return `${ctx.config.publicBaseUrl}/api/public/pay/${encodeURIComponent(orderRef)}?t=${token}`;
}
