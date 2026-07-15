import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { withPublicEvidenceSnapshot } from "./public-snapshot";

function database() {
  const statements: string[] = [];
  const release = vi.fn();
  const client = {
    query: vi.fn(async (statement: string) => {
      statements.push(statement);
      return { rows: [] };
    }),
    release,
  } as unknown as PoolClient;
  const pool = {
    connect: vi.fn(async () => client),
  } as unknown as Pick<Pool, "connect">;
  return { client, pool, release, statements };
}

describe("public evidence database snapshot", () => {
  it("uses one repeatable-read, read-only transaction and commits it", async () => {
    const current = database();
    await expect(
      withPublicEvidenceSnapshot(async (client) => {
        expect(client).toBe(current.client);
        await client.query("SELECT evidence");
        return 42;
      }, current.pool),
    ).resolves.toBe(42);

    expect(current.statements).toEqual([
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "SELECT evidence",
      "COMMIT",
    ]);
    expect(current.release).toHaveBeenCalledOnce();
  });

  it("rolls back and releases the client when a projection fails", async () => {
    const current = database();
    await expect(
      withPublicEvidenceSnapshot(async () => {
        throw new Error("projection failed");
      }, current.pool),
    ).rejects.toThrow("projection failed");

    expect(current.statements).toEqual([
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "ROLLBACK",
    ]);
    expect(current.release).toHaveBeenCalledOnce();
  });
});
