import { Pool } from "pg";

const globalForPool = globalThis as unknown as { giveawayPool?: Pool };

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required.");
  return new Pool({ connectionString, max: 10 });
}

export const db = globalForPool.giveawayPool ?? createPool();

if (process.env.NODE_ENV !== "production") globalForPool.giveawayPool = db;
