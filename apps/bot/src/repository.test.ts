import { describe, expect, it, vi } from "vitest";
import { privacyFenceHash } from "@lilac/core";
import type { Pool } from "pg";
import {
  createDraft,
  createGiveawayFromDraft,
  enqueueAction,
  getGiveaway,
  joinGiveaway,
  leaveGiveaway,
  type DraftPayload,
  type GiveawayRecord,
  type GiveawayStatus,
} from "./repository.js";

function fakePool(
  respond: (
    sql: string,
    values: unknown[] | undefined,
  ) => { rows?: unknown[]; rowCount?: number },
): { pool: Pool; query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async (sql: string, values?: unknown[]) => ({
    rows: [],
    rowCount: 0,
    ...respond(sql, values),
  }));
  const release = vi.fn();
  const pool = {
    connect: vi.fn(async () => ({ query, release })),
  } as unknown as Pool;
  return { pool, query, release };
}

const privacyHashSalt = "privacy-test-salt-that-is-at-least-32-bytes";
const entrantId = "100000000000000004";

function draftPayload(hostUserId = entrantId): DraftPayload {
  return {
    prize: "Prize",
    winnerCount: 1,
    durationSeconds: 60,
    scheduledStartAt: "2026-07-15T00:00:00.000Z",
    channelId: "100000000000000002",
    hostUserId,
    requiredRoleIds: [],
    prizeRoleIds: [],
    bonusRoles: [],
    requiredMessages: null,
    requiredRoleMode: null,
    messageScope: null,
  };
}

function giveaway(status: GiveawayStatus): GiveawayRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    guildId: "100000000000000001",
    channelId: "100000000000000002",
    messageId: null,
    creatorUserId: "100000000000000003",
    hostUserId: "100000000000000003",
    prize: "Prize",
    winnerCount: 1,
    durationSeconds: 60,
    scheduledStartAt: new Date("2026-07-15T00:00:00.000Z"),
    startedAt: null,
    endsAt: new Date("2026-07-15T00:01:00.000Z"),
    endedAt: null,
    status,
    requiredRoleMode: null,
    requiredMessages: null,
    messageScope: null,
    participantCount: 0,
    requiredRoleIds: [],
    prizeRoleIds: [],
    bonusRoles: [],
    createdAt: new Date("2026-07-15T00:00:00.000Z"),
    updatedAt: new Date("2026-07-15T00:00:00.000Z"),
  };
}

