import { applyMigrations, createDb, seedDatabase } from "@auction/db";

/** Bring the database to a known state before the servers start. */
export default async function globalSetup(): Promise<void> {
  const { db, pool } = createDb(process.env.DATABASE_URL);
  try {
    await applyMigrations(db);
    await seedDatabase(db); // markets, 7 roles, demo admins (idempotent)
  } finally {
    await pool.end();
  }
}
