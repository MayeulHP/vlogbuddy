import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  // A dedicated single connection; migrations must not share the pool.
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);

  console.log("[db] running migrations...");
  await migrate(db, { migrationsFolder: path.join(__dirname, "..", "drizzle") });
  console.log("[db] migrations complete");

  await client.end();
}

main().catch((err) => {
  console.error("[db] migration failed:", err);
  process.exit(1);
});