describe("giveaway identifier lookup", () => {
  it("rejects malformed identifiers without querying PostgreSQL", async () => {
    const query = vi
      .fn<(sql: string) => Promise<{ rows: never[] }>>()
      .mockResolvedValue({ rows: [] });
    const db = { query } as unknown as Pick<Pool, "query">;
    await expect(getGiveaway(db, "not-a-giveaway-id")).resolves.toBeNull();
    await expect(
      getGiveaway(db, "11111111-1111-4111-8111-111111111111 trailing"),
    ).resolves.toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it("uses the UUID index or exact message-id lookup without an OR cast", async () => {
    const query = vi
      .fn<(sql: string) => Promise<{ rows: never[] }>>()
      .mockResolvedValue({ rows: [] });
    const db = { query } as unknown as Pick<Pool, "query">;
    await getGiveaway(db, "11111111-1111-4111-8111-111111111111");
    await getGiveaway(db, "100000000000000001");
    const uuidSql = String(query.mock.calls[0]?.[0]);
    const messageSql = String(query.mock.calls[1]?.[0]);
    expect(uuidSql).toContain("g.id = $1::uuid");
    expect(uuidSql).not.toContain("g.id::text");
    expect(uuidSql).not.toContain(" OR ");
    expect(messageSql).toContain("g.message_id = $1");
    expect(messageSql).not.toContain(" OR ");
  });
});

describe("entry transaction boundaries", () => {
  it("takes the privacy lock before the giveaway row and blocks every incomplete deletion", async () => {
    for (const operation of ["join", "leave"] as const) {
      const { pool, query } = fakePool((sql) =>
        sql.includes("FROM data_deletion_requests") ? { rows: [{ "?column?": 1 }] } : {},
      );
      const result =
        operation === "join"
          ? joinGiveaway(pool, giveaway("active").id, {
              id: entrantId,
              username: "member",
              globalName: null,
              avatar: null,
            }, privacyHashSalt)
          : leaveGiveaway(
              pool,
              giveaway("active").id,
              entrantId,
              privacyHashSalt,
            );
      await expect(result).rejects.toThrow("data deletion request");
      const statements = query.mock.calls.map(([sql]) => String(sql));
      const privacyLock = statements.findIndex((sql) =>
        sql.includes("pg_advisory_xact_lock"),
      );
      const privacyCheck = statements.findIndex((sql) =>
        sql.includes("FROM data_deletion_requests"),
      );
      const giveawayLock = statements.findIndex((sql) =>
        sql.includes("FROM giveaways") && sql.includes("FOR UPDATE"),
      );
      expect(privacyLock).toBeGreaterThanOrEqual(0);
      expect(privacyCheck).toBeGreaterThan(privacyLock);
      expect(statements[privacyCheck]).toContain("status <> 'complete'");
      expect(giveawayLock).toBe(-1);
      expect(statements).toContain("ROLLBACK");
    }
  });

  it("rejects an incomplete durable privacy fence before locking the giveaway", async () => {
    const { pool, query } = fakePool((sql) =>
      sql.includes("SELECT completed_at, cleared_at")
        ? { rows: [{ completed_at: null, cleared_at: null }] }
        : {},
    );

    await expect(
      joinGiveaway(
        pool,
        giveaway("active").id,
        {
          id: entrantId,
          username: "member",
          globalName: null,
          avatar: null,
        },
        privacyHashSalt,
      ),
    ).rejects.toThrow("data deletion request");

    const statements = query.mock.calls.map(([sql]) => String(sql));
    const fenceQuery = query.mock.calls.find(([sql]) =>
      String(sql).includes("SELECT completed_at, cleared_at"),
    );
    expect(fenceQuery?.[1]).toEqual([privacyFenceHash(privacyHashSalt, entrantId)]);
    expect(statements.some((sql) => sql.includes("UPDATE privacy_deletion_fences"))).toBe(
      false,
    );
    expect(
      statements.some((sql) => sql.includes("FROM giveaways") && sql.includes("FOR UPDATE")),
    ).toBe(false);
    expect(statements).toContain("ROLLBACK");
  });

  it("treats Join as re-consent by clearing a completed fence before writing the entry", async () => {
    const { pool, query } = fakePool((sql) => {
      if (sql.includes("SELECT completed_at, cleared_at")) {
        return {
          rows: [{ completed_at: "2026-07-15T00:00:00.000Z", cleared_at: null }],
        };
      }
      if (sql.includes("UPDATE privacy_deletion_fences")) return { rowCount: 1 };
      if (sql.includes("AS entry_open")) {
        return { rows: [{ guild_id: "100000000000000001", entry_open: true }] };
      }
      if (sql.includes("SELECT left_at FROM entries")) return { rows: [] };
      if (sql.includes("RETURNING participant_count")) {
        return { rows: [{ participant_count: 1 }] };
      }
      return {};
    });

    await expect(
      joinGiveaway(
        pool,
        giveaway("active").id,
        {
          id: entrantId,
          username: "member",
          globalName: null,
          avatar: null,
        },
        privacyHashSalt,
      ),
    ).resolves.toEqual({ joined: true, participantCount: 1 });

    const statements = query.mock.calls.map(([sql]) => String(sql));
    const fenceRead = statements.findIndex((sql) =>
      sql.includes("SELECT completed_at, cleared_at"),
    );
    const fenceClear = statements.findIndex((sql) =>
      sql.includes("UPDATE privacy_deletion_fences"),
    );
    const giveawayLock = statements.findIndex(
      (sql) => sql.includes("FROM giveaways") && sql.includes("FOR UPDATE"),
    );
    expect(fenceClear).toBeGreaterThan(fenceRead);
    expect(giveawayLock).toBeGreaterThan(fenceClear);
    expect(String(query.mock.calls[fenceClear]?.[0])).toContain("completed_at IS NOT NULL");
    expect(query.mock.calls[fenceClear]?.[1]).toEqual([
      privacyFenceHash(privacyHashSalt, entrantId),
    ]);
    expect(statements).toContain("COMMIT");
  });

  it("fails closed if a completed privacy fence cannot be cleared", async () => {
    const { pool, query } = fakePool((sql) =>
      sql.includes("SELECT completed_at, cleared_at")
        ? {
            rows: [{ completed_at: "2026-07-15T00:00:00.000Z", cleared_at: null }],
          }
        : {},
    );

    await expect(
      joinGiveaway(
        pool,
        giveaway("active").id,
        {
          id: entrantId,
          username: "member",
          globalName: null,
          avatar: null,
        },
        privacyHashSalt,
      ),
    ).rejects.toThrow("privacy consent could not be updated");
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes("FROM giveaways") && String(sql).includes("FOR UPDATE"),
      ),
    ).toBe(false);
  });

  it("does not clear an active privacy fence on Leave", async () => {
    const { pool, query } = fakePool((sql) =>
      sql.includes("SELECT 1 FROM privacy_deletion_fences")
        ? { rows: [{ "?column?": 1 }] }
        : {},
    );

    await expect(
      leaveGiveaway(pool, giveaway("active").id, entrantId, privacyHashSalt),
    ).rejects.toThrow("privacy deletion fence");

    const statements = query.mock.calls.map(([sql]) => String(sql));
    const fenceQuery = query.mock.calls.find(([sql]) =>
      String(sql).includes("SELECT 1 FROM privacy_deletion_fences"),
    );
    expect(fenceQuery?.[1]).toEqual([privacyFenceHash(privacyHashSalt, entrantId)]);
    expect(statements.some((sql) => sql.includes("UPDATE privacy_deletion_fences"))).toBe(
      false,
    );
    expect(
      statements.some((sql) => sql.includes("FROM giveaways") && sql.includes("FOR UPDATE")),
    ).toBe(false);
    expect(statements).toContain("ROLLBACK");
  });

  it("rejects a join at the database-clock end boundary", async () => {
    const { pool, query, release } = fakePool((sql) =>
      sql.includes("AS entry_open")
        ? { rows: [{ guild_id: "100000000000000001", entry_open: false }] }
        : {},
    );

    await expect(
      joinGiveaway(pool, giveaway("active").id, {
        id: entrantId,
        username: "member",
        globalName: null,
        avatar: null,
      }, privacyHashSalt),
    ).rejects.toThrow("not active");

    const boundaryQuery = query.mock.calls.find(([sql]) =>
      String(sql).includes("AS entry_open"),
    );
    expect(String(boundaryQuery?.[0])).toContain("ends_at > clock_timestamp()");
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects a leave at the database-clock end boundary", async () => {
    const { pool, query } = fakePool((sql) =>
      sql.includes("AS entry_open")
        ? { rows: [{ guild_id: "100000000000000001", entry_open: false }] }
        : {},
    );

    await expect(
      leaveGiveaway(pool, giveaway("active").id, entrantId, privacyHashSalt),
    ).rejects.toThrow("not active");
    const boundaryQuery = query.mock.calls.find(([sql]) =>
      String(sql).includes("AS entry_open"),
    );
    expect(String(boundaryQuery?.[0])).toContain("ends_at > clock_timestamp()");
    expect(query).toHaveBeenCalledWith("ROLLBACK");
  });

  it("preserves the earliest queued refresh time after a real join", async () => {
    const { pool, query } = fakePool((sql) => {
      if (sql.includes("AS entry_open")) {
        return { rows: [{ guild_id: "100000000000000001", entry_open: true }] };
      }
      if (sql.includes("SELECT left_at FROM entries")) return { rows: [] };
      if (sql.includes("RETURNING participant_count")) {
        return { rows: [{ participant_count: 1 }] };
      }
      if (sql.includes("SELECT id FROM jobs")) return { rows: [{ id: "refresh-job" }] };
      return {};
    });

    await expect(
      joinGiveaway(pool, giveaway("active").id, {
        id: entrantId,
        username: "member",
        globalName: null,
        avatar: null,
      }, privacyHashSalt),
    ).resolves.toEqual({ joined: true, participantCount: 1 });
    const refreshUpdate = query.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE jobs"),
    );
    expect(String(refreshUpdate?.[0])).toContain(
      "LEAST(run_at, now() + interval '2 seconds')",
    );
  });
});

