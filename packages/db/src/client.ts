import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  pool: pg.Pool;
}

export function connectionString(): string {
  return process.env.DATABASE_URL ?? "postgres://auction:auction@localhost:5432/auction";
}

export function createDb(url = connectionString()): DbHandle {
  const pool = new pg.Pool({ connectionString: url, max: 20 });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
