import { fileURLToPath } from "node:url";
import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./client.js";

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

const { db, pool } = createDb();
try {
  await migrate(db, { migrationsFolder });
  console.log("migrations applied");
} finally {
  await pool.end();
}
