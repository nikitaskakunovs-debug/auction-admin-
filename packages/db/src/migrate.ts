import { createDb } from "./client.js";
import { applyMigrations } from "./migrateFn.js";

const { db, pool } = createDb();
try {
  await applyMigrations(db);
  console.log("migrations applied");
} finally {
  await pool.end();
}
