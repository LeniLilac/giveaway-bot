import { Pool } from "pg";

const globalForPool = globalThis as unknown as { giveawayPool?: Pool };

function getPool(): Pool {
  if (globalForPool.giveawayPool) return globalForPool.giveawayPool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    for (const name of ["PGHOST", "PGDATABASE", "PGUSER", "PGPASSWORD"]) {
      if (!process.env[name]) {
        throw new Error(
          "DATABASE_URL or complete PGHOST/PGDATABASE/PGUSER/PGPASSWORD settings are required at runtime.",
        );
      }
    }
  }
  const pool = new Pool({
    ...(connectionString ? { connectionString } : {}),
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 15_000,
    query_timeout: 20_000,
  });
  globalForPool.giveawayPool = pool;
  return pool;
}

export const db = new Proxy({} as Pool, {
  get(_target, property) {
    const pool = getPool();
    const value = Reflect.get(pool, property, pool) as unknown;
    return typeof value === "function" ? value.bind(pool) : value;
  },
});
