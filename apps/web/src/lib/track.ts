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

export function track(event: string, params: Record<string, unknown> = {}): void {
  const layer = dl();
  if (!layer) return;
  if ("ecommerce" in params || ECOM_EVENTS.has(event)) layer.push({ ecommerce: null });
  layer.push({ event, ...params });
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
