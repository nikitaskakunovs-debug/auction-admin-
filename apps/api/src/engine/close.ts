import {
  auctions,
  counters,
  customers,
  items,
  listings,
  markets,
  orders,
} from "@auction/db";
import {
  assertAuctionTransition,
  assertItemTransition,
  computeInvoice,
  qualifiesForReverseCharge,
  type AuctionStatus,
  type ItemStatus,
} from "@auction/domain";
import { eq, sql } from "drizzle-orm";
import { writeAudit, SYSTEM_ACTOR, type Actor } from "../audit.js";
import { publishAuctionEvent, type AppContext } from "../context.js";
import { issueInvoice } from "./invoices.js";
import { enqueueNotification } from "./notifications.js";
import { buildPayUrl } from "./payLink.js";

export interface CloseOutcome {
  ok: true;
  auctionId: string;
  status: AuctionStatus;
  orderRef?: string;
  hammerCents?: number;
}

/**
 * Close a live auction whose end time has passed: decide the outcome,
 * create the winner's order (hammer + premium + VAT per market config,
 * reverse charge when the buyer qualifies), and advance the item lifecycle.
 * Runs under the auction row lock so it cannot race a concurrent bid.
 */
export async function closeAuction(
  ctx: AppContext,
  auctionId: string,
  actor: Actor = SYSTEM_ACTOR,
): Promise<CloseOutcome | { ok: false; code: string }> {
  const now = ctx.now();

  const result = await ctx.db.transaction(async (tx) => {
    const [auction] = await tx.select().from(auctions).where(eq(auctions.id, auctionId)).for("update");
    if (!auction) return { ok: false as const, code: "AUCTION_NOT_FOUND" };
    if (auction.status !== "live") return { ok: false as const, code: "AUCTION_NOT_LIVE" };
    if (now.getTime() < auction.endsAt.getTime()) return { ok: false as const, code: "AUCTION_NOT_ENDED" };

    const [listing] = await tx.select().from(listings).where(eq(listings.id, auction.listingId));
    const [item] = await tx.select().from(items).where(eq(items.id, listing!.itemId));

    const transitionItem = async (to: ItemStatus, from: ItemStatus) => {
      assertItemTransition(from, to);
      await tx.update(items).set({ status: to, updatedAt: now }).where(eq(items.id, item!.id));
      return to;
    };

    // ── Won ───────────────────────────────────────────────────────────────
    if (auction.leaderCustomerId && auction.reserveMet && auction.currentPriceCents !== null) {
      assertAuctionTransition(auction.status as AuctionStatus, "ended_won");

      const [market] = await tx.select().from(markets).where(eq(markets.code, listing!.marketCode));
      const [winner] = await tx.select().from(customers).where(eq(customers.id, auction.leaderCustomerId));

      const reverseCharge = qualifiesForReverseCharge({
        sellerCountry: market!.code,
        buyerVatNo: winner!.vatNo,
        buyerVies: winner!.vies ?? null,
        nowMs: now.getTime(),
      });
      const inv = computeInvoice({
        hammerCents: auction.currentPriceCents,
        buyerPremiumBp: market!.buyerPremiumBp,
        vatRateBp: market!.vatRateBp,
        reverseCharge,
      });

      // Human order ref from the counters row (locked by the UPDATE).
      const [counter] = await tx
        .update(counters)
        .set({ value: sql`${counters.value} + 1` })
        .where(eq(counters.key, "order_ref"))
        .returning({ value: counters.value });
      const ref = `A-${counter!.value}`;

      const paymentDeadlineAt = new Date(now.getTime() + ctx.config.paymentDeadlineHours * 3_600_000);
      const [createdOrder] = await tx.insert(orders).values({
        ref,
        auctionId: auction.id,
        listingId: listing!.id,
        itemId: item!.id,
        customerId: winner!.id,
        customerAlias: winner!.alias,
        customerEmail: winner!.email,
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
      }).returning({ id: orders.id });

      // The invoice is the request for payment — issue it with the order,
      // atomically, with a gap-free number from the market's series.
      await issueInvoice(tx, createdOrder!.id, now);

      // Winner gets a "you won" email with the order ref + payment deadline
      // (and, when Klix is on, a one-click pay link straight to checkout).
      await enqueueNotification(tx, {
        customerId: winner!.id,
        type: "won",
        template: {
          alias: "",
          lotTitle: listing!.title,
          orderRef: ref,
          totalCents: inv.totalCents,
          deadline: paymentDeadlineAt,
          payUrl: buildPayUrl(ctx, ref, paymentDeadlineAt),
        },
      });

      await tx.update(auctions).set({ status: "ended_won", closedAt: now }).where(eq(auctions.id, auction.id));
      // live → won → awaiting_payment (order exists the moment the state does)
      await transitionItem("won", item!.status as ItemStatus);
      await transitionItem("awaiting_payment", "won");

      await writeAudit(tx, actor, "auction", "closed_won", listing!.title, {
        auctionId: auction.id,
        orderRef: ref,
        hammerCents: auction.currentPriceCents,
      });
      return {
        ok: true as const,
        auctionId: auction.id,
        status: "ended_won" as AuctionStatus,
        orderRef: ref,
        hammerCents: auction.currentPriceCents,
      };
    }

    // ── Reserve not met / no bids ─────────────────────────────────────────
    const status: AuctionStatus = auction.leaderCustomerId ? "ended_reserve_not_met" : "ended_no_bids";
    assertAuctionTransition(auction.status as AuctionStatus, status);
    await tx.update(auctions).set({ status, closedAt: now }).where(eq(auctions.id, auction.id));
    await transitionItem("unsold", item!.status as ItemStatus);
    await writeAudit(tx, actor, "auction", status === "ended_no_bids" ? "closed_no_bids" : "closed_reserve_not_met", listing!.title, {
      auctionId: auction.id,
    });
    return { ok: true as const, auctionId: auction.id, status };
  });

  if (result.ok) {
    await publishAuctionEvent(ctx, {
      type: "closed",
      auctionId,
      at: now.toISOString(),
      data: {
        status: result.status,
        ...(result.orderRef ? { orderRef: result.orderRef, hammerCents: result.hammerCents } : {}),
      },
    });
  }
  return result;
}

/** Open a scheduled auction whose start time has arrived. */
export async function openAuction(ctx: AppContext, auctionId: string): Promise<boolean> {
  const now = ctx.now();
  const opened = await ctx.db.transaction(async (tx) => {
    const [auction] = await tx.select().from(auctions).where(eq(auctions.id, auctionId)).for("update");
    if (!auction || auction.status !== "scheduled") return false;
    if (now.getTime() < auction.startsAt.getTime()) return false;
    const [listing] = await tx.select().from(listings).where(eq(listings.id, auction.listingId));
    const [item] = await tx.select().from(items).where(eq(items.id, listing!.itemId));

    assertAuctionTransition("scheduled", "live");
    assertItemTransition(item!.status as ItemStatus, "live");
    await tx.update(auctions).set({ status: "live" }).where(eq(auctions.id, auction.id));
    await tx.update(items).set({ status: "live", updatedAt: now }).where(eq(items.id, item!.id));
    await writeAudit(tx, SYSTEM_ACTOR, "auction", "opened", listing!.title, { auctionId: auction.id });
    return true;
  });
  if (opened) {
    await publishAuctionEvent(ctx, { type: "opened", auctionId, at: now.toISOString(), data: {} });
  }
  return opened;
}
