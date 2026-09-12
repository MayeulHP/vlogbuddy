import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Database = ReturnType<typeof drizzle<typeof schema>>;

export function createDb(connectionString?: string) {
  const url = connectionString ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  const client = postgres(url, {
    max: Number(process.env.DB_POOL_MAX ?? 10),
    idle_timeout: 30,
    connect_timeout: 15,
  });

  return { db: drizzle(client, { schema }), client };
}

interface DbSingleton {
  db: Database;
  client: postgres.Sql;
}

// Reused across hot reloads in dev so we don't leak connections.
const globalRef = globalThis as typeof globalThis & {
  __vlogbuddyDb?: DbSingleton;
};

function getSingleton(): DbSingleton {
  if (!globalRef.__vlogbuddyDb) {
    globalRef.__vlogbuddyDb = createDb();
  }
  return globalRef.__vlogbuddyDb;
}

/**
 * Lazy proxy so importing this module never opens a connection — important for
 * Next.js, where modules get evaluated during builds without a real database.
 */
export const db: Database = new Proxy({} as Database, {
  get(_target, prop, receiver) {
    const instance = getSingleton().db;
    const value = Reflect.get(instance as object, prop, receiver);
    return typeof value === "function" ? value.bind(instance) : value;
  },
});

export function getSqlClient(): postgres.Sql {
  return getSingleton().client;
}

export { schema };
