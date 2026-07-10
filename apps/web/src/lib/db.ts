import { Pool } from "pg";

const globalForPool = globalThis as unknown as { giveawayPool?: Pool };

function getPool(): Pool {
  if (globalForPool.giveawayPool) return globalForPool.giveawayPool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required at runtime.");
  const pool = new Pool({ connectionString, max: 10 });
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