describe("management job deduplication", () => {
  it("takes the actor privacy lock before any giveaway management write", async () => {
    const { pool, query } = fakePool((sql) =>
      sql.includes("FROM data_deletion_requests") ? { rows: [{ exists: true }] } : {},
    );

    await expect(
      enqueueAction(
        pool,
        "delete_giveaway",
        giveaway("queued"),
        entrantId,
        "discord",
        privacyHashSalt,
      ),
    ).rejects.toThrow("data deletion");
    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements.findIndex((sql) => sql.includes("pg_advisory_xact_lock")))
      .toBeGreaterThanOrEqual(0);
    expect(statements.findIndex((sql) => sql.includes("FROM giveaways"))).toBe(-1);
    expect(statements.some((sql) => sql.includes("INSERT INTO jobs"))).toBe(false);
    expect(statements).toContain("ROLLBACK");
  });

  it("accelerates scheduled start/end jobs and deduplicates immediate actions", async () => {
    const cases = [
      ["start_giveaway", "queued"],
      ["end_giveaway", "active"],
      ["delete_giveaway", "queued"],
    ] as const;
    for (const [type, status] of cases) {
      const scheduledLifecycle = type === "start_giveaway" || type === "end_giveaway";
      const { pool, query } = fakePool((sql) => {
        if (sql.includes("SELECT status FROM giveaways")) return { rows: [{ status }] };
        if (sql.includes("SELECT id, run_at")) {
          return { rows: [{ id: "existing", immediate: !scheduledLifecycle }] };
        }
        return {};
      });
      await enqueueAction(
        pool,
        type,
        giveaway(status),
        "100000000000000004",
        "discord",
        privacyHashSalt,
        undefined,
      );
      const statements = query.mock.calls.map(([sql]) => String(sql));
      const duplicateQuery = statements.find((sql) => sql.includes("SELECT id, run_at"));
      expect(duplicateQuery).not.toContain("payload");
      expect(statements.some((sql) => sql.includes("INSERT INTO jobs"))).toBe(false);
      expect(statements).toContain("COMMIT");
      if (scheduledLifecycle) {
        const acceleration = query.mock.calls.find(([sql]) =>
          String(sql).includes("SET run_at = LEAST(run_at, now())"),
        );
        expect(acceleration).toBeDefined();
        expect(String(acceleration?.[0])).toContain("payload = payload || $2::jsonb");
        expect(String(acceleration?.[1]?.[1])).toContain('"actorUserId"');
        expect(statements.some((sql) => sql.includes("INSERT INTO audit_events")))
          .toBe(true);
      } else {
        expect(statements.some((sql) => sql.includes("UPDATE jobs"))).toBe(false);
        expect(statements.some((sql) => sql.includes("INSERT INTO audit_events")))
          .toBe(false);
      }
    }
  });

  it("rejects a duplicate reroll instead of claiming a new count was queued", async () => {
    const { pool, query } = fakePool((sql) => {
      if (sql.includes("SELECT status FROM giveaways")) {
        return { rows: [{ status: "ended" }] };
      }
      if (sql.includes("SELECT id, run_at")) {
        return { rows: [{ id: "existing", immediate: true }] };
      }
      return {};
    });

    await expect(
      enqueueAction(
        pool,
        "reroll_giveaway",
        giveaway("ended"),
        "100000000000000004",
        "discord",
        privacyHashSalt,
        25,
      ),
    ).rejects.toThrow("Another reroll");
    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements.findIndex((sql) => sql.includes("pg_advisory_xact_lock")))
      .toBeLessThan(statements.findIndex((sql) => sql.includes("FOR UPDATE")));
    expect(statements).toContain("ROLLBACK");
    expect(statements.some((sql) => sql.includes("INSERT INTO audit_events"))).toBe(false);
  });

  it("does not duplicate start/end jobs that are already immediate", async () => {
    for (const [type, status] of [
      ["start_giveaway", "queued"],
      ["end_giveaway", "active"],
    ] as const) {
      const { pool, query } = fakePool((sql) => {
        if (sql.includes("SELECT status FROM giveaways")) return { rows: [{ status }] };
        if (sql.includes("SELECT id, run_at")) {
          return { rows: [{ id: "existing", immediate: true }] };
        }
        return {};
      });
      await enqueueAction(
        pool,
        type,
        giveaway(status),
        "100000000000000004",
        "discord",
        privacyHashSalt,
      );
      const statements = query.mock.calls.map(([sql]) => String(sql));
      expect(statements.some((sql) => sql.includes("UPDATE jobs"))).toBe(false);
      expect(statements.some((sql) => sql.includes("INSERT INTO audit_events")))
        .toBe(false);
      expect(statements).toContain("COMMIT");
    }
  });
});

