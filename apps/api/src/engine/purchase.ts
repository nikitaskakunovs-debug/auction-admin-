import { counters, customers, invoices, items, listings, markets, orders } from "@auction/db";
import { assertItemTransition, computeInvoice, qualifiesForReverseCharge, type ItemStatus } from "@auction/domain";
import { eq, sql } from "drizzle-orm";
import { outstandingFeeCents } from "./fees.js";
import type { AppContext } from "../context.js";
import { issueInvoice } from "./invoices.js";
import { enqueueNotification } from "./notifications.js";
import { buildPayUrl } from "./payLink.js";
import { heldByOthers, releaseHold } from "./reservations.js";
import { slackBuyNow } from "./slackNotify.js";

/**
 * Fixed-price "buy it now". Stock-safe: the listing + item rows are locked
 * FOR UPDATE so concurrent buyers serialize.
 *
 * Two shapes of stock:
 *  — quantity 1 (the classic unique lot): the backing item's `listed` status
 *    is the availability gate; the sale archives the listing and walks the
 *    item into the post-sale lifecycle;
 *  — quantity N (an e-commerce style multi-stock lot): each sale takes ONE
 *    unit. The display item stays `listed` while stock remains; the sold unit
 *    gets its own cloned item row (warehouse flows — picking, shipping,
 *    returns — drive item status per PHYSICAL unit, so units must not share a
 *    row). The last unit sells through the classic path.
 *
 * Ten-minute checkout reservations (Redis) narrow availability: units held by
 * OTHER people are not for sale, the buyer's own hold never blocks them.
 * Reuses the auction post-sale machinery (order + sequential invoice + item
 * lifecycle) with no buyer's premium (that's an auction-hammer commission).
 */

export type BuyError =
  | "LISTING_NOT_FOUND"
  | "NOT_FIXED_PRICE"
  | "NOT_AVAILABLE"
  | "BIDDER_BLOCKED"
  | "FEES_OUTSTANDING"
  | "NO_PRICE";

export interface BuyResult {
  ok: true;
  orderRef: string;
  totalCents: number;
  /** S1 — extra fields the Slack mirror needs after the commit. */
  slack?: { title: string; priceCents: number; orderId: string; alias: string };
}

