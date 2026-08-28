import { customers, notificationPrefs, notifications, type Db } from "@auction/db";
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
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
import { unsubscribeApiUrl, unsubscribeUrl } from "./unsubscribe.js";

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

/** Ссылки на витрину в письмах помечаются utm-метками — возвраты из писем
 *  видны в отчёте «Mārketings» как канал email, а не «прямой заход».
 *  amp: в HTML параметры доклеиваются как &amp;, в plain-тексте — как &. */
function tagEmailLinks(body: string, campaign: string, base: string, amp: string): string {
  if (!base) return body;
  const re = new RegExp(base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + `[^\\s"'<)\\]]*`, "g");
  const utm = `utm_source=email${amp}utm_medium=email${amp}utm_campaign=${encodeURIComponent(campaign)}`;
  return body.replace(re, (url) => {
    if (url.includes("utm_source=")) return url;
    // Точка или запятая после ссылки в тексте — не часть адреса.
    const tail = /[.,;:!]+$/.exec(url)?.[0] ?? "";
    const clean = tail ? url.slice(0, -tail.length) : url;
    // Фрагмент (#…) обязан остаться в самом конце адреса.
    const [addr = "", hash] = clean.split(/#(.*)/s);
    const sep = addr.includes("?") ? amp : "?";
    return `${addr}${sep}${utm}${hash !== undefined ? `#${hash}` : ""}${tail}`;
  });
}

/** Подпись под рассылкой: почему письмо пришло и как перестать его получать.
 *  У сервисных писем этого блока нет — от счёта не отписываются. */
const UNSUB_COPY: Record<Lang, { label: string; note: string }> = {
  lv: {
    label: "Atteikties no jaunumiem",
    note: "Šo vēstuli saņēmāt, jo piekritāt jaunumiem izsoli.lv. Paziņojumi par jūsu solījumiem, rēķiniem un saņemšanu pienāks arī turpmāk.",
  },
  ru: {
    label: "Отписаться от рассылки",
    note: "Письмо пришло, потому что вы согласились получать новости izsoli.lv. Уведомления о ваших ставках, счетах и выдаче будут приходить и дальше.",
  },
  en: {
    label: "Unsubscribe from updates",
    note: "You received this because you agreed to updates from izsoli.lv. Notices about your bids, invoices and pickup will keep coming.",
  },
};

/** Subject + both bodies for one message. */
export function renderNotification(
  ctx: AppContext,
  type: NotificationType,
  lang: Lang,
  input: TemplateInput,
  /** Идентификатор клиента для маркетинговых писем: с ним в подвал ляжет
   *  видимая ссылка отписки. Для сервисных писем не передаётся. */
  marketingFor?: string,
): { subject: string; text: string; html: string } {
  const copy: Rendered = renderCopy(type, lang, input, copyContext(ctx));
  const base = ctx.config.storefrontBaseUrl;
  const unsub = marketingFor
    ? { ...UNSUB_COPY[lang], url: unsubscribeUrl(marketingFor, ctx.config.jwtSecret, base) }
    : undefined;
  const spec = unsub ? { ...copy.spec, unsubscribe: unsub } : copy.spec;
  // Ссылка отписки помечена своей меткой: отписки в отчёте видны отдельно от
  // переходов в каталог, а utm-подстановка её не трогает.
  const textUnsub = unsub ? `\n\n---\n${unsub.note}\n${unsub.label}: ${unsub.url}` : "";
  return {
    subject: copy.subject,
    text: tagEmailLinks(copy.text, type, base, "&") + textUnsub,
    html: tagEmailLinks(renderEmailHtml(spec, emailBrand(ctx)), type, base, "&amp;"),
  };
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
    .where(and(
      eq(notifications.status, "pending"),
      // Маркетинг, отложенный из-за ночной тишины, ждёт своего часа;
      // сервисные письма приходят без этой отметки и уходят сразу.
      or(isNull(notifications.scheduledFor), lte(notifications.scheduledFor, ctx.now())),
    ))
    .orderBy(asc(notifications.createdAt))
    .limit(batch);

  let sent = 0;
  for (const n of pending) {
    try {
      const body = await resolvePayLaterExample(ctx, n.body);
      // Rows written before HTML emails existed have no html — they still go
      // out as plain text rather than being re-rendered from newer copy.
      const html = n.html ? await resolvePayLaterExample(ctx, n.html) : undefined;
      // Отписка: почтовики требуют её у любой рассылки, и Gmail показывает
      // свою кнопку только при этих двух заголовках. У сервисных писем
      // отписки нет и быть не может — их отменяют не так.
      const headers = n.kind === "marketing" && n.customerId
        ? {
            "List-Unsubscribe": `<${unsubscribeApiUrl(n.customerId, ctx.config.jwtSecret, ctx.config.publicBaseUrl)}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          }
        : undefined;
      await ctx.email.send({
        to: n.toEmail,
        subject: n.subject,
        text: body,
        ...(html ? { html } : {}),
        ...(headers ? { headers } : {}),
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
