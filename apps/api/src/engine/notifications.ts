import { customers, notificationPrefs, notifications, type Db } from "@auction/db";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import type { AppContext } from "../context.js";
import {
  LANGS,
  NOTIFICATION_TYPES,
  renderCopy,
  sampleInput,
  type CopyContext,
  type Lang,
  type NotificationType,
  type Rendered,
  type TemplateInput,
} from "./emailCopy.js";
import { renderEmailHtml, type EmailBrand } from "./emailLayout.js";

/**
 * Notification enqueue + dispatch. Enqueue writes an outbox row (inside the
 * caller's transaction when durability matters); dispatch drains pending rows
 * and hands each to the email adapter, marking sent/failed with retry.
 *
 * Both bodies are rendered and stored at enqueue: the plain text that has
 * always been sent, and the designed HTML beside it. What the outbox holds is
 * exactly what went out — nothing is re-rendered later from different code.
 */

export { LANGS, NOTIFICATION_TYPES, sampleInput };
export type { Lang, NotificationType, TemplateInput };

/** Bidder language: their own preference, else the country. */
export function langFor(pref: string | null, country: string | null): Lang {
  if (pref === "lv" || pref === "ru" || pref === "en") return pref;
  return country === "LV" ? "lv" : "en";
}

/** Everything the copy needs to point at, assembled from config once. */
export function copyContext(ctx: AppContext): CopyContext {
  const b = ctx.config.emailBrand;
  const site = b.siteUrl;
  return {
    siteUrl: site,
    ordersUrl: `${site}/me/orders`,
    feesUrl: `${site}/me/fees`,
    pickupPassUrl: `${site}/me/pickup`,
    pickupAddress: b.pickupAddress,
    pickupHours: b.pickupHours,
    // Read from the live context, not from config alone: a provider that
    // failed to construct is off no matter what the env says.
    online: { klix: ctx.klix !== null, inbank: ctx.inbank !== null },
  };
}

export function emailBrand(ctx: AppContext): EmailBrand {
  const b = ctx.config.emailBrand;
  return {
    companyName: b.companyName,
    legalName: b.legalName,
    regNo: b.regNo,
    address: b.address,
    phone: b.phone,
    email: b.email,
    siteUrl: b.siteUrl,
    heroUrl: b.heroUrl,
    facebookUrl: b.facebookUrl,
    instagramUrl: b.instagramUrl,
    reviewUrl: b.reviewUrl,
  };
}

/** Subject + both bodies for one message. */
export function renderNotification(
  ctx: AppContext,
  type: NotificationType,
  lang: Lang,
  input: TemplateInput,
): { subject: string; text: string; html: string } {
  const copy: Rendered = renderCopy(type, lang, input, copyContext(ctx));
  return { subject: copy.subject, text: copy.text, html: renderEmailHtml(copy.spec, emailBrand(ctx)) };
}

type Tx = Pick<Db, "select" | "insert">;

/**
 * Enqueue a notification for a customer. Looks up the recipient's email +
 * language snapshot. Skips silently for erased/missing recipients. `dedupeKey`
 * (when given) makes the enqueue idempotent via the unique index.
 */
/** События, которые человек вправе выключить (экран «Paziņojumi»). */
const OPTIONAL_EVENTS = new Set<string>(["outbid"]);

export async function enqueueNotification(
  ctx: AppContext,
  tx: Tx,
  args: { customerId: string; type: NotificationType; template: TemplateInput; dedupeKey?: string },
): Promise<void> {
  const [recipient] = await tx
    .select({
      email: customers.email,
      alias: customers.alias,
      country: customers.country,
      lang: customers.lang,
      erasedAt: customers.erasedAt,
    })
    .from(customers)
    .where(eq(customers.id, args.customerId));
  if (!recipient || recipient.erasedAt !== null) return;
  // Служебный адрес соцвхода почты не принимает — не пишем и не шлём.
  if (recipient.email.endsWith("@nav.izsoli.lv")) return;

  // Матрица уведомлений: необязательные события человек может выключить.
  // Юридически обязательные (won, счёт, оплата, выдача) сюда не входят —
  // их выключателя нет ни в интерфейсе, ни здесь.
  if (OPTIONAL_EVENTS.has(args.type)) {
    const [pref] = await tx
      .select({ email: notificationPrefs.email })
      .from(notificationPrefs)
      .where(and(eq(notificationPrefs.customerId, args.customerId), eq(notificationPrefs.event, args.type)));
    if (pref && !pref.email) return;
  }

  const lang = langFor(recipient.lang, recipient.country);
  // The greeting name always comes from the current record, never the caller.
  const { subject, text, html } = renderNotification(ctx, args.type, lang, {
    ...args.template,
    alias: recipient.alias,
  });
  await tx
    .insert(notifications)
    .values({
      customerId: args.customerId,
      type: args.type,
      toEmail: recipient.email,
      lang,
      subject,
      body: text,
      html,
      dedupeKey: args.dedupeKey ?? null,
    })
    .onConflictDoNothing(); // dedupeKey collision → already enqueued
}