describe("draft privacy fencing", () => {
  const creatorId = "100000000000000004";
  const hostId = "100000000000000005";

  it("rejects an active credited-host fence before persisting a draft", async () => {
    const hostHash = privacyFenceHash(privacyHashSalt, hostId);
    const { pool, query } = fakePool((sql, values) =>
      sql.includes("SELECT completed_at, cleared_at") && values?.[0] === hostHash
        ? { rows: [{ completed_at: null, cleared_at: null }] }
        : {},
    );

    await expect(
      createDraft(
        pool,
        "100000000000000001",
        creatorId,
        draftPayload(hostId),
        privacyHashSalt,
      ),
    ).rejects.toThrow("credited host");
    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements.filter((sql) => sql.includes("pg_advisory_xact_lock"))).toHaveLength(2);
    expect(statements.some((sql) => sql.includes("INSERT INTO giveaway_drafts"))).toBe(false);
    expect(statements).toContain("ROLLBACK");
  });

  it("rechecks host privacy before committing an existing draft", async () => {
    const payload = draftPayload(hostId);
    const hostHash = privacyFenceHash(privacyHashSalt, hostId);
    const { pool, query } = fakePool((sql, values) => {
      if (sql.includes("SELECT creator_user_id, payload")) {
        return { rows: [{ creator_user_id: creatorId, payload }] };
      }
      if (sql.includes("SELECT completed_at, cleared_at") && values?.[0] === hostHash) {
        return { rows: [{ completed_at: null, cleared_at: null }] };
      }
      return {};
    });

    await expect(
      createGiveawayFromDraft(
        pool,
        "11111111-1111-4111-8111-111111111111",
        creatorId,
        "Guild",
        null,
        privacyHashSalt,
      ),
    ).rejects.toThrow("credited host");
    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.includes("INSERT INTO giveaways"))).toBe(false);
    expect(statements).toContain("ROLLBACK");
  });
});
