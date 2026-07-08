import { createDb } from "./client.js";
import { seedDatabase } from "./seedData.js";

const { db, pool } = createDb();
try {
  await seedDatabase(db);
  console.log("seed complete");
} finally {
  await pool.end();
}
