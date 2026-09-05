import { customers, emailTemplateOverrides, notificationPrefs, notifications, suppliers, type Db } from "@auction/db";
import { formatEur } from "@auction/domain";
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { AppContext } from "../context.js";
import {
  LANGS,
  MARKETING_TYPES,
  NOTIFICATION_TYPES,
  renderCopy,
  replyDeskOf,
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

export { LANGS, MARKETING_TYPES, NOTIFICATION_TYPES, sampleInput };
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
    portalUrl: ctx.config.supplierPortalUrl,
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
    tiktokUrl: b.tiktokUrl,
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

/* ── CMS-переопределения шаблонов (MD §9) ─────────────────────────────────
 * Каждый текст письма можно поправить из админки. Правка хранится в
 * email_template_overrides; пустое поле означает «взять из кода». Плейсхолдеры
 * вида {alias} подставляются здесь — теми же форматтерами, что в кодовых
 * шаблонах, чтобы деньги и даты выглядели одинаково на всех языках. */

const fmtMoney = (c: number | undefined, lang: Lang): string => {
  if (c === undefined) return "";
  const en = formatEur(c);
  if (lang === "en") return en;
  const [whole = "0", frac = "00"] = en.replace(/^-?€/, "").split(".");
  return `${en.startsWith("-") ? "−" : ""}${whole.replace(/,/g, " ")},${frac} €`;
};
const fmtDay = (d: Date | undefined, lang: Lang): string => {
  if (!d) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  const s = `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
  return lang === "lv" ? `${s}.` : s;
};

/** Подстановка плейсхолдеров админского текста. Неизвестные — остаются как
 *  есть (видно в превью, ничего не падает). */
export function fillPlaceholders(tpl: string, i: TemplateInput, ctx: AppContext, lang: Lang): string {
  const cc = copyContext(ctx);
  const map: Record<string, string> = {
    alias: i.alias,
    lotTitle: i.lotTitle ?? "",
    orderRef: i.orderRef ?? "",
    amount: fmtMoney(i.amountCents, lang),
    total: fmtMoney(i.totalCents, lang),
    fee: fmtMoney(i.feeCents, lang),
    refund: fmtMoney(i.refundCents, lang),
    deadline: fmtDay(i.deadline, lang),
    pickupCode: i.pickupCode ?? "",
    carrier: i.carrier ?? "",
    trackingUrl: i.trackingUrl ?? "",
    machineName: i.machineName ?? "",
    ticketNumber: i.ticketNumber !== undefined ? String(i.ticketNumber) : "",
    reason: i.reason ?? "",
    actionUrl: i.actionUrl ?? "",
    payUrl: i.payUrl ?? "",
    searchName: i.searchName ?? "",
    promoCode: i.promoCode ?? "",
    promoPercent: i.promoPercent !== undefined ? String(i.promoPercent) : "",
    promoDeadline: fmtDay(i.promoDeadline, lang),
    pointsEarned: fmtMoney(i.pointsEarnedCents, lang),
    pointsBalance: fmtMoney(i.pointsBalanceCents, lang),
    referralUrl: i.referralUrl ?? "",
    referralSignup: fmtMoney(i.referralSignupCents, lang),
    referralOrder: fmtMoney(i.referralOrderCents, lang),
    referralPercent: i.referralPercent !== undefined ? String(i.referralPercent) : "",
    categoryLabel: i.categoryLabel ?? "",
    // Письма части A и письма поставщикам — те же плейсхолдеры доступны
    // администратору, когда он правит текст руками.
    expiring: fmtMoney(i.expiringCents, lang),
    expiresAt: fmtDay(i.expiresAt, lang),
    deviceLabel: i.deviceLabel ?? "",
    failureReason: i.failureReason ?? "",
    supplierName: i.supplierName ?? "",
    inviteUrl: i.inviteUrl ?? "",
    consignmentRef: i.consignmentRef ?? "",
    declaredCount: i.declaredCount !== undefined ? String(i.declaredCount) : "",
    acceptedCount: i.acceptedCount !== undefined ? String(i.acceptedCount) : "",
    rejectedCount: i.rejectedCount !== undefined ? String(i.rejectedCount) : "",
    discrepancyNote: i.discrepancyNote ?? "",
    replyByDate: fmtDay(i.replyByDate, lang),
    invoiceNumber: i.invoiceNumber ?? "",
    dueDate: fmtDay(i.dueDate, lang),
    rejectReason: i.rejectReason ?? "",
    paymentRef: i.paymentRef ?? "",
    paidAt: fmtDay(i.paidAt, lang),
    periodLabel: i.periodLabel ?? "",
    soldGross: fmtMoney(i.soldGrossCents, lang),
    commission: fmtMoney(i.commissionCents, lang),
    payout: fmtMoney(i.payoutCents, lang),
    unsoldCount: i.unsoldCount !== undefined ? String(i.unsoldCount) : "",
    decideByDate: fmtDay(i.decideByDate, lang),
    siteUrl: cc.siteUrl,
    ordersUrl: cc.ordersUrl,
    lots: (i.lots ?? []).map((l) => `• ${l.title} — ${fmtMoney(l.priceCents, lang)}`).join("\n"),
  };
  return tpl.replace(/\{(\w+)\}/g, (m, key: string) => (key in map ? map[key]! : m));
}

interface TplOverride {
  subject: string | null;
  body: string | null;
  html: string | null;
  ctaLabel: string | null;
  ctaUrl: string | null;
}
const OVERRIDE_CACHE_MS = 60_000;
const overrideCache = new Map<string, { at: number; row: TplOverride | null }>();

export function invalidateTemplateOverrideCache(): void {
  overrideCache.clear();
}

async function loadOverride(
  db: Pick<Db, "select">,
  type: string,
  lang: string,
): Promise<TplOverride | null> {
  const key = `${type}:${lang}`;
  const hit = overrideCache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < OVERRIDE_CACHE_MS) return hit.row;
  let row: TplOverride | null = null;
  try {
    const [r] = await db
      .select({
        subject: emailTemplateOverrides.subject,
        body: emailTemplateOverrides.body,
        html: emailTemplateOverrides.html,
        ctaLabel: emailTemplateOverrides.ctaLabel,
        ctaUrl: emailTemplateOverrides.ctaUrl,
        enabled: emailTemplateOverrides.enabled,
      })
      .from(emailTemplateOverrides)
      .where(and(eq(emailTemplateOverrides.type, type), eq(emailTemplateOverrides.lang, lang)));
    row = r && r.enabled
      ? { subject: r.subject, body: r.body, html: r.html, ctaLabel: r.ctaLabel, ctaUrl: r.ctaUrl }
      : null;
  } catch {
    // Правки — удобство, не обязанность: сбой чтения не должен ронять письмо.
  }
  overrideCache.set(key, { at: now, row });
  return row;
}

/** Subject + both bodies for one message. */
export async function renderNotification(
  ctx: AppContext,
  type: NotificationType,
  lang: Lang,
  input: TemplateInput,
  /** Идентификатор клиента для маркетинговых писем: с ним в подвал ляжет
   *  видимая ссылка отписки. Для сервисных писем не передаётся. */
  marketingFor?: string,
  /** skipOverride — превью кодового варианта в админке. db — ЧЕЙ рукой
   *  читать правку: вызов изнутри транзакции обязан передать её же, иначе
   *  чтение возьмёт второе соединение пула и при полусотне параллельных
   *  ставок пул кончится намертво. */
  opts: { skipOverride?: boolean; db?: Pick<Db, "select"> } = {},
): Promise<{ subject: string; text: string; html: string }> {
  const copy: Rendered = renderCopy(type, lang, input, copyContext(ctx));
  const base = ctx.config.storefrontBaseUrl;
  const unsub = marketingFor
    ? { ...UNSUB_COPY[lang], url: unsubscribeUrl(marketingFor, ctx.config.jwtSecret, base) }
    : undefined;

  // Правки из админки: тема и текст меняются, функциональные блоки письма
  // (кнопка оплаты, код выдачи, суммы) остаются из кода — админ не может
  // случайно оторвать у счёта кнопку «оплатить».
  const override = opts.skipOverride ? null : await loadOverride(opts.db ?? ctx.db, type, lang);
  let subject = copy.subject;
  let text = copy.text;
  let spec = copy.spec;
  if (override?.subject) subject = fillPlaceholders(override.subject, input, ctx, lang);
  if (override?.body) {
    const filled = fillPlaceholders(override.body, input, ctx, lang);
    const paras = filled.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    text = `${filled}\n\n[${type}]`;
    spec = {
      ...spec,
      intro: paras[0] ?? spec.intro,
      notes: paras.slice(1).map((p) => ({ text: p })),
    };
  }
  // Правка CTA из админки: текст и ссылка кнопки (с плейсхолдерами). Ссылка
  // после подстановки обязана быть http(s) — иначе остаётся кодовая: письмо
  // с кнопкой в никуда хуже письма без правки.
  if (override?.ctaLabel || override?.ctaUrl) {
    const label = override.ctaLabel ? fillPlaceholders(override.ctaLabel, input, ctx, lang) : spec.cta?.label;
    const rawUrl = override.ctaUrl ? fillPlaceholders(override.ctaUrl, input, ctx, lang) : spec.cta?.url;
    const url = rawUrl && /^https?:\/\//i.test(rawUrl) ? rawUrl : spec.cta?.url;
    if (label && url) spec = { ...spec, cta: { label, url } };
  }

  // art: тип письма выбирает line-art иллюстрацию макета ({siteUrl}/email/).
  const specWithUnsub = { ...spec, art: type, ...(unsub ? { unsubscribe: unsub } : {}) };
  // Ссылка отписки помечена своей меткой: отписки в отчёте видны отдельно от
  // переходов в каталог, а utm-подстановка её не трогает.
  const textUnsub = unsub ? `\n\n---\n${unsub.note}\n${unsub.label}: ${unsub.url}` : "";
  // Полный HTML-блок из админки заменяет собранное письмо целиком; ссылка
  // отписки дописывается и к нему — законная обязанность, не оформление.
  const html = override?.html
    ? fillPlaceholders(override.html, input, ctx, lang) +
      (unsub ? `<p style="font-size:12px;color:#888;">${unsub.note}<br/><a href="${unsub.url}">${unsub.label}</a></p>` : "")
    : renderEmailHtml(specWithUnsub, emailBrand(ctx));
  return {
    subject,
    text: tagEmailLinks(text, type, base, "&") + textUnsub,
    html: tagEmailLinks(html, type, base, "&amp;"),
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
  const { subject, text, html } = await renderNotification(
    ctx, args.type, lang,
    { ...args.template, alias: recipient.alias },
    undefined,
    // Читаем правки рукой вызывающей транзакции — не вторым соединением.
    { db: tx },
  );
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

/**
 * Письмо со сбросом пароля — единственное, которое НЕ ложится в очередь.
 * Ссылка в нём живёт минуты и открывает аккаунт, а журнал уведомлений виден
 * администраторам: хранить её там значило бы раздать всей команде ключ от
 * чужого кабинета. Поэтому письмо рендерится общим движком (тот же дизайн,
 * те же правки текста из админки) и уходит сразу, минуя запись.
 */
export async function sendPasswordReset(
  ctx: AppContext,
  args: { toEmail: string; alias: string; lang: Lang; link: string },
): Promise<void> {
  const { subject, text, html } = await renderNotification(ctx, "password_reset", args.lang, {
    alias: args.alias,
    lotTitle: "",
    actionUrl: args.link,
    validHours: Math.max(1, Math.round(ctx.config.passwordResetTtlSec / 3600)),
  });
  await ctx.email.send({ to: args.toEmail, subject, text, html });
}

/**
 * То же самое, но адресат — поставщик (письма S1…S10). Язык берём из его
 * карточки, обращение — по контактному лицу, а если его нет — по названию
 * компании. Всё остальное общее: та же очередь, те же повторы, тот же журнал
 * в «Paziņojumi» и те же правки текстов из админки.
 */
export async function enqueueSupplierNotification(
  ctx: AppContext,
  tx: Tx,
  args: { supplierId: string; type: NotificationType; template: TemplateInput; dedupeKey?: string },
): Promise<void> {
  const [recipient] = await tx
    .select({
      email: suppliers.email,
      name: suppliers.name,
      contactName: suppliers.contactName,
      lang: suppliers.lang,
      active: suppliers.active,
    })
    .from(suppliers)
    .where(eq(suppliers.id, args.supplierId));
  // Без адреса письмо отправить некуда; неактивным поставщикам не пишем.
  if (!recipient || !recipient.email.trim() || !recipient.active) return;
  const lang = langFor(recipient.lang, null);
  const { subject, text, html } = await renderNotification(
    ctx, args.type, lang,
    {
      ...args.template,
      alias: recipient.contactName.trim() || recipient.name,
      supplierName: recipient.name,
    },
    undefined,
    { db: tx },
  );
  await tx
    .insert(notifications)
    .values({
      supplierId: args.supplierId,
      type: args.type,
      toEmail: recipient.email,
      lang,
      subject,
      body: text,
      html,
      dedupeKey: args.dedupeKey ?? null,
    })
    .onConflictDoNothing();
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
/**
 * Пиксель открытия + обёртка кликов для маркетингового письма. Ссылки отписки
 * не трогаем: клик «отпишите меня» — не вовлечённость, и обёртка не должна
 * стоять между человеком и его правом отписаться.
 */
export function withEmailTracking(html: string, notificationId: string, apiBase: string): string {
  const wrapped = html.replace(/href="(https?:\/\/[^"]+)"/g, (m, url: string) => {
    if (/unsubscribe|atteikties/i.test(url)) return m;
    return `href="${apiBase}/api/t/c/${notificationId}?u=${encodeURIComponent(url)}"`;
  });
  const pixel = `<img src="${apiBase}/api/t/o/${notificationId}.png" width="1" height="1" alt="" style="display:none" />`;
  return wrapped.includes("</body>") ? wrapped.replace("</body>", `${pixel}</body>`) : wrapped + pixel;
}

export async function dispatchNotifications(ctx: AppContext, batch = 50): Promise<number> {
  const rows = await ctx.db
    .select({ n: notifications, bouncedAt: customers.emailBouncedAt })
    .from(notifications)
    .leftJoin(customers, eq(customers.id, notifications.customerId))
    .where(and(
      eq(notifications.status, "pending"),
      // Маркетинг, отложенный из-за ночной тишины, ждёт своего часа;
      // сервисные письма приходят без этой отметки и уходят сразу.
      or(isNull(notifications.scheduledFor), lte(notifications.scheduledFor, ctx.now())),
    ))
    .orderBy(asc(notifications.createdAt))
    .limit(batch);

  let sent = 0;
  for (const { n, bouncedAt } of rows) {
    // Ящика не существует — и служебное письмо туда не идёт. Проверка была
    // только у рассылок, а напоминания об оплате ходили в мёртвый адрес
    // каждый день; каждый такой отбой — минус к репутации домена, а значит
    // к доставке счетов всем остальным. Кто исправит почту в кабинете,
    // снимет отметку — и письма пойдут снова.
    if (bouncedAt !== null && bouncedAt !== undefined) {
      await ctx.db
        .update(notifications)
        .set({ status: "failed", attempts: n.attempts + 1, lastError: "address bounced" })
        .where(eq(notifications.id, n.id));
      continue;
    }
    try {
      const body = await resolvePayLaterExample(ctx, n.body);
      // Rows written before HTML emails existed have no html — they still go
      // out as plain text rather than being re-rendered from newer copy.
      let html = n.html ? await resolvePayLaterExample(ctx, n.html) : undefined;
      // Открытия/клики трекаются ТОЛЬКО у маркетинга (MD §1.4): пиксель и
      // обёртка ссылок — с id письма; сервисные письма идут нетронутыми.
      if (html && n.kind === "marketing") html = withEmailTracking(html, n.id, ctx.config.publicBaseUrl);
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
        // Ответ на счёт — бухгалтерии, на «где заказ» — поддержке: стол
        // выбирает тип письма, адрес стола — конфиг.
        replyTo: ctx.config.replyDesks[replyDeskOf(n.type as NotificationType)],
      });
      await ctx.db
        .update(notifications)
        .set({ status: "sent", sentAt: ctx.now(), attempts: n.attempts + 1, body, html: html ?? n.html })
        .where(eq(notifications.id, n.id));
      sent += 1;
      // Push-канал (MD §6.8): дублируем сервисное письмо коротким пушем, если
      // человек включил канал и подписал браузер. Ошибка пуша письмо не ломает.
      if (n.customerId && n.kind === "service") {
        const { PUSH_EVENTS, sendPushToCustomer } = await import("./push.js");
        if (PUSH_EVENTS.has(n.type)) {
          void sendPushToCustomer(ctx, n.customerId, {
            title: n.subject,
            body: n.body.split("\n").find((l) => l.trim().length > 0)?.slice(0, 140) ?? "",
            event: n.type,
          }).catch(() => undefined);
        }
      }
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