export async function buyNow(
  ctx: AppContext,
  args: {
    listingId: string;
    customerId: string;
    holderIds?: string[];
    /** Применённый промокод: скидка на ЭТУ строку корзины. Итог заказа
     *  считается от уменьшенной финальной цены той же раскладкой. */
    promo?: { id: string; discountCents: number };
  },
): Promise<BuyResult | { ok: false; code: BuyError }> {
  const now = ctx.now();
  const mine = [args.customerId, ...(args.holderIds ?? [])];

  // Единицы, зарезервированные ДРУГИМИ оформляющими, покупке недоступны.
  // Считаем до транзакции: Redis внутри блокировки строк держать незачем.
  const othersHold = await heldByOthers(ctx, args.listingId, mine);

  const result = await ctx.db.transaction(async (tx): Promise<BuyResult | { ok: false; code: BuyError }> => {
    const [listing] = await tx.select().from(listings).where(eq(listings.id, args.listingId)).for("update");
    if (!listing) return { ok: false, code: "LISTING_NOT_FOUND" };
    if (listing.type !== "fixed") return { ok: false, code: "NOT_FIXED_PRICE" };
    if (listing.priceCents === null) return { ok: false, code: "NO_PRICE" };
    if (listing.status !== "published") return { ok: false, code: "NOT_AVAILABLE" };
    if (listing.quantity - othersHold <= 0) return { ok: false, code: "NOT_AVAILABLE" };

    const [buyer] = await tx.select().from(customers).where(eq(customers.id, args.customerId));
    if (!buyer || buyer.blocked || buyer.erasedAt !== null) return { ok: false, code: "BIDDER_BLOCKED" };
    // Outstanding restock fees pause the account until settled or waived.
    if ((await outstandingFeeCents(tx, args.customerId)) > 0) return { ok: false, code: "FEES_OUTSTANDING" };

    // The single backing item's `listed` status is the availability gate.
    const [item] = await tx.select().from(items).where(eq(items.id, listing.itemId)).for("update");
    if (!item || item.status !== "listed") return { ok: false, code: "NOT_AVAILABLE" };
    const [market] = await tx.select().from(markets).where(eq(markets.code, listing.marketCode));

    const reverseCharge = qualifiesForReverseCharge({
      sellerCountry: market!.code,
      buyerVatNo: buyer.vatNo,
      buyerVies: buyer.vies ?? null,
      nowMs: now.getTime(),
    });
    // Цена «Pirkt tagad» — финальная: НДС уже внутри, счёт её раскладывает, а
    // не увеличивает. Промокод уменьшает финальную цену ДО раскладки: скидка
    // честно проходит через НДС, а не мимо него.
    //
    // Комиссия покупателя здесь НУЛЕВАЯ, и это не упрощение. Комиссия — плата
    // за проведение торгов; в продаже по фиксированной цене торгов нет, цены
    // молотка нет, и делить сумму надвое не на чем. Раньше делили по ставке
    // рынка, и покупатель получал счёт со строкой «комиссия 10%» за услугу,
    // которой не было, а в учёте эти деньги ложились на счёт выручки от
    // услуг вместо выручки от товара. Итог для покупателя не меняется — он
    // платит цену с ценника.
    const promoDiscountCents = Math.min(args.promo?.discountCents ?? 0, listing.priceCents);
    const inv = computeInvoice({
      grossCents: listing.priceCents - promoDiscountCents,
      buyerPremiumBp: 0,
      vatRateBp: market!.vatRateBp,
      reverseCharge,
    });

    const [counter] = await tx
      .update(counters)
      .set({ value: sql`${counters.value} + 1` })
      .where(eq(counters.key, "order_ref"))
      .returning({ value: counters.value });
    const ref = `A-${counter!.value}`;
    const paymentDeadlineAt = new Date(now.getTime() + ctx.config.paymentDeadlineHours * 3_600_000);

    // Одна единица из остатка или последняя? Последняя идёт классическим
    // путём — витринная карточка и есть проданная вещь. Не последняя получает
    // собственную карточку-единицу: складские потоки (сборка, отправка,
    // возврат) ведут статус по физической вещи, и делить одну строку между
    // покупателями нельзя. Витринная карточка остаётся listed, лот — published.
    const lastUnit = listing.quantity <= 1;
    let soldItemId = item.id;
    if (!lastUnit) {
      // Номер единицы — по числу заказов лота: отменённые не освобождают
      // номер, артикул единицы не повторяется.
      const [unitRow] = await tx
        .select({ n: sql<string>`count(*)` })
        .from(orders)
        .where(eq(orders.listingId, listing.id));
      const [unit] = await tx
        .insert(items)
        .values({
          sku: `${item.sku}-U${Number(unitRow!.n) + 2}`,
          title: item.title,
          description: item.description,
          condition: item.condition,
          conditionNotes: item.conditionNotes,
          category: item.category,
          location: item.location,
          locationId: item.locationId,
          weightGrams: item.weightGrams,
          dims: item.dims,
          photos: item.photos,
          consignmentId: item.consignmentId,
          costCents: item.costCents,
          marketCode: item.marketCode,
          status: "awaiting_payment",
        })
        .returning({ id: items.id });
      soldItemId = unit!.id;
      await tx
        .update(listings)
        .set({ quantity: listing.quantity - 1, updatedAt: now })
        .where(eq(listings.id, listing.id));
    }

    const [order] = await tx
      .insert(orders)
      .values({
        ref,
        listingId: listing.id,
        itemId: soldItemId,
        customerId: buyer.id,
        customerAlias: buyer.alias,
        customerEmail: buyer.email,
        marketCode: market!.code,
        hammerCents: inv.hammerCents,
        premiumCents: inv.premiumCents,
        vatCents: inv.vatCents,
        vatRateBp: inv.vatRateBp,
        shippingCents: 0,
        totalCents: inv.totalCents,
        reverseCharge,
        status: "awaiting_payment",
        paymentDeadlineAt,
        // Код с нулевой товарной скидкой (free_shipping) тоже сохраняется —
        // fulfilment по нему обнулит доставку.
        ...(args.promo ? { promoCodeId: args.promo.id, promoDiscountCents } : {}),
        // Два снимка «откуда пришёл клиент» — первое касание (кто привёл) и
        // последнее (что привело к этой покупке). Отчёт по рекламе умеет
        // считать по обеим моделям, и обе остаются верны после удаления
        // аккаунта: цифры кампаний не должны зависеть от чужого ухода.
        attribution: buyer.attribution ?? null,
        attributionLast: buyer.attributionLast ?? buyer.attribution ?? null,
      })
      .returning({ id: orders.id });

    await issueInvoice(tx, order!.id, now);

    if (lastUnit) {
      // The last (or only) unit is sold: close the listing.
      await tx
        .update(listings)
        .set({ quantity: 0, status: "archived", updatedAt: now })
        .where(eq(listings.id, listing.id));

      // Move the item into the post-sale lifecycle (listed → won → awaiting_payment).
      assertItemTransition(item.status as ItemStatus, "won");
      assertItemTransition("won", "awaiting_payment");
      await tx.update(items).set({ status: "awaiting_payment", updatedAt: now }).where(eq(items.id, item.id));
    }

    await enqueueNotification(ctx, tx, {
      customerId: buyer.id,
      type: "purchased",
      template: {
        alias: "",
        lotTitle: listing.title,
        orderRef: ref,
        totalCents: inv.totalCents,
        hammerCents: inv.hammerCents,
        premiumCents: inv.premiumCents,
        vatCents: inv.vatCents,
        deadline: paymentDeadlineAt,
        payUrl: buildPayUrl(ctx, ref, paymentDeadlineAt),
      },
    });

    return { ok: true, orderRef: ref, totalCents: inv.totalCents, slack: { title: listing.title, priceCents: listing.priceCents!, orderId: order!.id, alias: buyer.alias } };
  });

  // Покупка состоялась — резерв больше не нужен, единица списана по-настоящему.
  if (result.ok) await releaseHold(ctx, args.listingId, mine).catch(() => undefined);

  if (result.ok && result.slack) {
    slackBuyNow(ctx, {
      title: result.slack.title,
      priceCents: result.slack.priceCents,
      orderRef: result.orderRef!,
      bidderAlias: result.slack.alias,
      orderId: result.slack.orderId,
    });
  }
  return result;
}
