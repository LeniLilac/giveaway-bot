import type { Pool, PoolClient } from "pg";
import { db } from "./db";

type ConnectablePool = Pick<Pool, "connect">;

export async function withPublicEvidenceSnapshot<T>(
  loader: (client: PoolClient) => Promise<T>,
  pool: ConnectablePool = db,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    const result = await loader(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
