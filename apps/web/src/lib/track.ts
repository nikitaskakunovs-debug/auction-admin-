"use client";

/** Мост к Google Tag Manager.
 *
 *  События уходят в dataLayer; если GTM на этой сборке не подключён
 *  (нет NEXT_PUBLIC_GTM_ID) — вызовы тихо ничего не делают, поэтому
 *  инструментированные места не проверяют окружение сами.
 *
 *  Персональные данные сюда не попадают: только идентификаторы лотов,
 *  суммы и названия событий. Кто именно смотрел — решают пиксели после
 *  согласия, и это их зона ответственности, не наша.
 */

type DataLayer = Array<Record<string, unknown> | IArguments>;

const dl = (): DataLayer | null => {
  if (typeof window === "undefined") return null;
  return (window as unknown as { dataLayer?: DataLayer }).dataLayer ?? null;
};

/** События, у которых GA4 читает товары из ключа ecommerce. Перед КАЖДЫМ
 *  таким событием ключ обнуляется — даже если карточка товара не собралась:
 *  иначе GTM рекурсивно домешает товар из прошлого события (парка вместо
 *  зāģis — реальный случай с теста). */
const ECOM_EVENTS = new Set(["view_item", "add_to_cart", "view_cart", "begin_checkout", "purchase"]);

/** Поисковую строку человек пишет сам — иногда это его же почта или телефон.
 *  Отправлять такое в аналитику нельзя (политика Google и GDPR), поэтому
 *  заменяем на метку: сам факт поиска остаётся, личные данные — нет. */
function redact(value: string): string {
  return value
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]")
    .replace(/(?:\+?\d[\s()-]?){7,}/g, "[phone]");
}

export function track(event: string, params: Record<string, unknown> = {}): void {
  const layer = dl();
  if (!layer) return;
  const safe = typeof params.search_term === "string"
    ? { ...params, search_term: redact(params.search_term) }
    : params;
  if ("ecommerce" in safe || ECOM_EVENTS.has(event)) layer.push({ ecommerce: null });
  layer.push({ event, ...safe });
}

/** Товарная строка GA4 (items[]) по ТЗ аналитики:
 *  item_id — номер лота (SKU, DEMO-KID-B), UUID карточки — отдельно как
 *  listing_id; price — лот + обязательная комиссия, БЕЗ НДС; gross_price —
 *  с НДС. Одинаковый item_id держит воронку от просмотра до покупки. */
export function gaItem(i: {
  sku: string; listingId?: string; name: string; category?: string | null;
  netCents: number; hammerCents?: number; feeCents?: number;
  vatRateBp?: number; grossCents?: number;
}) {
  return {
    item_id: i.sku,
    ...(i.listingId ? { listing_id: i.listingId } : {}),
    item_name: i.name,
    ...(i.category ? { item_category: i.category } : {}),
    price: i.netCents / 100,
    quantity: 1,
    ...(i.hammerCents !== undefined ? { hammer_price: i.hammerCents / 100 } : {}),
    ...(i.feeCents !== undefined ? { auction_fee: i.feeCents / 100 } : {}),
    ...(i.vatRateBp !== undefined ? { vat_rate: i.vatRateBp / 100 } : {}),
    ...(i.grossCents !== undefined ? { gross_price: i.grossCents / 100 } : {}),
  };
}

/** Заказ движка → карточка товара + суммы. Net = молоток + комиссия (без
 *  НДС), gross = с НДС; доставка в gross_price лота не входит — она общая. */
export interface OrderLike {
  ref: string; itemSku: string; itemTitle: string; itemCategory?: string | null;
  hammerCents: number; premiumCents: number; vatCents: number;
  vatRateBp?: number; reverseCharge?: boolean;
  shippingCents: number; handlingCents: number; totalCents: number;
}
export function orderEcom(o: OrderLike) {
  const netCents = o.hammerCents + o.premiumCents;
  return {
    netCents,
    taxCents: o.vatCents,
    shippingCents: o.shippingCents + o.handlingCents,
    grossCents: o.totalCents,
    commissionCents: o.premiumCents,
    vatScheme: o.reverseCharge ? "reverse_charge" : "standard",
    item: gaItem({
      sku: o.itemSku, name: o.itemTitle, category: o.itemCategory,
      netCents, hammerCents: o.hammerCents, feeCents: o.premiumCents,
      ...(o.vatRateBp !== undefined ? { vatRateBp: o.vatRateBp } : {}),
      grossCents: netCents + o.vatCents,
    }),
  };
}

/** First-party данные для Google Ads Enhanced Conversions (begin_checkout и
 *  purchase). Правила:
 *  — собираются ТОЛЬКО при согласии на маркетинг (сигнал ad_user_data):
 *    без галочки в плашке объект вообще не попадает в dataLayer;
 *  — ничего не хэшируем сами — это делает тег Google в GTM;
 *  — почта в lowercase без пробелов, телефон только в международном формате,
 *    отсутствующие поля не передаются;
 *  — в GA4 эти поля не уходят: их читает только тег Google Ads, GA4-теги
 *    к user_data не привязаны. */
export function adsUserData(i: {
  email?: string | null; phone?: string | null; name?: string | null;
  country?: string | null; zip?: string | null;
}): { user_data?: Record<string, unknown> } {
  try {
    const c = JSON.parse(localStorage.getItem("izsoli_cc_v1") ?? "null") as { marketing?: boolean } | null;
    if (c?.marketing !== true) return {};
  } catch { return {}; }
  const email = i.email?.trim().toLowerCase() || undefined;
  const cleaned = (i.phone ?? "").replace(/[\s()-]/g, "");
  const phone = /^\+\d{8,15}$/.test(cleaned) ? cleaned : undefined;
  const parts = (i.name ?? "").trim().split(/\s+/).filter(Boolean);
  const address = {
    ...(parts[0] ? { first_name: parts[0] } : {}),
    ...(parts.length > 1 ? { last_name: parts.slice(1).join(" ") } : {}),
    ...(i.country ? { country: i.country } : {}),
    ...(i.zip ? { postal_code: i.zip } : {}),
  };
  const user_data = {
    ...(email ? { email } : {}),
    ...(phone ? { phone_number: phone } : {}),
    ...(Object.keys(address).length > 0 ? { address } : {}),
  };
  return Object.keys(user_data).length > 0 ? { user_data } : {};
}

/** purchase — ровно один раз на заказ: обновление страницы чека или возврат
 *  на неё не должны дублировать конверсию (плюс GA4 сам дедуплицирует по
 *  transaction_id — двойная страховка). */
export function purchaseOnce(ref: string, params: Record<string, unknown>): void {
  try {
    const key = `izsoli_ga_purchase_${ref}`;
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, "1");
  } catch { /* приватный режим — положимся на дедупликацию GA4 */ }
  track("purchase", params);
}

/** Обновление Google Consent Mode при каждом решении в плашке cookie.
 *  Consent-команды читаются только из arguments-объекта (стиль gtag) —
 *  обычный объект в dataLayer Consent Mode не увидит. */
export function consentUpdate(analytics: boolean, marketing: boolean): void {
  const layer = dl();
  if (!layer) return;
  /* eslint-disable prefer-rest-params */
  function gtag() { layer!.push(arguments); }
  (gtag as unknown as (...a: unknown[]) => void)("consent", "update", {
    analytics_storage: analytics ? "granted" : "denied",
    ad_storage: marketing ? "granted" : "denied",
    ad_user_data: marketing ? "granted" : "denied",
    ad_personalization: marketing ? "granted" : "denied",
  });
}
