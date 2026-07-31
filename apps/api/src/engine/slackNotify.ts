import { formatEur } from "@auction/domain";
import type { AppContext } from "../context.js";
import type { SlackMessage } from "./slack.js";

/**
 * The business-event → Slack vocabulary (Phase S1). One function per event so
 * the wording lives in a single place rather than scattered across routes.
 *
 * Every helper is fire-and-forget: `mirror()` swallows failures, because a
 * Slack outage must never roll back a sale or block a warehouse action. The
 * copy is Latvian — the team's language, matching the panel default.
 */

/**
 * Post without ever throwing into the caller's transaction/response path —
 * but never silently: a swallowed failure is invisible to operators, so the
 * reason (Slack's own error code: channel_not_found, invalid_auth, …) is
 * logged and kept for the Activity screen's connection card.
 */
function mirror(ctx: AppContext, msg: SlackMessage): void {
  if (!ctx.slack) return;
  void ctx.slack.post(msg).then(
    () => recordSlackResult(null),
    (err: unknown) => {
      const reason = err instanceof Error ? err.message : String(err);
      recordSlackResult(reason);
      console.warn(`[slack] ${msg.channel} post failed: ${reason}`);
    },
  );
}

/** Last delivery outcome, surfaced by GET /api/bugs/jira-status. */
let lastError: { at: string; reason: string } | null = null;
let lastOkAt: string | null = null;

function recordSlackResult(reason: string | null): void {
  if (reason === null) {
    lastOkAt = new Date().toISOString();
    lastError = null;
  } else {
    lastError = { at: new Date().toISOString(), reason };
  }
}

export const slackHealth = (): { lastOkAt: string | null; lastError: { at: string; reason: string } | null } => ({
  lastOkAt,
  lastError,
});

const adminUrl = (ctx: AppContext, hash: string): string | null => {
  const base = ctx.config.adminBaseUrl;
  return base ? `${base}/#/${hash}` : null;
};

// ── #orders ─────────────────────────────────────────────────────────────────

export function slackAuctionWon(
  ctx: AppContext,
  p: { title: string; hammerCents: number; orderRef: string; bidderAlias: string; orderId: string },
): void {
  mirror(ctx, {
    channel: "orders",
    title: "🏆 Izsole noslēgusies",
    text: `${p.title} — pārdota par ${formatEur(p.hammerCents)}`,
    fields: [`Pasūtījums: ${p.orderRef}`, `Solītājs: ${p.bidderAlias}`],
    url: adminUrl(ctx, `orders/${p.orderId}`),
  });
}

export function slackBuyNow(
  ctx: AppContext,
  p: { title: string; priceCents: number; orderRef: string; bidderAlias: string; orderId: string },
): void {
  mirror(ctx, {
    channel: "orders",
    title: "🛒 Pirkums «Pērc uzreiz»",
    text: `${p.title} — ${formatEur(p.priceCents)}`,
    fields: [`Pasūtījums: ${p.orderRef}`, `Pircējs: ${p.bidderAlias}`],
    url: adminUrl(ctx, `orders/${p.orderId}`),
  });
}

export function slackOrderPaid(
  ctx: AppContext,
  p: { orderRef: string; totalCents: number; via: string; orderId: string },
): void {
  mirror(ctx, {
    channel: "orders",
    title: "💰 Apmaksāts",
    text: `${p.orderRef} — ${formatEur(p.totalCents)}`,
    fields: [`Veids: ${p.via}`],
    url: adminUrl(ctx, `orders/${p.orderId}`),
  });
}

export function slackShipmentRegistered(
  ctx: AppContext,
  p: { orderRef: string; carrier: string; barcode: string; orderId: string },
): void {
  mirror(ctx, {
    channel: "orders",
    title: "📦 Sūtījums reģistrēts",
    text: `${p.orderRef} → ${p.carrier}`,
    fields: [`Sekošanas nr.: ${p.barcode}`],
    url: adminUrl(ctx, `orders/${p.orderId}`),
  });
}

export function slackOrderCancelled(
  ctx: AppContext,
  p: { orderRef: string; reason: string; feeCents: number; orderId: string },
): void {
  const reasonText =
    p.reason === "unpaid" ? "neapmaksāts termiņā"
      : p.reason === "no_pickup" ? "nav izņemts termiņā"
        : "atcelts manuāli";
  mirror(ctx, {
    channel: "orders",
    title: "❌ Pasūtījums atcelts",
    text: `${p.orderRef} — ${reasonText}`,
    fields: p.feeCents > 0 ? [`Ieturētā maksa: ${formatEur(p.feeCents)}`] : undefined,
    url: adminUrl(ctx, `orders/${p.orderId}`),
  });
}

