import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, seedDatabase, SEED_ADMIN_TOTP_SECRET, type DbHandle } from "@auction/db";
import { base32Decode, totp } from "@auction/domain";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import { Redis } from "ioredis";
import pg from "pg";
import { loadConfig } from "../src/config.js";
import type { AppContext } from "../src/context.js";
import { CapturingEmailAdapter } from "../src/email.js";
import { buildServer, type BuiltServer } from "../src/server.js";
import { createStorage } from "../src/storage.js";

const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://auction:auction@localhost:5432/auction";
const TEST_DB = "auction_test";
const TEST_URL = ADMIN_URL.replace(/\/[^/]+$/, `/${TEST_DB}`);
const TEST_REDIS = (process.env.REDIS_URL ?? "redis://localhost:6379").replace(/\/?$/, "") + "/1";

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

export interface TestWorld {
  ctx: AppContext;
  server: BuiltServer;
  handle: DbHandle;
  /** Captures every email the engine would send. */
  email: CapturingEmailAdapter;
  /** Set to control the engine clock; null = real time. */
  setNow: (d: Date | null) => void;
  close: () => Promise<void>;
}

async function ensureTestDatabase(): Promise<void> {
  const client = new pg.Client({ connectionString: ADMIN_URL });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE ${TEST_DB}`);
  } catch (err) {
    if ((err as { code?: string }).code !== "42P04") throw err; // already exists
  } finally {
    await client.end();
  }
}

export async function createWorld(): Promise<TestWorld> {
  await ensureTestDatabase();
  const handle = createDb(TEST_URL);
  await migrate(handle.db, { migrationsFolder });

  // Clean slate: truncate everything, reseed baseline config (no demo data).
  await handle.db.execute(sql`
    truncate markets, admin_roles, role_permissions, admin_users, refresh_tokens,
      customers, customer_refresh_tokens, items, listings, auctions, bids, orders,
      refunds, invoices, counters, audit_log, cms_pages, notifications,
      warehouse_locations, stock_movements, pickup_tickets, pickup_ticket_items,
      customer_fees, consignments cascade
  `);
  await seedDatabase(handle.db, { demoData: false });

  const redis = new Redis(TEST_REDIS);
  await redis.flushdb();

  let fakeNow: Date | null = null;
  const config = loadConfig({
    ...process.env,
    DATABASE_URL: TEST_URL,
    REDIS_URL: TEST_REDIS,
    ALLOW_BID_SIMULATION: "1",
    // Photo uploads land on local disk under the (gitignored) var/ dir.
    STORAGE_DRIVER: "local",
    UPLOAD_DIR: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../var/test-uploads"),
  });
  const email = new CapturingEmailAdapter();
  const ctx: AppContext = {
    db: handle.db,
    pool: handle.pool,
    redis,
    config,
    email,
    storage: createStorage(config),
    now: () => fakeNow ?? new Date(),
  };
  const server = await buildServer(ctx);

  return {
    ctx,
    server,
    handle,
    email,
    setNow: (d) => {
      fakeNow = d;
    },
    close: async () => {
      await server.app.close();
      await redis.quit().catch(() => undefined);
      await handle.pool.end();
    },
  };
}

/** Current TOTP code for the fixed dev secret the seeded admins enrolled with. */
export function seedTotpCode(world: TestWorld): string {
  return totp(base32Decode(SEED_ADMIN_TOTP_SECRET), Math.floor(world.ctx.now().getTime() / 1000));
}

/**
 * Log in a seeded role user through the full two-step flow (password →
 * challenge → TOTP) and return its bearer access token. The seeded admins are
 * pre-enrolled with a known secret so the code is computed deterministically.
 */
export async function loginAs(world: TestWorld, email: string, password = "Admin123!"): Promise<string> {
  const res = await world.server.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  if (res.statusCode !== 200) throw new Error(`login failed for ${email}: ${res.body}`);
  const { challenge, challengeToken } = res.json() as { challenge: string; challengeToken: string };
  if (challenge !== "totp") throw new Error(`expected totp challenge for ${email}, got ${challenge}`);
  const res2 = await world.server.app.inject({
    method: "POST",
    url: "/api/auth/login/2fa",
    payload: { challengeToken, code: seedTotpCode(world) },
  });
  if (res2.statusCode !== 200) throw new Error(`2fa failed for ${email}: ${res2.body}`);
  return (res2.json() as { accessToken: string }).accessToken;
}

export const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/** Create item + auction listing + published auction, return ids. */
export async function createLiveAuction(
  world: TestWorld,
  token: string,
  opts: { startPriceCents?: number; reserveCents?: number | null; endsInMs?: number; antiSnipeSec?: number } = {},
): Promise<{ itemId: string; listingId: string; auctionId: string }> {
  const app = world.server.app;
  const sku = `T-${Math.random().toString(36).slice(2, 10)}`;
  const itemRes = await app.inject({
    method: "POST",
    url: "/api/items",
    headers: auth(token),
    payload: { sku, title: `Test lot ${sku}`, marketCode: "LV" },
  });
  const itemId = (itemRes.json() as { item: { id: string } }).item.id;

  const listingRes = await app.inject({
    method: "POST",
    url: "/api/listings",
    headers: auth(token),
    payload: {
      itemId,
      type: "auction",
      title: `Test lot ${sku}`,
      marketCode: "LV",
      startPriceCents: opts.startPriceCents ?? 1_000,
      reserveCents: opts.reserveCents ?? null,
      antiSnipeSec: opts.antiSnipeSec,
    },
  });
  if (listingRes.statusCode !== 200) throw new Error(`listing create failed: ${listingRes.body}`);
  const listingId = (listingRes.json() as { listing: { id: string } }).listing.id;

  const pub = await app.inject({ method: "POST", url: `/api/listings/${listingId}/publish`, headers: auth(token) });
  if (pub.statusCode !== 200) throw new Error(`publish failed: ${pub.body}`);

  const now = world.ctx.now().getTime();
  const auctionRes = await app.inject({
    method: "POST",
    url: "/api/auctions",
    headers: auth(token),
    payload: {
      listingId,
      startsAt: new Date(now - 1_000).toISOString(),
      endsAt: new Date(now + (opts.endsInMs ?? 3_600_000)).toISOString(),
    },
  });
  if (auctionRes.statusCode !== 200) throw new Error(`auction create failed: ${auctionRes.body}`);
  const auctionId = (auctionRes.json() as { auction: { id: string } }).auction.id;

  // Open it (scheduler would do this on its next tick).
  const { openAuction } = await import("../src/engine/close.js");
  const opened = await openAuction(world.ctx, auctionId);
  if (!opened) throw new Error("auction failed to open");

  return { itemId, listingId, auctionId };
}

export async function createBidder(world: TestWorld, alias: string, extra: Record<string, unknown> = {}): Promise<string> {
  const { customers } = await import("@auction/db");
  const [row] = await world.ctx.db
    .insert(customers)
    .values({ email: `${alias}@bidders.test`, alias, marketCode: "LV", ...extra })
    .returning({ id: customers.id });
  return row!.id;
}
