import {
  auctions,
  bids,
  customers,
  listings,
  markets,
} from "@auction/db";
import {
  applyAntiSnipe,
  resolveBid,
  validateIncrementTable,
  type BidState,
  type IncrementTable,
  type RejectCode,
} from "@auction/domain";
import { and, eq, isNull, sql } from "drizzle-orm";
import { publishAuctionEvent, type AppContext } from "../context.js";
import { outstandingFeeCents } from "./fees.js";
import { enqueueNotification } from "./notifications.js";

export type PlaceBidError =
  | { ok: false; code: "AUCTION_NOT_FOUND" | "AUCTION_NOT_LIVE" | "AUCTION_ENDED" | "BIDDER_NOT_FOUND" | "BIDDER_BLOCKED" | "FEES_OUTSTANDING" }
  | { ok: false; code: RejectCode; minAcceptableCents: number };

export interface PlaceBidOk {
  ok: true;
  auctionId: string;
  currentPriceCents: number;
  leaderCustomerId: string;
  leaderAlias: string;
  bidCount: number;
  endsAt: Date;
  extended: boolean;
  reserveMet: boolean;
}

export type PlaceBidResult = PlaceBidOk | PlaceBidError;

/**
 * Concurrency-safe bid placement. The auction row is locked FOR UPDATE for
 * the duration of the transaction, so concurrent bids on one auction
 * serialize; the pure domain resolver runs inside the lock. No bid is lost,
 * none double-applied — verified by the 50-bidder concurrency test.
 */
export async function placeBid(
  ctx: AppContext,
  args: { auctionId: string; customerId: string; maxCents: number },
): Promise<PlaceBidResult> {
  const now = ctx.now();

  const result = await ctx.db.transaction(async (tx): Promise<PlaceBidResult> => {
    const [auction] = await tx
      .select()
      .from(auctions)
      .where(eq(auctions.id, args.auctionId))
      .for("update");
    if (!auction) return { ok: false, code: "AUCTION_NOT_FOUND" };
    if (auction.status !== "live") return { ok: false, code: "AUCTION_NOT_LIVE" };
    if (now.getTime() >= auction.endsAt.getTime()) return { ok: false, code: "AUCTION_ENDED" };

    const [listing] = await tx.select().from(listings).where(eq(listings.id, auction.listingId));
    if (!listing) return { ok: false, code: "AUCTION_NOT_FOUND" };
    const [market] = await tx.select().from(markets).where(eq(markets.code, listing.marketCode));
    if (!market) return { ok: false, code: "AUCTION_NOT_FOUND" };

    const [bidder] = await tx
      .select({ id: customers.id, alias: customers.alias, blocked: customers.blocked })
      .from(customers)
      .where(eq(customers.id, args.customerId));
    if (!bidder) return { ok: false, code: "BIDDER_NOT_FOUND" };
    if (bidder.blocked) return { ok: false, code: "BIDDER_BLOCKED" };
    // Outstanding restock fees pause the account until settled or waived.
    if ((await outstandingFeeCents(tx, args.customerId)) > 0) return { ok: false, code: "FEES_OUTSTANDING" };

    const incrementTable: IncrementTable = market.incrementTable;
    validateIncrementTable(incrementTable);

    const state: BidState = {
      startPriceCents: listing.startPriceCents ?? 0,
      reserveCents: listing.reserveCents,
      currentPriceCents: auction.currentPriceCents,
      leader:
        auction.leaderCustomerId && auction.leaderMaxCents !== null
          ? {
              bidderId: auction.leaderCustomerId,
              maxCents: auction.leaderMaxCents,
              seq: auction.leaderSeq ?? 0,
            }
          : null,
    };
    const oldLeader = state.leader;

    const resolution = resolveBid(
      state,
      { bidderId: args.customerId, maxCents: args.maxCents, seq: auction.bidCount + 1 },
      incrementTable,
    );
    if (!resolution.ok) {
      return { ok: false, code: resolution.code, minAcceptableCents: resolution.minAcceptableCents };
    }

    const windowSec = listing.antiSnipeSec ?? market.antiSnipeSec;
    const snipe = applyAntiSnipe({
      endsAtMs: auction.endsAt.getTime(),
      bidAtMs: now.getTime(),
      windowSec,
      extensionsSoFar: auction.extensions,
    });

    // Append the ledger rows produced by this resolution.
    let seq = auction.bidCount;
    for (const entry of resolution.ledger) {
      seq += 1;
      const isIncoming = entry.bidderId === args.customerId && !entry.auto;
      await tx.insert(bids).values({
        auctionId: auction.id,
        customerId: entry.bidderId,
        amountCents: entry.amountCents,
        maxCents: isIncoming
          ? args.maxCents
          : oldLeader && entry.bidderId === oldLeader.bidderId
            ? oldLeader.maxCents
            : entry.amountCents,
        auto: entry.auto,
        outbid: entry.outbid,
        seq,
      });
    }

    // A dethroned leader's earlier winning rows flip to outbid, and they get
    // an outbid notification (enqueued in-transaction so it can't be lost).
    if (resolution.leaderChanged && oldLeader) {
      await tx
        .update(bids)
        .set({ outbid: true })
        .where(
          and(
            eq(bids.auctionId, auction.id),
            eq(bids.customerId, oldLeader.bidderId),
            eq(bids.outbid, false),
            isNull(bids.voidedAt),
          ),
        );
      await enqueueNotification(tx, {
        customerId: oldLeader.bidderId,
        type: "outbid",
        template: { alias: "", lotTitle: listing.title, amountCents: resolution.state.currentPriceCents ?? 0 },
      });
    }

    const newLeader = resolution.state.leader!;
    await tx
      .update(auctions)
      .set({
        currentPriceCents: resolution.state.currentPriceCents,
        leaderCustomerId: newLeader.bidderId,
        leaderMaxCents: newLeader.maxCents,
        leaderSeq: newLeader.seq,
        bidCount: seq,
        reserveMet: resolution.reserveMet,
        endsAt: snipe.extended ? new Date(snipe.endsAtMs) : auction.endsAt,
        extensions: snipe.extended ? auction.extensions + 1 : auction.extensions,
      })
      .where(eq(auctions.id, auction.id));

    const [leaderRow] = await tx
      .select({ alias: customers.alias })
      .from(customers)
      .where(eq(customers.id, newLeader.bidderId));

    return {
      ok: true,
      auctionId: auction.id,
      currentPriceCents: resolution.state.currentPriceCents!,
      leaderCustomerId: newLeader.bidderId,
      leaderAlias: leaderRow?.alias ?? "—",
      bidCount: seq,
      endsAt: snipe.extended ? new Date(snipe.endsAtMs) : auction.endsAt,
      extended: snipe.extended,
      reserveMet: resolution.reserveMet,
    };
  });

  if (result.ok) {
    // Public-safe event: price, leader alias, count, close time. Never the
    // hidden reserve or any proxy max.
    await publishAuctionEvent(ctx, {
      type: "bid",
      auctionId: result.auctionId,
      at: now.toISOString(),
      data: {
        currentPriceCents: result.currentPriceCents,
        leaderAlias: result.leaderAlias,
        bidCount: result.bidCount,
        endsAt: result.endsAt.toISOString(),
        reserveMet: result.reserveMet,
        extended: result.extended,
      },
    });
    if (result.extended) {
      await publishAuctionEvent(ctx, {
        type: "extended",
        auctionId: result.auctionId,
        at: now.toISOString(),
        data: { endsAt: result.endsAt.toISOString() },
      });
    }
  }
  return result;
}

