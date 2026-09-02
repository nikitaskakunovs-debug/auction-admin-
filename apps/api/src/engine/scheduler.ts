import { auctions, customers, items, markets, orders } from "@auction/db";
import { assertItemTransition, computeNoShowSettlement, type ItemStatus } from "@auction/domain";
import { and, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { writeAudit, SYSTEM_ACTOR } from "../audit.js";
import type { AppContext } from "../context.js";
import { closeAuction, openAuction } from "./close.js";
import { moveCredit } from "./credits.js";
import { movePoints } from "./loyalty.js";
import { recordFee } from "./fees.js";
import { cancelNoShowDue, remindPickupDue } from "./noShow.js";
import { dispatchNotifications, enqueueNotification, reminderDedupeKey } from "./notifications.js";
import { buildPayUrl } from "./payLink.js";

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
        // Each phase is isolated: one poisoned row used to abort the whole
        // tick, so a single stuck order silently stopped every later phase —
        // pickup reminders, shipment tracking and, worst of all, the
        // notification outbox — for as long as it sat there.
        const phase = async (name: string, run: () => Promise<unknown>): Promise<void> => {
          try {
            await run();
          } catch (err) {
            console.error(`scheduler phase ${name} failed`, err);
          }
        };
        // A heartbeat the smoke check can read: "the clock is alive, and it
        // last completed a pass N seconds ago". Cheap, and the only way to
        // tell a stopped scheduler from a quiet day.
        await this.ctx.redis.set("scheduler:beat", this.ctx.now().toISOString(), "PX", 120_000);
        await phase("openDue", () => this.openDue());
        await phase("closeDue", () => this.closeDue());
        // Design-doc unpaid-winner flow: deadline → reminder → auto-cancel.
        await phase("remindUnpaidDue", () => this.remindUnpaidDue());
        await phase("cancelUnpaidDue", () => this.cancelUnpaidDue());
        // Pickup no-show flow: reminder → cancel + restock fee + strike.
        await phase("remindPickupDue", () => remindPickupDue(this.ctx));
        await phase("cancelNoShowDue", () => cancelNoShowDue(this.ctx));
        // Carrier tracking: poll active shipments (rate-limited to every
        // 30 min via its own Redis key — the per-second tick just asks).
        await phase("pollShipments", () => this.pollShipments());
        // Phase E: pull Jira statuses + IT comments (every 5 min).
        await phase("syncBugs", () => this.syncBugs());
        // Письма по просьбе: новые лоты под сохранённые поиски и вэлмес на
        // исходе (раз в 30 минут — чаще некуда, письма всё равно суточные).
        await phase("marketingCrons", () => this.marketingCrons());
        // Ночной пакет роста (план v15): сводка интересов, RFM, сегменты,
        // lifecycle-письма. Раз в сутки, ранним утром.
        await phase("growthNightly", () => this.growthNightly());
        // Кампании конструктора: раз в минуту смотрим, не пора ли слать.
        await phase("campaigns", () => this.campaignsDue());
        // Drain the outbox last so this tick's enqueues go out promptly.
        await phase("dispatchNotifications", () => dispatchNotifications(this.ctx));
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

  /**
   * Refresh tracking for every shipment still moving. Guarded by a 30-minute
   * Redis marker so the carrier API sees at most ~50 polls a day regardless
   * of tick frequency or instance count.
   */
  private async pollShipments(): Promise<void> {
    if (!this.ctx.omniva && !this.ctx.dpd) return;
    const marker = await this.ctx.redis.set("shipments:poll", "1", "PX", 30 * 60 * 1000, "NX");
    if (marker !== "OK") return;
    const { shipments } = await import("@auction/db");
    const { refreshShipment } = await import("../routes/shipping.js");
    const active = await this.ctx.db
      .select()
      .from(shipments)
      .where(inArray(shipments.status, ["registered", "in_transit"]))
      .limit(200);
    for (const shipment of active) {
      await refreshShipment(this.ctx, shipment).catch(() => undefined);
    }
  }

  /** Кроны запрошенных писем, раз в 30 минут (Redis-маркер). */
  private async marketingCrons(): Promise<void> {
    const marker = await this.ctx.redis.set("marketing:crons", "1", "PX", 30 * 60 * 1000, "NX");
    if (marker !== "OK") return;
    const { runSavedSearchAlerts, runWatchlistEndingAlerts } = await import("./marketingCrons.js");
    await runSavedSearchAlerts(this.ctx).catch((err) => console.error("saved search alerts failed", err));
    await runWatchlistEndingAlerts(this.ctx).catch((err) => console.error("watchlist alerts failed", err));
  }

  /** Ночной пересчёт роста: раз в сутки, между 01:00 и 06:00 UTC (03:00–08:00
   *  по Риге) — статистика ночная, письма всё равно задержит тишина. */
  private async growthNightly(): Promise<void> {
    const hour = this.ctx.now().getUTCHours();
    if (hour < 1 || hour >= 6) return;
    const day = this.ctx.now().toISOString().slice(0, 10);
    const marker = await this.ctx.redis.set(`growth:${day}`, "1", "PX", 26 * 3600 * 1000, "NX");
    if (marker !== "OK") return;
    const { runNightlyGrowth } = await import("./growth.js");
    await runNightlyGrowth(this.ctx).catch((err) => console.error("nightly growth failed", err));
  }

  /** Кампании со scheduledAt в прошлом — раз в минуту. */
  private async campaignsDue(): Promise<void> {
    const marker = await this.ctx.redis.set("campaigns:due", "1", "PX", 60 * 1000, "NX");
    if (marker !== "OK") return;
    const { dispatchCampaigns } = await import("./growth.js");
    await dispatchCampaigns(this.ctx).catch((err) => console.error("campaign dispatch failed", err));
  }

  /** Jira → panel sync, guarded by a 5-minute Redis marker. */
  private async syncBugs(): Promise<void> {
    if (!this.ctx.jira) return;
    const marker = await this.ctx.redis.set("bugs:sync", "1", "PX", 5 * 60 * 1000, "NX");
    if (marker !== "OK") return;
    const { syncBugReports } = await import("./bugSync.js");
    await syncBugReports(this.ctx).catch((err) => console.error("bug sync failed", err));
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

  /**
   * Unpaid-winner reminder: once the deadline is within the lead window (and
   * still in the future), enqueue a single payment reminder per order. The
   * dedupe key makes this idempotent no matter how often the tick runs.
   */
  private async remindUnpaidDue(): Promise<void> {
    const now = this.ctx.now();
    const windowEnd = new Date(now.getTime() + this.ctx.config.paymentReminderLeadHours * 3_600_000);
    const due = await this.ctx.db
      .select({ id: orders.id, ref: orders.ref, customerId: orders.customerId, totalCents: orders.totalCents, deadline: orders.paymentDeadlineAt })
      .from(orders)
      .where(
        and(
          eq(orders.status, "awaiting_payment"),
          gt(orders.paymentDeadlineAt, now),
          lte(orders.paymentDeadlineAt, windowEnd),
        ),
      );
    for (const o of due) {
      await enqueueNotification(this.ctx, this.ctx.db, {
        customerId: o.customerId,
        type: "payment_reminder",
        template: {
          alias: "",
          lotTitle: "",
          orderRef: o.ref,
          totalCents: o.totalCents,
          deadline: o.deadline ?? undefined,
          payUrl: buildPayUrl(this.ctx, o.ref, o.deadline),
        },
        dedupeKey: reminderDedupeKey(o.id),
      });
    }
  }

  /**
   * Unpaid-winner handling: deadline passed → cancel order + strike + an
   * OUTSTANDING restock fee (we hold no funds to deduct from, so the fee is
   * a claim that blocks bidding/buying until settled or waived).
   */
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
        const [market] = await tx.select().from(markets).where(eq(markets.code, order.marketCode));
        const feeCents = computeNoShowSettlement(order.totalCents, market?.restockFeeBp ?? 500).feeCents;
        await tx
          .update(orders)
          .set({ status: "cancelled", cancelledAt: now, cancelReason: "unpaid", restockFeeCents: feeCents })
          .where(eq(orders.id, order.id));
        await tx.update(items).set({ status: "unpaid_cancelled", updatedAt: now }).where(eq(items.id, item!.id));
        // Зачтённый аванс не сгорает вместе с заказом — возвращается на счёт.
        if (order.creditAppliedCents > 0) {
          await moveCredit(tx, order.customerId, {
            kind: "refund_to_credit",
            amountCents: order.creditAppliedCents,
            orderRef: order.ref,
            note: "pasūtījums atcelts — avanss atgriezts",
          }, now);
          await tx.update(orders).set({ creditAppliedCents: 0 }).where(eq(orders.id, order.id));
        }
        // Списанные баллы — тоже: отменённый заказ их не съедает.
        if (order.pointsAppliedCents > 0) {
          await movePoints(tx, order.customerId, {
            reason: "manual",
            amountCents: order.pointsAppliedCents,
            orderRef: order.ref,
            note: "pasūtījums atcelts — punkti atgriezti",
          }, now);
          await tx.update(orders).set({ pointsAppliedCents: 0 }).where(eq(orders.id, order.id));
        }
        await tx
          .update(customers)
          .set({ strikes: sql`${customers.strikes} + 1` })
          .where(eq(customers.id, order.customerId));
        await recordFee(tx, {
          customerId: order.customerId,
          orderId: order.id,
          orderRef: order.ref,
          type: "unpaid_restock",
          amountCents: feeCents,
          status: "outstanding",
          note: "auto: payment deadline passed",
          now,
        });
        await enqueueNotification(this.ctx, tx, {
          customerId: order.customerId,
          type: "unpaid_cancelled",
          template: { alias: "", lotTitle: "", orderRef: order.ref, feeCents },
          dedupeKey: `unpaid_cancelled:${order.id}`,
        });
        await writeAudit(tx, SYSTEM_ACTOR, "order", "auto_cancelled_unpaid", order.ref, {
          orderId: order.id,
          customerId: order.customerId,
          feeCents,
        });
      });
    }
  }
}
