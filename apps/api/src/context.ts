import type { Db } from "@auction/db";
import type pg from "pg";
import type { Redis } from "ioredis";
import type { ApiConfig } from "./config.js";
import type { EmailAdapter } from "./email.js";

/** Shared dependencies threaded through routes and the engine. */
export interface AppContext {
  db: Db;
  pool: pg.Pool;
  redis: Redis;
  config: ApiConfig;
  /** Email transport (console in dev; capturing in tests). */
  email: EmailAdapter;
  /** Injectable clock so tests control time. */
  now: () => Date;
}

/** Redis pub/sub channel for one auction's public events. */
export const auctionChannel = (auctionId: string): string => `auction:${auctionId}`;
/** Firehose channel for the admin live views. */
export const ADMIN_CHANNEL = "admin:events";

export interface AuctionEvent {
  type: "bid" | "extended" | "opened" | "closed" | "cancelled" | "bid_voided";
  auctionId: string;
  at: string;
  /** Public-safe payload — must NEVER contain reserve or proxy maxima. */
  data: Record<string, unknown>;
}

export async function publishAuctionEvent(ctx: AppContext, ev: AuctionEvent): Promise<void> {
  const msg = JSON.stringify(ev);
  await ctx.redis.publish(auctionChannel(ev.auctionId), msg);
  await ctx.redis.publish(ADMIN_CHANNEL, msg);
}