/**
 * Void a bid (admin op, audited, reason required at the route). Historical
 * rows stay for auditability; the voided row is stamped, and the auction
 * summary is rebuilt by replaying the surviving manual bids through the
 * domain resolver inside the same lock.
 */
export async function voidBid(
  ctx: AppContext,
  args: { auctionId: string; bidId: string; reason: string },
): Promise<{ ok: true; currentPriceCents: number | null; leaderCustomerId: string | null } | { ok: false; code: string }> {
  const now = ctx.now();
  const result = await ctx.db.transaction(async (tx) => {
    const [auction] = await tx
      .select()
      .from(auctions)
      .where(eq(auctions.id, args.auctionId))
      .for("update");
    if (!auction) return { ok: false as const, code: "AUCTION_NOT_FOUND" };
    if (auction.status !== "live") return { ok: false as const, code: "AUCTION_NOT_LIVE" };

    const [target] = await tx
      .select()
      .from(bids)
      .where(and(eq(bids.id, args.bidId), eq(bids.auctionId, args.auctionId)));
    if (!target) return { ok: false as const, code: "BID_NOT_FOUND" };
    if (target.voidedAt) return { ok: false as const, code: "ALREADY_VOIDED" };

    // Void every row of that bidder (their standing max is what is voided).
    await tx
      .update(bids)
      .set({ voidedAt: now, voidReason: args.reason })
      .where(and(eq(bids.auctionId, args.auctionId), eq(bids.customerId, target.customerId), isNull(bids.voidedAt)));

    const [listing] = await tx.select().from(listings).where(eq(listings.id, auction.listingId));
    const [market] = await tx.select().from(markets).where(eq(markets.code, listing!.marketCode));

    // Replay surviving manual bids in original order.
    const survivors = await tx
      .select()
      .from(bids)
      .where(and(eq(bids.auctionId, args.auctionId), eq(bids.auto, false), isNull(bids.voidedAt)))
      .orderBy(bids.seq);

    let state: BidState = {
      startPriceCents: listing!.startPriceCents ?? 0,
      reserveCents: listing!.reserveCents,
      currentPriceCents: null,
      leader: null,
    };
    for (const b of survivors) {
      const r = resolveBid(state, { bidderId: b.customerId, maxCents: b.maxCents, seq: b.seq }, market!.incrementTable);
      if (r.ok) state = r.state;
    }

    await tx
      .update(auctions)
      .set({
        currentPriceCents: state.currentPriceCents,
        leaderCustomerId: state.leader?.bidderId ?? null,
        leaderMaxCents: state.leader?.maxCents ?? null,
        leaderSeq: state.leader?.seq ?? null,
        reserveMet:
          state.leader !== null &&
          (listing!.reserveCents === null || state.leader.maxCents >= listing!.reserveCents),
      })
      .where(eq(auctions.id, args.auctionId));

    return {
      ok: true as const,
      currentPriceCents: state.currentPriceCents,
      leaderCustomerId: state.leader?.bidderId ?? null,
    };
  });

  if (result.ok) {
    await publishAuctionEvent(ctx, {
      type: "bid_voided",
      auctionId: args.auctionId,
      at: now.toISOString(),
      data: { currentPriceCents: result.currentPriceCents },
    });
  }
  return result;
}
