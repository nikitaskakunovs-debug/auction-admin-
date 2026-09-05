import { items, orders } from "@auction/db";
import { eq } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { recallMetaIdentity } from "../routes/meta.js";
import { hasMarketingConsent, identityOfCustomer, logMetaSkipped, sendMetaEvent } from "./metaCapi.js";

/**
 * Событие покупки для Meta.
 *
 * Отправляется только из движка расчёта и только после подтверждённой оплаты:
 * ни открытие кассы, ни создание неоплаченного заказа, ни возврат на страницу
 * подтверждения покупкой не считаются. Повтор невозможен по построению —
 * заказ переходит в «оплачен» ровно один раз, а журнал отправок держит
 * уникальный event_id.
 *
 * event_id формируется правилом `purchase-<номер заказа>`, и по этому же
 * правилу его строит витрина. Номер заказа — тот самый transaction_id, что
 * уходит в GA4 и Google Ads, поэтому три системы считают одну и ту же покупку.
 */
export function purchaseEventId(orderRef: string): string {
  return `purchase-${orderRef}`;
}

export async function purchaseToMeta(
  ctx: AppContext,
  order: typeof orders.$inferSelect,
): Promise<void> {
  if (!ctx.config.metaCapi) return;

  const eventId = purchaseEventId(order.ref);
  const allowed = await hasMarketingConsent(ctx, { customerId: order.customerId });
  if (!allowed) {
    await logMetaSkipped(ctx, {
      eventId, eventName: "Purchase", customerId: order.customerId, reason: "no_marketing_consent",
    });
    return;
  }

  const [item] = await ctx.db
    .select({ sku: items.sku, title: items.title, category: items.category })
    .from(items)
    .where(eq(items.id, order.itemId));

  // Браузерные метки человека, запомненные на его прошлых событиях: оплата
  // подтверждается без участия браузера, и взять их в этот момент больше
  // неоткуда, а без них сопоставление в Meta заметно хуже.
  const cached = await recallMetaIdentity(ctx, order.customerId);
  const profile = await identityOfCustomer(ctx, order.customerId);

  // Цена без НДС — та же, что в GA4: лот плюс обязательная комиссия. Так
  // выручка в Meta, GA4 и Google Ads сходится до цента.
  const netCents = order.hammerCents + order.premiumCents;
  const sku = item?.sku ?? order.itemId;

  sendMetaEvent(ctx, {
    eventName: "Purchase",
    eventId,
    // Страницы у серверного события нет — указываем ту, на которую человек
    // возвращается после банка; Meta требует поле заполненным.
    eventSourceUrl: `${ctx.config.storefrontBaseUrl}/account?tab=pirkumi`,
    eventTime: order.paidAt ?? ctx.now(),
    identity: {
      ...profile,
      // Телефон и адрес получателя знает сам заказ — это лучшее сопоставление,
      // какое у нас есть, и оно относится именно к этому покупателю.
      phone: order.recipientPhone,
      ...(order.shippingTo?.country ? { country: order.shippingTo.country } : {}),
      ...(order.shippingTo?.zip ? { zip: order.shippingTo.zip } : {}),
      ...(order.shippingTo?.city ? { city: order.shippingTo.city } : {}),
      ...(cached.fbp ? { fbp: cached.fbp } : {}),
      ...(cached.fbc ? { fbc: cached.fbc } : {}),
      ...(cached.ip ? { ip: cached.ip } : {}),
      ...(cached.ua ? { userAgent: cached.ua } : {}),
    },
    customData: {
      content_ids: [sku],
      content_type: "product",
      ...(item?.title ? { content_name: item.title } : {}),
      ...(item?.category ? { content_category: item.category } : {}),
      contents: [{ id: sku, quantity: 1, item_price: netCents / 100 }],
      num_items: 1,
      value: netCents / 100,
      currency: "EUR",
      order_id: order.ref,
    },
  });
}
