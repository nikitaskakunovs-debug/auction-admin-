import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Db } from "./client.js";

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

/** Apply all pending migrations. Shared by the CLI script and callers (e2e). */
export async function applyMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder });
}
