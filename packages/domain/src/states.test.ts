import { describe, expect, it } from "vitest";
import {
  assertAuctionTransition,
  assertItemTransition,
  canTransitionAuction,
  canTransitionItem,
  IllegalTransitionError,
  type ItemStatus,
} from "./states.js";

describe("auction state machine", () => {
  it("allows the normal lifecycle", () => {
    expect(canTransitionAuction("scheduled", "live")).toBe(true);
    expect(canTransitionAuction("live", "ended_won")).toBe(true);
    expect(canTransitionAuction("live", "ended_reserve_not_met")).toBe(true);
    expect(canTransitionAuction("live", "ended_no_bids")).toBe(true);
    expect(canTransitionAuction("live", "cancelled")).toBe(true);
    expect(canTransitionAuction("scheduled", "cancelled")).toBe(true);
  });

  it("blocks resurrection of ended auctions", () => {
    expect(canTransitionAuction("ended_won", "live")).toBe(false);
    expect(canTransitionAuction("cancelled", "live")).toBe(false);
    expect(() => assertAuctionTransition("ended_no_bids", "live")).toThrow(IllegalTransitionError);
  });

  it("blocks skipping straight from scheduled to an end state", () => {
    expect(canTransitionAuction("scheduled", "ended_won")).toBe(false);
  });
});

describe("item lifecycle (design-doc warehouse flow)", () => {
  it("walks the full happy path", () => {
    const path: ItemStatus[] = [
      "draft", "listed", "live", "won", "awaiting_payment", "paid",
      "picking", "packed", "shipped", "delivered", "closed",
    ];
    for (let i = 1; i < path.length; i++) {
      expect(() => assertItemTransition(path[i - 1]!, path[i]!)).not.toThrow();
    }
  });

  it("supports unsold → relist and unsold → draft", () => {
    expect(canTransitionItem("live", "unsold")).toBe(true);
    expect(canTransitionItem("unsold", "listed")).toBe(true);
    expect(canTransitionItem("unsold", "draft")).toBe(true);
  });

  it("supports the unpaid-winner branch: cancel then relist", () => {
    expect(canTransitionItem("awaiting_payment", "unpaid_cancelled")).toBe(true);
    expect(canTransitionItem("unpaid_cancelled", "listed")).toBe(true);
  });

  it("admin cancelling a live auction returns the item to listed", () => {
    expect(canTransitionItem("live", "listed")).toBe(true);
  });

  it("a listed item can be sold directly (fixed-price buy-now) or go to auction", () => {
    expect(canTransitionItem("listed", "won")).toBe(true); // buy now
    expect(canTransitionItem("listed", "live")).toBe(true); // auction
  });

  it("blocks illegal jumps", () => {
    expect(canTransitionItem("draft", "live")).toBe(false);
    expect(canTransitionItem("paid", "shipped")).toBe(false); // must pick+pack first
    expect(canTransitionItem("closed", "listed")).toBe(false);
    expect(canTransitionItem("won", "paid")).toBe(false); // must go through awaiting_payment
    expect(() => assertItemTransition("delivered", "paid")).toThrow(IllegalTransitionError);
  });
});
