import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Db } from "./client.js";

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

/** Apply all pending migrations. Shared by the CLI script and callers (e2e). */
export async function applyMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder });
}

/**
 * How far the database has been migrated. Read-only: compares the journal
 * shipped in this build against what the migrator has recorded, so a deploy
 * that forgot the migrate step is visible rather than mysterious.
 */
export async function migrationStatus(db: Db): Promise<{ applied: number; total: number; pending: string[] }> {
  const { readFile } = await import("node:fs/promises");
  const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: Array<{ tag: string }> };
  const tags = journal.entries.map((e) => e.tag);
  let applied = 0;
  try {
    const rows = await db.execute<{ count: string }>(
      sql`select count(*)::text as count from drizzle.__drizzle_migrations`,
    );
    applied = Number((rows.rows[0] as { count: string } | undefined)?.count ?? 0);
  } catch {
    applied = 0; // migrator has never run here
  }
  return { applied, total: tags.length, pending: tags.slice(applied) };
}
