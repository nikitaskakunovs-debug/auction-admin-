import { createDb } from "@auction/db";
import { Redis } from "ioredis";
import { loadConfig } from "./config.js";
import type { AppContext } from "./context.js";
import { createEmailAdapter } from "./email.js";
import { AuctionScheduler } from "./engine/scheduler.js";
import { buildServer } from "./server.js";

const config = loadConfig();
const { db, pool } = createDb(config.databaseUrl);
const redis = new Redis(config.redisUrl);

const ctx: AppContext = { db, pool, redis, config, email: createEmailAdapter(config.emailMode), now: () => new Date() };

const { app } = await buildServer(ctx, { logger: true });
const scheduler = new AuctionScheduler(ctx);
if (config.schedulerEnabled) scheduler.start();

await app.listen({ host: config.host, port: config.port });
console.log(`auction api listening on :${config.port}`);

const shutdown = async () => {
  scheduler.stop();
  await app.close();
  await redis.quit().catch(() => undefined);
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
