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

export function track(event: string, params: Record<string, unknown> = {}): void {
  // ecommerce GA4 читает из отдельного ключа; перед событием его надо
  // обнулить, иначе параметры прошлой покупки подмешиваются в следующую.
  const layer = dl();
  if (!layer) return;
  if ("ecommerce" in params) layer.push({ ecommerce: null });
  layer.push({ event, ...params });
}

/** Товарная строка GA4 (items[]): по ней отчёты видят, какие категории и
 *  лоты приносят деньги, а не только сумму кассы. */
export function gaItem(input: { id: string; name: string; category?: string | null; priceCents: number }) {
  return {
    item_id: input.id,
    item_name: input.name,
    ...(input.category ? { item_category: input.category } : {}),
    price: input.priceCents / 100,
    quantity: 1,
  };
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
