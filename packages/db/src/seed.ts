import { createDb } from "./client.js";
import { bootstrapAdmin, seedDatabase } from "./seedData.js";

/**
 * Seed CLI.
 * - Dev/staging (default): full demo dataset + the 7 demo role admins.
 * - Production (NODE_ENV=production): baseline config ONLY (markets, roles,
 *   permissions, counters, bins) — never the demo admins with their published
 *   password — plus one real super admin from INITIAL_ADMIN_EMAIL /
 *   INITIAL_ADMIN_PASSWORD (min 12 chars; 2FA enrolled on first login).
 */
const isProduction = process.env.NODE_ENV === "production";

const { db, pool } = createDb();
try {
  if (isProduction) {
    await seedDatabase(db, { demoData: false, demoAdmins: false });
    const email = process.env.INITIAL_ADMIN_EMAIL;
    const password = process.env.INITIAL_ADMIN_PASSWORD;
    if (email && password) {
      const result = await bootstrapAdmin(db, email, password, process.env.INITIAL_ADMIN_NAME ?? "Owner");
      console.log(result === "created" ? `bootstrap admin created: ${email}` : "admin users already exist — bootstrap skipped");
    } else {
      console.log("baseline seeded (set INITIAL_ADMIN_EMAIL + INITIAL_ADMIN_PASSWORD to create the first admin)");
    }
  } else {
    await seedDatabase(db);
    console.log("seed complete (demo data + demo admins)");
  }
} finally {
  await pool.end();
}
