import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, getPool } from "./index.js";

const directory = process.env.MIGRATIONS_DIR ?? path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../db/migrations",
);
await getPool().query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
for (const name of (await readdir(directory)).filter((item) => item.endsWith(".sql")).sort()) {
  const exists = await getPool().query("SELECT 1 FROM schema_migrations WHERE name=$1", [name]);
  if (exists.rowCount) continue;
  const sql = await readFile(path.join(directory, name), "utf8");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
await closePool();
