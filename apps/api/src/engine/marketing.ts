import { customerFees, customers, notifications } from "@auction/db";
import { and, count, desc, eq, gte, isNull, sql } from "drizzle-orm";
import type { AppContext } from "../context.js";
import type { Db } from "@auction/db";
import { emailBrand, langFor, renderNotification } from "./notifications.js";
import { renderEmailHtml } from "./emailLayout.js";
import { unsubscribeUrl } from "./unsubscribe.js";
import type { Lang, NotificationType, TemplateInput } from "./emailCopy.js";

/**
 * Планировщик маркетинговых писем.
 *
 * Сервисные письма (заказ, оплата, выдача) идут всегда и мимо этого файла —
 * их человек ждёт. Всё остальное — дайджесты, подборки, возвращение — проходит
 * здесь и обязано пережить четыре проверки: согласие, стоп-сигналы, частоту
 * и тишину. Правила зашиты в код, а не держатся в голове: рассылка без
 * ограничителей за полгода превращается в спам и сжигает репутацию домена,
 * после чего перестают доходить и сервисные письма тоже.
 */

/** Не больше двух маркетинговых писем в неделю на человека. */
const MAX_PER_WEEK = 2;
/** И не чаще одного раза в двое суток. */
const MIN_GAP_HOURS = 48;
/** Ночью не пишем: письмо ждёт утра. Часы по рижскому времени. */
const QUIET_FROM_HOUR = 22;
const QUIET_TO_HOUR = 8;

export type MarketingSkip =
  | "no_consent"
  | "unsubscribed"
  | "bounced"
  | "blocked"
  | "debt"
  | "erased"
  | "service_address"
  | "too_soon"
  | "weekly_cap"
  | "duplicate";

export type MarketingResult = { ok: true; scheduledFor: Date } | { ok: false; skip: MarketingSkip };

type Tx = Pick<Db, "select" | "insert">;

/** Рижское время суток (UTC+2/+3) — почта уходит по часам получателя, а не
 *  по часам сервера. Смещение зимой 2, летом 3; берём по месяцу — ошибка в
 *  неделю на границе перевода часов роли для «не писать ночью» не играет. */
function rigaHour(at: Date): number {
  const month = at.getUTCMonth() + 1;
  const offset = month >= 4 && month <= 10 ? 3 : 2;
  return (at.getUTCHours() + offset) % 24;
}

/** Ближайший момент, когда писать уже можно. */
function afterQuietHours(at: Date): Date {
  const hour = rigaHour(at);
  if (hour >= QUIET_TO_HOUR && hour < QUIET_FROM_HOUR) return at;
  // Двигаемся вперёд по часу, пока не выйдем из тишины: так не нужно
  // считать переходы через полночь и смену смещения вручную.
  const next = new Date(at.getTime());
  for (let i = 0; i < 24; i++) {
    next.setTime(next.getTime() + 3_600_000);
    if (rigaHour(next) === QUIET_TO_HOUR) {
      next.setUTCMinutes(0, 0, 0);
      return next;
    }
  }
  return at;
}

/**
 * Поставить маркетинговое письмо в очередь, если человеку сейчас можно писать.
 * Возвращает причину отказа — вызывающая сторона может её записать, но
 * никогда не должна обходить.
 */
