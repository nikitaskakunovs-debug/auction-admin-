/**
 * What each email says, in Latvian, Russian and English.
 *
 * One entry per notification type returns three things at once:
 *   subject  the inbox line
 *   text     the plain-text body — unchanged from before, still carrying the
 *            `[type]` machine tag and the Klix placeholder
 *   spec     the structured content the blue layout renders
 *
 * Text and HTML are written side by side on purpose. A customer whose client
 * blocks HTML gets exactly the same facts, and neither version can quietly
 * drift away from the other.
 */
import { formatEur } from "@auction/domain";
import type { EmailSpec, Fact, MoneyLine } from "./emailLayout.js";

export type Lang = "lv" | "ru" | "en";
export const LANGS: Lang[] = ["lv", "ru", "en"];

export type NotificationType =
  | "verify_email"
  | "outbid"
  | "won"
  | "purchased"
  | "payment_reminder"
  | "order_paid"
  | "pickup_ready"
  | "pickup_reminder"
  | "no_pickup_cancelled"
  | "unpaid_cancelled"
  | "shipped"
  | "refunded"
  | "checked_in"
  | "saved_search_hits"
  | "watchlist_ending"
  // ── Lifecycle-письма плана v15 (маркетинг + сегментация) ──
  | "welcome_reminder"
  | "inactive_nudge"
  | "winback_offer"
  | "lost_bid_similar"
  | "review_request"
  | "referral_invite"
  // ── Надстройка v15 (MD §6) ──
  | "abandoned_bid"
  | "second_purchase"
  | "gift_card_received"
  // ── Пробелы, закрытые после запуска фин-слоя (план писем, часть A) ──
  /** Сброс пароля: раньше уходил голым текстом мимо этой системы. */
  | "password_reset"
  /** Баллы сгорят через N дней — обязательное предупреждение. */
  | "points_expiring"
  /** Вход с нового устройства, смена пароля или адреса. */
  | "security_alert"
  /** Посылка доставлена или ждёт в автомате. */
  | "delivered"
  /** Ставка аннулирована администратором. */
  | "bid_voided"
  /** Лот снят с торгов — участникам. */
  | "lot_withdrawn"
  /** Оплата не прошла — вернуться к оплате. */
  | "payment_failed"
  // ── Письма поставщикам (S1…S10) ──
  | "sup_invite"
  | "sup_welcome"
  | "sup_intake_done"
  | "sup_discrepancy"
  | "sup_invoice_accepted"
  | "sup_invoice_rejected"
  | "sup_payment_sent"
  | "sup_monthly_report"
  | "sup_sales_report"
  | "sup_unsold";

/** Письма поставщикам: адресат — supplier, а не customer. */
export const SUPPLIER_TYPES = [
  "sup_invite", "sup_welcome", "sup_intake_done", "sup_discrepancy",
  "sup_invoice_accepted", "sup_invoice_rejected", "sup_payment_sent",
  "sup_monthly_report", "sup_sales_report", "sup_unsold",
] as const satisfies readonly NotificationType[];

export const isSupplierType = (t: NotificationType): boolean =>
  (SUPPLIER_TYPES as readonly string[]).includes(t);

export const NOTIFICATION_TYPES: NotificationType[] = [
  "verify_email", "outbid", "won", "purchased", "payment_reminder", "order_paid",
  "pickup_ready", "pickup_reminder", "no_pickup_cancelled", "unpaid_cancelled",
  "shipped", "refunded", "checked_in", "saved_search_hits", "watchlist_ending",
  "welcome_reminder", "inactive_nudge", "winback_offer", "lost_bid_similar",
  "review_request", "referral_invite",
  "abandoned_bid", "second_purchase", "gift_card_received",
  "password_reset", "points_expiring", "security_alert", "delivered",
  "bid_voided", "lot_withdrawn", "payment_failed",
  ...SUPPLIER_TYPES,
];

/** Типы, которые уходят как МАРКЕТИНГ (через enqueueMarketing): у них в
 *  подвале обязана быть видимая отписка. Сервисные письма отписки не несут —
 *  их отменяют не так (счёт и выдачу отпиской не выключить). Превью в
 *  админке ориентируется на этот же список, чтобы показывать 1:1. */
export const MARKETING_TYPES: ReadonlySet<NotificationType> = new Set([
  "saved_search_hits", "watchlist_ending",
  "welcome_reminder", "inactive_nudge", "winback_offer", "lost_bid_similar",
  "review_request", "referral_invite", "abandoned_bid", "second_purchase",
]);

export interface TemplateInput {
  alias: string;
  lotTitle: string;
  amountCents?: number | undefined;
  orderRef?: string | undefined;
  totalCents?: number | undefined;
  deadline?: Date | undefined;
  pickupCode?: string | undefined;
  feeCents?: number | undefined;
  refundCents?: number | undefined;
  payUrl?: string | null | undefined;
  barcode?: string | undefined;
  machineName?: string | undefined;
  carrier?: string | undefined;
  trackingUrl?: string | undefined;
  /** Invoice breakdown, when the caller has it — shown under the total. */
  hammerCents?: number | undefined;
  premiumCents?: number | undefined;
  vatCents?: number | undefined;
  /** Why the money went back (refunded). */
  reason?: string | undefined;
  /** Queue number handed out at check-in. */
  ticketNumber?: number | undefined;
  /** How many items that ticket bundles. */
  lineCount?: number | undefined;
  /** Ссылка действия письма — подтверждение почты. */
  actionUrl?: string | undefined;
  /** Подборка лотов для писем-списков: новые по сохранённому поиску, лоты
   *  из вэлмес на исходе. Цена — та, что человек видит на витрине. */
  lots?: Array<{ title: string; priceCents: number; endsAt?: Date | undefined }> | undefined;
  /** Имя сохранённого поиска, которому письмо соответствует. */
  searchName?: string | undefined;
  /** Сколько нашлось всего, если в письме показан не весь список. */
  totalCount?: number | undefined;
  /** Промокод (welcome / win-back): сам код, процент и срок действия.
   *  Числа приходят из marketing_settings — в шаблонах их не зашивать. */
  promoCode?: string | undefined;
  promoPercent?: number | undefined;
  promoDeadline?: Date | undefined;
  /** Баллы лояльности: начислено этим заказом и текущий баланс (в центах). */
  pointsEarnedCents?: number | undefined;
  pointsBalanceCents?: number | undefined;
  /** Реферальная программа: личная ссылка и размеры наград (в центах). */
  referralUrl?: string | undefined;
  referralSignupCents?: number | undefined;
  referralOrderCents?: number | undefined;
  referralPercent?: number | undefined;
  /** Человеческое название категории — для писем «похожие лоты». */
  categoryLabel?: string | undefined;

  // ── Письма части A (пробелы покупательской переписки) ──
  /** Сколько часов живёт ссылка сброса пароля. */
  validHours?: number | undefined;
  /** Баллы, которые сгорят, и дата сгорания. */
  expiringCents?: number | undefined;
  expiresAt?: Date | undefined;
  /** Событие безопасности: password_changed | email_changed | new_device. */
  securityEvent?: string | undefined;
  /** Что видно про устройство/место входа — без точного IP в письме. */
  deviceLabel?: string | undefined;
  eventAt?: Date | undefined;
  /** Доставка: посылка выдана на руки или ждёт в автомате N дней. */
  waitingDays?: number | undefined;
  /** Почему платёж не прошёл (человеческим языком, без кодов провайдера). */
  failureReason?: string | undefined;

  // ── Письма поставщикам (S1…S10) ──
  /** Название поставщика и человек, к которому обращаемся. */
  supplierName?: string | undefined;
  /** Ссылка приглашения в кабинет поставщика и срок её жизни (дни). */
  inviteUrl?: string | undefined;
  inviteDays?: number | undefined;
  /** Поставка: наш номер, заявлено/принято/брак. */
  consignmentRef?: string | undefined;
  declaredCount?: number | undefined;
  acceptedCount?: number | undefined;
  rejectedCount?: number | undefined;
  /** Что именно не так и до какого числа ждём ответ. */
  discrepancyNote?: string | undefined;
  replyByDate?: Date | undefined;
  /** Счёт поставщика: его номер, сумма, дата оплаты или причина отказа. */
  invoiceNumber?: string | undefined;
  dueDate?: Date | undefined;
  rejectReason?: string | undefined;
  /** Платёж: что оплачено и с каким референсом. */
  paymentRef?: string | undefined;
  paidAt?: Date | undefined;
  invoiceNumbers?: string[] | undefined;
  /** Период отчёта и его цифры. */
  periodLabel?: string | undefined;
  receivedCount?: number | undefined;
  soldCount?: number | undefined;
  soldGrossCents?: number | undefined;
  sellThroughPercent?: number | undefined;
  /** Комиссионная модель: наша комиссия и сумма к выплате. */
  commissionCents?: number | undefined;
  commissionPercent?: number | undefined;
  payoutCents?: number | undefined;
  /** Непроданный остаток: сколько единиц и до какой даты решить. */
  unsoldCount?: number | undefined;
  decideByDate?: Date | undefined;
  /** Строки отчёта: что продано и за сколько. */
  soldLots?: Array<{ title: string; priceCents: number }> | undefined;
}

/** Links and addresses the copy needs; supplied by config, never hard-coded. */
export interface CopyContext {
  siteUrl: string;
  ordersUrl: string;
  feesUrl: string;
  pickupPassUrl: string;
  pickupAddress: string;
  pickupHours: string;
  /** Which online providers are switched on. The methods line under the
   * button names these and nothing else — an email must not offer a way to
   * pay that the site cannot take. */
  online: { klix: boolean; inbank: boolean };
}

export interface Rendered {
  subject: string;
  text: string;
  spec: EmailSpec;
}

/**
 * Money as the reader writes it: "251,56 €" in Latvian and Russian, "€251.56"
 * in English. Same number, same rounding — `formatEur` stays the single source
 * for that, and this only rearranges what it produced.
 */
function moneyIn(c: number | undefined, lang: Lang): string {
  if (c === undefined) return "";
  const en = formatEur(c); // €1,234.56
  if (lang === "en") return en;
  const negative = en.startsWith("-");
  const digits = en.replace(/^-?€/, "");
  const [whole = "0", frac = "00"] = digits.split(".");
  return `${negative ? "−" : ""}${whole.replace(/,/g, " ")},${frac} €`;
}

