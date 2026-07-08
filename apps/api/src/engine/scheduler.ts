import { auctions, customers, items, orders } from "@auction/db";
import { assertItemTransition, type ItemStatus } from "@auction/domain";
import { and, eq, lte, sql } from "drizzle-orm";
import { writeAudit, SYSTEM_ACTOR } from "../audit.js";
import type { AppContext } from "../context.js";
import { closeAuction, openAuction } from "./close.js";

const LOCK_KEY = "scheduler:lock";
const LOCK_TTL_MS = 4_000;

/**
 * The auction clock: a 1s tick that opens scheduled auctions, closes ended
 * ones, and auto-cancels unpaid winners past their deadline (design doc:
 * deadline → auto-cancel → relist + strike; relisting stays a manual admin
 * action). A Redis NX lock makes the tick single-flight across instances.
 */
export class AuctionScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private ctx: AppContext) {}

  start(intervalMs = 1_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass; safe to call directly from tests. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const token = Math.random().toString(36).slice(2);
      const locked = await this.ctx.redis.set(LOCK_KEY, token, "PX", LOCK_TTL_MS, "NX");
      if (locked !== "OK") return;
      try {
        await this.openDue();
        await this.closeDue();
        await this.cancelUnpaidDue();
      } finally {
        // Release only our own lock.
        await this.ctx.redis.eval(
          `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`,
          1,
          LOCK_KEY,
          token,
        );
      }
    } catch (err) {
      // Never let the clock die; log and try next tick.
      console.error("scheduler tick failed", err);
    } finally {
      this.running = false;
    }
  }

  private async openDue(): Promise<void> {
    const now = this.ctx.now();
    const due = await this.ctx.db
      .select({ id: auctions.id })
      .from(auctions)
      .where(and(eq(auctions.status, "scheduled"), lte(auctions.startsAt, now)));
    for (const a of due) await openAuction(this.ctx, a.id);
  }

  private async closeDue(): Promise<void> {
    const now = this.ctx.now();
    const due = await this.ctx.db
      .select({ id: auctions.id })
      .from(auctions)
      .where(and(eq(auctions.status, "live"), lte(auctions.endsAt, now)));
    for (const a of due) await closeAuction(this.ctx, a.id);
  }

  /** Unpaid-winner handling: deadline passed → cancel order + strike. */
  private async cancelUnpaidDue(): Promise<void> {
    const now = this.ctx.now();
    const due = await this.ctx.db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.status, "awaiting_payment"), lte(orders.paymentDeadlineAt, now)));
    for (const o of due) {
      await this.ctx.db.transaction(async (tx) => {
        const [order] = await tx.select().from(orders).where(eq(orders.id, o.id)).for("update");
        if (!order || order.status !== "awaiting_payment") return;
        const [item] = await tx.select().from(items).where(eq(items.id, order.itemId));

        assertItemTransition(item!.status as ItemStatus, "unpaid_cancelled");
        await tx.update(orders).set({ status: "cancelled", cancelledAt: now }).where(eq(orders.id, order.id));
        await tx.update(items).set({ status: "unpaid_cancelled", updatedAt: now }).where(eq(items.id, item!.id));
        await tx
          .update(customers)
          .set({ strikes: sql`${customers.strikes} + 1` })
          .where(eq(customers.id, order.customerId));
        await writeAudit(tx, SYSTEM_ACTOR, "order", "auto_cancelled_unpaid", order.ref, {
          orderId: order.id,
          customerId: order.customerId,
        });
      });
    }
  }
}