export function slackRefund(
  ctx: AppContext,
  p: { orderRef: string; amountCents: number; reason: string; orderId: string },
): void {
  mirror(ctx, {
    channel: "orders",
    title: "↩️ Atmaksa",
    text: `${p.orderRef} — ${formatEur(p.amountCents)}`,
    fields: p.reason ? [`Iemesls: ${p.reason}`] : undefined,
    url: adminUrl(ctx, `orders/${p.orderId}`),
  });
}

// ── #warehouse ──────────────────────────────────────────────────────────────

export function slackCheckIn(
  ctx: AppContext,
  p: { ticketNumber: number; alias: string; lines: number; via: string },
): void {
  mirror(ctx, {
    channel: "warehouse",
    title: "🎫 Klients ieradies",
    text: `Talons ${p.ticketNumber} — ${p.alias}, ${p.lines} preces`,
    fields: [`Reģistrēts: ${p.via === "kiosk" ? "kiosks" : "lete"}`],
    url: adminUrl(ctx, "pickup"),
  });
}

export function slackHandover(
  ctx: AppContext,
  p: { ticketNumber: number; worker: string; minutes: number | null },
): void {
  mirror(ctx, {
    channel: "warehouse",
    title: "✅ Izsniegts",
    text: `Talons ${p.ticketNumber} pabeigts`,
    fields: [
      `Izsniedza: ${p.worker}`,
      ...(p.minutes !== null ? [`Ilgums: ${p.minutes} min`] : []),
    ],
    url: adminUrl(ctx, "pickup"),
  });
}

export function slackConsignmentOpened(
  ctx: AppContext,
  p: { ref: string; supplier: string; expected: number | null },
): void {
  mirror(ctx, {
    channel: "warehouse",
    title: "📥 Jauna piegāde",
    text: `${p.ref} — ${p.supplier || "bez piegādātāja"}`,
    fields: p.expected ? [`Gaidāmās vienības: ${p.expected}`] : undefined,
    url: adminUrl(ctx, "receiving"),
  });
}

export function slackItemPulled(
  ctx: AppContext,
  p: { sku: string; title: string; reason: string; note: string; quarantined: boolean },
): void {
  const reasons: Record<string, string> = {
    damaged: "bojāts",
    rephoto: "jāpārfotografē",
    regrade: "jāpārvērtē",
    recount: "jāpārskaita",
    other: "cits iemesls",
  };
  mirror(ctx, {
    channel: "warehouse",
    title: p.quarantined ? "⚠️ Noņemts karantīnā" : "📤 Noņemts no plaukta",
    text: `${p.sku} — ${p.title}`,
    fields: [`Iemesls: ${reasons[p.reason] ?? p.reason}`, ...(p.note ? [`Piezīme: ${p.note}`] : [])],
    url: adminUrl(ctx, "inventory"),
  });
}

export function slackGradeRejected(
  ctx: AppContext,
  p: { sku: string; title: string; reason: string; reviewer: string },
): void {
  mirror(ctx, {
    channel: "warehouse",
    title: "🏷️ Novērtējums noraidīts",
    text: `${p.sku} — ${p.title}`,
    fields: [`Iemesls: ${p.reason}`, `Pārbaudīja: ${p.reviewer}`],
    url: adminUrl(ctx, "receiving"),
  });
}

// ── #bugs ───────────────────────────────────────────────────────────────────

const SEVERITY_LV: Record<string, string> = {
  low: "zema", normal: "parasta", high: "augsta", blocker: "bloķē darbu",
};

export function slackBugReported(
  ctx: AppContext,
  p: { jiraKey: string | null; severity: string; reporter: string; body: string; screen: string },
): void {
  mirror(ctx, {
    channel: "bugs",
    title: `🐞 Jauns ziņojums${p.jiraKey ? ` · ${p.jiraKey}` : ""}`,
    text: p.body,
    fields: [
      `Ziņoja: ${p.reporter}`,
      `Nopietnība: ${SEVERITY_LV[p.severity] ?? p.severity}`,
      ...(p.screen ? [`Ekrāns: ${p.screen}`] : []),
    ],
    url: adminUrl(ctx, "activity"),
  });
}

export function slackBugReply(
  ctx: AppContext,
  p: { jiraKey: string | null; body: string },
): void {
  mirror(ctx, {
    channel: "bugs",
    title: `💬 IT atbildēja${p.jiraKey ? ` · ${p.jiraKey}` : ""}`,
    text: p.body,
    url: adminUrl(ctx, "activity"),
  });
}

export function slackBugFixed(
  ctx: AppContext,
  p: { jiraKey: string | null; resolution: string },
): void {
  mirror(ctx, {
    channel: "bugs",
    title: `✓ Salabots${p.jiraKey ? ` · ${p.jiraKey}` : ""}`,
    text: p.resolution || "Ziņojums aizvērts.",
    url: adminUrl(ctx, "activity"),
  });
}
