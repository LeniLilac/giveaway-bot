import pg from "pg";
import { v7 as uuidv7 } from "uuid";

const { Pool } = pg;
let pool: pg.Pool | undefined;

export type DatabaseClient = pg.Pool | pg.PoolClient;

export function getPool(): pg.Pool {
  pool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.DB_POOL_MAX ?? 20),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  return pool;
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  const current = pool;
  pool = undefined;
  await current.end();
}

export async function withTransaction<T>(
  operation: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function newId(): string {
  return uuidv7();
}

export async function enqueueJob(
  input: {
    type: string;
    giveawayId?: string;
    payload?: Record<string, unknown>;
    runAt?: Date;
    idempotencyKey?: string;
  },
  client: DatabaseClient = getPool(),
): Promise<string> {
  const id = newId();
  await client.query(
    `INSERT INTO jobs (id, type, giveaway_id, payload, run_at, idempotency_key)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
     DO NOTHING`,
    [
      id,
      input.type,
      input.giveawayId ?? null,
      JSON.stringify(input.payload ?? {}),
      input.runAt ?? new Date(),
      input.idempotencyKey ?? null,
    ],
  );
  return id;
}

export async function lockGuildCapacity(
  client: pg.PoolClient,
  guildId: string,
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `giveaway-cap:${guildId}`,
  ]);
}