const MAX_ATTEMPTS = 5;

const PL_EXAMPLE_TOKEN = /\{\{KLIX_PL_EXAMPLE:(\d+):(\w+)\}\}/;
const PL_EXAMPLE_CACHE_TTL_SEC = 24 * 3600;

/**
 * Resolve the Pay Later representative-example placeholder into Klix's
 * actual consumer-credit text for the amount (cached in Redis for a day —
 * the financing endpoint is rate-limited and the text is deterministic per
 * amount/language). Degrades to removing the placeholder: a Klix hiccup
 * must never block the "you won" email.
 */
async function resolvePayLaterExample(ctx: AppContext, body: string): Promise<string> {
  const m = body.match(PL_EXAMPLE_TOKEN);
  if (!m) return body;
  let text = "";
  if (ctx.klix) {
    const [, amount, lang] = m as unknown as [string, string, string];
    const cacheKey = `klix:pl_example:${amount}:${lang}`;
    try {
      const cached = await ctx.redis.get(cacheKey);
      if (cached !== null) {
        text = cached;
      } else {
        text = (await ctx.klix.representativeExample(Number(amount), lang)) ?? "";
        await ctx.redis.set(cacheKey, text, "EX", PL_EXAMPLE_CACHE_TTL_SEC);
      }
    } catch {
      text = "";
    }
  }
  return body.replace(PL_EXAMPLE_TOKEN, text ? `${text}\n` : "");
}

/** Drain pending notifications and send them. Returns how many were sent. */
export async function dispatchNotifications(ctx: AppContext, batch = 50): Promise<number> {
  const pending = await ctx.db
    .select()
    .from(notifications)
    .where(eq(notifications.status, "pending"))
    .orderBy(asc(notifications.createdAt))
    .limit(batch);

  let sent = 0;
  for (const n of pending) {
    try {
      const body = await resolvePayLaterExample(ctx, n.body);
      // Rows written before HTML emails existed have no html — they still go
      // out as plain text rather than being re-rendered from newer copy.
      const html = n.html ? await resolvePayLaterExample(ctx, n.html) : undefined;
      await ctx.email.send({
        to: n.toEmail,
        subject: n.subject,
        text: body,
        ...(html ? { html } : {}),
      });
      await ctx.db
        .update(notifications)
        .set({ status: "sent", sentAt: ctx.now(), attempts: n.attempts + 1, body, html: html ?? n.html })
        .where(eq(notifications.id, n.id));
      sent += 1;
    } catch (err) {
      const attempts = n.attempts + 1;
      await ctx.db
        .update(notifications)
        .set({
          status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
          attempts,
          lastError: (err as Error).message.slice(0, 500),
        })
        .where(eq(notifications.id, n.id));
    }
  }
  return sent;
}

/** Convenience for tests/ops: count outbox rows by status. */
export async function notificationCounts(ctx: AppContext): Promise<Record<string, number>> {
  const rows = await ctx.db
    .select({ status: notifications.status, n: sql<string>`count(*)` })
    .from(notifications)
    .groupBy(notifications.status);
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
}

/** Reminders due: awaiting-payment orders whose deadline is within the window. */
export function reminderDedupeKey(orderId: string): string {
  return `payment_reminder:${orderId}`;
}

/** One pickup reminder per window (3 days out, 1 day out) per order. */
export function pickupReminderDedupeKey(orderId: string, window: "3d" | "1d"): string {
  return `pickup_reminder:${window}:${orderId}`;
}