export async function enqueueMarketing(
  ctx: AppContext,
  tx: Tx,
  args: {
    customerId: string;
    /** «campaign» — свободное письмо конструктора кампаний (MD §1.4). */
    type: NotificationType | "campaign";
    template: TemplateInput;
    /** Кампания: тема и текст по языкам, вместо кодового шаблона. */
    custom?: Record<string, { subject: string; body: string }>;
    /** Ключ идемпотентности: одно письмо на событие, а не на каждый проход крона. */
    dedupeKey: string;
    /**
     * Письмо, которое человек попросил сам: галочка «сообщать о новых лотах»
     * у сохранённого поиска, лоты из вэлмес на исходе. Такое письмо не
     * требует общего согласия на рассылку и лимитами частоты не задерживается
     * (хотя в них считается: подборка уступает место просьбе). Стоп-сигналы —
     * отписка, возврат почты, блокировка — действуют без исключений.
     */
    explicit?: boolean;
  },
): Promise<MarketingResult> {
  const now = ctx.now();

  const [person] = await tx
    .select({
      email: customers.email,
      alias: customers.alias,
      country: customers.country,
      lang: customers.lang,
      erasedAt: customers.erasedAt,
      blocked: customers.blocked,
      marketingOptIn: customers.marketingOptIn,
      unsubscribedAt: customers.unsubscribedAt,
      emailBouncedAt: customers.emailBouncedAt,
    })
    .from(customers)
    .where(eq(customers.id, args.customerId));

  if (!person || person.erasedAt !== null) return { ok: false, skip: "erased" };
  if (person.email.endsWith("@nav.izsoli.lv")) return { ok: false, skip: "service_address" };
  if (person.emailBouncedAt !== null) return { ok: false, skip: "bounced" };
  if (person.unsubscribedAt !== null) return { ok: false, skip: "unsubscribed" };
  if (person.blocked) return { ok: false, skip: "blocked" };
  if (!args.explicit) {
    if (!person.marketingOptIn) return { ok: false, skip: "no_consent" };

    // Долг: пока человек должен денег, продавать ему новое неуместно.
    const [debt] = await tx
      .select({ n: count() })
      .from(customerFees)
      .where(and(eq(customerFees.customerId, args.customerId), eq(customerFees.status, "outstanding")));
    if ((debt?.n ?? 0) > 0) return { ok: false, skip: "debt" };

    // Частота считается по уже поставленным в очередь письмам, а не по
    // отправленным: иначе два крона в одну минуту пробили бы лимит вдвоём.
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
    const [week] = await tx
      .select({ n: count() })
      .from(notifications)
      .where(and(
        eq(notifications.customerId, args.customerId),
        eq(notifications.kind, "marketing"),
        gte(notifications.createdAt, weekAgo),
      ));
    if ((week?.n ?? 0) >= MAX_PER_WEEK) return { ok: false, skip: "weekly_cap" };

    const [last] = await tx
      .select({ createdAt: notifications.createdAt })
      .from(notifications)
      .where(and(eq(notifications.customerId, args.customerId), eq(notifications.kind, "marketing")))
      .orderBy(desc(notifications.createdAt))
      .limit(1);
    if (last && now.getTime() - last.createdAt.getTime() < MIN_GAP_HOURS * 3_600_000) {
      return { ok: false, skip: "too_soon" };
    }
  }

  const lang = langFor(person.lang, person.country);
  let subject: string;
  let text: string;
  let html: string;
  if (args.type === "campaign") {
    // Кампания: тема и текст заданы в конструкторе; берём язык получателя с
    // фолбэком, оборачиваем в фирменный HTML и ОБЯЗАТЕЛЬНО даём отписку.
    const content = args.custom?.[lang] ?? args.custom?.lv ?? args.custom?.en;
    if (!content) return { ok: false, skip: "duplicate" };
    const rendered = renderCampaignEmail(ctx, {
      lang, alias: person.alias, subject: content.subject, body: content.body, customerId: args.customerId,
    });
    subject = rendered.subject;
    text = rendered.text;
    html = rendered.html;
  } else {
    ({ subject, text, html } = await renderNotification(
      ctx,
      args.type,
      lang,
      { ...args.template, alias: person.alias },
      args.customerId,
    ));
  }
  const scheduledFor = afterQuietHours(now);

  const rows = await tx
    .insert(notifications)
    .values({
      customerId: args.customerId,
      type: args.type,
      kind: "marketing",
      toEmail: person.email,
      lang,
      subject,
      body: text,
      html,
      dedupeKey: args.dedupeKey,
      scheduledFor,
    })
    .onConflictDoNothing()
    .returning({ id: notifications.id });
  if (rows.length === 0) return { ok: false, skip: "duplicate" };
  return { ok: true, scheduledFor };
}

/** Письмо кампании: свободные тема и текст из конструктора, фирменная
 *  обёртка, обязательная отписка. Плейсхолдер поддерживается один — {alias}. */
function renderCampaignEmail(
  ctx: AppContext,
  args: { lang: Lang; alias: string; subject: string; body: string; customerId: string },
): { subject: string; text: string; html: string } {
  const L = args.lang;
  const unsubUrl = unsubscribeUrl(args.customerId, ctx.config.jwtSecret, ctx.config.storefrontBaseUrl);
  const unsub = {
    url: unsubUrl,
    label: { lv: "Atteikties no jaunumiem", ru: "Отписаться от рассылки", en: "Unsubscribe from updates" }[L],
    note: {
      lv: "Šo vēstuli saņēmāt, jo piekritāt jaunumiem izsoli.lv.",
      ru: "Письмо пришло, потому что вы согласились получать новости izsoli.lv.",
      en: "You received this because you agreed to updates from izsoli.lv.",
    }[L],
  };
  const subject = args.subject.replace(/\{alias\}/g, args.alias);
  const bodyFilled = args.body.replace(/\{alias\}/g, args.alias);
  const paras = bodyFilled.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const greeting = `${{ lv: "Sveicināti", ru: "Здравствуйте", en: "Hello" }[L]}, ${args.alias}!`;
  const html = renderEmailHtml(
    {
      preheader: (paras[0] ?? "").slice(0, 120),
      headline: subject.slice(0, 80).toUpperCase(),
      headlineTone: "accent",
      greeting,
      intro: paras[0] ?? "",
      notes: paras.slice(1).map((text) => ({ text })),
      cta: {
        label: { lv: "Skatīt izsoles", ru: "Смотреть лоты", en: "See the lots" }[L],
        url: ctx.config.storefrontBaseUrl,
      },
      labels: {
        follow: { lv: "Seko mums", ru: "Мы в соцсетях", en: "Follow us" }[L],
        review: { lv: "Atstāj atsauksmi", ru: "Оставить отзыв", en: "Leave a review" }[L],
      },
      unsubscribe: unsub,
    },
    emailBrand(ctx),
  );
  const text = `${greeting}\n\n${bodyFilled}\n\n[campaign]\n\n---\n${unsub.note}\n${unsub.label}: ${unsub.url}`;
  return { subject, text, html };
}

/** Отписка по ссылке из письма. Идемпотентна: повторный клик ничего не портит. */
export async function applyUnsubscribe(ctx: AppContext, customerId: string): Promise<boolean> {
  const rows = await ctx.db
    .update(customers)
    .set({
      unsubscribedAt: ctx.now(),
      marketingOptIn: false,
      marketingOptOutAt: sql`coalesce(${customers.marketingOptOutAt}, ${ctx.now()})`,
    })
    .where(and(eq(customers.id, customerId), isNull(customers.erasedAt)))
    .returning({ id: customers.id });
  return rows.length > 0;
}