/** dd.mm.yyyy — the form every Baltic reader parses without thinking. */
function fmtDate(d: Date | undefined, lang: Lang): string {
  if (!d) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  const s = `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
  return lang === "lv" ? `${s}.` : s;
}

function fmtDateTime(d: Date | undefined, lang: Lang): string {
  if (!d) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${fmtDate(d, lang)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** Shared words. Keeping them in one place is what stops "Pasūtījums" and
 * "Pasūtījuma nr." from drifting apart across eleven templates. */
const W = {
  hi: { lv: "Sveicināti", ru: "Здравствуйте", en: "Hello" },
  orderNo: { lv: "Pasūtījuma numurs:", ru: "Номер заказа:", en: "Order number:" },
  lot: { lv: "Prece:", ru: "Товар:", en: "Lot:" },
  place: { lv: "Izsniegšanas vieta:", ru: "Место выдачи:", en: "Collection point:" },
  status: { lv: "Statuss:", ru: "Статус:", en: "Status:" },
  totalDue: { lv: "Kopējā summa apmaksai:", ru: "Итого к оплате:", en: "Total due:" },
  hammer: { lv: "Āmura cena", ru: "Цена молотка", en: "Hammer price" },
  premium: { lv: "Pircēja komisija", ru: "Комиссия покупателя", en: "Buyer's premium" },
  vat: { lv: "PVN", ru: "НДС", en: "VAT" },
  payBy: { lv: "Samaksāt līdz:", ru: "Оплатить до:", en: "Pay by:" },
  atCounter: {
    lv: "Apmaksa pie letes — skaidrā naudā vai ar karti",
    ru: "Оплата на стойке — наличными или картой",
    en: "Pay at the counter — cash or card",
  },
  follow: { lv: "Seko mums", ru: "Мы в соцсетях", en: "Follow us" },
  review: { lv: "Atstāj atsauksmi", ru: "Оставить отзыв", en: "Leave a review" },
  openOrders: { lv: "Skatīt savus pasūtījumus", ru: "Мои заказы", en: "View your orders" },
  stAwaitingPayment: { lv: "GAIDA APMAKSU", ru: "ОЖИДАЕТ ОПЛАТЫ", en: "AWAITING PAYMENT" },
  stPaid: { lv: "APMAKSĀTS", ru: "ОПЛАЧЕНО", en: "PAID" },
  stReady: { lv: "GATAVS SAŅEMŠANAI", ru: "ГОТОВ К ВЫДАЧЕ", en: "READY FOR COLLECTION" },
  stCancelled: { lv: "ATCELTS", ru: "ОТМЕНЁН", en: "CANCELLED" },
  stShipped: { lv: "CEĻĀ", ru: "В ПУТИ", en: "ON ITS WAY" },
  stRefunded: { lv: "ATMAKSĀTS", ru: "ВОЗВРАТ ВЫПОЛНЕН", en: "REFUNDED" },
  where: { lv: "Kur:", ru: "Где:", en: "Where:" },
  when: { lv: "Darba laiks:", ru: "Часы работы:", en: "Opening hours:" },
  collectBy: { lv: "Izņemt līdz:", ru: "Забрать до:", en: "Collect by:" },
  code: { lv: "SAŅEMŠANAS KODS", ru: "КОД ПОЛУЧЕНИЯ", en: "COLLECTION CODE" },
  codeNote: {
    lv: "Nosauc to pie letes vai ievadi kioskā",
    ru: "Назовите его на стойке или введите в киоске",
    en: "Say it at the desk or type it into the kiosk",
  },
  lateFee: {
    lv: "Ja neapmaksā līdz termiņam:",
    ru: "Если не оплатить до срока:",
    en: "If it is not paid by the deadline:",
  },
  lateFeeText: {
    lv: "pasūtījums tiek atcelts un tiek piemērota 5% uzglabāšanas maksa. Ja vajag vairāk laika — atraksti mums.",
    ru: "заказ будет отменён, и удерживается 5% плата за хранение. Нужно больше времени — напишите нам.",
    en: "the order is cancelled and a 5% restocking fee applies. Need more time? Write to us.",
  },
} as const;

type Phrase = { lv: string; ru: string; en: string };
const w = (p: Phrase, lang: Lang): string => p[lang];

/** Money card lines from the invoice breakdown, when the caller has it. */
function breakdown(i: TemplateInput, lang: Lang): MoneyLine[] | undefined {
  if (i.hammerCents === undefined) return undefined;
  const lines: MoneyLine[] = [{ label: w(W.hammer, lang), value: moneyIn(i.hammerCents, lang) }];
  if (i.premiumCents !== undefined) lines.push({ label: w(W.premium, lang), value: moneyIn(i.premiumCents, lang) });
  if (i.vatCents !== undefined) lines.push({ label: w(W.vat, lang), value: moneyIn(i.vatCents, lang) });
  return lines;
}

function orderFacts(i: TemplateInput, lang: Lang, ctx: CopyContext, status: Phrase, tone: Fact["tone"]): Fact[] {
  const facts: Fact[] = [];
  if (i.orderRef) facts.push({ label: w(W.orderNo, lang), value: i.orderRef });
  facts.push({ label: w(W.lot, lang), value: i.lotTitle });
  facts.push({ label: w(W.place, lang), value: ctx.pickupAddress });
  facts.push({ label: w(W.status, lang), value: w(status, lang), tone });
  return facts;
}

const labelsFor = (lang: Lang) => ({ follow: w(W.follow, lang), review: w(W.review, lang) });


/**
 * The button on a payment-due email. With an online provider on, it is the
 * one-click checkout. With none, it must not say "Pay €X" and then land on a
 * list — it opens the order and the counter takes the money.
 */
function payCta(i: TemplateInput, lang: Lang, ctx: CopyContext): { label: string; url: string } {
  if (i.payUrl) {
    return {
      label: { lv: `Apmaksāt ${moneyIn(i.totalCents, lang)}`, ru: `Оплатить ${moneyIn(i.totalCents, lang)}`, en: `Pay ${moneyIn(i.totalCents, lang)}` }[lang],
      url: i.payUrl,
    };
  }
  return {
    label: { lv: "Skatīt pasūtījumu", ru: "Открыть заказ", en: "View the order" }[lang],
    url: ctx.ordersUrl,
  };
}

/** What the line under the button may honestly promise. */
function methodsLine(lang: Lang, ctx: CopyContext): string {
  const parts: string[] = [];
  if (ctx.online.klix) {
    parts.push({ lv: "banka", ru: "банк", en: "bank" }[lang]);
    parts.push({ lv: "karte", ru: "карта", en: "card" }[lang]);
    parts.push("Klix");
  }
  if (ctx.online.inbank) parts.push("Inbank");
  if (parts.length === 0) return w(W.atCounter, lang);
  return parts.join(" · ");
}


/**
 * Klix representative example placeholder — resolved at dispatch, not here,
 * because enqueue runs inside the caller's transaction and must not make
 * network calls. Present in the text body only; the HTML carries the same
 * information in the payment-methods line.
 */
const plToken = (i: TemplateInput, lang: Lang): string =>
  i.payUrl && i.totalCents ? `{{KLIX_PL_EXAMPLE:${i.totalCents}:${lang}}}` : "";

function payLine(i: TemplateInput, lang: Lang): string {
  if (!i.payUrl) return "";
  const head =
    lang === "lv"
      ? "Apmaksāt tiešsaistē (karte, banklinks, Klix Pay Later):"
      : lang === "ru"
        ? "Оплатить онлайн (карта, банклинк, Klix Pay Later):"
        : "Pay online (card, bank link, Klix Pay Later):";
  return `\n${head}\n${i.payUrl}\n${plToken(i, lang)}`;
}

// ── The eleven messages ──────────────────────────────────────────────────────

export function renderCopy(type: NotificationType, lang: Lang, i: TemplateInput, ctx: CopyContext): Rendered {
  const hi = `${w(W.hi, lang)}, ${i.alias}!`;
  const labels = labelsFor(lang);

  switch (type) {
    // ── Подтверди почту ─────────────────────────────────────────────────────
    case "verify_email": {
      const subject = {
        lv: "Apstiprini savu e-pastu — Izsoli.lv",
        ru: "Подтвердите свою почту — Izsoli.lv",
        en: "Confirm your e-mail — Izsoli.lv",
      }[lang];
      // Приветственный код −N% (IZ-P01): сервисная часть этого же письма,
      // отдельной отправки нет. Появляется, когда движок его выпустил.
      const promo = i.promoCode
        ? {
            lv: `\n\nDāvana pirmajam pirkumam: kods ${i.promoCode} dod −${i.promoPercent ?? 10}% jebkurai precei${i.promoDeadline ? ` līdz ${fmtDate(i.promoDeadline, "lv")}` : ""}.`,
            ru: `\n\nПодарок на первую покупку: код ${i.promoCode} даёт −${i.promoPercent ?? 10}% на любой товар${i.promoDeadline ? ` до ${fmtDate(i.promoDeadline, "ru")}` : ""}.`,
            en: `\n\nA first-purchase gift: code ${i.promoCode} gives ${i.promoPercent ?? 10}% off anything${i.promoDeadline ? ` until ${fmtDate(i.promoDeadline, "en")}` : ""}.`,
          }[lang]
        : "";
      const text = {
        lv: `Sveiki, ${i.alias}!\n\nApstiprini savu e-pastu, lai varētu solīt un pirkt: ${i.actionUrl}\nSaite derīga 24 stundas. Ja kontu neveidoji tu — vienkārši ignorē šo vēstuli.${promo}\n\n[verify_email]`,
        ru: `Здравствуйте, ${i.alias}!\n\nПодтвердите почту, чтобы делать ставки и покупать: ${i.actionUrl}\nСсылка действует 24 часа. Если аккаунт создавали не вы — просто игнорируйте письмо.${promo}\n\n[verify_email]`,
        en: `Hi ${i.alias},\n\nConfirm your e-mail to bid and buy: ${i.actionUrl}\nThe link is valid for 24 hours. If you did not create this account, just ignore this message.${promo}\n\n[verify_email]`,
      }[lang];
      return {
        subject,
        text,
        spec: {
          ...(i.promoCode
            ? {
                code: {
                  label: { lv: "DĀVANA: ATLAIDES KODS", ru: "ПОДАРОК: КОД СКИДКИ", en: "GIFT: DISCOUNT CODE" }[lang],
                  value: i.promoCode,
                  note: {
                    lv: `−${i.promoPercent ?? 10}% pirmajam pirkumam${i.promoDeadline ? ` · līdz ${fmtDate(i.promoDeadline, "lv")}` : ""}`,
                    ru: `−${i.promoPercent ?? 10}% на первую покупку${i.promoDeadline ? ` · до ${fmtDate(i.promoDeadline, "ru")}` : ""}`,
                    en: `${i.promoPercent ?? 10}% off your first purchase${i.promoDeadline ? ` · until ${fmtDate(i.promoDeadline, "en")}` : ""}`,
                  }[lang],
                },
              }
            : {}),
          preheader: { lv: "Saite derīga 24 stundas", ru: "Ссылка действует 24 часа", en: "The link is valid for 24 hours" }[lang],
          headline: { lv: "APSTIPRINI E-PASTU", ru: "ПОДТВЕРДИТЕ ПОЧТУ", en: "CONFIRM YOUR E-MAIL" }[lang],
          headlineTone: "accent",
          greeting: hi,
          intro: {
            lv: "Bez apstiprināta e-pasta solīšana un pirkšana ir slēgta — mēs nevarētu tev atsūtīt ne rēķinu, ne brīdinājumu par pārsolīšanu.",
            ru: "Без подтверждённой почты ставки и покупки закрыты — мы не сможем прислать ни счёт, ни уведомление о перебитой ставке.",
            en: "Bidding and buying stay locked until your e-mail is confirmed — we could not send you an invoice or an outbid alert otherwise.",
          }[lang],
          facts: [],
          cta: {
            label: { lv: "Apstiprināt e-pastu", ru: "Подтвердить почту", en: "Confirm e-mail" }[lang],
            url: i.actionUrl ?? ctx.siteUrl,
          },
          labels,
        },
      };
    }

    // ── Someone bid over you ────────────────────────────────────────────────
    case "outbid": {
      const subject = {
        lv: `Jūsu solījums pārsolīts — ${i.lotTitle}`,
        ru: `Вашу ставку перебили — ${i.lotTitle}`,
        en: `You have been outbid — ${i.lotTitle}`,
      }[lang];
      const text = {
        lv: `Sveiki, ${i.alias}!\n\nJūsu solījums izsolē "${i.lotTitle}" ir pārsolīts. Pašreizējā cena: ${moneyIn(i.amountCents, lang)}.\nJa vēlaties turpināt, paaugstiniet savu maksimālo cenu.\n\n[outbid]`,
        ru: `Здравствуйте, ${i.alias}!\n\nВашу ставку на "${i.lotTitle}" перебили. Текущая цена: ${moneyIn(i.amountCents, lang)}.\nЧтобы остаться в игре, поднимите свою максимальную ставку.\n\n[outbid]`,
        en: `Hi ${i.alias},\n\nYou have been outbid on "${i.lotTitle}". Current price: ${moneyIn(i.amountCents, lang)}.\nRaise your maximum bid if you'd like to stay in.\n\n[outbid]`,
      }[lang];
      return {
        subject,
        text,
        spec: {
          preheader: { lv: `Pašreizējā cena ${moneyIn(i.amountCents, lang)}`, ru: `Текущая цена ${moneyIn(i.amountCents, lang)}`, en: `Current price ${moneyIn(i.amountCents, lang)}` }[lang],
          headline: { lv: "JŪS PĀRSOLĪJA", ru: "ВАШУ СТАВКУ ПЕРЕБИЛИ", en: "YOU HAVE BEEN OUTBID" }[lang],
          headlineTone: "warn",
          greeting: hi,
          intro: {
            lv: `Kāds nosolīja vairāk par preci "${i.lotTitle}". Vēl var paspēt — paaugstini savu maksimālo cenu.`,
            ru: `Кто-то поставил больше за "${i.lotTitle}". Ещё не поздно — поднимите максимальную ставку.`,
            en: `Someone has bid higher on "${i.lotTitle}". There is still time — raise your maximum.`,
          }[lang],
          amount: {
            label: { lv: "Pašreizējā cena:", ru: "Текущая цена:", en: "Current price:" }[lang],
            value: moneyIn(i.amountCents, lang),
          },
          facts: [{ label: w(W.lot, lang), value: i.lotTitle }],
          cta: { label: { lv: "Solīt vēlreiz", ru: "Сделать ставку", en: "Bid again" }[lang], url: ctx.siteUrl },
          labels,
        },
      };
    }

    // ── You won / you bought ────────────────────────────────────────────────
    case "won":
    case "purchased": {
      const isWon = type === "won";
      const subject = isWon
        ? { lv: `Apsveicam — jūs uzvarējāt izsolē ${i.lotTitle}`, ru: `Поздравляем — вы выиграли ${i.lotTitle}`, en: `Congratulations — you won ${i.lotTitle}` }[lang]
        : { lv: `Pirkums apstiprināts — ${i.lotTitle}`, ru: `Покупка подтверждена — ${i.lotTitle}`, en: `Purchase confirmed — ${i.lotTitle}` }[lang];
      const textLv = isWon
        ? `Sveiki, ${i.alias}!\n\nJūs uzvarējāt izsolē "${i.lotTitle}". Rēķina numurs: ${i.orderRef}. Kopā apmaksai: ${moneyIn(i.totalCents, "lv")}.\nLūdzu, apmaksājiet līdz ${fmtDate(i.deadline, "lv")}.\n${payLine(i, "lv")}\n[${type}]`
        : `Sveiki, ${i.alias}!\n\nPaldies par pirkumu "${i.lotTitle}". Rēķina numurs: ${i.orderRef}. Kopā apmaksai: ${moneyIn(i.totalCents, "lv")}.\nLūdzu, apmaksājiet līdz ${fmtDate(i.deadline, "lv")}.\n${payLine(i, "lv")}\n[${type}]`;
      const textRu = isWon
        ? `Здравствуйте, ${i.alias}!\n\nВы выиграли торги за "${i.lotTitle}". Номер счёта: ${i.orderRef}. Итого к оплате: ${moneyIn(i.totalCents, "ru")}.\nПожалуйста, оплатите до ${fmtDate(i.deadline, "ru")}.\n${payLine(i, "ru")}\n[${type}]`
        : `Здравствуйте, ${i.alias}!\n\nСпасибо за покупку "${i.lotTitle}". Номер счёта: ${i.orderRef}. Итого к оплате: ${moneyIn(i.totalCents, "ru")}.\nПожалуйста, оплатите до ${fmtDate(i.deadline, "ru")}.\n${payLine(i, "ru")}\n[${type}]`;
      const textEn = isWon
        ? `Hi ${i.alias},\n\nYou won "${i.lotTitle}". Order ${i.orderRef}. Total due: ${moneyIn(i.totalCents, "en")}.\nPlease pay by ${fmtDate(i.deadline, "en")}.\n${payLine(i, "en")}\n[${type}]`
        : `Hi ${i.alias},\n\nThank you for buying "${i.lotTitle}". Order ${i.orderRef}. Total due: ${moneyIn(i.totalCents, "en")}.\nPlease pay by ${fmtDate(i.deadline, "en")}.\n${payLine(i, "en")}\n[${type}]`;
      return {
        subject,
        text: { lv: textLv, ru: textRu, en: textEn }[lang],
        spec: {
          preheader: `${w(W.totalDue, lang)} ${moneyIn(i.totalCents, lang)} · ${w(W.payBy, lang)} ${fmtDate(i.deadline, lang)}`,
          headline: isWon
            ? { lv: "APSVEICAM AR UZVARU!", ru: "ПОЗДРАВЛЯЕМ С ПОБЕДОЙ!", en: "CONGRATULATIONS — YOU WON!" }[lang]
            : { lv: "PALDIES PAR PIRKUMU!", ru: "СПАСИБО ЗА ПОКУПКУ!", en: "THANK YOU FOR YOUR PURCHASE!" }[lang],
          greeting: hi,
          intro: isWon
            ? {
                lv: `Solīšana ir noslēgusies, un augstākais solījums bija jūsējais. Nosūtām rēķinu apmaksai.`,
                ru: `Торги завершены, и высшая ставка была вашей. Отправляем счёт на оплату.`,
                en: `Bidding has closed and the highest bid was yours. Here is the invoice.`,
              }[lang]
            : {
                lv: `Prece "${i.lotTitle}" ir rezervēta jums. Atliek to apmaksāt.`,
                ru: `Товар "${i.lotTitle}" зарезервирован за вами. Осталось оплатить.`,
                en: `"${i.lotTitle}" is reserved for you. All that is left is payment.`,
              }[lang],
          amount: { label: w(W.totalDue, lang), value: moneyIn(i.totalCents, lang), lines: breakdown(i, lang) },
          facts: orderFacts(i, lang, ctx, W.stAwaitingPayment, "accent"),
          cta: payCta(i, lang, ctx),
          ctaNote: `${w(W.payBy, lang)} ${fmtDate(i.deadline, lang)}`,
          ctaSubnote: methodsLine(lang, ctx),
          notes: [
            { title: w(W.lateFee, lang), text: w(W.lateFeeText, lang) },
            {
              title: { lv: "Pēc apmaksas:", ru: "После оплаты:", en: "After payment:" }[lang],
              text: {
                lv: `atsūtīsim saņemšanas kodu. Preci var izņemt ${ctx.pickupAddress} (${ctx.pickupHours}) vai pasūtīt piegādi uz pakomātu.`,
                ru: `мы пришлём код получения. Забрать можно ${ctx.pickupAddress} (${ctx.pickupHours}) или заказать доставку в посылочный автомат.`,
                en: `we send a collection code. Collect at ${ctx.pickupAddress} (${ctx.pickupHours}) or ask for parcel delivery.`,
              }[lang],
            },
          ],
          footNote: i.orderRef,
          labels,
        },
      };
    }

    // ── Still not paid ──────────────────────────────────────────────────────
    case "payment_reminder": {
      return {
        subject: { lv: `Atgādinājums par apmaksu — ${i.orderRef}`, ru: `Напоминание об оплате — ${i.orderRef}`, en: `Payment reminder — ${i.orderRef}` }[lang],
        text: {
          lv: `Sveiki, ${i.alias}!\n\nRēķins ${i.orderRef} (${moneyIn(i.totalCents, lang)}) vēl nav apmaksāts. Termiņš: ${fmtDateTime(i.deadline, "lv")}.\nNeapmaksāšanas gadījumā pasūtījums tiks atcelts.\n${payLine(i, "lv")}\n[payment_reminder]`,
          ru: `Здравствуйте, ${i.alias}!\n\nСчёт ${i.orderRef} (${moneyIn(i.totalCents, lang)}) ещё не оплачен. Срок: ${fmtDateTime(i.deadline, "ru")}.\nПри неоплате заказ будет отменён.\n${payLine(i, "ru")}\n[payment_reminder]`,
          en: `Hi ${i.alias},\n\nOrder ${i.orderRef} (${moneyIn(i.totalCents, lang)}) is not yet paid. Deadline: ${fmtDateTime(i.deadline, "en")}.\nIf unpaid, the order will be cancelled.\n${payLine(i, "en")}\n[payment_reminder]`,
        }[lang],
        spec: {
          preheader: `${moneyIn(i.totalCents, lang)} · ${w(W.payBy, lang)} ${fmtDateTime(i.deadline, lang)}`,
          headline: { lv: "RĒĶINS VĒL NAV APMAKSĀTS", ru: "СЧЁТ ЕЩЁ НЕ ОПЛАЧЕН", en: "YOUR INVOICE IS STILL OPEN" }[lang],
          headlineTone: "warn",
          greeting: hi,
          intro: {
            lv: `Atgādinām par rēķinu ${i.orderRef}. Prece ir nolikta malā un gaida jūs.`,
            ru: `Напоминаем о счёте ${i.orderRef}. Товар отложен и ждёт вас.`,
            en: `A reminder about order ${i.orderRef}. The lot is set aside and waiting for you.`,
          }[lang],
          amount: { label: w(W.totalDue, lang), value: moneyIn(i.totalCents, lang), lines: breakdown(i, lang) },
          facts: orderFacts(i, lang, ctx, W.stAwaitingPayment, "warn"),
          cta: payCta(i, lang, ctx),
          ctaNote: `${w(W.payBy, lang)} ${fmtDateTime(i.deadline, lang)}`,
          ctaSubnote: methodsLine(lang, ctx),
          notes: [{ title: w(W.lateFee, lang), text: w(W.lateFeeText, lang), tone: "danger" }],
          footNote: i.orderRef,
          labels,
        },
      };
    }

    // ── Money arrived ───────────────────────────────────────────────────────
    case "order_paid": {
      // Баллы лояльности (IZ-P06): транзакционный абзац в письме об оплате —
      // первый момент, когда система баллов становится осязаемой (MD §5a.3).
      const pts = i.pointsEarnedCents
        ? {
            lv: `\n\nPar šo pirkumu tev ieskaitīti ${moneyIn(i.pointsEarnedCents, "lv")} punktos (kopā: ${moneyIn(i.pointsBalanceCents ?? i.pointsEarnedCents, "lv")}). 1 punkts = 1 € atlaide nākamajam pirkumam: ${ctx.siteUrl}/punkti`,
            ru: `\n\nЗа эту покупку вам начислено ${moneyIn(i.pointsEarnedCents, "ru")} баллами (всего: ${moneyIn(i.pointsBalanceCents ?? i.pointsEarnedCents, "ru")}). 1 балл = скидка 1 € на следующую покупку: ${ctx.siteUrl}/punkti`,
            en: `\n\nThis purchase earned you ${moneyIn(i.pointsEarnedCents, "en")} in points (balance: ${moneyIn(i.pointsBalanceCents ?? i.pointsEarnedCents, "en")}). 1 point = €1 off a future order: ${ctx.siteUrl}/punkti`,
          }[lang]
        : "";
      return {
        subject: { lv: `Apmaksa saņemta — ${i.orderRef}`, ru: `Оплата получена — ${i.orderRef}`, en: `Payment received — ${i.orderRef}` }[lang],
        text: {
          lv: `Sveiki, ${i.alias}!\n\nMēs saņēmām apmaksu par pasūtījumu ${i.orderRef} (${moneyIn(i.totalCents, lang)}). Paldies!${pts}\n\n[order_paid]`,
          ru: `Здравствуйте, ${i.alias}!\n\nМы получили оплату по заказу ${i.orderRef} (${moneyIn(i.totalCents, lang)}). Спасибо!${pts}\n\n[order_paid]`,
          en: `Hi ${i.alias},\n\nWe received payment for order ${i.orderRef} (${moneyIn(i.totalCents, lang)}). Thank you!${pts}\n\n[order_paid]`,
        }[lang],
        spec: {
          preheader: { lv: `${moneyIn(i.totalCents, lang)} saņemti · paldies!`, ru: `${moneyIn(i.totalCents, lang)} получены · спасибо!`, en: `${moneyIn(i.totalCents, lang)} received · thank you!` }[lang],
          headline: { lv: "APMAKSA SAŅEMTA", ru: "ОПЛАТА ПОЛУЧЕНА", en: "PAYMENT RECEIVED" }[lang],
          headlineTone: "ok",
          greeting: hi,
          intro: {
            lv: `Paldies! Nauda par pasūtījumu ${i.orderRef} ir saņemta. Sagatavojam preci izsniegšanai.`,
            ru: `Спасибо! Оплата по заказу ${i.orderRef} получена. Готовим товар к выдаче.`,
            en: `Thank you. Payment for order ${i.orderRef} has arrived. We are preparing the lot.`,
          }[lang],
          amount: { label: { lv: "Apmaksāts:", ru: "Оплачено:", en: "Paid:" }[lang], value: moneyIn(i.totalCents, lang) },
          facts: orderFacts(i, lang, ctx, W.stPaid, "ok"),
          cta: { label: w(W.openOrders, lang), url: ctx.ordersUrl },
          notes: [
            {
              title: { lv: "Kas tālāk:", ru: "Что дальше:", en: "What happens next:" }[lang],
              text: {
                lv: "atsevišķā vēstulē atsūtīsim saņemšanas kodu, tiklīdz prece būs plauktā gatava.",
                ru: "отдельным письмом пришлём код получения, как только товар будет готов к выдаче.",
                en: "we will send the collection code in a separate email as soon as the lot is ready.",
              }[lang],
            },
            ...(i.pointsEarnedCents
              ? [{
                  title: { lv: "Tavi punkti:", ru: "Ваши баллы:", en: "Your points:" }[lang],
                  text: {
                    lv: `par šo pirkumu ieskaitīti ${moneyIn(i.pointsEarnedCents, "lv")} punktos (kopā ${moneyIn(i.pointsBalanceCents ?? i.pointsEarnedCents, "lv")}). 1 punkts = 1 € atlaide nākamajam pirkumam.`,
                    ru: `за эту покупку начислено ${moneyIn(i.pointsEarnedCents, "ru")} баллами (всего ${moneyIn(i.pointsBalanceCents ?? i.pointsEarnedCents, "ru")}). 1 балл = скидка 1 € на следующую покупку.`,
                    en: `this purchase earned ${moneyIn(i.pointsEarnedCents, "en")} in points (balance ${moneyIn(i.pointsBalanceCents ?? i.pointsEarnedCents, "en")}). 1 point = €1 off a future order.`,
                  }[lang],
                  tone: "ok" as const,
                }]
              : []),
          ],
          footNote: i.orderRef,
          labels,
        },
      };
    }

    // ── Come and get it ─────────────────────────────────────────────────────
    case "pickup_ready":
    case "pickup_reminder": {
      const isReminder = type === "pickup_reminder";
      return {
        subject: isReminder
          ? { lv: `Atgādinājums: saņemiet pasūtījumu ${i.orderRef}`, ru: `Напоминание: заберите заказ ${i.orderRef}`, en: `Reminder: collect order ${i.orderRef}` }[lang]
          : { lv: `Gatavs saņemšanai — ${i.orderRef}`, ru: `Готов к получению — ${i.orderRef}`, en: `Ready for pickup — ${i.orderRef}` }[lang],
        text: {
          lv: isReminder
            ? `Sveiki, ${i.alias}!\n\nPasūtījums ${i.orderRef} joprojām gaida noliktavā. Saņemšanas kods: ${i.pickupCode}.\nTermiņš: ${fmtDate(i.deadline, "lv")}. Pēc termiņa pasūtījums tiek atcelts ar 5% uzglabāšanas maksu.\n\n[pickup_reminder]`
            : `Sveiki, ${i.alias}!\n\nPasūtījums ${i.orderRef} ir gatavs saņemšanai noliktavā. Saņemšanas kods: ${i.pickupCode}.\nLūdzu, izņemiet līdz ${fmtDate(i.deadline, "lv")} — pēc termiņa pasūtījums tiek atcelts ar 5% uzglabāšanas maksu.\n\n[pickup_ready]`,
          ru: isReminder
            ? `Здравствуйте, ${i.alias}!\n\nЗаказ ${i.orderRef} всё ещё ждёт на складе. Код получения: ${i.pickupCode}.\nСрок: ${fmtDate(i.deadline, "ru")}. После срока заказ отменяется с удержанием 5% за хранение.\n\n[pickup_reminder]`
            : `Здравствуйте, ${i.alias}!\n\nЗаказ ${i.orderRef} готов к получению на складе. Код получения: ${i.pickupCode}.\nЗаберите до ${fmtDate(i.deadline, "ru")} — после срока заказ отменяется с удержанием 5% за хранение.\n\n[pickup_ready]`,
          en: isReminder
            ? `Hi ${i.alias},\n\nOrder ${i.orderRef} is still waiting at the warehouse. Pickup code: ${i.pickupCode}.\nDeadline: ${fmtDate(i.deadline, "en")}. After the deadline the order is cancelled with a 5% restocking fee.\n\n[pickup_reminder]`
            : `Hi ${i.alias},\n\nOrder ${i.orderRef} is ready for collection at the warehouse. Pickup code: ${i.pickupCode}.\nPlease collect by ${fmtDate(i.deadline, "en")} — after the deadline the order is cancelled with a 5% restocking fee.\n\n[pickup_ready]`,
        }[lang],
        spec: {
          preheader: `${w(W.code, lang)} ${i.pickupCode ?? ""} · ${w(W.collectBy, lang)} ${fmtDate(i.deadline, lang)}`,
          headline: isReminder
            ? { lv: "PRECE VĒL GAIDA JŪS", ru: "ТОВАР ВСЁ ЕЩЁ ЖДЁТ", en: "YOUR LOT IS STILL WAITING" }[lang]
            : { lv: "PRECE GAIDA JŪS!", ru: "ТОВАР ЖДЁТ ВАС!", en: "YOUR LOT IS READY!" }[lang],
          headlineTone: isReminder ? "warn" : "ok",
          greeting: hi,
          intro: isReminder
            ? {
                lv: `Pasūtījums ${i.orderRef} joprojām stāv plauktā uz jūsu vārda. Atgādinām par termiņu.`,
                ru: `Заказ ${i.orderRef} по-прежнему лежит на полке на ваше имя. Напоминаем о сроке.`,
                en: `Order ${i.orderRef} is still on the shelf under your name. A reminder about the deadline.`,
              }[lang]
            : {
                lv: `Apmaksa saņemta — "${i.lotTitle}" ir nolikta plauktā uz jūsu vārda.`,
                ru: `Оплата получена — "${i.lotTitle}" отложен на ваше имя.`,
                en: `Payment received — "${i.lotTitle}" is set aside under your name.`,
              }[lang],
          code: { label: w(W.code, lang), value: i.pickupCode ?? "", note: w(W.codeNote, lang) },
          facts: [
            ...(i.orderRef ? [{ label: w(W.orderNo, lang), value: i.orderRef }] : []),
            { label: w(W.where, lang), value: ctx.pickupAddress },
            { label: w(W.when, lang), value: ctx.pickupHours },
            { label: w(W.collectBy, lang), value: fmtDate(i.deadline, lang) },
            { label: w(W.status, lang), value: w(W.stReady, lang), tone: isReminder ? "warn" : "ok" },
          ],
          cta: {
            label: { lv: "Atvērt caurlaidi telefonā", ru: "Открыть пропуск в телефоне", en: "Open your pass on your phone" }[lang],
            url: ctx.pickupPassUrl,
          },
          ctaSubnote: {
            lv: "Vai atraksti mums, ja labāk piegādi uz pakomātu.",
            ru: "Или напишите нам, если удобнее доставка в посылочный автомат.",
            en: "Or write to us if parcel delivery suits you better.",
          }[lang],
          notes: [
            {
              title: { lv: "Pēc termiņa:", ru: "После срока:", en: "After the deadline:" }[lang],
              text: {
                lv: "neizņemts pasūtījums tiek atcelts, tiek ieturēta 5% uzglabāšanas maksa, bet pārējais tiek atmaksāts.",
                ru: "неполученный заказ отменяется, удерживается 5% за хранение, остальное возвращается.",
                en: "an uncollected order is cancelled, a 5% restocking fee is kept and the rest is refunded.",
              }[lang],
            },
          ],
          footNote: i.orderRef,
          labels,
        },
      };
    }

    // ── Cancelled: never paid ───────────────────────────────────────────────
    case "unpaid_cancelled": {
      return {
        subject: { lv: `Pasūtījums atcelts (nav apmaksāts) — ${i.orderRef}`, ru: `Заказ отменён (не оплачен) — ${i.orderRef}`, en: `Order cancelled (not paid) — ${i.orderRef}` }[lang],
        text: {
          lv: `Sveiki, ${i.alias}!\n\nPasūtījums ${i.orderRef} netika apmaksāts līdz termiņam un ir atcelts. Saskaņā ar noteikumiem tiek piemērota 5% uzglabāšanas maksa: ${moneyIn(i.feeCents, lang)}.\nKamēr maksa nav nokārtota, solīšana un pirkšana jūsu kontā ir apturēta.\n\n[unpaid_cancelled]`,
          ru: `Здравствуйте, ${i.alias}!\n\nЗаказ ${i.orderRef} не был оплачен в срок и отменён. Согласно правилам удерживается 5% плата за хранение: ${moneyIn(i.feeCents, lang)}.\nПока она не погашена, ставки и покупки в вашем аккаунте приостановлены.\n\n[unpaid_cancelled]`,
          en: `Hi ${i.alias},\n\nOrder ${i.orderRef} was not paid by the deadline and has been cancelled. Per our terms a 5% restocking fee applies: ${moneyIn(i.feeCents, lang)}.\nBidding and buying on your account are paused until the fee is settled.\n\n[unpaid_cancelled]`,
        }[lang],
        spec: {
          preheader: { lv: `Uzglabāšanas maksa ${moneyIn(i.feeCents, lang)}`, ru: `Плата за хранение ${moneyIn(i.feeCents, lang)}`, en: `Restocking fee ${moneyIn(i.feeCents, lang)}` }[lang],
          headline: { lv: "PASŪTĪJUMS ATCELTS", ru: "ЗАКАЗ ОТМЕНЁН", en: "ORDER CANCELLED" }[lang],
          headlineTone: "danger",
          greeting: hi,
          intro: {
            lv: `Rēķins ${i.orderRef} netika apmaksāts līdz termiņam, tāpēc pasūtījums ir atcelts un prece atgriezta pārdošanā.`,
            ru: `Счёт ${i.orderRef} не был оплачен в срок, поэтому заказ отменён, а товар вернулся в продажу.`,
            en: `Order ${i.orderRef} was not paid by the deadline, so it has been cancelled and the lot returned to sale.`,
          }[lang],
          amount: {
            label: { lv: "Uzglabāšanas maksa (5%):", ru: "Плата за хранение (5%):", en: "Restocking fee (5%):" }[lang],
            value: moneyIn(i.feeCents, lang),
          },
          facts: orderFacts(i, lang, ctx, W.stCancelled, "danger"),
          cta: {
            label: { lv: `Nokārtot ${moneyIn(i.feeCents, lang)}`, ru: `Погасить ${moneyIn(i.feeCents, lang)}`, en: `Settle ${moneyIn(i.feeCents, lang)}` }[lang],
            url: ctx.feesUrl,
          },
          ctaSubnote: {
            lv: "Kamēr maksa nav nokārtota, solīšana kontā ir apturēta.",
            ru: "Пока плата не погашена, ставки в аккаунте приостановлены.",
            en: "Bidding on your account is paused until the fee is settled.",
          }[lang],
          notes: [
            {
              title: { lv: "Ja notikusi kļūda:", ru: "Если это ошибка:", en: "If this is a mistake:" }[lang],
              text: {
                lv: "atraksti mums, un pārskatīsim — cilvēks atbildēs, ne robots.",
                ru: "напишите нам, и мы разберёмся — ответит человек, а не робот.",
                en: "write to us and we will look again — a person answers, not a robot.",
              }[lang],
            },
          ],
          footNote: i.orderRef,
          labels,
        },
      };
    }

    // ── Cancelled: never collected ──────────────────────────────────────────
    case "no_pickup_cancelled": {
      return {
        subject: { lv: `Pasūtījums atcelts (nav izņemts) — ${i.orderRef}`, ru: `Заказ отменён (не получен) — ${i.orderRef}`, en: `Order cancelled (not collected) — ${i.orderRef}` }[lang],
        text: {
          lv: `Sveiki, ${i.alias}!\n\nPasūtījums ${i.orderRef} netika izņemts līdz termiņam un ir atcelts. Uzglabāšanas maksa: ${moneyIn(i.feeCents, lang)}. Atmaksa: ${moneyIn(i.refundCents, lang)}.\nAtmaksa tiks veikta uz jūsu maksājuma līdzekli.\n\n[no_pickup_cancelled]`,
          ru: `Здравствуйте, ${i.alias}!\n\nЗаказ ${i.orderRef} не был получен в срок и отменён. Плата за хранение: ${moneyIn(i.feeCents, lang)}. Возврат: ${moneyIn(i.refundCents, lang)}.\nВозврат придёт на ваш способ оплаты.\n\n[no_pickup_cancelled]`,
          en: `Hi ${i.alias},\n\nOrder ${i.orderRef} was not collected by the deadline and has been cancelled. Restocking fee: ${moneyIn(i.feeCents, lang)}. Refund: ${moneyIn(i.refundCents, lang)}.\nThe refund will be returned to your payment method.\n\n[no_pickup_cancelled]`,
        }[lang],
        spec: {
          preheader: { lv: `Atmaksa ${moneyIn(i.refundCents, lang)}`, ru: `Возврат ${moneyIn(i.refundCents, lang)}`, en: `Refund ${moneyIn(i.refundCents, lang)}` }[lang],
          headline: { lv: "PASŪTĪJUMS ATCELTS", ru: "ЗАКАЗ ОТМЕНЁН", en: "ORDER CANCELLED" }[lang],
          headlineTone: "danger",
          greeting: hi,
          intro: {
            lv: `Pasūtījums ${i.orderRef} netika izņemts līdz termiņam. Prece atgriezta pārdošanā, un naudu sūtām atpakaļ.`,
            ru: `Заказ ${i.orderRef} не был получен в срок. Товар вернулся в продажу, а деньги отправляем обратно.`,
            en: `Order ${i.orderRef} was not collected in time. The lot is back on sale and the money is on its way to you.`,
          }[lang],
          amount: {
            label: { lv: "Atmaksājam:", ru: "Возвращаем:", en: "Refunding:" }[lang],
            value: moneyIn(i.refundCents, lang),
            lines: [
              {
                label: { lv: "Uzglabāšanas maksa (5%)", ru: "Плата за хранение (5%)", en: "Restocking fee (5%)" }[lang],
                value: `− ${moneyIn(i.feeCents, lang)}`,
              },
            ],
          },
          facts: orderFacts(i, lang, ctx, W.stCancelled, "danger"),
          cta: { label: w(W.openOrders, lang), url: ctx.ordersUrl },
          ctaSubnote: {
            lv: "Atmaksa nonāk atpakaļ uz to pašu maksājuma līdzekli 3–5 darba dienu laikā.",
            ru: "Возврат придёт тем же способом оплаты в течение 3–5 рабочих дней.",
            en: "The refund returns to the same payment method within 3–5 working days.",
          }[lang],
          footNote: i.orderRef,
          labels,
        },
      };
    }

    // ── On its way ──────────────────────────────────────────────────────────
    case "shipped": {
      const carrier = i.carrier ?? "Omniva";
      return {
        subject: { lv: `Sūtījums ceļā — ${i.orderRef}`, ru: `Посылка в пути — ${i.orderRef}`, en: `Your parcel is on its way — ${i.orderRef}` }[lang],
        text: {
          lv: `Sveiki, ${i.alias}!\n\nPasūtījums ${i.orderRef} ir nodots ${carrier} un ceļā uz pakomātu "${i.machineName}".\nSūtījuma numurs: ${i.barcode}\nSekot sūtījumam: ${i.trackingUrl}\n\nKad paka būs pakomātā, ${carrier} nosūtīs SMS ar durvju kodu.\n\n[shipped]`,
          ru: `Здравствуйте, ${i.alias}!\n\nЗаказ ${i.orderRef} передан ${carrier} и едет в автомат "${i.machineName}".\nНомер отправления: ${i.barcode}\nОтследить: ${i.trackingUrl}\n\nКогда посылка будет на месте, ${carrier} пришлёт SMS с кодом дверцы.\n\n[shipped]`,
          en: `Hi ${i.alias},\n\nOrder ${i.orderRef} has been handed to ${carrier} and is on its way to the "${i.machineName}" locker.\nTracking number: ${i.barcode}\nTrack it here: ${i.trackingUrl}\n\n${carrier} will text you a door code when the parcel arrives.\n\n[shipped]`,
        }[lang],
        spec: {
          preheader: { lv: `${carrier} · ${i.machineName ?? ""}`, ru: `${carrier} · ${i.machineName ?? ""}`, en: `${carrier} · ${i.machineName ?? ""}` }[lang],
          headline: { lv: "SŪTĪJUMS CEĻĀ", ru: "ПОСЫЛКА В ПУТИ", en: "YOUR PARCEL IS ON ITS WAY" }[lang],
          headlineTone: "ok",
          greeting: hi,
          intro: {
            lv: `Pasūtījums ${i.orderRef} ir nodots ${carrier}. Kad paka būs pakomātā, saņemsi SMS ar durvju kodu.`,
            ru: `Заказ ${i.orderRef} передан ${carrier}. Когда посылка будет в автомате, придёт SMS с кодом дверцы.`,
            en: `Order ${i.orderRef} has been handed to ${carrier}. You will get a text with the door code when it arrives.`,
          }[lang],
          facts: [
            ...(i.orderRef ? [{ label: w(W.orderNo, lang), value: i.orderRef }] : []),
            { label: w(W.lot, lang), value: i.lotTitle },
            { label: { lv: "Pakomāts:", ru: "Автомат:", en: "Locker:" }[lang], value: i.machineName ?? "" },
            { label: { lv: "Sūtījuma numurs:", ru: "Номер отправления:", en: "Tracking number:" }[lang], value: i.barcode ?? "" },
            { label: w(W.status, lang), value: w(W.stShipped, lang), tone: "ok" },
          ],
          cta: i.trackingUrl
            ? { label: { lv: "Sekot sūtījumam", ru: "Отследить посылку", en: "Track the parcel" }[lang], url: i.trackingUrl }
            : undefined,
          footNote: i.orderRef,
          labels,
        },
      };
    }

    // ── Standing at the counter, waiting to be called ───────────────────────
    case "checked_in": {
      const n = String(i.ticketNumber ?? "");
      const units = i.lineCount ?? 0;
      return {
        subject: { lv: `Jūsu numurs ir ${n}`, ru: `Ваш номер — ${n}`, en: `Your number is ${n}` }[lang],
        text: {
          lv: `Sveiki, ${i.alias}!\n\nJūs esat reģistrēts. Jūsu numurs ir ${n}.\nSekojiet tam uz ekrāna zālē — kad blakus numuram parādās "IZSNIEDZ", nāciet pie letes.\nSagatavojam ${units} preci(-es).\n\n[checked_in]`,
          ru: `Здравствуйте, ${i.alias}!\n\nВы зарегистрированы. Ваш номер — ${n}.\nСледите за ним на экране в зале — когда рядом появится "ВЫДАЁМ", подходите к стойке.\nГотовим ${units} товар(-ов).\n\n[checked_in]`,
          en: `Hi ${i.alias},\n\nYou are checked in. Your number is ${n}.\nWatch for it on the screen — when it says "COLLECTING", come to the counter.\nWe are preparing ${units} item(s).\n\n[checked_in]`,
        }[lang],
        spec: {
          preheader: { lv: `Numurs ${n} · sekojiet ekrānam`, ru: `Номер ${n} · следите за экраном`, en: `Number ${n} · watch the screen` }[lang],
          headline: { lv: "JŪS ESAT RINDĀ", ru: "ВЫ В ОЧЕРЕДИ", en: "YOU ARE IN THE QUEUE" }[lang],
          headlineTone: "accent",
          greeting: hi,
          intro: {
            lv: `Reģistrācija veiksmīga. Zemāk ir jūsu numurs — tas pats, kas parādīsies uz ekrāna zālē.`,
            ru: `Регистрация выполнена. Ниже ваш номер — тот самый, что появится на экране в зале.`,
            en: `You are checked in. Below is your number — the same one that appears on the screen.`,
          }[lang],
          code: {
            label: { lv: "JŪSU NUMURS", ru: "ВАШ НОМЕР", en: "YOUR NUMBER" }[lang],
            value: n,
            note: {
              lv: "Kad blakus parādās «IZSNIEDZ» — nāciet pie letes",
              ru: "Когда рядом появится «ВЫДАЁМ» — подходите к стойке",
              en: "When it says “COLLECTING”, come to the counter",
            }[lang],
          },
          facts: [
            { label: { lv: "Sagatavojam:", ru: "Готовим:", en: "Preparing:" }[lang], value: String(units) },
            { label: w(W.where, lang), value: ctx.pickupAddress },
          ],
          notes: [
            {
              title: { lv: "Ja jāaiziet:", ru: "Если нужно уйти:", en: "If you have to leave:" }[lang],
              text: {
                lv: "pasakiet darbiniekam — prece paliek plauktā uz jūsu vārda, un varēsiet atnākt citu dienu.",
                ru: "скажите сотруднику — товар останется на полке на ваше имя, придёте в другой день.",
                en: "tell a member of staff — the lot stays on the shelf under your name for another day.",
              }[lang],
            },
          ],
          labels,
        },
      };
    }

    // ── Money going back ────────────────────────────────────────────────────
    case "refunded": {
      return {
        subject: { lv: `Atmaksa veikta — ${i.orderRef}`, ru: `Возврат выполнен — ${i.orderRef}`, en: `Refund issued — ${i.orderRef}` }[lang],
        text: {
          lv: `Sveiki, ${i.alias}!\n\nPar pasūtījumu ${i.orderRef} ir veikta atmaksa: ${moneyIn(i.refundCents, lang)}.\nIemesls: ${i.reason ?? ""}\nNauda atgriezīsies uz to pašu maksājuma līdzekli 3–5 darba dienu laikā.\n\n[refunded]`,
          ru: `Здравствуйте, ${i.alias}!\n\nПо заказу ${i.orderRef} выполнен возврат: ${moneyIn(i.refundCents, lang)}.\nПричина: ${i.reason ?? ""}\nДеньги вернутся тем же способом оплаты в течение 3–5 рабочих дней.\n\n[refunded]`,
          en: `Hi ${i.alias},\n\nA refund of ${moneyIn(i.refundCents, lang)} has been issued for order ${i.orderRef}.\nReason: ${i.reason ?? ""}\nThe money returns to the same payment method within 3–5 working days.\n\n[refunded]`,
        }[lang],
        spec: {
          preheader: { lv: `Atmaksa ${moneyIn(i.refundCents, lang)}`, ru: `Возврат ${moneyIn(i.refundCents, lang)}`, en: `Refund ${moneyIn(i.refundCents, lang)}` }[lang],
          headline: { lv: "ATMAKSA VEIKTA", ru: "ВОЗВРАТ ВЫПОЛНЕН", en: "REFUND ISSUED" }[lang],
          headlineTone: "ok",
          greeting: hi,
          intro: {
            lv: `Par pasūtījumu ${i.orderRef} nauda ir ceļā atpakaļ pie jums.`,
            ru: `По заказу ${i.orderRef} деньги уже идут обратно к вам.`,
            en: `The money for order ${i.orderRef} is on its way back to you.`,
          }[lang],
          amount: { label: { lv: "Atmaksāts:", ru: "Возвращено:", en: "Refunded:" }[lang], value: moneyIn(i.refundCents, lang) },
          facts: [
            ...(i.orderRef ? [{ label: w(W.orderNo, lang), value: i.orderRef }] : []),
            { label: w(W.lot, lang), value: i.lotTitle },
            ...(i.reason ? [{ label: { lv: "Iemesls:", ru: "Причина:", en: "Reason:" }[lang], value: i.reason }] : []),
            { label: w(W.status, lang), value: w(W.stRefunded, lang), tone: "ok" as const },
          ],
          cta: { label: w(W.openOrders, lang), url: ctx.ordersUrl },
          ctaSubnote: {
            lv: "Nauda atgriežas uz to pašu maksājuma līdzekli 3–5 darba dienu laikā.",
            ru: "Деньги вернутся тем же способом оплаты в течение 3–5 рабочих дней.",
            en: "The money returns to the same payment method within 3–5 working days.",
          }[lang],
          footNote: i.orderRef,
          labels,
        },
      };
    }

    // ── Marketing: new lots matching a saved search (LC-02) ─────────────────
    case "saved_search_hits": {
      const lots = i.lots ?? [];
      const total = i.totalCount ?? lots.length;
      const name = i.searchName ?? "";
      const listText = lots
        .map((l) => `• ${l.title} — ${moneyIn(l.priceCents, lang)}`)
        .join("\n");
      const more = total > lots.length
        ? { lv: `\n…un vēl ${total - lots.length} loti.`, ru: `\n…и ещё ${total - lots.length} лотов.`, en: `\n…and ${total - lots.length} more lots.` }[lang]
        : "";
      return {
        subject: {
          lv: `Jauni loti: ${name} (${total})`,
          ru: `Новые лоты: ${name} (${total})`,
          en: `New lots: ${name} (${total})`,
        }[lang],
        text: {
          lv: `Sveiki, ${i.alias}!\n\nPēc jūsu saglabātā meklējuma «${name}» ir parādījušies jauni loti:\n\n${listText}${more}\n\nSkatīt visus: ${ctx.siteUrl}/meklet\n\n[saved_search_hits]`,
          ru: `Здравствуйте, ${i.alias}!\n\nПо вашему сохранённому поиску «${name}» появились новые лоты:\n\n${listText}${more}\n\nСмотреть все: ${ctx.siteUrl}/meklet\n\n[saved_search_hits]`,
          en: `Hi ${i.alias},\n\nNew lots have appeared for your saved search "${name}":\n\n${listText}${more}\n\nSee them all: ${ctx.siteUrl}/meklet\n\n[saved_search_hits]`,
        }[lang],
        spec: {
          preheader: {
            lv: `${total} jauni loti pēc meklējuma «${name}»`,
            ru: `${total} новых лотов по поиску «${name}»`,
            en: `${total} new lots for "${name}"`,
          }[lang],
          headline: { lv: "JAUNI LOTI JŪSU MEKLĒJUMĀ", ru: "НОВЫЕ ЛОТЫ ПО ВАШЕМУ ПОИСКУ", en: "NEW LOTS FOR YOUR SEARCH" }[lang],
          headlineTone: "accent",
          greeting: hi,
          intro: {
            lv: `Pēc saglabātā meklējuma «${name}» kopš pēdējās vēstules ir parādījušies ${total} jauni loti. Cena ir galīgā — bez piemaksām pie kases.`,
            ru: `По сохранённому поиску «${name}» с прошлого письма появились новые лоты: ${total}. Цена финальная — без доплат на кассе.`,
            en: `Since our last message, ${total} new lots have appeared for your saved search "${name}". The price you see is final — nothing added at checkout.`,
          }[lang],
          facts: lots.map((l) => ({ label: `${l.title}:`, value: moneyIn(l.priceCents, lang) })),
          cta: { label: { lv: "Skatīt lotus", ru: "Смотреть лоты", en: "See the lots" }[lang], url: `${ctx.siteUrl}/meklet` },
          ...(total > lots.length
            ? {
                ctaNote: {
                  lv: `Vēstulē redzami pirmie ${lots.length} — pavisam ${total}.`,
                  ru: `В письме первые ${lots.length} — всего ${total}.`,
                  en: `Showing the first ${lots.length} of ${total}.`,
                }[lang],
              }
            : {}),
          labels,
        },
      };
    }

    // ── Marketing: watched lots about to close ──────────────────────────────
    case "watchlist_ending": {
      const lots = i.lots ?? [];
      const listText = lots
        .map((l) => `• ${l.title} — ${moneyIn(l.priceCents, lang)}${l.endsAt ? ` (${fmtDateTime(l.endsAt, lang)})` : ""}`)
        .join("\n");
      const one = lots.length === 1;
      return {
        subject: one
          ? { lv: `Drīz noslēgsies: ${lots[0]!.title}`, ru: `Скоро завершится: ${lots[0]!.title}`, en: `Ending soon: ${lots[0]!.title}` }[lang]
          : { lv: `${lots.length} jūsu vēlmju loti drīz noslēgsies`, ru: `${lots.length} лотов из вашего списка скоро завершатся`, en: `${lots.length} of your watched lots are ending soon` }[lang],
        text: {
          lv: `Sveiki, ${i.alias}!\n\nLoti no jūsu vēlmju saraksta drīz noslēgsies:\n\n${listText}\n\nPaspējiet nosolīt: ${ctx.siteUrl}/velmes\n\n[watchlist_ending]`,
          ru: `Здравствуйте, ${i.alias}!\n\nЛоты из вашего списка желаний скоро завершатся:\n\n${listText}\n\nУспейте сделать ставку: ${ctx.siteUrl}/velmes\n\n[watchlist_ending]`,
          en: `Hi ${i.alias},\n\nLots on your watchlist are about to close:\n\n${listText}\n\nThere is still time to bid: ${ctx.siteUrl}/velmes\n\n[watchlist_ending]`,
        }[lang],
        spec: {
          preheader: {
            lv: "Pēdējā iespēja nosolīt sekotos lotus",
            ru: "Последний шанс поставить на отслеживаемые лоты",
            en: "Last chance to bid on the lots you follow",
          }[lang],
          headline: { lv: "DRĪZ NOSLĒGSIES", ru: "СКОРО ЗАВЕРШИТСЯ", en: "ENDING SOON" }[lang],
          headlineTone: "warn",
          greeting: hi,
          intro: {
            lv: "Loti, kuriem sekojat, tuvojas beigām. Ja kāds no tiem ir jūsējais — tagad ir īstais brīdis.",
            ru: "Лоты, за которыми вы следите, подходят к концу. Если какой-то из них ваш — сейчас самое время.",
            en: "The lots you follow are coming to a close. If one of them is yours, now is the moment.",
          }[lang],
          facts: lots.map((l) => ({
            label: `${l.title}:`,
            value: `${moneyIn(l.priceCents, lang)}${l.endsAt ? ` · ${fmtDateTime(l.endsAt, lang)}` : ""}`,
            tone: "warn" as const,
          })),
          cta: { label: { lv: "Uz vēlmju sarakstu", ru: "К списку желаний", en: "To your watchlist" }[lang], url: `${ctx.siteUrl}/velmes` },
          labels,
        },
      };
    }

    // ── v15: напоминание о неиспользованном welcome-коде (IZ-P02) ──────────
    case "welcome_reminder": {
      const pct = i.promoPercent ?? 10;
      const code = i.promoCode ?? "";
      const till = fmtDate(i.promoDeadline, lang);
      return {
        subject: {
          lv: `Tava atlaide −${pct}% vēl gaida — derīga līdz ${till}`,
          ru: `Ваша скидка −${pct}% ещё ждёт — действует до ${till}`,
          en: `Your ${pct}% discount is still waiting — valid until ${till}`,
        }[lang],
        text: {
          lv: `Sveiki, ${i.alias}!\n\nTavs atlaides kods pirmajam pirkumam vēl nav izmantots:\n\n${code} — −${pct}% jebkurai precei, derīgs līdz ${till}.\n\nIzvēlies preci: ${ctx.siteUrl}/katalogs\n\n[welcome_reminder]`,
          ru: `Здравствуйте, ${i.alias}!\n\nВаш код скидки на первую покупку ещё не использован:\n\n${code} — −${pct}% на любой товар, действует до ${till}.\n\nВыбрать товар: ${ctx.siteUrl}/katalogs\n\n[welcome_reminder]`,
          en: `Hi ${i.alias},\n\nYour first-purchase discount code is still unused:\n\n${code} — ${pct}% off anything, valid until ${till}.\n\nPick something: ${ctx.siteUrl}/katalogs\n\n[welcome_reminder]`,
        }[lang],
        spec: {
          preheader: { lv: `Kods ${code} derīgs līdz ${till}`, ru: `Код ${code} действует до ${till}`, en: `Code ${code} valid until ${till}` }[lang],
          headline: { lv: `TAVA ATLAIDE −${pct}%`, ru: `ВАША СКИДКА −${pct}%`, en: `YOUR ${pct}% DISCOUNT` }[lang],
          headlineTone: "accent",
          greeting: hi,
          intro: {
            lv: `Reģistrējoties tu saņēmi −${pct}% pirmajam pirkumam. Kods vēl nav izmantots — un drīz beigsies.`,
            ru: `При регистрации вы получили −${pct}% на первую покупку. Код ещё не использован — и скоро сгорит.`,
            en: `You received ${pct}% off your first purchase when you signed up. The code is still unused — and about to expire.`,
          }[lang],
          code: { label: { lv: "ATLAIDES KODS", ru: "КОД СКИДКИ", en: "DISCOUNT CODE" }[lang], value: code, note: { lv: `Derīgs līdz ${till}`, ru: `Действует до ${till}`, en: `Valid until ${till}` }[lang] },
          cta: { label: { lv: "Izvēlēties preci", ru: "Выбрать товар", en: "Pick something" }[lang], url: `${ctx.siteUrl}/katalogs` },
          labels,
        },
      };
    }

    // ── v15: 14 дней тишины — топ-лоты любимой категории (IZ-P03) ─────────
    case "inactive_nudge": {
      const lots = i.lots ?? [];
      const cat = i.categoryLabel ?? "";
      const listText = lots.map((l) => `• ${l.title} — ${moneyIn(l.priceCents, lang)}`).join("\n");
      return {
        subject: cat
          ? { lv: `Jaunumi kategorijā ${cat}`, ru: `Новинки в категории «${cat}»`, en: `New in ${cat}` }[lang]
          : { lv: "Šobrīd izsolē — atlasīts tev", ru: "Сейчас на торгах — подборка для вас", en: "On the block right now — picked for you" }[lang],
        text: {
          lv: `Sveiki, ${i.alias}!\n\nKamēr tevis nebija, izsolē parādījās loti, kas varētu interesēt:\n\n${listText}\n\nSkatīt: ${ctx.siteUrl}/katalogs\n\n[inactive_nudge]`,
          ru: `Здравствуйте, ${i.alias}!\n\nПока вас не было, на торгах появились лоты, которые могут быть интересны:\n\n${listText}\n\nСмотреть: ${ctx.siteUrl}/katalogs\n\n[inactive_nudge]`,
          en: `Hi ${i.alias},\n\nWhile you were away, lots you might like have come up:\n\n${listText}\n\nHave a look: ${ctx.siteUrl}/katalogs\n\n[inactive_nudge]`,
        }[lang],
        spec: {
          preheader: { lv: "Atlasīti loti pēc tavām interesēm", ru: "Лоты, подобранные по вашим интересам", en: "Lots picked around your interests" }[lang],
          headline: { lv: "TEV VARĒTU PATIKT", ru: "ВАМ МОЖЕТ ПОНРАВИТЬСЯ", en: "YOU MIGHT LIKE THESE" }[lang],
          headlineTone: "accent",
          greeting: hi,
          intro: cat
            ? { lv: `Kategorijā «${cat}», kuru skaties visbiežāk, ir jauni loti. Cena — galīgā, bez piemaksām.`, ru: `В категории «${cat}», которую вы смотрите чаще всего, новые лоты. Цена финальная, без доплат.`, en: `New lots in ${cat} — the category you browse most. The price you see is final.` }[lang]
            : { lv: "Šobrīd izsolē ir loti, kas sasaucas ar tavām interesēm.", ru: "Сейчас на торгах есть лоты, созвучные вашим интересам.", en: "There are lots on the block right now that match your interests." }[lang],
          facts: lots.map((l) => ({ label: `${l.title}:`, value: moneyIn(l.priceCents, lang) })),
          cta: { label: { lv: "Skatīt katalogu", ru: "Смотреть каталог", en: "Browse the catalogue" }[lang], url: `${ctx.siteUrl}/katalogs` },
          labels,
        },
      };
    }

    // ── v15: win-back спящему клиенту с личным кодом (IZ-P11) ─────────────
    case "winback_offer": {
      const pct = i.promoPercent ?? 15;
      const code = i.promoCode ?? "";
      const till = fmtDate(i.promoDeadline, lang);
      const cat = i.categoryLabel;
      return {
        subject: cat
          ? { lv: `−${pct}% kategorijā ${cat} — tikai tev`, ru: `−${pct}% в категории «${cat}» — только для вас`, en: `${pct}% off in ${cat} — just for you` }[lang]
          : { lv: `Sen neredzēts — −${pct}% nākamajam pirkumam`, ru: `Давно не виделись — −${pct}% на следующую покупку`, en: `It has been a while — ${pct}% off your next purchase` }[lang],
        text: {
          lv: `Sveiki, ${i.alias}!\n\nSen neesi pie mums iegriezies. Atgriešanās dāvana:\n\n${code} — −${pct}%${cat ? ` kategorijā «${cat}»` : ""}, derīgs līdz ${till}.\n\nSkatīt lotus: ${ctx.siteUrl}/katalogs\n\n[winback_offer]`,
          ru: `Здравствуйте, ${i.alias}!\n\nВы давно к нам не заглядывали. Подарок на возвращение:\n\n${code} — −${pct}%${cat ? ` в категории «${cat}»` : ""}, действует до ${till}.\n\nСмотреть лоты: ${ctx.siteUrl}/katalogs\n\n[winback_offer]`,
          en: `Hi ${i.alias},\n\nIt has been a while. A welcome-back gift:\n\n${code} — ${pct}% off${cat ? ` in ${cat}` : ""}, valid until ${till}.\n\nSee the lots: ${ctx.siteUrl}/katalogs\n\n[winback_offer]`,
        }[lang],
        spec: {
          preheader: { lv: `Personīgs kods ${code} līdz ${till}`, ru: `Личный код ${code} до ${till}`, en: `Personal code ${code} until ${till}` }[lang],
          headline: { lv: "ATGRIEŠANĀS DĀVANA", ru: "ПОДАРОК НА ВОЗВРАЩЕНИЕ", en: "A WELCOME-BACK GIFT" }[lang],
          headlineTone: "accent",
          greeting: hi,
          intro: cat
            ? { lv: `Kopš pēdējā pirkuma kategorijā «${cat}» ir daudz jauna. Šis kods ir personīgs un der tikai tev.`, ru: `С вашей последней покупки в категории «${cat}» много нового. Этот код личный и действует только для вас.`, en: `A lot has arrived in ${cat} since your last purchase. This code is personal to you.` }[lang]
            : { lv: "Kopš pēdējā pirkuma pie mums ir daudz jauna. Šis kods ir personīgs un der tikai tev.", ru: "С вашей последней покупки у нас много нового. Этот код личный и действует только для вас.", en: "A lot has arrived since your last purchase. This code is personal to you." }[lang],
          code: { label: { lv: "TAVS KODS", ru: "ВАШ КОД", en: "YOUR CODE" }[lang], value: code, note: { lv: `−${pct}% · līdz ${till}`, ru: `−${pct}% · до ${till}`, en: `${pct}% off · until ${till}` }[lang] },
          cta: { label: { lv: "Skatīt lotus", ru: "Смотреть лоты", en: "See the lots" }[lang], url: `${ctx.siteUrl}/katalogs` },
          labels,
        },
      };
    }

    // ── v15: похожие лоты после проигранных торгов (IZ-P05) ───────────────
    case "lost_bid_similar": {
      const lots = i.lots ?? [];
      const listText = lots.map((l) => `• ${l.title} — ${moneyIn(l.priceCents, lang)}`).join("\n");
      return {
        subject: {
          lv: `Šī izsole aizgāja citam — bet ir līdzīgi loti`,
          ru: `Этот лот ушёл другому — но есть похожие`,
          en: `That one got away — but there are similar lots`,
        }[lang],
        text: {
          lv: `Sveiki, ${i.alias}!\n\nIzsole "${i.lotTitle}" noslēdzās bez tavas uzvaras. Šobrīd solās līdzīgi loti:\n\n${listText}\n\nSkatīt: ${ctx.siteUrl}/katalogs\n\n[lost_bid_similar]`,
          ru: `Здравствуйте, ${i.alias}!\n\nТорги «${i.lotTitle}» завершились не в вашу пользу. Сейчас на торгах похожие лоты:\n\n${listText}\n\nСмотреть: ${ctx.siteUrl}/katalogs\n\n[lost_bid_similar]`,
          en: `Hi ${i.alias},\n\nThe auction for "${i.lotTitle}" closed without you. Similar lots are on the block right now:\n\n${listText}\n\nHave a look: ${ctx.siteUrl}/katalogs\n\n[lost_bid_similar]`,
        }[lang],
        spec: {
          preheader: { lv: "Līdzīgi loti vēl solās", ru: "Похожие лоты ещё торгуются", en: "Similar lots are still open" }[lang],
          headline: { lv: "VĒL NAV PAR VĒLU", ru: "ЕЩЁ НЕ ПОЗДНО", en: "NOT TOO LATE" }[lang],
          headlineTone: "accent",
          greeting: hi,
          intro: {
            lv: `"${i.lotTitle}" aizgāja citam solītājam — bet līdzīgi loti vēl ir spēlē.`,
            ru: `«${i.lotTitle}» достался другому участнику — но похожие лоты ещё в игре.`,
            en: `"${i.lotTitle}" went to another bidder — but similar lots are still in play.`,
          }[lang],
          facts: lots.map((l) => ({ label: `${l.title}:`, value: moneyIn(l.priceCents, lang) })),
          cta: { label: { lv: "Skatīt līdzīgos", ru: "Смотреть похожие", en: "See similar lots" }[lang], url: `${ctx.siteUrl}/katalogs` },
          labels,
        },
      };
    }

    // ── v15: запрос отзыва после выдачи (IZ-P07) ──────────────────────────
    case "review_request": {
      const url = i.actionUrl ?? ctx.siteUrl;
      return {
        subject: {
          lv: `Kā tev ar pirkumu «${i.lotTitle}»?`,
          ru: `Как вам покупка «${i.lotTitle}»?`,
          en: `How is your "${i.lotTitle}"?`,
        }[lang],
        text: {
          lv: `Sveiki, ${i.alias}!\n\nCeram, ka «${i.lotTitle}» (pasūtījums ${i.orderRef}) tevi priecē. Īss atsauksme palīdz gan mums, gan nākamajiem pircējiem: ${url}\n\n[review_request]`,
          ru: `Здравствуйте, ${i.alias}!\n\nНадеемся, «${i.lotTitle}» (заказ ${i.orderRef}) вас радует. Короткий отзыв помогает и нам, и следующим покупателям: ${url}\n\n[review_request]`,
          en: `Hi ${i.alias},\n\nWe hope you are enjoying "${i.lotTitle}" (order ${i.orderRef}). A short review helps us and the next buyers alike: ${url}\n\n[review_request]`,
        }[lang],
        spec: {
          preheader: { lv: "Divas minūtes — un tavs viedoklis palīdz citiem", ru: "Две минуты — и ваше мнение поможет другим", en: "Two minutes — and your view helps others" }[lang],
          headline: { lv: "PASTĀSTI, KĀ SANĀCA", ru: "РАССКАЖИТЕ, КАК ВСЁ ПРОШЛО", en: "TELL US HOW IT WENT" }[lang],
          headlineTone: "accent",
          greeting: hi,
          intro: {
            lv: `Pirkums «${i.lotTitle}» ir pie tevis. Ja atradīsi divas minūtes atsauksmei — mēs to tiešām izlasām, un nākamajiem pircējiem tā ir zelta vērtē.`,
            ru: `Покупка «${i.lotTitle}» уже у вас. Если найдёте две минуты на отзыв — мы правда его читаем, а следующим покупателям он на вес золота.`,
            en: `Your purchase "${i.lotTitle}" is with you now. If you can spare two minutes for a review — we genuinely read them, and future buyers rely on them.`,
          }[lang],
          facts: i.orderRef ? [{ label: w(W.orderNo, lang), value: i.orderRef }] : [],
          cta: { label: { lv: "Atstāt atsauksmi", ru: "Оставить отзыв", en: "Leave a review" }[lang], url },
          labels,
        },
      };
    }

    // ── v15: приглашение в реферальную программу (IZ-P04) ─────────────────
    case "referral_invite": {
      const url = i.referralUrl ?? ctx.siteUrl;
      const s = moneyIn(i.referralSignupCents, lang);
      const o = moneyIn(i.referralOrderCents, lang);
      const pct = i.referralPercent ?? 15;
      return {
        subject: {
          lv: "Uzaicini draugu — nopelni punktus",
          ru: "Пригласите друга — заработайте баллы",
          en: "Invite a friend — earn points",
        }[lang],
        text: {
          lv: `Sveiki, ${i.alias}!\n\nTev acīmredzot pie mums patīk — uzaicini draugu! Draugs saņem −${pct}% pirmajam pirkumam, tu — ${s} punktos par viņa reģistrāciju un vēl ${o}, kad viņš izdara pirmo pirkumu.\n\nTava personīgā saite: ${url}\n\n[referral_invite]`,
          ru: `Здравствуйте, ${i.alias}!\n\nПохоже, вам у нас нравится — пригласите друга! Друг получит −${pct}% на первую покупку, вы — ${s} баллами за его регистрацию и ещё ${o}, когда он совершит первую покупку.\n\nВаша личная ссылка: ${url}\n\n[referral_invite]`,
          en: `Hi ${i.alias},\n\nIt looks like you are enjoying izsoli.lv — invite a friend! They get ${pct}% off their first purchase; you get ${s} in points when they sign up and another ${o} when they make their first purchase.\n\nYour personal link: ${url}\n\n[referral_invite]`,
        }[lang],
        spec: {
          preheader: { lv: `Draugam −${pct}%, tev punkti`, ru: `Другу −${pct}%, вам баллы`, en: `${pct}% for them, points for you` }[lang],
          headline: { lv: "UZAICINI DRAUGU", ru: "ПРИГЛАСИТЕ ДРУГА", en: "INVITE A FRIEND" }[lang],
          headlineTone: "accent",
          greeting: hi,
          intro: {
            lv: `Draugs saņem −${pct}% pirmajam pirkumam. Tu nopelni ${s}, kad viņš apstiprina e-pastu, un vēl ${o}, kad viņš izdara pirmo pirkumu.`,
            ru: `Друг получает −${pct}% на первую покупку. Вы зарабатываете ${s}, когда он подтвердит почту, и ещё ${o} после его первой покупки.`,
            en: `Your friend gets ${pct}% off their first purchase. You earn ${s} when they confirm their e-mail and another ${o} after their first purchase.`,
          }[lang],
          facts: [],
          cta: { label: { lv: "Dalīties ar saiti", ru: "Поделиться ссылкой", en: "Share your link" }[lang], url },
          ctaNote: url,
          labels,
        },
      };
    }

    // ── §6.1: смотрел лот, не ставил, торги на исходе ─────────────────────
    case "abandoned_bid": {
      const price = moneyIn(i.amountCents, lang);
      const url = i.actionUrl ?? `${ctx.siteUrl}/katalogs`;
      return {
        subject: {
          lv: `«${i.lotTitle}» drīz noslēgsies — tu to apskatīji`,
          ru: `«${i.lotTitle}» скоро закроется — вы его смотрели`,
          en: `"${i.lotTitle}" is about to close — you were looking at it`,
        }[lang],
        text: {
          lv: `Sveiki, ${i.alias}!\n\nLots, kuru nesen apskatīji, drīz noslēgsies:\n\n${i.lotTitle} — pašlaik ${price}.\n\nJa tas vēl interesē, tagad ir īstais brīdis: ${url}\n\n[abandoned_bid]`,
          ru: `Здравствуйте, ${i.alias}!\n\nЛот, который вы недавно смотрели, скоро закроется:\n\n${i.lotTitle} — сейчас ${price}.\n\nЕсли он ещё интересен, сейчас самое время: ${url}\n\n[abandoned_bid]`,
          en: `Hi ${i.alias},\n\nA lot you looked at recently is about to close:\n\n${i.lotTitle} — currently at ${price}.\n\nIf you are still interested, now is the moment: ${url}\n\n[abandoned_bid]`,
        }[lang],
        spec: {
          preheader: { lv: "Izsole tuvojas beigām", ru: "Торги подходят к концу", en: "The auction is ending" }[lang],
          headline: { lv: "DRĪZ NOSLĒGSIES", ru: "СКОРО ЗАКРОЕТСЯ", en: "CLOSING SOON" }[lang],
          headlineTone: "accent",
          greeting: hi,
          intro: {
            lv: `«${i.lotTitle}» ir izsolē pēdējās stundas — pašlaik ${price}. Tu to apskatīji, bet solījumu neizdarīji.`,
            ru: `«${i.lotTitle}» на торгах последние часы — сейчас ${price}. Вы его смотрели, но ставку не сделали.`,
            en: `"${i.lotTitle}" is in its final hours — currently at ${price}. You looked but did not bid.`,
          }[lang],
          cta: { label: { lv: "Atvērt lotu", ru: "Открыть лот", en: "Open the lot" }[lang], url },
          labels,
        },
      };
    }

    // ── §6.2: N dienas pēc pirmā pirkuma — otrā vēl nav ───────────────────
    case "second_purchase": {
      const lots = i.lots ?? [];
      const cat = i.categoryLabel;
      const listText = lots.map((l) => `• ${l.title} — ${moneyIn(l.priceCents, lang)}`).join("\n");
      const pts = i.pointsBalanceCents ?? 0;
      const ptsLine = pts >= 100
        ? { lv: `\n\nAtgādinām: tavā kontā ir ${moneyIn(pts, lang)} punktos — tos var izmantot apmaksā.`, ru: `\n\nНапоминаем: на вашем счету ${moneyIn(pts, lang)} баллами — их можно использовать при оплате.`, en: `\n\nReminder: you have ${moneyIn(pts, lang)} in points — you can spend them at checkout.` }[lang]
        : "";
      return {
        subject: {
          lv: "Kā tev patika pirmais pirkums?",
          ru: "Как вам первая покупка?",
          en: "How was your first purchase?",
        }[lang],
        text: {
          lv: `Sveiki, ${i.alias}!\n\nPriecājamies, ka izdarīji pirmo pirkumu! Šobrīd izsolē ir loti, kas varētu iepatikties:\n\n${listText}${ptsLine}\n\nSkatīt: ${ctx.siteUrl}/katalogs\n\n[second_purchase]`,
          ru: `Здравствуйте, ${i.alias}!\n\nРады, что вы сделали первую покупку! Сейчас на торгах лоты, которые могут понравиться:\n\n${listText}${ptsLine}\n\nСмотреть: ${ctx.siteUrl}/katalogs\n\n[second_purchase]`,
          en: `Hi ${i.alias},\n\nGlad you made your first purchase! Lots you might like are on the block now:\n\n${listText}${ptsLine}\n\nHave a look: ${ctx.siteUrl}/katalogs\n\n[second_purchase]`,
        }[lang],
        spec: {
          preheader: { lv: "Atlasīts pēc tava pirmā pirkuma", ru: "Подобрано по вашей первой покупке", en: "Picked after your first purchase" }[lang],
          headline: { lv: "TURPINĀM?", ru: "ПРОДОЛЖИМ?", en: "SHALL WE CONTINUE?" }[lang],
          headlineTone: "accent",
          greeting: hi,
          intro: cat
            ? { lv: `Pēc tava pirmā pirkuma kategorijā «${cat}» esam atlasījuši vēl dažus lotus. Cena — galīgā, bez piemaksām.`, ru: `После вашей первой покупки в категории «${cat}» мы подобрали ещё несколько лотов. Цена финальная, без доплат.`, en: `After your first purchase in ${cat}, we picked a few more lots. The price you see is final.` }[lang]
            : { lv: "Pēc tava pirmā pirkuma esam atlasījuši vēl dažus lotus, kas varētu iepatikties.", ru: "После вашей первой покупки мы подобрали ещё несколько лотов, которые могут понравиться.", en: "After your first purchase, we picked a few more lots you might like." }[lang],
          facts: lots.map((l) => ({ label: `${l.title}:`, value: moneyIn(l.priceCents, lang) })),
          cta: { label: { lv: "Skatīt katalogu", ru: "Смотреть каталог", en: "Browse the catalogue" }[lang], url: `${ctx.siteUrl}/katalogs` },
          labels,
        },
      };
    }

    // ── Dāvanu karte ieskaitīta kredītā ───────────────────────────────────
    case "gift_card_received": {
      const sum = moneyIn(i.amountCents, lang);
      return {
        subject: {
          lv: `Dāvanu karte ${sum} ieskaitīta tavā kontā`,
          ru: `Подарочная карта ${sum} зачислена на ваш счёт`,
          en: `Gift card ${sum} added to your account`,
        }[lang],
        text: {
          lv: `Sveiki, ${i.alias}!\n\nDāvanu karte ${sum} ir ieskaitīta tavā kontā kā kredīts. Tas automātiski samazinās nākamā pirkuma summu.\n\nSkatīt lotus: ${ctx.siteUrl}/katalogs\n\n[gift_card_received]`,
          ru: `Здравствуйте, ${i.alias}!\n\nПодарочная карта ${sum} зачислена на ваш счёт как кредит. Он автоматически уменьшит сумму следующей покупки.\n\nСмотреть лоты: ${ctx.siteUrl}/katalogs\n\n[gift_card_received]`,
          en: `Hi ${i.alias},\n\nA gift card of ${sum} has been added to your account as credit. It will automatically reduce your next order total.\n\nSee the lots: ${ctx.siteUrl}/katalogs\n\n[gift_card_received]`,
        }[lang],
        spec: {
          preheader: { lv: `Kredīts ${sum} jau kontā`, ru: `Кредит ${sum} уже на счету`, en: `${sum} credit is on your account` }[lang],
          headline: { lv: "DĀVANA SAŅEMTA", ru: "ПОДАРОК ПОЛУЧЕН", en: "GIFT RECEIVED" }[lang],
          headlineTone: "accent",
          greeting: hi,
          intro: {
            lv: `Kartes vērtība ${sum} tagad ir tavs konta kredīts — tas automātiski piemērosies nākamajai apmaksai.`,
            ru: `Номинал карты ${sum} теперь кредит вашего счёта — он автоматически применится к следующей оплате.`,
            en: `The card value of ${sum} is now account credit — it applies automatically to your next payment.`,
          }[lang],
          facts: [{ label: { lv: "Ieskaitīts:", ru: "Зачислено:", en: "Credited:" }[lang], value: sum }],
          cta: { label: { lv: "Skatīt lotus", ru: "Смотреть лоты", en: "See the lots" }[lang], url: `${ctx.siteUrl}/katalogs` },
          labels,
        },
      };
    }

    // ── Сброс пароля ────────────────────────────────────────────────────────
    // Ссылка живёт минутами и даёт доступ к аккаунту, поэтому это письмо
    // единственное, которое НЕ попадает в журнал уведомлений (см.
    // sendPasswordReset): оформление и правки текста — общие, хранения нет.
    case "password_reset": {
      const hours = i.validHours ?? 1;
      const subject = {
        lv: "Paroles atjaunošana — Izsoli.lv",
        ru: "Восстановление пароля — Izsoli.lv",
        en: "Password reset — Izsoli.lv",
      }[lang];
      const validity = {
        lv: hours === 1 ? "Saite derīga 1 stundu." : `Saite derīga ${hours} stundas.`,
        ru: hours === 1 ? "Ссылка действует 1 час." : `Ссылка действует ${hours} ч.`,
        en: hours === 1 ? "The link is valid for 1 hour." : `The link is valid for ${hours} hours.`,
      }[lang];
      const text = {
        lv: `Sveiki, ${i.alias}!\n\nJauno paroli var iestatīt šeit: ${i.actionUrl}\n${validity}\n\nJa paroli neprasīji tu — nedari neko, vecā parole paliek spēkā.\n\n[password_reset]`,
        ru: `Здравствуйте, ${i.alias}!\n\nНовый пароль можно задать здесь: ${i.actionUrl}\n${validity}\n\nЕсли пароль запрашивали не вы — ничего не делайте, старый остаётся действующим.\n\n[password_reset]`,
        en: `Hi ${i.alias},\n\nSet a new password here: ${i.actionUrl}\n${validity}\n\nIf you did not ask for this, do nothing — your current password stays valid.\n\n[password_reset]`,
      }[lang];
      return {
        subject,
        text,
        spec: {
          preheader: validity,
          headline: { lv: "JAUNA PAROLE", ru: "НОВЫЙ ПАРОЛЬ", en: "NEW PASSWORD" }[lang],
          headlineTone: "accent",
          greeting: hi,
          intro: {
            lv: "Saņēmām pieprasījumu nomainīt paroli. Nospied pogu un iestati jaunu — vecā pārstās darboties uzreiz.",
            ru: "Мы получили запрос на смену пароля. Нажмите кнопку и задайте новый — старый перестанет работать сразу.",
            en: "We received a request to change your password. Press the button and set a new one — the old password stops working immediately.",
          }[lang],
          facts: [],
          cta: {
            label: { lv: "Iestatīt jaunu paroli", ru: "Задать новый пароль", en: "Set a new password" }[lang],
            url: i.actionUrl ?? ctx.siteUrl,
          },
          ctaNote: validity,
          notes: [{ text: {
            lv: "Ja paroli neprasīji tu — vienkārši ignorē šo vēstuli. Konts paliek ar veco paroli.",
            ru: "Если пароль запрашивали не вы — просто игнорируйте письмо. Аккаунт останется со старым паролем.",
            en: "If this was not you, just ignore this e-mail. Your account keeps its current password.",
          }[lang] }],
          labels,
        },
      };
    }

    // ── Баллы скоро сгорят ──────────────────────────────────────────────────
    case "points_expiring": {
      const sum = moneyIn(i.expiringCents, lang);
      const when = fmtDate(i.expiresAt, lang);
      const subject = {
        lv: `${sum} punktu sadegs ${when}`,
        ru: `${sum} баллов сгорят ${when}`,
        en: `${sum} in points expires on ${when}`,
      }[lang];
      const text = {
        lv: `Sveiki, ${i.alias}!\n\n${sum} no taviem punktiem sadegs ${when}. Punkti sedz līdz pusei no pasūtījuma summas — tos var izmantot jebkurai precei.\n\nSkatīt lotus: ${ctx.siteUrl}/katalogs\n\n[points_expiring]`,
        ru: `Здравствуйте, ${i.alias}!\n\n${sum} ваших баллов сгорят ${when}. Баллами можно закрыть до половины суммы заказа — на любой товар.\n\nСмотреть лоты: ${ctx.siteUrl}/katalogs\n\n[points_expiring]`,
        en: `Hi ${i.alias},\n\n${sum} of your points expires on ${when}. Points cover up to half of an order — on anything you like.\n\nSee the lots: ${ctx.siteUrl}/katalogs\n\n[points_expiring]`,
      }[lang];
      return {
        subject,
        text,
        spec: {
          preheader: { lv: `Izmanto līdz ${when}`, ru: `Используйте до ${when}`, en: `Use them before ${when}` }[lang],
          headline: { lv: "PUNKTI DRĪZ SADEGS", ru: "БАЛЛЫ СКОРО СГОРЯТ", en: "YOUR POINTS EXPIRE SOON" }[lang],
          headlineTone: "warn",
          greeting: hi,
          intro: {
            lv: "Nopelnītie punkti dzīvo 12 mēnešus. Daļa no taviem tuvojas termiņa beigām — brīdinām laikus, lai tie nepazustu klusi.",
            ru: "Заработанные баллы живут 12 месяцев. Часть ваших подходит к концу срока — предупреждаем заранее, чтобы они не пропали молча.",
            en: "Points last 12 months from the day they were earned. Some of yours are close to that date — here is a heads-up so they don't vanish quietly.",
          }[lang],
          amount: {
            label: { lv: "Sadegs:", ru: "Сгорит:", en: "Expiring:" }[lang],
            value: sum,
            ...(i.pointsBalanceCents !== undefined
              ? {
                  lines: [{
                    label: { lv: "Kopējais atlikums", ru: "Всего на счету", en: "Total balance" }[lang],
                    value: moneyIn(i.pointsBalanceCents, lang),
                  }],
                }
              : {}),
          },
          facts: [{ label: { lv: "Termiņš:", ru: "Срок:", en: "Expires:" }[lang], value: when }],
          cta: { label: { lv: "Izmantot punktus", ru: "Потратить баллы", en: "Spend the points" }[lang], url: `${ctx.siteUrl}/katalogs` },
          labels,
        },
      };
    }

    // ── Безопасность аккаунта ───────────────────────────────────────────────
    case "security_alert": {
      const ev = i.securityEvent ?? "new_device";
      const what = {
        password_changed: { lv: "Parole nomainīta", ru: "Пароль изменён", en: "Password changed" },
        email_changed: { lv: "Nomainīta e-pasta adrese", ru: "Изменён адрес почты", en: "E-mail address changed" },
        new_device: { lv: "Jauna ierīce kontā", ru: "Вход с нового устройства", en: "New device signed in" },
      }[ev] ?? { lv: "Konta izmaiņas", ru: "Изменения в аккаунте", en: "Account change" };
      const subject = `${what[lang]} — Izsoli.lv`;
      const when = i.eventAt ? fmtDate(i.eventAt, lang) : "";
      const device = i.deviceLabel ?? "—";
      const text = {
        lv: `Sveiki, ${i.alias}!\n\n${what.lv}. Ierīce: ${device}${when ? `, ${when}` : ""}.\n\nJa tas biji tu — nekas nav jādara. Ja nē — nekavējoties nomaini paroli: ${ctx.siteUrl}/aizmirsu-paroli\n\n[security_alert]`,
        ru: `Здравствуйте, ${i.alias}!\n\n${what.ru}. Устройство: ${device}${when ? `, ${when}` : ""}.\n\nЕсли это вы — делать ничего не нужно. Если нет — немедленно смените пароль: ${ctx.siteUrl}/aizmirsu-paroli\n\n[security_alert]`,
        en: `Hi ${i.alias},\n\n${what.en}. Device: ${device}${when ? `, ${when}` : ""}.\n\nIf this was you, there is nothing to do. If not, change your password right away: ${ctx.siteUrl}/aizmirsu-paroli\n\n[security_alert]`,
      }[lang];
      return {
        subject,
        text,
        spec: {
          preheader: { lv: "Ja tas nebiji tu — nomaini paroli", ru: "Если это не вы — смените пароль", en: "If this wasn't you, change your password" }[lang],
          headline: { lv: "KONTA DROŠĪBA", ru: "БЕЗОПАСНОСТЬ АККАУНТА", en: "ACCOUNT SECURITY" }[lang],
          headlineTone: "warn",
          greeting: hi,
          intro: `${what[lang]}. ${{
            lv: "Šo vēstuli sūtām vienmēr, kad kontā notiek kaut kas svarīgs — lai svešs cilvēks nevarētu to izdarīt klusi.",
            ru: "Такое письмо мы шлём всегда, когда в аккаунте происходит что-то важное — чтобы чужой человек не сделал это незаметно.",
            en: "We always send this when something important happens to your account — so nobody can do it quietly.",
          }[lang]}`,
          facts: [
            { label: { lv: "Notikums:", ru: "Событие:", en: "Event:" }[lang], value: what[lang] },
            { label: { lv: "Ierīce:", ru: "Устройство:", en: "Device:" }[lang], value: device },
            ...(when ? [{ label: { lv: "Laiks:", ru: "Время:", en: "Time:" }[lang], value: when }] : []),
          ],
          cta: { label: { lv: "Nomainīt paroli", ru: "Сменить пароль", en: "Change password" }[lang], url: `${ctx.siteUrl}/aizmirsu-paroli` },
          ctaNote: { lv: "Nospied tikai tad, ja tas nebiji tu.", ru: "Нажимайте, только если это были не вы.", en: "Only press this if it wasn't you." }[lang],
          labels,
        },
      };
    }

    // ── Посылка доставлена / ждёт в автомате ────────────────────────────────
    case "delivered": {
      const waiting = i.waitingDays ?? 0;
      const inMachine = Boolean(i.machineName) && waiting > 0;
      const subject = inMachine
        ? { lv: `Sūtījums gaida pakomātā — ${i.lotTitle}`, ru: `Посылка ждёт в автомате — ${i.lotTitle}`, en: `Your parcel is waiting — ${i.lotTitle}` }[lang]
        : { lv: `Sūtījums piegādāts — ${i.lotTitle}`, ru: `Посылка доставлена — ${i.lotTitle}`, en: `Parcel delivered — ${i.lotTitle}` }[lang];
      const text = inMachine
        ? {
            lv: `Sveiki, ${i.alias}!\n\nSūtījums ar "${i.lotTitle}" ir pakomātā ${i.machineName}. Tas gaida ${waiting} dienas, pēc tam atgriežas pie mums.\nPasūtījums: ${i.orderRef}\n\n[delivered]`,
            ru: `Здравствуйте, ${i.alias}!\n\nПосылка с "${i.lotTitle}" в автомате ${i.machineName}. Она ждёт ${waiting} дн., потом возвращается к нам.\nЗаказ: ${i.orderRef}\n\n[delivered]`,
            en: `Hi ${i.alias},\n\nYour parcel with "${i.lotTitle}" is at ${i.machineName}. It waits ${waiting} days before coming back to us.\nOrder: ${i.orderRef}\n\n[delivered]`,
          }[lang]
        : {
            lv: `Sveiki, ${i.alias}!\n\nSūtījums ar "${i.lotTitle}" ir piegādāts. Pasūtījums: ${i.orderRef}.\nJa ar preci kaut kas nav kārtībā, atraksti 14 dienu laikā.\n\n[delivered]`,
            ru: `Здравствуйте, ${i.alias}!\n\nПосылка с "${i.lotTitle}" доставлена. Заказ: ${i.orderRef}.\nЕсли с товаром что-то не так — напишите в течение 14 дней.\n\n[delivered]`,
            en: `Hi ${i.alias},\n\nYour parcel with "${i.lotTitle}" has been delivered. Order: ${i.orderRef}.\nIf anything is wrong with the item, write to us within 14 days.\n\n[delivered]`,
          }[lang];
      return {
        subject,
        text,
        spec: {
          preheader: inMachine
            ? { lv: `Gaida ${waiting} dienas`, ru: `Ждёт ${waiting} дн.`, en: `Waiting ${waiting} days` }[lang]
            : { lv: "Sūtījums nogādāts", ru: "Посылка у вас", en: "Parcel delivered" }[lang],
          headline: inMachine
            ? { lv: "SŪTĪJUMS GAIDA", ru: "ПОСЫЛКА ЖДЁТ", en: "YOUR PARCEL IS WAITING" }[lang]
            : { lv: "SŪTĪJUMS PIEGĀDĀTS", ru: "ПОСЫЛКА ДОСТАВЛЕНА", en: "PARCEL DELIVERED" }[lang],
          headlineTone: inMachine ? "warn" : "ok",
          greeting: hi,
          intro: inMachine
            ? {
                lv: `Preci vari izņemt jebkurā laikā. Pēc ${waiting} dienām pakomāts sūtījumu atdod atpakaļ mums, un izņemšana kļūst sarežģītāka.`,
                ru: `Забрать можно в любое время. Через ${waiting} дн. автомат вернёт посылку нам, и получить её станет сложнее.`,
                en: `You can collect it any time. After ${waiting} days the machine returns the parcel to us and collecting it gets harder.`,
              }[lang]
            : {
                lv: "Prece ir pie tevis. Ja kaut kas nav kārtībā — apraksti problēmu 14 dienu laikā, un mēs to atrisināsim.",
                ru: "Товар у вас. Если что-то не так — опишите проблему в течение 14 дней, и мы её решим.",
                en: "The item is with you. If something is wrong, describe the problem within 14 days and we will sort it out.",
              }[lang],
          facts: [
            { label: w(W.lot, lang), value: i.lotTitle },
            { label: w(W.orderNo, lang), value: i.orderRef ?? "" },
            ...(i.machineName ? [{ label: w(W.place, lang), value: i.machineName }] : []),
            ...(i.carrier ? [{ label: { lv: "Pārvadātājs:", ru: "Перевозчик:", en: "Carrier:" }[lang], value: i.carrier }] : []),
          ],
          cta: {
            label: inMachine
              ? { lv: "Sekot sūtījumam", ru: "Отследить посылку", en: "Track the parcel" }[lang]
              : { lv: "Mani pasūtījumi", ru: "Мои заказы", en: "My orders" }[lang],
            url: (inMachine ? i.trackingUrl : ctx.ordersUrl) ?? ctx.ordersUrl,
          },
          labels,
        },
      };
    }

    // ── Ставка аннулирована / лот снят ──────────────────────────────────────
    case "bid_voided":
    case "lot_withdrawn": {
      const voided = type === "bid_voided";
      const subject = voided
        ? { lv: `Solījums anulēts — ${i.lotTitle}`, ru: `Ставка аннулирована — ${i.lotTitle}`, en: `Bid voided — ${i.lotTitle}` }[lang]
        : { lv: `Lots noņemts no izsoles — ${i.lotTitle}`, ru: `Лот снят с торгов — ${i.lotTitle}`, en: `Lot withdrawn — ${i.lotTitle}` }[lang];
      const why = i.reason?.trim()
        ? i.reason
        : { lv: "iemesls nav norādīts", ru: "причина не указана", en: "no reason given" }[lang];
      const text = voided
        ? {
            lv: `Sveiki, ${i.alias}!\n\nTavs solījums izsolē "${i.lotTitle}" ir anulēts. Iemesls: ${why}.\nJa uzskati, ka tā ir kļūda, atraksti mums — pārbaudīsim.\n\n[bid_voided]`,
            ru: `Здравствуйте, ${i.alias}!\n\nВаша ставка на "${i.lotTitle}" аннулирована. Причина: ${why}.\nЕсли считаете это ошибкой — напишите нам, проверим.\n\n[bid_voided]`,
            en: `Hi ${i.alias},\n\nYour bid on "${i.lotTitle}" has been voided. Reason: ${why}.\nIf you think this is a mistake, write to us and we will check.\n\n[bid_voided]`,
          }[lang]
        : {
            lv: `Sveiki, ${i.alias}!\n\nLots "${i.lotTitle}" ir noņemts no izsoles, un visi solījumi ir atcelti. Iemesls: ${why}.\nNauda netika ieturēta. Līdzīgas preces atradīsi katalogā.\n\n[lot_withdrawn]`,
            ru: `Здравствуйте, ${i.alias}!\n\nЛот "${i.lotTitle}" снят с торгов, все ставки отменены. Причина: ${why}.\nДеньги не списывались. Похожие товары есть в каталоге.\n\n[lot_withdrawn]`,
            en: `Hi ${i.alias},\n\nThe lot "${i.lotTitle}" has been withdrawn and all bids are cancelled. Reason: ${why}.\nNo money was taken. You will find similar items in the catalogue.\n\n[lot_withdrawn]`,
          }[lang];
      return {
        subject,
        text,
        spec: {
          preheader: voided
            ? { lv: "Solījums vairs nav spēkā", ru: "Ставка больше не действует", en: "The bid no longer stands" }[lang]
            : { lv: "Visi solījumi atcelti", ru: "Все ставки отменены", en: "All bids cancelled" }[lang],
          headline: voided
            ? { lv: "SOLĪJUMS ANULĒTS", ru: "СТАВКА АННУЛИРОВАНА", en: "BID VOIDED" }[lang]
            : { lv: "LOTS NOŅEMTS", ru: "ЛОТ СНЯТ С ТОРГОВ", en: "LOT WITHDRAWN" }[lang],
          headlineTone: "warn",
          greeting: hi,
          intro: voided
            ? {
                lv: "Solījumu atcēla mūsu darbinieks. Tas notiek reti — piemēram, tehniskas kļūdas vai pārbaudes dēļ.",
                ru: "Ставку отменил наш сотрудник. Так бывает редко — например, из-за технической ошибки или проверки.",
                en: "A member of our team voided the bid. This is rare — a technical error or a check, usually.",
              }[lang]
            : {
                lv: "Preci nācās izņemt no izsoles. Nekādas saistības tev nepaliek — un mēs piedāvājam paskatīties līdzīgas.",
                ru: "Товар пришлось снять с торгов. Никаких обязательств у вас не остаётся — предлагаем посмотреть похожие.",
                en: "We had to pull the item from the auction. You are left with no obligation — have a look at similar lots instead.",
              }[lang],
          facts: [
            { label: w(W.lot, lang), value: i.lotTitle },
            ...(i.amountCents !== undefined ? [{ label: { lv: "Solījums:", ru: "Ставка:", en: "Bid:" }[lang], value: moneyIn(i.amountCents, lang) }] : []),
            { label: { lv: "Iemesls:", ru: "Причина:", en: "Reason:" }[lang], value: why },
          ],
          cta: { label: { lv: "Skatīt katalogu", ru: "Смотреть каталог", en: "Browse the catalogue" }[lang], url: `${ctx.siteUrl}/katalogs` },
          labels,
        },
      };
    }

    // ── Платёж не прошёл ────────────────────────────────────────────────────
    case "payment_failed": {
      const subject = {
        lv: `Maksājums neizdevās — ${i.orderRef}`,
        ru: `Платёж не прошёл — ${i.orderRef}`,
        en: `Payment failed — ${i.orderRef}`,
      }[lang];
      const why = i.failureReason?.trim() ?? {
        lv: "banka vai karte darījumu neapstiprināja",
        ru: "банк или карта не подтвердили операцию",
        en: "the bank or card did not approve the transaction",
      }[lang];
      const text = {
        lv: `Sveiki, ${i.alias}!\n\nMaksājums par pasūtījumu ${i.orderRef} (${moneyIn(i.totalCents, "lv")}) neizdevās: ${why}.\nPrece vēl ir rezervēta${i.deadline ? ` līdz ${fmtDate(i.deadline, "lv")}` : ""} — mēģini vēlreiz.${payLine(i, "lv")}\n\n[payment_failed]`,
        ru: `Здравствуйте, ${i.alias}!\n\nПлатёж по заказу ${i.orderRef} (${moneyIn(i.totalCents, "ru")}) не прошёл: ${why}.\nТовар ещё за вами${i.deadline ? ` до ${fmtDate(i.deadline, "ru")}` : ""} — попробуйте ещё раз.${payLine(i, "ru")}\n\n[payment_failed]`,
        en: `Hi ${i.alias},\n\nThe payment for order ${i.orderRef} (${moneyIn(i.totalCents, "en")}) did not go through: ${why}.\nThe item is still held for you${i.deadline ? ` until ${fmtDate(i.deadline, "en")}` : ""} — please try again.${payLine(i, "en")}\n\n[payment_failed]`,
      }[lang];
      return {
        subject,
        text,
        spec: {
          preheader: { lv: "Prece vēl ir rezervēta — mēģini vēlreiz", ru: "Товар ещё за вами — попробуйте снова", en: "The item is still held — try again" }[lang],
          headline: { lv: "MAKSĀJUMS NEIZDEVĀS", ru: "ПЛАТЁЖ НЕ ПРОШЁЛ", en: "PAYMENT FAILED" }[lang],
          headlineTone: "warn",
          greeting: hi,
          intro: {
            lv: "Nauda no konta netika noņemta. Visbiežāk pietiek mēģināt vēlreiz vai izvēlēties citu maksājuma veidu.",
            ru: "Деньги со счёта не списаны. Чаще всего достаточно повторить оплату или выбрать другой способ.",
            en: "No money left your account. Usually it is enough to try again or pick a different payment method.",
          }[lang],
          amount: { label: w(W.totalDue, lang), value: moneyIn(i.totalCents, lang) },
          facts: [
            { label: w(W.lot, lang), value: i.lotTitle },
            { label: w(W.orderNo, lang), value: i.orderRef ?? "" },
            { label: { lv: "Kļūda:", ru: "Причина:", en: "Reason:" }[lang], value: why },
            ...(i.deadline ? [{ label: w(W.payBy, lang), value: fmtDate(i.deadline, lang) }] : []),
          ],
          cta: {
            label: { lv: "Apmaksāt vēlreiz", ru: "Оплатить снова", en: "Pay again" }[lang],
            url: i.payUrl ?? ctx.ordersUrl,
          },
          ctaNote: methodsLine(lang, ctx),
          labels,
        },
      };
    }

    // ══ Письма поставщикам (S1…S10) ═══════════════════════════════════════
    // Адресат — компания, а не покупатель: обращение по контактному лицу,
    // тон деловой, все письма служебные (часть договорных отношений).

    // ── S1. Приглашение в кабинет ──────────────────────────────────────────
    case "sup_invite": {
      const days = i.inviteDays ?? 7;
      const portal = i.inviteUrl ?? `${ctx.siteUrl}/piegadatajs`;
      const subject = {
        lv: "Piekļuve piegādātāja kabinetam — Izsoli.lv",
        ru: "Доступ в кабинет поставщика — Izsoli.lv",
        en: "Your supplier portal access — Izsoli.lv",
      }[lang];
      const validity = {
        lv: `Saite derīga ${days} dienas.`,
        ru: `Ссылка действует ${days} дн.`,
        en: `The link is valid for ${days} days.`,
      }[lang];
      const text = {
        lv: `Labdien, ${i.alias}!\n\nIzsoli.lv ir izveidojis kabinetu uzņēmumam ${i.supplierName ?? ""}. Tajā redzams piegāžu statuss, pieņemšanas akti, rēķinu apstrāde un maksājumi.\n\nIzveido paroli: ${portal}\n${validity}\n\n[sup_invite]`,
        ru: `Добрый день, ${i.alias}!\n\nIzsoli.lv завёл кабинет для компании ${i.supplierName ?? ""}. В нём видно статус поставок, акты приёмки, обработку счетов и платежи.\n\nЗадайте пароль: ${portal}\n${validity}\n\n[sup_invite]`,
        en: `Hello ${i.alias},\n\nIzsoli.lv has created a portal account for ${i.supplierName ?? ""}. It shows delivery status, intake reports, invoice processing and payments.\n\nSet your password: ${portal}\n${validity}\n\n[sup_invite]`,
      }[lang];
      return {
        subject,
        text,
        spec: {
          preheader: validity,
          headline: { lv: "PIEGĀDĀTĀJA KABINETS", ru: "КАБИНЕТ ПОСТАВЩИКА", en: "SUPPLIER PORTAL" }[lang],
          headlineTone: "accent",
          greeting: `${{ lv: "Labdien", ru: "Добрый день", en: "Hello" }[lang]}, ${i.alias}!`,
          intro: {
            lv: "Kabinetā vienuviet ir viss, kas parasti izklīst pa sarakstēm: piegāžu statusi, pieņemšanas akti ar bildēm, rēķinu apstrāde un maksājumu vēsture.",
            ru: "В кабинете в одном месте всё, что обычно расползается по переписке: статусы поставок, акты приёмки с фото, обработка счетов и история платежей.",
            en: "The portal keeps in one place what usually scatters across chats: delivery status, intake reports with photos, invoice processing and payment history.",
          }[lang],
          facts: [
            ...(i.supplierName ? [{ label: { lv: "Uzņēmums:", ru: "Компания:", en: "Company:" }[lang], value: i.supplierName }] : []),
          ],
          cta: { label: { lv: "Izveidot paroli", ru: "Задать пароль", en: "Set your password" }[lang], url: portal },
          ctaNote: validity,
          notes: [{ text: {
            lv: "Ja saite nostrādāja par vēlu, uzraksti mums — nosūtīsim jaunu.",
            ru: "Если ссылка уже не работает — напишите нам, вышлем новую.",
            en: "If the link has expired, write to us and we will send a new one.",
          }[lang] }],
          labels,
        },
      };
    }

    // ── S2. Как мы работаем ────────────────────────────────────────────────
    case "sup_welcome": {
      const commission = i.commissionPercent !== undefined && i.commissionPercent > 0;
      const subject = {
        lv: "Kā mēs strādājam — Izsoli.lv",
        ru: "Как мы работаем — Izsoli.lv",
        en: "How we work together — Izsoli.lv",
      }[lang];
      const terms = i.validHours; // не используется здесь; сроки идут фактами
      void terms;
      const text = {
        lv: `Labdien, ${i.alias}!\n\nKabinets ir aktivizēts. Īsi par kārtību:\n• piegādi piesaki kabinetā pirms atvešanas;\n• pēc pieņemšanas saņemsi aktu ar skaitiem un bildēm;\n• rēķinu ielādē kabinetā — tur redzēsi tā statusu un maksājuma datumu;\n• reizi mēnesī atsūtīsim pārskatu par pieņemto un pārdoto.\n\nKabinets: ${ctx.siteUrl}/piegadatajs\n\n[sup_welcome]`,
        ru: `Добрый день, ${i.alias}!\n\nКабинет активирован. Коротко о порядке:\n• поставку заявляйте в кабинете до приезда;\n• после приёмки получите акт с количествами и фото;\n• счёт загружайте в кабинет — там же виден его статус и дата оплаты;\n• раз в месяц пришлём сводку по принятому и проданному.\n\nКабинет: ${ctx.siteUrl}/piegadatajs\n\n[sup_welcome]`,
        en: `Hello ${i.alias},\n\nYour portal is active. In short:\n• announce a delivery in the portal before it arrives;\n• after intake you receive a report with counts and photos;\n• upload your invoice in the portal — its status and payment date are there;\n• once a month we send a summary of what was received and sold.\n\nPortal: ${ctx.siteUrl}/piegadatajs\n\n[sup_welcome]`,
      }[lang];
      return {
        subject,
        text,
        spec: {
          preheader: { lv: "Kabinets ir aktivizēts", ru: "Кабинет активирован", en: "Your portal is active" }[lang],
          headline: { lv: "SĀKAM DARBU", ru: "НАЧИНАЕМ РАБОТУ", en: "LET'S GET STARTED" }[lang],
          headlineTone: "ok",
          greeting: `${{ lv: "Labdien", ru: "Добрый день", en: "Hello" }[lang]}, ${i.alias}!`,
          intro: {
            lv: "Kabinets ir gatavs. Zemāk — galvenais par mūsu sadarbību; detaļas vienmēr atradīsi kabinetā.",
            ru: "Кабинет готов. Ниже — главное о нашей работе; детали всегда в кабинете.",
            en: "Your portal is ready. Below is the essence of how we work; the details always live in the portal.",
          }[lang],
          facts: [
            {
              label: { lv: "Sadarbības veids:", ru: "Модель работы:", en: "Model:" }[lang],
              value: commission
                ? { lv: "komisija", ru: "комиссия", en: "commission" }[lang]
                : { lv: "izpirkums", ru: "выкуп", en: "buy-out" }[lang],
            },
            ...(commission
              ? [{ label: { lv: "Mūsu komisija:", ru: "Наша комиссия:", en: "Our commission:" }[lang], value: `${i.commissionPercent}%` }]
              : []),
            ...(i.inviteDays !== undefined
              ? [{ label: { lv: "Apmaksas termiņš:", ru: "Срок оплаты:", en: "Payment terms:" }[lang], value: `${i.inviteDays} ${{ lv: "dienas", ru: "дн.", en: "days" }[lang]}` }]
              : []),
          ],
          cta: { label: { lv: "Atvērt kabinetu", ru: "Открыть кабинет", en: "Open the portal" }[lang], url: `${ctx.siteUrl}/piegadatajs` },
          notes: [{ text: {
            lv: "Jautājumi par konkrētu piegādi — raksti tieši kabinetā pie tās; tā atbilde nepazūd sarakstē.",
            ru: "Вопросы по конкретной поставке пишите прямо в кабинете рядом с ней — так ответ не теряется в переписке.",
            en: "Questions about a delivery are best written in the portal next to it — that way the answer does not get lost.",
          }[lang] }],
          labels,
        },
      };
    }

    // ── S3. Акт приёмки ────────────────────────────────────────────────────
    case "sup_intake_done": {
      const accepted = i.acceptedCount ?? 0;
      const declared = i.declaredCount ?? accepted;
      const rejected = i.rejectedCount ?? 0;
      const ref = i.consignmentRef ?? "";
      const subject = {
        lv: `Piegāde pieņemta — ${ref}`,
        ru: `Поставка принята — ${ref}`,
        en: `Delivery accepted — ${ref}`,
      }[lang];
      const text = {
        lv: `Labdien, ${i.alias}!\n\nPiegāde ${ref} ir pieņemta.\nPieteikts: ${declared}\nPieņemts: ${accepted}\nNoraidīts: ${rejected}\n\nAkts ar bildēm: ${ctx.siteUrl}/piegadatajs\n\n[sup_intake_done]`,
        ru: `Добрый день, ${i.alias}!\n\nПоставка ${ref} принята.\nЗаявлено: ${declared}\nПринято: ${accepted}\nОтклонено: ${rejected}\n\nАкт с фото: ${ctx.siteUrl}/piegadatajs\n\n[sup_intake_done]`,
        en: `Hello ${i.alias},\n\nDelivery ${ref} has been accepted.\nDeclared: ${declared}\nAccepted: ${accepted}\nRejected: ${rejected}\n\nReport with photos: ${ctx.siteUrl}/piegadatajs\n\n[sup_intake_done]`,
      }[lang];
      return {
        subject,
        text,
        spec: {
          preheader: { lv: `Pieņemtas ${accepted} vienības`, ru: `Принято единиц: ${accepted}`, en: `${accepted} units accepted` }[lang],
          headline: { lv: "PIEGĀDE PIEŅEMTA", ru: "ПОСТАВКА ПРИНЯТА", en: "DELIVERY ACCEPTED" }[lang],
          headlineTone: rejected > 0 ? "warn" : "ok",
          greeting: `${{ lv: "Labdien", ru: "Добрый день", en: "Hello" }[lang]}, ${i.alias}!`,
          intro: {
            lv: "Preces ir saskaitītas un pārbaudītas. Zemāk skaitļi; pilns akts ar bildēm par katru noraidīto vienību — kabinetā.",
            ru: "Товар пересчитан и проверен. Ниже цифры; полный акт с фото по каждой отклонённой единице — в кабинете.",
            en: "The goods have been counted and checked. The figures are below; the full report with photos of every rejected unit is in the portal.",
          }[lang],
          facts: [
            { label: { lv: "Piegāde:", ru: "Поставка:", en: "Delivery:" }[lang], value: ref },
            { label: { lv: "Pieteikts:", ru: "Заявлено:", en: "Declared:" }[lang], value: String(declared) },
            { label: { lv: "Pieņemts:", ru: "Принято:", en: "Accepted:" }[lang], value: String(accepted) },
            { label: { lv: "Noraidīts:", ru: "Отклонено:", en: "Rejected:" }[lang], value: String(rejected) },
          ],
          cta: { label: { lv: "Skatīt aktu", ru: "Смотреть акт", en: "View the report" }[lang], url: `${ctx.siteUrl}/piegadatajs` },
          labels,
        },
      };
    }

    // ── S4. Расхождение при приёмке ────────────────────────────────────────
    case "sup_discrepancy": {
      const ref = i.consignmentRef ?? "";
      const by = fmtDate(i.replyByDate, lang);
      const subject = {
        lv: `Neatbilstība piegādē ${ref} — gaidām atbildi`,
        ru: `Расхождение по поставке ${ref} — ждём ответ`,
        en: `Discrepancy in delivery ${ref} — reply needed`,
      }[lang];
      const note = i.discrepancyNote ?? "";
      const text = {
        lv: `Labdien, ${i.alias}!\n\nPieņemot piegādi ${ref}, konstatējām neatbilstību:\n${note}\n\nPieteikts: ${i.declaredCount ?? "—"}, pieņemts: ${i.acceptedCount ?? "—"}, noraidīts: ${i.rejectedCount ?? "—"}.\nLūdzam atbildēt kabinetā līdz ${by}. Ja atbildes nebūs, akts tiks uzskatīts par pieņemtu.\n\n[sup_discrepancy]`,
        ru: `Добрый день, ${i.alias}!\n\nПри приёмке поставки ${ref} обнаружено расхождение:\n${note}\n\nЗаявлено: ${i.declaredCount ?? "—"}, принято: ${i.acceptedCount ?? "—"}, отклонено: ${i.rejectedCount ?? "—"}.\nПросим ответить в кабинете до ${by}. Без ответа акт считается принятым.\n\n[sup_discrepancy]`,
        en: `Hello ${i.alias},\n\nWhile receiving delivery ${ref} we found a discrepancy:\n${note}\n\nDeclared: ${i.declaredCount ?? "—"}, accepted: ${i.acceptedCount ?? "—"}, rejected: ${i.rejectedCount ?? "—"}.\nPlease reply in the portal by ${by}. Without a reply the report is treated as accepted.\n\n[sup_discrepancy]`,
      }[lang];
      return {
        subject,
        text,
        spec: {
          preheader: { lv: `Atbilde līdz ${by}`, ru: `Ответ до ${by}`, en: `Reply by ${by}` }[lang],
          headline: { lv: "NEATBILSTĪBA PIEGĀDĒ", ru: "РАСХОЖДЕНИЕ ПО ПОСТАВКЕ", en: "DELIVERY DISCREPANCY" }[lang],
          headlineTone: "warn",
          greeting: `${{ lv: "Labdien", ru: "Добрый день", en: "Hello" }[lang]}, ${i.alias}!`,
          intro: {
            lv: "Skaitļi nesakrīt ar pavaddokumentiem. Bildes un detaļas ir kabinetā — apskati un apstiprini vai apstrīdi.",
            ru: "Цифры не сошлись с сопроводительными документами. Фото и детали — в кабинете: посмотрите и согласитесь или оспорьте.",
            en: "The counts do not match the paperwork. Photos and details are in the portal — review and either accept or dispute.",
          }[lang],
          facts: [
            { label: { lv: "Piegāde:", ru: "Поставка:", en: "Delivery:" }[lang], value: ref },
            ...(note ? [{ label: { lv: "Konstatēts:", ru: "Обнаружено:", en: "Found:" }[lang], value: note }] : []),
            { label: { lv: "Atbildēt līdz:", ru: "Ответить до:", en: "Reply by:" }[lang], value: by },
          ],
          cta: { label: { lv: "Atbildēt kabinetā", ru: "Ответить в кабинете", en: "Reply in the portal" }[lang], url: `${ctx.siteUrl}/piegadatajs` },
          ctaNote: {
            lv: "Bez atbildes noteiktajā termiņā akts stājas spēkā tāds, kāds ir.",
            ru: "Без ответа в срок акт вступает в силу в текущем виде.",
            en: "With no reply by that date the report stands as it is.",
          }[lang],
          labels,
        },
      };
    }

    // ── S5. Счёт принят ────────────────────────────────────────────────────
    case "sup_invoice_accepted": {
      const num = i.invoiceNumber ?? "";
      const due = fmtDate(i.dueDate, lang);
      const sum = moneyIn(i.amountCents, lang);
      const subject = {
        lv: `Rēķins ${num} pieņemts — apmaksa ${due}`,
        ru: `Счёт ${num} принят — оплата ${due}`,
        en: `Invoice ${num} accepted — payment on ${due}`,
      }[lang];
      const text = {
        lv: `Labdien, ${i.alias}!\n\nRēķins ${num} par ${sum} ir pārbaudīts un apstiprināts apmaksai.\nPlānotais maksājuma datums: ${due}.\n\nStatuss kabinetā: ${ctx.siteUrl}/piegadatajs\n\n[sup_invoice_accepted]`,
        ru: `Добрый день, ${i.alias}!\n\nСчёт ${num} на ${sum} проверен и согласован к оплате.\nПлановая дата платежа: ${due}.\n\nСтатус в кабинете: ${ctx.siteUrl}/piegadatajs\n\n[sup_invoice_accepted]`,
        en: `Hello ${i.alias},\n\nInvoice ${num} for ${sum} has been checked and approved for payment.\nPlanned payment date: ${due}.\n\nStatus in the portal: ${ctx.siteUrl}/piegadatajs\n\n[sup_invoice_accepted]`,
      }[lang];
      return {
        subject,
        text,
        spec: {
          preheader: { lv: `Apmaksa plānota ${due}`, ru: `Оплата запланирована на ${due}`, en: `Payment planned for ${due}` }[lang],
          headline: { lv: "RĒĶINS PIEŅEMTS", ru: "СЧЁТ ПРИНЯТ", en: "INVOICE ACCEPTED" }[lang],
          headlineTone: "ok",
          greeting: `${{ lv: "Labdien", ru: "Добрый день", en: "Hello" }[lang]}, ${i.alias}!`,
          intro: {
            lv: "Rēķins izgājis pārbaudi un apstiprināšanu. Datums zemāk ir tas, uz kuru plānojam maksājumu — atgādināt nevajag.",
            ru: "Счёт прошёл проверку и согласование. Дата ниже — та, на которую запланирован платёж; напоминать не нужно.",
            en: "The invoice has passed checking and approval. The date below is when we plan to pay — no need to chase us.",
          }[lang],
          amount: { label: { lv: "Summa:", ru: "Сумма:", en: "Amount:" }[lang], value: sum },
          facts: [
            { label: { lv: "Rēķins:", ru: "Счёт:", en: "Invoice:" }[lang], value: num },
            { label: { lv: "Apmaksa:", ru: "Оплата:", en: "Payment:" }[lang], value: due },
          ],
          cta: { label: { lv: "Skatīt kabinetā", ru: "Смотреть в кабинете", en: "View in the portal" }[lang], url: `${ctx.siteUrl}/piegadatajs` },
          labels,
        },
      };
    }

    // ── S6. Счёт отклонён ──────────────────────────────────────────────────
    case "sup_invoice_rejected": {
      const num = i.invoiceNumber ?? "";
      const why = i.rejectReason?.trim() ?? { lv: "nav norādīts", ru: "не указана", en: "not stated" }[lang];
      const subject = {
        lv: `Rēķins ${num} noraidīts`,
        ru: `Счёт ${num} отклонён`,
        en: `Invoice ${num} rejected`,
      }[lang];
      const text = {
        lv: `Labdien, ${i.alias}!\n\nRēķinu ${num} par ${moneyIn(i.amountCents, "lv")} nevaram pieņemt apmaksai.\nIemesls: ${why}\n\nLūdzam iesniegt labotu rēķinu kabinetā: ${ctx.siteUrl}/piegadatajs\n\n[sup_invoice_rejected]`,
        ru: `Добрый день, ${i.alias}!\n\nСчёт ${num} на ${moneyIn(i.amountCents, "ru")} не может быть принят к оплате.\nПричина: ${why}\n\nПросим загрузить исправленный счёт в кабинет: ${ctx.siteUrl}/piegadatajs\n\n[sup_invoice_rejected]`,
        en: `Hello ${i.alias},\n\nInvoice ${num} for ${moneyIn(i.amountCents, "en")} cannot be accepted for payment.\nReason: ${why}\n\nPlease upload a corrected invoice in the portal: ${ctx.siteUrl}/piegadatajs\n\n[sup_invoice_rejected]`,
      }[lang];
      return {
        subject,
        text,
        spec: {
          preheader: { lv: "Vajadzīgs labots rēķins", ru: "Нужен исправленный счёт", en: "A corrected invoice is needed" }[lang],
          headline: { lv: "RĒĶINS NORAIDĪTS", ru: "СЧЁТ ОТКЛОНЁН", en: "INVOICE REJECTED" }[lang],
          headlineTone: "warn",
          greeting: `${{ lv: "Labdien", ru: "Добрый день", en: "Hello" }[lang]}, ${i.alias}!`,
          intro: {
            lv: "Rēķinu atgriežam labošanai — apmaksas termiņš sāksies no labotā rēķina saņemšanas.",
            ru: "Возвращаем счёт на исправление — срок оплаты пойдёт от получения исправленного.",
            en: "We are returning the invoice for correction — the payment term starts from the corrected one.",
          }[lang],
          facts: [
            { label: { lv: "Rēķins:", ru: "Счёт:", en: "Invoice:" }[lang], value: num },
            { label: { lv: "Summa:", ru: "Сумма:", en: "Amount:" }[lang], value: moneyIn(i.amountCents, lang) },
            { label: { lv: "Iemesls:", ru: "Причина:", en: "Reason:" }[lang], value: why },
          ],
          cta: { label: { lv: "Iesniegt labotu", ru: "Загрузить исправленный", en: "Upload a corrected invoice" }[lang], url: `${ctx.siteUrl}/piegadatajs` },
          labels,
        },
      };
    }

    // ── S7. Оплата отправлена ──────────────────────────────────────────────
    case "sup_payment_sent": {
      const sum = moneyIn(i.amountCents, lang);
      const when = fmtDate(i.paidAt, lang);
      const nums = (i.invoiceNumbers ?? []).join(", ");
      const subject = {
        lv: `Maksājums nosūtīts — ${sum}`,
        ru: `Платёж отправлен — ${sum}`,
        en: `Payment sent — ${sum}`,
      }[lang];
      const text = {
        lv: `Labdien, ${i.alias}!\n\nMaksājums ${sum} nosūtīts ${when}.\nRēķini: ${nums || "—"}\nMaksājuma references: ${i.paymentRef ?? "—"}\n\n[sup_payment_sent]`,
        ru: `Добрый день, ${i.alias}!\n\nПлатёж ${sum} отправлен ${when}.\nСчета: ${nums || "—"}\nРеференс платежа: ${i.paymentRef ?? "—"}\n\n[sup_payment_sent]`,
        en: `Hello ${i.alias},\n\nA payment of ${sum} was sent on ${when}.\nInvoices: ${nums || "—"}\nPayment reference: ${i.paymentRef ?? "—"}\n\n[sup_payment_sent]`,
      }[lang];
      return {
        subject,
        text,
        spec: {
          preheader: { lv: `Nosūtīts ${when}`, ru: `Отправлен ${when}`, en: `Sent on ${when}` }[lang],
          headline: { lv: "MAKSĀJUMS NOSŪTĪTS", ru: "ПЛАТЁЖ ОТПРАВЛЕН", en: "PAYMENT SENT" }[lang],
          headlineTone: "ok",
          greeting: `${{ lv: "Labdien", ru: "Добрый день", en: "Hello" }[lang]}, ${i.alias}!`,
          intro: {
            lv: "Nauda ir izsūtīta no mūsu konta. Atkarībā no bankas tā parasti ir jūsu kontā tajā pašā vai nākamajā darba dienā.",
            ru: "Деньги отправлены с нашего счёта. В зависимости от банка они обычно у вас в тот же или на следующий рабочий день.",
            en: "The money has left our account. Depending on the banks it usually arrives the same or the next business day.",
          }[lang],
          amount: { label: { lv: "Summa:", ru: "Сумма:", en: "Amount:" }[lang], value: sum },
          facts: [
            ...(nums ? [{ label: { lv: "Rēķini:", ru: "Счета:", en: "Invoices:" }[lang], value: nums }] : []),
            { label: { lv: "Datums:", ru: "Дата:", en: "Date:" }[lang], value: when },
            ...(i.paymentRef ? [{ label: { lv: "References:", ru: "Референс:", en: "Reference:" }[lang], value: i.paymentRef }] : []),
          ],
          cta: { label: { lv: "Maksājumu vēsture", ru: "История платежей", en: "Payment history" }[lang], url: `${ctx.siteUrl}/piegadatajs` },
          labels,
        },
      };
    }

    // ── S8. Месячная сводка ────────────────────────────────────────────────
    case "sup_monthly_report": {
      const period = i.periodLabel ?? "";
      const st = i.sellThroughPercent ?? 0;
      const subject = {
        lv: `Pārskats par ${period}`,
        ru: `Сводка за ${period}`,
        en: `Summary for ${period}`,
      }[lang];
      const text = {
        lv: `Labdien, ${i.alias}!\n\nPārskats par ${period}:\n• pieņemts: ${i.receivedCount ?? 0} vienības\n• pārdots: ${i.soldCount ?? 0} vienības (${st}%)\n• pārdošanas apjoms: ${moneyIn(i.soldGrossCents, "lv")}\n• izmaksāts: ${moneyIn(i.payoutCents, "lv")}\n\nDetaļas kabinetā: ${ctx.siteUrl}/piegadatajs\n\n[sup_monthly_report]`,
        ru: `Добрый день, ${i.alias}!\n\nСводка за ${period}:\n• принято: ${i.receivedCount ?? 0} ед.\n• продано: ${i.soldCount ?? 0} ед. (${st}%)\n• объём продаж: ${moneyIn(i.soldGrossCents, "ru")}\n• выплачено: ${moneyIn(i.payoutCents, "ru")}\n\nДетали в кабинете: ${ctx.siteUrl}/piegadatajs\n\n[sup_monthly_report]`,
        en: `Hello ${i.alias},\n\nSummary for ${period}:\n• received: ${i.receivedCount ?? 0} units\n• sold: ${i.soldCount ?? 0} units (${st}%)\n• sales volume: ${moneyIn(i.soldGrossCents, "en")}\n• paid out: ${moneyIn(i.payoutCents, "en")}\n\nDetails in the portal: ${ctx.siteUrl}/piegadatajs\n\n[sup_monthly_report]`,
      }[lang];
      return {
        subject,
        text,
        spec: {
          preheader: { lv: `Pārdots ${st}% no pieņemtā`, ru: `Продано ${st}% принятого`, en: `${st}% of intake sold` }[lang],
          headline: { lv: "MĒNEŠA PĀRSKATS", ru: "СВОДКА ЗА МЕСЯЦ", en: "MONTHLY SUMMARY" }[lang],
          headlineTone: "accent",
          greeting: `${{ lv: "Labdien", ru: "Добрый день", en: "Hello" }[lang]}, ${i.alias}!`,
          intro: {
            lv: "Īsi par to, kā gāja jūsu precēm pagājušajā mēnesī. Sadalījums pa vienībām ar cenām ir kabinetā.",
            ru: "Коротко о том, как прошёл месяц у ваших товаров. Разбивка по единицам с ценами — в кабинете.",
            en: "A short view of how your goods did last month. The per-unit breakdown with prices is in the portal.",
          }[lang],
          amount: {
            label: { lv: "Pārdošanas apjoms:", ru: "Объём продаж:", en: "Sales volume:" }[lang],
            value: moneyIn(i.soldGrossCents, lang),
            lines: [
              { label: { lv: "Izmaksāts periodā", ru: "Выплачено за период", en: "Paid out in the period" }[lang], value: moneyIn(i.payoutCents, lang) },
            ],
          },
          facts: [
            { label: { lv: "Periods:", ru: "Период:", en: "Period:" }[lang], value: period },
            { label: { lv: "Pieņemts:", ru: "Принято:", en: "Received:" }[lang], value: String(i.receivedCount ?? 0) },
            { label: { lv: "Pārdots:", ru: "Продано:", en: "Sold:" }[lang], value: `${i.soldCount ?? 0} (${st}%)` },
          ],
          cta: { label: { lv: "Atvērt pārskatu", ru: "Открыть отчёт", en: "Open the report" }[lang], url: `${ctx.siteUrl}/piegadatajs` },
          labels,
        },
      };
    }

    // ── S9. Отчёт о продажах и расчёт комиссии (self-billing) ──────────────
    case "sup_sales_report": {
      const period = i.periodLabel ?? "";
      const lots = i.soldLots ?? [];
      const listText = lots.map((l) => `• ${l.title} — ${moneyIn(l.priceCents, lang)}`).join("\n");
      const subject = {
        lv: `Pārdošanas atskaite un aprēķins — ${period}`,
        ru: `Отчёт о продажах и расчёт — ${period}`,
        en: `Sales report and settlement — ${period}`,
      }[lang];
      const text = {
        lv: `Labdien, ${i.alias}!\n\nPārdošanas atskaite par ${period}:\n${listText}\n\nKopā pārdots: ${moneyIn(i.soldGrossCents, "lv")}\nMūsu komisija (${i.commissionPercent ?? 0}%): ${moneyIn(i.commissionCents, "lv")}\nIzmaksai: ${moneyIn(i.payoutCents, "lv")}\n\nAtskaite kabinetā: ${ctx.siteUrl}/piegadatajs\n\n[sup_sales_report]`,
        ru: `Добрый день, ${i.alias}!\n\nОтчёт о продажах за ${period}:\n${listText}\n\nПродано на: ${moneyIn(i.soldGrossCents, "ru")}\nНаша комиссия (${i.commissionPercent ?? 0}%): ${moneyIn(i.commissionCents, "ru")}\nК выплате: ${moneyIn(i.payoutCents, "ru")}\n\nОтчёт в кабинете: ${ctx.siteUrl}/piegadatajs\n\n[sup_sales_report]`,
        en: `Hello ${i.alias},\n\nSales report for ${period}:\n${listText}\n\nSold for: ${moneyIn(i.soldGrossCents, "en")}\nOur commission (${i.commissionPercent ?? 0}%): ${moneyIn(i.commissionCents, "en")}\nDue to you: ${moneyIn(i.payoutCents, "en")}\n\nReport in the portal: ${ctx.siteUrl}/piegadatajs\n\n[sup_sales_report]`,
      }[lang];
      return {
        subject,
        text,
        spec: {
          preheader: { lv: `Izmaksai ${moneyIn(i.payoutCents, lang)}`, ru: `К выплате ${moneyIn(i.payoutCents, lang)}`, en: `Due to you: ${moneyIn(i.payoutCents, lang)}` }[lang],
          headline: { lv: "PĀRDOŠANAS ATSKAITE", ru: "ОТЧЁТ О ПРОДАЖАХ", en: "SALES REPORT" }[lang],
          headlineTone: "accent",
          greeting: `${{ lv: "Labdien", ru: "Добрый день", en: "Hello" }[lang]}, ${i.alias}!`,
          intro: {
            lv: "Šī atskaite aizstāj jūsu rēķinu: tā ir pamats izmaksai. Ja kaut kas nesakrīt, atraksti pirms maksājuma datuma.",
            ru: "Этот отчёт заменяет ваш счёт: он основание для выплаты. Если что-то не сходится — напишите до даты платежа.",
            en: "This report replaces your invoice: it is the basis for the payout. If anything looks wrong, write before the payment date.",
          }[lang],
          amount: {
            label: { lv: "Izmaksai:", ru: "К выплате:", en: "Due to you:" }[lang],
            value: moneyIn(i.payoutCents, lang),
            lines: [
              { label: { lv: "Pārdots kopā", ru: "Продано всего", en: "Sold in total" }[lang], value: moneyIn(i.soldGrossCents, lang) },
              { label: `${{ lv: "Komisija", ru: "Комиссия", en: "Commission" }[lang]} ${i.commissionPercent ?? 0}%`, value: `− ${moneyIn(i.commissionCents, lang)}` },
            ],
          },
          // Период идёт первым фактом намеренно: в сводной шапке письма
          // показывается первый факт, и там уместнее период, чем случайный
          // первый лот из списка.
          facts: [
            { label: { lv: "Periods:", ru: "Период:", en: "Period:" }[lang], value: period },
            ...lots.map((l) => ({ label: `${l.title}:`, value: moneyIn(l.priceCents, lang) })),
          ],
          cta: { label: { lv: "Skatīt atskaiti", ru: "Смотреть отчёт", en: "View the report" }[lang], url: `${ctx.siteUrl}/piegadatajs` },
          labels,
        },
      };
    }

    // ── S10. Непроданный остаток ───────────────────────────────────────────
    case "sup_unsold": {
      const count = i.unsoldCount ?? 0;
      const by = fmtDate(i.decideByDate, lang);
      const days = i.waitingDays ?? 60;
      const subject = {
        lv: `Nepārdotās preces — jālemj līdz ${by}`,
        ru: `Непроданный остаток — решение до ${by}`,
        en: `Unsold items — decision needed by ${by}`,
      }[lang];
      const text = {
        lv: `Labdien, ${i.alias}!\n\n${count} vienības no jūsu piegādēm nav pārdotas ${days} dienu laikā.\nIespējas: pazemināt cenu, izņemt atpakaļ vai norakstīt utilizācijai.\nLūdzam izvēlēties kabinetā līdz ${by}.\n\n${ctx.siteUrl}/piegadatajs\n\n[sup_unsold]`,
        ru: `Добрый день, ${i.alias}!\n\n${count} единиц из ваших поставок не продались за ${days} дн.\nВарианты: снизить цену, забрать обратно или списать на утилизацию.\nПросим выбрать в кабинете до ${by}.\n\n${ctx.siteUrl}/piegadatajs\n\n[sup_unsold]`,
        en: `Hello ${i.alias},\n\n${count} units from your deliveries have not sold within ${days} days.\nOptions: lower the price, take them back, or write them off.\nPlease choose in the portal by ${by}.\n\n${ctx.siteUrl}/piegadatajs\n\n[sup_unsold]`,
      }[lang];
      return {
        subject,
        text,
        spec: {
          preheader: { lv: `${count} vienības gaida lēmumu`, ru: `${count} ед. ждут решения`, en: `${count} units await a decision` }[lang],
          headline: { lv: "NEPĀRDOTĀS PRECES", ru: "НЕПРОДАННЫЙ ОСТАТОК", en: "UNSOLD ITEMS" }[lang],
          headlineTone: "warn",
          greeting: `${{ lv: "Labdien", ru: "Добрый день", en: "Hello" }[lang]}, ${i.alias}!`,
          intro: {
            lv: "Šīs preces stāv noliktavā un neienes neko ne jums, ne mums. Izvēlies, ko ar tām darīt — katra iespēja ir kabinetā ar vienu pogu.",
            ru: "Этот товар стоит на складе и не приносит ничего ни вам, ни нам. Выберите, что с ним делать — каждый вариант в кабинете одной кнопкой.",
            en: "These items sit in the warehouse earning nothing for either of us. Choose what to do — each option is one button in the portal.",
          }[lang],
          facts: [
            { label: { lv: "Vienības:", ru: "Единиц:", en: "Units:" }[lang], value: String(count) },
            { label: { lv: "Noliktavā:", ru: "На складе:", en: "In stock:" }[lang], value: `${days} ${{ lv: "dienas", ru: "дн.", en: "days" }[lang]}` },
            { label: { lv: "Lēmums līdz:", ru: "Решение до:", en: "Decide by:" }[lang], value: by },
          ],
          cta: { label: { lv: "Izvēlēties kabinetā", ru: "Выбрать в кабинете", en: "Choose in the portal" }[lang], url: `${ctx.siteUrl}/piegadatajs` },
          labels,
        },
      };
    }
  }
}

