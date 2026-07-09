import { counters, customers, invoices, items, listings, markets, orders } from "@auction/db";
import { assertItemTransition, computeInvoice, qualifiesForReverseCharge, type ItemStatus } from "@auction/domain";
import { eq, sql } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { issueInvoice } from "./invoices.js";
import { enqueueNotification } from "./notifications.js";

/**
 * Fixed-price "buy it now". A fixed listing is backed by ONE unique warehouse
 * item (the platform's lots are unique), so it sells exactly once — the
 * item's `listed` status is the availability gate. Stock-safe: the listing +
 * item rows are locked FOR UPDATE so concurrent buyers serialize and only one
 * wins. Reuses the auction post-sale machinery (order + sequential invoice +
 * item lifecycle) with no buyer's premium (that's an auction-hammer commission).
 */

export type BuyError =
  | "LISTING_NOT_FOUND"
  | "NOT_FIXED_PRICE"
  | "NOT_AVAILABLE"
  | "BIDDER_BLOCKED"
  | "NO_PRICE";

export interface BuyResult {
  ok: true;
  orderRef: string;
  totalCents: number;
}

export async function buyNow(
  ctx: AppContext,
  args: { listingId: string; customerId: string },
): Promise<BuyResult | { ok: false; code: BuyError }> {
  const now = ctx.now();

  const result = await ctx.db.transaction(async (tx): Promise<BuyResult | { ok: false; code: BuyError }> => {
    const [listing] = await tx.select().from(listings).where(eq(listings.id, args.listingId)).for("update");
    if (!listing) return { ok: false, code: "LISTING_NOT_FOUND" };
    if (listing.type !== "fixed") return { ok: false, code: "NOT_FIXED_PRICE" };
    if (listing.priceCents === null) return { ok: false, code: "NO_PRICE" };
    if (listing.status !== "published") return { ok: false, code: "NOT_AVAILABLE" };

    const [buyer] = await tx.select().from(customers).where(eq(customers.id, args.customerId));
    if (!buyer || buyer.blocked || buyer.erasedAt !== null) return { ok: false, code: "BIDDER_BLOCKED" };

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
    // Fixed-price: the listed price is the goods value; no buyer's premium.
    const inv = computeInvoice({
      hammerCents: listing.priceCents,
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

    const [order] = await tx
      .insert(orders)
      .values({
        ref,
        listingId: listing.id,
        itemId: item.id,
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
      })
      .returning({ id: orders.id });

    await issueInvoice(tx, order!.id, now);

    // The unique item is sold: close the listing.
    await tx
      .update(listings)
      .set({ quantity: 0, status: "archived", updatedAt: now })
      .where(eq(listings.id, listing.id));

    // Move the item into the post-sale lifecycle (listed → won → awaiting_payment).
    assertItemTransition(item.status as ItemStatus, "won");
    assertItemTransition("won", "awaiting_payment");
    await tx.update(items).set({ status: "awaiting_payment", updatedAt: now }).where(eq(items.id, item.id));

    await enqueueNotification(tx, {
      customerId: buyer.id,
      type: "purchased",
      template: { alias: "", lotTitle: listing.title, orderRef: ref, totalCents: inv.totalCents, deadline: paymentDeadlineAt },
    });

    return { ok: true, orderRef: ref, totalCents: inv.totalCents };
  });

  return result;
}