/** Sample data for the panel's preview — plausible, obviously not a real order. */
export function sampleInput(type: NotificationType, opts: { online?: boolean } = {}): TemplateInput {
  const inFiveDays = new Date(Date.now() + 5 * 86_400_000);
  const base: TemplateInput = {
    // A sample checkout link, but only when this deployment has a provider
    // that could mint a real one.
    payUrl: opts.online ? "https://izsoli.lv/api/public/pay/A-1042?t=sample" : null,
    alias: "Elīna Priede",
    lotTitle: "Omega Seamaster, 1970. gadi",
    orderRef: "A-1042",
    totalCents: 25_156,
    hammerCents: 18_900,
    premiumCents: 1_890,
    vatCents: 4_366,
    deadline: inFiveDays,
  };
  // Письма поставщикам: адресат — компания, а не покупатель, поэтому у них
  // своя «болванка» без лота, заказа и покупательских сумм.
  const supBase: TemplateInput = {
    alias: "Jānis Ozols",
    supplierName: "Baltic Wholesale SIA",
    lotTitle: "",
    orderRef: undefined,
    totalCents: undefined,
    payUrl: null,
  };
  switch (type) {
    case "verify_email":
      return { ...base, actionUrl: "https://izsoli.lv/verify-email?token=sample", orderRef: undefined, totalCents: undefined };
    case "outbid":
      return { ...base, amountCents: 21_000, orderRef: undefined, totalCents: undefined };
    case "pickup_ready":
    case "pickup_reminder":
      return { ...base, pickupCode: "418209", deadline: new Date(Date.now() + 14 * 86_400_000) };
    case "unpaid_cancelled":
      return { ...base, feeCents: 1_258 };
    case "no_pickup_cancelled":
      return { ...base, feeCents: 1_258, refundCents: 23_898 };
    case "shipped":
      return { ...base, carrier: "Omniva", machineName: "Rīga, Alfa pakomāts", barcode: "CC123456789LV", trackingUrl: "https://omniva.lv/track" };
    case "refunded":
      return { ...base, refundCents: 25_156, reason: "Prece neatbilda aprakstam" };
    case "checked_in":
      return { ...base, ticketNumber: 119, lineCount: 2 };
    case "saved_search_hits":
      return {
        ...base,
        orderRef: undefined, totalCents: undefined, hammerCents: undefined, premiumCents: undefined, vatCents: undefined,
        searchName: "Rolex pulksteņi",
        totalCount: 4,
        lots: [
          { title: "Rolex Datejust 36, 1985", priceCents: 312_000 },
          { title: "Rolex Air-King, 2001", priceCents: 258_000 },
          { title: "Tudor Black Bay 58", priceCents: 189_000 },
        ],
      };
    case "watchlist_ending":
      return {
        ...base,
        orderRef: undefined, totalCents: undefined, hammerCents: undefined, premiumCents: undefined, vatCents: undefined,
        lots: [
          { title: "Omega Seamaster, 1970. gadi", priceCents: 25_156, endsAt: new Date(Date.now() + 6 * 3_600_000) },
          { title: "Dyson V15 putekļsūcējs", priceCents: 18_900, endsAt: new Date(Date.now() + 9 * 3_600_000) },
        ],
      };
    case "welcome_reminder":
      return { ...base, orderRef: undefined, totalCents: undefined, promoCode: "SVEIKI10", promoPercent: 10, promoDeadline: inFiveDays };
    case "winback_offer":
      return { ...base, orderRef: undefined, totalCents: undefined, promoCode: "ATPAKAL15", promoPercent: 15, promoDeadline: new Date(Date.now() + 14 * 86_400_000), categoryLabel: "Pulksteņi" };
    case "inactive_nudge":
      return {
        ...base, orderRef: undefined, totalCents: undefined, categoryLabel: "Elektronika",
        lots: [
          { title: "Sony WH-1000XM5 austiņas", priceCents: 21_900 },
          { title: "iPad Air M2, 128 GB", priceCents: 54_900 },
        ],
      };
    case "lost_bid_similar":
      return {
        ...base, orderRef: undefined, totalCents: undefined,
        lots: [
          { title: "Omega Speedmaster, 1998", priceCents: 289_000 },
          { title: "Longines Conquest, 2015", priceCents: 96_000 },
        ],
      };
    case "review_request":
      return { ...base, actionUrl: "https://izsoli.lv/atsauksme?order=A-1042" };
    case "referral_invite":
      return { ...base, orderRef: undefined, totalCents: undefined, referralUrl: "https://izsoli.lv/?ref=ELINA7", referralSignupCents: 500, referralOrderCents: 1_000, referralPercent: 15 };
    case "abandoned_bid":
      return { ...base, orderRef: undefined, totalCents: undefined, amountCents: 18_900, actionUrl: "https://izsoli.lv/lots/sample" };
    case "second_purchase":
      return {
        ...base, orderRef: undefined, totalCents: undefined, categoryLabel: "Pulksteņi", pointsBalanceCents: 1_200,
        lots: [
          { title: "Seiko Presage, 2020", priceCents: 34_900 },
          { title: "Tissot PRX, 2022", priceCents: 28_500 },
        ],
      };
    case "gift_card_received":
      return { ...base, orderRef: undefined, totalCents: undefined, amountCents: 5_000 };

    // ── Письма части A ──
    case "password_reset":
      return { ...base, orderRef: undefined, totalCents: undefined, actionUrl: "https://izsoli.lv/reset-password?token=paraugs", validHours: 1 };
    case "points_expiring":
      return { ...base, orderRef: undefined, totalCents: undefined, expiringCents: 4_000, pointsBalanceCents: 6_500, expiresAt: inFiveDays };
    case "security_alert":
      return { ...base, orderRef: undefined, totalCents: undefined, securityEvent: "new_device", deviceLabel: "Chrome · Windows · Rīga", eventAt: new Date() };
    case "delivered":
      return { ...base, carrier: "Omniva", machineName: "Rīga, Alfa pakomāts", waitingDays: 7, trackingUrl: "https://omniva.lv/track" };
    case "bid_voided":
      return { ...base, orderRef: undefined, totalCents: undefined, amountCents: 18_900, reason: "tehniska kļūda solīšanā" };
    case "lot_withdrawn":
      return { ...base, orderRef: undefined, totalCents: undefined, amountCents: 18_900, reason: "prece atsaukta pārbaudes dēļ" };
    case "payment_failed":
      return { ...base, failureReason: "banka noraidīja darījumu", payUrl: opts.online ? "https://izsoli.lv/maksat/A-1042" : null };

    // ── Письма поставщикам ──
    case "sup_invite":
      return { ...supBase, inviteUrl: "https://izsoli.lv/piegadatajs/uzaicinajums?token=paraugs", inviteDays: 7 };
    case "sup_welcome":
      return { ...supBase, commissionPercent: 25, inviteDays: 14 };
    case "sup_intake_done":
      return { ...supBase, consignmentRef: "CON-0042", declaredCount: 120, acceptedCount: 116, rejectedCount: 4 };
    case "sup_discrepancy":
      return {
        ...supBase, consignmentRef: "CON-0042", declaredCount: 120, acceptedCount: 116, rejectedCount: 4,
        discrepancyNote: "4 vienības ar bojātu iepakojumu un ūdens pēdām",
        replyByDate: inFiveDays,
      };
    case "sup_invoice_accepted":
      return { ...supBase, invoiceNumber: "PS-2026-114", amountCents: 184_000, dueDate: inFiveDays };
    case "sup_invoice_rejected":
      return { ...supBase, invoiceNumber: "PS-2026-114", amountCents: 184_000, rejectReason: "summa nesakrīt ar pieņemšanas aktu (CON-0042)" };
    case "sup_payment_sent":
      return { ...supBase, amountCents: 184_000, paidAt: new Date(), paymentRef: "IZS-2026-0731", invoiceNumbers: ["PS-2026-114", "PS-2026-118"] };
    case "sup_monthly_report":
      return { ...supBase, periodLabel: "2026. gada jūlijs", receivedCount: 240, soldCount: 186, soldGrossCents: 812_400, sellThroughPercent: 78, payoutCents: 512_000 };
    case "sup_sales_report":
      return {
        ...supBase, periodLabel: "2026. gada jūlijs", soldGrossCents: 812_400, commissionPercent: 25,
        commissionCents: 203_100, payoutCents: 609_300,
        soldLots: [
          { title: "Seiko Presage, 2020", priceCents: 34_900 },
          { title: "Bosch urbjmašīna GSB 18V", priceCents: 12_500 },
          { title: "Dyson V11 putekļsūcējs", priceCents: 28_900 },
        ],
      };
    case "sup_unsold":
      return { ...supBase, unsoldCount: 34, waitingDays: 60, decideByDate: inFiveDays };

    default:
      return base;
  }
}
