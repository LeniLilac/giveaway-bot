import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import pino from "pino";
import { privacyFenceHash } from "@lilac/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimDiscordDelivery,
  claimJob,
  completeJob,
  createDrawCommitment,
  getDraw,
  getGiveaway,
  markDiscordDeliverySending,
  persistWinners,
  previousWinnerProofIds,
  retryJob,
  type DrawRow,
  type Job,
} from "./database.js";
import {
  deactivateOldRoleClaims,
  grantPrizeRoles,
  processJob,
  proofIdForUser,
} from "./lifecycle.js";
import type { Candidate } from "./selection.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
let pool: Pool;

class FakeDiscord {
  readonly roles = new Map<string, Set<string>>();
  posts = 0;
  additions = 0;
  removals = 0;
  winnerAnnouncements: Array<{ winnerIds: string[]; redactedWinnerCount: number }> = [];
  redactedWinnerMessages: string[] = [];
  redactedGiveawayMessages: string[] = [];
  redactedGiveawayMessageIds: string[] = [];
  messageCount = 0;
  memberSnapshots = 0;
  omittedSnapshotMembers = new Set<string>();
  messageSearchError: Error | null = null;
  messageSearches: Array<{ guildId: string; userId: string; since: Date | null }> = [];
  reconciliation:
    | { status: "found"; messageId: string }
    | { status: "absent" }
    | { status: "unknown" } = { status: "unknown" };

  deliveryNonce(value: string) {
    return value.padEnd(24, "0").slice(0, 24);
  }
  async findMessageByNonce() {
    return this.reconciliation;
  }

  async getMember(_guildId: string, userId: string) {
    return { user: { id: userId, username: userId }, roles: [...(this.roles.get(userId) ?? [])] };
  }
  async getMembers(guildId: string, userIds: string[]) {
    this.memberSnapshots += 1;
    return new Map(
      await Promise.all(
        userIds
          .filter((userId) => !this.omittedSnapshotMembers.has(userId))
          .map(async (userId) => [userId, await this.getMember(guildId, userId)] as const),
      ),
    );
  }
  async searchMessageCount(guildId: string, userId: string, since: Date | null) {
    this.messageSearches.push({ guildId, userId, since });
    if (this.messageSearchError) throw this.messageSearchError;
    return this.messageCount;
  }
  async addRole(_guildId: string, userId: string, roleId: string) {
    this.additions += 1;
    const roles = this.roles.get(userId) ?? new Set<string>();
    roles.add(roleId);
    this.roles.set(userId, roles);
  }
  async removeRole(_guildId: string, userId: string, roleId: string) {
    this.removals += 1;
    this.roles.get(userId)?.delete(roleId);
  }
  async postGiveaway() {
    this.posts += 1;
    return { id: "100000000000000099" };
  }
  async refreshGiveaway() {}
  async tombstone() {}
  async postWinners(
    _giveaway: unknown,
    winnerIds: string[],
    redactedWinnerCount: number,
  ) {
    this.winnerAnnouncements.push({ winnerIds, redactedWinnerCount });
  }
  async redactWinnerMessage(
    _channelId: string,
    messageId: string,
  ) {
    this.redactedWinnerMessages.push(messageId);
  }
  async redactGiveawayIdentity(
    giveaway: { id: string; messageId?: string | null },
    userId: string,
  ) {
    this.redactedGiveawayMessages.push(`${giveaway.id}:${userId}`);
    if (giveaway.messageId) this.redactedGiveawayMessageIds.push(giveaway.messageId);
  }
  async postRerollRejected() {
    return { id: "100000000000000098" };
  }
}

const salt = "integration-proof-salt-at-least-32-bytes";
const logger = pino({ level: "silent" });

function dependencies(discord: FakeDiscord) {
  return {
    pool,
    discord,
    logger,
    websiteUrl: "https://example.invalid",
    privacyHashSalt: salt,
    drand: {
      chainHash: "00".repeat(32),
      publicKey: "00",
      period: 3,
      genesisTime: 1,
      scheme: "test",
      baseUrls: [] as string[],
    },
  };
}

function job(input: Partial<Job> & Pick<Job, "id" | "type">): Job {
  return {
    id: input.id,
    type: input.type,
    giveawayId: input.giveawayId ?? null,
    payload: input.payload ?? {},
    attempts: input.attempts ?? 1,
    maxAttempts: input.maxAttempts ?? 10,
    lockedBy: input.lockedBy ?? "test-worker",
    lockToken: input.lockToken ?? randomUUID(),
  };
}

async function insertGiveaway(id: string, status = "ended", participantCount = 0) {
  await pool.query(
    `INSERT INTO giveaways
       (id, guild_id, channel_id, creator_user_id, host_user_id, prize,
        winner_count, duration_seconds, scheduled_start_at, started_at, ends_at,
        ended_at, status, participant_count)
     VALUES ($1, 'guild', 'channel', 'creator', 'creator', 'Prize', 1, 60,
             now(), now(), now(), CASE WHEN $2 = 'ended' THEN now() END, $2, $3)`,
    [id, status, participantCount],
  );
}

async function insertLegacyDraw(drawId: string, giveawayId: string, userId: string, status = "complete") {
  const client = await pool.connect();
  try {
    await client.query("SET session_replication_role = replica");
    await client.query(
    `INSERT INTO draws
       (id, giveaway_id, draw_number, requested_by_user_id, requested_winner_count,
        candidate_hash, drand_chain_hash, drand_round, drand_beacon_time,
        proof_version, status)
     VALUES ($1, $2, 1, $3, 1, 'original-hash', $4, 1, now() + interval '1 minute',
             'lilac-weighted-v1', 'awaiting_beacon')`,
      [drawId, giveawayId, userId, "00".repeat(32)],
    );
    await client.query(
    `INSERT INTO draw_candidates (draw_id, user_id, username, joined_at, weight, ordinal)
     VALUES ($1, $2, 'person', now() - interval '1 hour', 1, 0)`,
      [drawId, userId],
    );
    await client.query(
      "UPDATE draws SET commitment_published_at = now() WHERE id = $1",
      [drawId],
    );
    if (status === "complete") {
      await client.query(
      `INSERT INTO draw_winners (draw_id, user_id, username, position)
       VALUES ($1, $2, 'person', 1)`,
        [drawId, userId],
      );
      await client.query(
      `UPDATE draws SET status = 'complete', drand_signature = 'signature',
         drand_randomness = 'randomness', drand_beacon = '{}'::jsonb,
         completed_at = now() WHERE id = $1`,
        [drawId],
      );
    }
  } finally {
    await client.query("SET session_replication_role = origin").catch(() => undefined);
    client.release();
  }
}

async function makeDrawBeaconAvailable(drawId: string) {
  const fixtureClient = await pool.connect();
  try {
    await fixtureClient.query("SET session_replication_role = replica");
    await fixtureClient.query(
      "UPDATE draws SET drand_beacon_time = now() - interval '1 minute' WHERE id = $1",
      [drawId],
    );
  } finally {
    await fixtureClient.query("SET session_replication_role = origin").catch(() => undefined);
    fixtureClient.release();
  }
}

async function insertV2Draw(
  drawId: string,
  giveawayId: string,
  userIds: string[],
  status: "awaiting_beacon" | "complete" = "complete",
) {
  await pool.query(
    `INSERT INTO draws
       (id, giveaway_id, draw_number, requested_winner_count, candidate_hash,
        drand_chain_hash, drand_round, drand_beacon_time, proof_version, status)
     VALUES ($1, $2, 1, $3, $4, $5, 1, now() + interval '1 minute',
             'lilac-weighted-v2', 'awaiting_beacon')`,
    [drawId, giveawayId, userIds.length, "aa".repeat(32), "00".repeat(32)],
  );
  for (const [ordinal, userId] of userIds.entries()) {
    await pool.query(
      `INSERT INTO draw_candidates
         (draw_id, user_id, proof_id, username, joined_at, weight, ordinal)
       VALUES ($1, $2, $3, 'person', now() - interval '1 hour', 1, $4)`,
      [drawId, userId, proofIdForUser({ privacyHashSalt: salt }, giveawayId, userId), ordinal],
    );
  }
  await pool.query("UPDATE draws SET commitment_published_at = now() WHERE id = $1", [drawId]);
  if (status === "complete") {
    await makeDrawBeaconAvailable(drawId);
    for (const [position, userId] of userIds.entries()) {
      await pool.query(
        `INSERT INTO draw_winners (draw_id, user_id, proof_id, username, position)
         VALUES ($1, $2, $3, 'person', $4)`,
        [
          drawId,
          userId,
          proofIdForUser({ privacyHashSalt: salt }, giveawayId, userId),
          position + 1,
        ],
      );
    }
    await pool.query(
      `UPDATE draws SET status = 'complete', drand_signature = 'signature',
         drand_randomness = 'randomness', drand_beacon = '{}'::jsonb,
         completed_at = now() WHERE id = $1`,
      [drawId],
    );
  }
}

async function claimedPrivacyJob(userId: string, requestId: string): Promise<Job> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO jobs (id, type, payload, run_at, idempotency_key)
     VALUES ($1, 'privacy_delete', jsonb_build_object(
       'userId', $2::text, 'requestId', $3::text
     ), now(), $4)`,
    [id, userId, requestId, `privacy:${requestId}`],
  );
  const claimed = await claimJob(pool, `privacy-worker:${requestId}`);
  if (!claimed || claimed.id !== id) throw new Error("Privacy test job was not claimed.");
  return claimed;
}

suite("worker database security invariants", () => {
  beforeAll(async () => {
    const parsed = new URL(databaseUrl!);
    const loopback = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
    if (
      process.env.NODE_ENV !== "test" ||
      !loopback.has(parsed.hostname.toLowerCase()) ||
      parsed.pathname !== "/giveaway_bot_test"
    ) {
      throw new Error(
        "Integration reset requires NODE_ENV=test and local database giveaway_bot_test.",
      );
    }
    pool = new Pool({ connectionString: databaseUrl, max: 6 });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    for (const name of [
      "001_initial.sql",
      "002_custom_reroll_winner_count.sql",
      "003_security_hardening.sql",
    ]) {
      await pool.query(await readFile(resolve("db/migrations", name), "utf8"));
    }
  });

  beforeEach(async () => {
    const tables = await pool.query(
      `SELECT tablename FROM pg_tables
       WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
    );
    if (tables.rows.length > 0) {
      const names = tables.rows.map((row) => `"${String(row.tablename).replaceAll('"', '""')}"`);
      await pool.query(`TRUNCATE ${names.join(", ")} CASCADE`);
    }
  });

  afterAll(async () => pool?.end());
  afterEach(() => vi.unstubAllGlobals());

  it("fences a stale job owner and preserves idempotency keys", async () => {
    const giveawayId = randomUUID();
    await insertGiveaway(giveawayId);
    await pool.query(
      `INSERT INTO jobs (id, type, giveaway_id, run_at, idempotency_key)
       VALUES ($1, 'refresh_giveaway', $2, now(), 'refresh:one')`,
      [randomUUID(), giveawayId],
    );
    const first = await claimJob(pool, "worker-one");
    expect(first).not.toBeNull();
    await pool.query("UPDATE jobs SET lease_expires_at = now() - interval '1 second'");
    const second = await claimJob(pool, "worker-two");
    expect(second?.id).toBe(first?.id);
    await expect(completeJob(pool, first!)).resolves.toBe(false);
    await expect(completeJob(pool, second!)).resolves.toBe(true);
    await expect(
      pool.query(
        `INSERT INTO jobs (id, type, run_at, idempotency_key)
         VALUES ($1, 'refresh_giveaway', now(), 'refresh:one')`,
        [randomUUID()],
      ),
    ).rejects.toThrow();

    await pool.query(
      `INSERT INTO jobs (id, type, giveaway_id, payload, run_at, attempts, max_attempts)
       VALUES ($1, 'complete_draw', $2, jsonb_build_object('drawId', $3::text),
               now(), 50, 10)`,
      [randomUUID(), giveawayId, randomUUID()],
    );
    const persistent = await claimJob(pool, "worker-three");
    expect(persistent?.attempts).toBe(51);
    await expect(retryJob(pool, persistent!, new Error("retry"))).resolves.toBe(true);
    const retried = await pool.query("SELECT completed_at, run_at > now() AS delayed FROM jobs WHERE id = $1", [
      persistent!.id,
    ]);
    expect(retried.rows[0]).toMatchObject({ completed_at: null, delayed: true });

    const privacyId = randomUUID();
    const privacyRequestId = randomUUID();
    const privacyUserId = "100000000000000018";
    await pool.query(
      "INSERT INTO data_deletion_requests (id, user_id, status) VALUES ($1, $2, 'queued')",
      [privacyRequestId, privacyUserId],
    );
    await pool.query(
      `INSERT INTO privacy_deletion_fences (user_id_hash, request_id)
       VALUES ($1, $2)`,
      [privacyFenceHash(salt, privacyUserId), privacyRequestId],
    );
    await pool.query(
      `INSERT INTO jobs
         (id, type, payload, run_at, attempts, max_attempts, idempotency_key)
       VALUES ($1, 'privacy_delete',
               jsonb_build_object('userId', $2::text, 'requestId', $3::text),
               now(), 50, 10, $4)`,
      [privacyId, privacyUserId, privacyRequestId, `privacy:${privacyRequestId}`],
    );
    const persistentPrivacy = await claimJob(pool, "privacy-persistent");
    expect(persistentPrivacy?.id).toBe(privacyId);
    await retryJob(pool, persistentPrivacy!, new Error("retry privacy"));
    const privacyRetry = await pool.query(
      "SELECT completed_at, run_at > now() AS delayed FROM jobs WHERE id = $1",
      [privacyId],
    );
    expect(privacyRetry.rows[0]).toMatchObject({ completed_at: null, delayed: true });
    await pool.query("UPDATE jobs SET run_at = now() WHERE id = $1", [privacyId]);
    const malformedPrivacy = await claimJob(pool, "privacy-malformed");
    await retryJob(pool, malformedPrivacy!, new Error("malformed"), { forceTerminal: true });
    const terminalPrivacy = await pool.query(
      `SELECT job.completed_at, job.payload, job.idempotency_key,
              request.status, request.completed_at AS request_completed_at,
              fence.completed_at AS fence_completed_at, fence.cleared_at
       FROM jobs job
       JOIN data_deletion_requests request ON request.id = $2
       JOIN privacy_deletion_fences fence ON fence.request_id = request.id
       WHERE job.id = $1`,
      [privacyId, privacyRequestId],
    );
    expect(terminalPrivacy.rows[0]!.completed_at).not.toBeNull();
    expect(terminalPrivacy.rows[0]).toMatchObject({
      payload: { requestId: privacyRequestId },
      idempotency_key: null,
      status: "failed",
      request_completed_at: null,
      fence_completed_at: null,
      cleared_at: null,
    });
  });

  it("does not corrupt giveaway lifecycle state when a refresh job exhausts retries", async () => {
    const giveawayId = randomUUID();
    await insertGiveaway(giveawayId, "active");
    const refreshId = randomUUID();
    await pool.query(
      `INSERT INTO jobs
         (id, type, giveaway_id, run_at, attempts, max_attempts)
       VALUES ($1, 'refresh_giveaway', $2, now(), 9, 10)`,
      [refreshId, giveawayId],
    );
    const refresh = await claimJob(pool, "refresh-worker");
    expect(refresh?.id).toBe(refreshId);
    await expect(
      retryJob(pool, refresh!, new Error("Discord refresh failed"), {
        markGiveawayError: true,
      }),
    ).resolves.toBe(true);

    const state = await pool.query(
      `SELECT giveaway.status, job.completed_at
       FROM giveaways giveaway JOIN jobs job ON job.giveaway_id = giveaway.id
       WHERE giveaway.id = $1 AND job.id = $2`,
      [giveawayId, refreshId],
    );
    expect(state.rows[0]!.status).toBe("active");
    expect(state.rows[0]!.completed_at).not.toBeNull();
  });

  it("chooses a DB-clock-guarded future round and rejects a stale privacy snapshot", async () => {
    const giveawayId = randomUUID();
    const userId = "100000000000000009";
    await insertGiveaway(giveawayId, "active", 1);
    await pool.query(
      "INSERT INTO entries (giveaway_id, user_id, username) VALUES ($1, $2, 'person')",
      [giveawayId, userId],
    );
    const giveaway = (await getGiveaway(pool, giveawayId))!;
    const candidate: Candidate = {
      userId,
      participantId: proofIdForUser({ privacyHashSalt: salt }, giveawayId, userId),
      ordinal: 0,
      username: "person",
      joinedAt: new Date(),
      weight: 1,
    };
    const committed = await createDrawCommitment(pool, {
      drawId: randomUUID(),
      giveaway,
      requestedWinnerCount: 1,
      candidates: [candidate],
      exclusions: [],
      privacyFenceHashesByUser: {
        [userId]: privacyFenceHash(salt, userId),
      },
      candidateHash: "aa".repeat(32),
      chainHash: "00".repeat(32),
      chainInfo: {
        hash: "00".repeat(32),
        public_key: "00",
        period: 3,
        genesis_time: 1692803367,
        schemeID: "test",
      },
      actorUserId: null,
    });
    expect(committed.drandBeaconTime.getTime()).toBeGreaterThanOrEqual(Date.now() + 15_000);

    const staleGiveawayId = randomUUID();
    await insertGiveaway(staleGiveawayId, "active", 1);
    await pool.query(
      "INSERT INTO entries (giveaway_id, user_id, username) VALUES ($1, $2, 'person')",
      [staleGiveawayId, userId],
    );
    const requestId = randomUUID();
    await pool.query(
      "INSERT INTO data_deletion_requests (id, user_id, status) VALUES ($1, $2, 'queued')",
      [requestId, userId],
    );
    const staleGiveaway = (await getGiveaway(pool, staleGiveawayId))!;
    await expect(
      createDrawCommitment(pool, {
        drawId: randomUUID(),
        giveaway: staleGiveaway,
        requestedWinnerCount: 1,
        candidates: [{
          ...candidate,
          participantId: proofIdForUser(
            { privacyHashSalt: salt },
            staleGiveawayId,
            userId,
          ),
        }],
        exclusions: [],
        privacyFenceHashesByUser: {
          [userId]: privacyFenceHash(salt, userId),
        },
        candidateHash: "bb".repeat(32),
        chainHash: "00".repeat(32),
        chainInfo: {
          hash: "00".repeat(32),
          public_key: "00",
          period: 3,
          genesis_time: 1692803367,
          schemeID: "test",
        },
        actorUserId: null,
      }),
    ).rejects.toThrow("privacy state changed");
  });

  it("serializes privacy fencing ahead of draw snapshot commitment", async () => {
    const giveawayId = randomUUID();
    const userId = "100000000000000019";
    const requestId = randomUUID();
    await insertGiveaway(giveawayId, "active", 1);
    await pool.query(
      "INSERT INTO entries (giveaway_id, user_id, username) VALUES ($1, $2, 'person')",
      [giveawayId, userId],
    );
    const giveaway = (await getGiveaway(pool, giveawayId))!;
    const candidate: Candidate = {
      userId,
      participantId: proofIdForUser({ privacyHashSalt: salt }, giveawayId, userId),
      ordinal: 0,
      username: "person",
      joinedAt: new Date(),
      weight: 1,
    };
    const privacy = await pool.connect();
    try {
      await privacy.query("BEGIN");
      await privacy.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`privacy-delete:${userId}`],
      );
      await privacy.query("SELECT id FROM giveaways WHERE id = $1 FOR UPDATE", [giveawayId]);
      await privacy.query(
        "INSERT INTO data_deletion_requests (id, user_id, status) VALUES ($1, $2, 'queued')",
        [requestId, userId],
      );
      await privacy.query(
        `INSERT INTO privacy_deletion_fences (user_id_hash, request_id)
         VALUES ($1, $2)`,
        [privacyFenceHash(salt, userId), requestId],
      );

      let settled = false;
      const commitment = createDrawCommitment(pool, {
        drawId: randomUUID(),
        giveaway,
        requestedWinnerCount: 1,
        candidates: [candidate],
        exclusions: [],
        privacyFenceHashesByUser: { [userId]: privacyFenceHash(salt, userId) },
        candidateHash: "cc".repeat(32),
        chainHash: "00".repeat(32),
        chainInfo: {
          hash: "00".repeat(32),
          public_key: "00",
          period: 3,
          genesis_time: 1692803367,
          schemeID: "test",
        },
        actorUserId: null,
      }).finally(() => {
        settled = true;
      });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      expect(settled).toBe(false);
      await privacy.query("COMMIT");
      await expect(commitment).rejects.toThrow("privacy state changed");
    } finally {
      await privacy.query("ROLLBACK").catch(() => undefined);
      privacy.release();
    }
  });

  it("rechecks message requirements at snapshot using the actual start time", async () => {
    const giveawayId = randomUUID();
    const userId = "100000000000000040";
    const startedAt = new Date("2026-01-02T03:04:05.000Z");
    await insertGiveaway(giveawayId, "active", 1);
    await pool.query(
      `UPDATE giveaways SET required_messages = 5, message_scope = 'since_start',
         started_at = $2, ends_at = now() - interval '1 second',
         message_id = '100000000000000094'
       WHERE id = $1`,
      [giveawayId, startedAt],
    );
    await pool.query(
      `INSERT INTO entries (giveaway_id, user_id, username, joined_at)
       VALUES ($1, $2, 'person', $3)`,
      [giveawayId, userId, new Date("2026-02-01T00:00:00.000Z")],
    );
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      hash: "00".repeat(32),
      public_key: "00",
      period: 3,
      genesis_time: 1,
      schemeID: "test",
      groupHash: "00".repeat(32),
      metadata: { beaconID: "test" },
    }))));
    const discord = new FakeDiscord();
    discord.messageCount = 4;
    const deps = dependencies(discord);
    deps.drand.baseUrls = ["https://relay.invalid"];
    await processJob(
      deps as never,
      job({ id: randomUUID(), type: "end_giveaway", giveawayId }),
    );
    expect(discord.memberSnapshots).toBe(1);
    expect(discord.messageSearches).toEqual([{ guildId: "guild", userId, since: startedAt }]);
    const exclusion = await pool.query(
      `SELECT exclusion.reason
       FROM draw_exclusions exclusion JOIN draws draw ON draw.id = exclusion.draw_id
       WHERE draw.giveaway_id = $1 AND exclusion.user_id = $2`,
      [giveawayId, userId],
    );
    expect(exclusion.rows[0]!.reason).toBe("message_requirement_not_met");
  });

  it("does not publish a partial snapshot when message search fails", async () => {
    const giveawayId = randomUUID();
    const userId = "100000000000000041";
    await insertGiveaway(giveawayId, "active", 1);
    await pool.query(
      `UPDATE giveaways SET required_messages = 1, message_scope = 'all_time',
         ends_at = now() - interval '1 second', message_id = '100000000000000095'
       WHERE id = $1`,
      [giveawayId],
    );
    await pool.query(
      `INSERT INTO entries (giveaway_id, user_id, username, joined_at)
       VALUES ($1, $2, 'person', now() - interval '1 minute')`,
      [giveawayId, userId],
    );
    const discord = new FakeDiscord();
    discord.messageSearchError = new Error("Discord message search timed out.");
    await expect(processJob(
      dependencies(discord) as never,
      job({ id: randomUUID(), type: "end_giveaway", giveawayId }),
    )).rejects.toThrow("message search timed out");
    const drawCount = await pool.query(
      "SELECT count(*)::int AS count FROM draws WHERE giveaway_id = $1",
      [giveawayId],
    );
    expect(drawCount.rows[0]!.count).toBe(0);
  });

  it("does not publish a partial snapshot when member resolution is incomplete", async () => {
    const giveawayId = randomUUID();
    const userId = "100000000000000042";
    await insertGiveaway(giveawayId, "active", 1);
    await pool.query(
      `UPDATE giveaways SET ends_at = now() - interval '1 second',
         message_id = '100000000000000096'
       WHERE id = $1`,
      [giveawayId],
    );
    await pool.query(
      `INSERT INTO entries (giveaway_id, user_id, username, joined_at)
       VALUES ($1, $2, 'person', now() - interval '1 minute')`,
      [giveawayId, userId],
    );
    const discord = new FakeDiscord();
    discord.omittedSnapshotMembers.add(userId);

    await expect(processJob(
      dependencies(discord) as never,
      job({ id: randomUUID(), type: "end_giveaway", giveawayId }),
    )).rejects.toThrow("did not resolve every draw entry");
    const drawCount = await pool.query(
      "SELECT count(*)::int AS count FROM draws WHERE giveaway_id = $1",
      [giveawayId],
    );
    expect(drawCount.rows[0]!.count).toBe(0);
  });

  it("prevents published proof evidence from being rewritten or inserted directly", async () => {
    const giveawayId = randomUUID();
    const drawId = randomUUID();
    const winnerId = "100000000000000020";
    const otherId = "100000000000000021";
    const excludedId = "100000000000000022";
    await insertGiveaway(giveawayId);
    await expect(pool.query(
      `INSERT INTO draws
         (id, giveaway_id, draw_number, requested_winner_count, candidate_hash,
          drand_chain_hash, drand_round, drand_beacon_time, proof_version, status)
       VALUES ($1, $2, 1, 1, $3, $4, 1, now() + interval '1 minute',
               'lilac-weighted-v1', 'awaiting_beacon')`,
      [randomUUID(), giveawayId, "dd".repeat(32), "00".repeat(32)],
    )).rejects.toThrow("must use lilac-weighted-v2");
    await expect(pool.query(
      `INSERT INTO draws
         (id, giveaway_id, draw_number, requested_winner_count, candidate_hash,
          drand_chain_hash, drand_round, drand_beacon_time, proof_version,
          commitment_published_at, status, completed_at)
       VALUES ($1, $2, 1, 1, $3, $4, 1, now() + interval '1 minute',
               'lilac-weighted-v2', now(), 'complete', now())`,
      [randomUUID(), giveawayId, "dd".repeat(32), "00".repeat(32)],
    )).rejects.toThrow("unpublished awaiting commitments");

    await pool.query(
      `INSERT INTO draws
         (id, giveaway_id, draw_number, requested_by_user_id, requested_winner_count,
          candidate_hash, drand_chain_hash, drand_round, drand_beacon_time,
          proof_version, status)
       VALUES ($1, $2, 1, $3, 1, $4, $5, 1, now() + interval '1 minute',
               'lilac-weighted-v2', 'awaiting_beacon')`,
      [drawId, giveawayId, winnerId, "ee".repeat(32), "00".repeat(32)],
    );
    for (const [ordinal, userId] of [winnerId, otherId].entries()) {
      await pool.query(
        `INSERT INTO draw_candidates
           (draw_id, user_id, proof_id, username, joined_at, weight, ordinal)
         VALUES ($1, $2, $3, 'person', now(), 1, $4)`,
        [drawId, userId, proofIdForUser({ privacyHashSalt: salt }, giveawayId, userId), ordinal],
      );
    }
    await pool.query(
      `INSERT INTO draw_exclusions (draw_id, user_id, proof_id, reason)
       VALUES ($1, $2, $3, 'not_in_server')`,
      [
        drawId,
        excludedId,
        proofIdForUser({ privacyHashSalt: salt }, giveawayId, excludedId),
      ],
    );
    await pool.query("UPDATE draws SET commitment_published_at = now() WHERE id = $1", [drawId]);
    await pool.query(
      `INSERT INTO draw_winners (draw_id, user_id, proof_id, username, position)
       VALUES ($1, $2, $3, 'person', 1)`,
      [drawId, winnerId, proofIdForUser({ privacyHashSalt: salt }, giveawayId, winnerId)],
    );
    await expect(pool.query(
      `UPDATE draws SET status = 'complete', drand_signature = 'signature',
         drand_randomness = 'randomness', drand_beacon = '{}'::jsonb,
         completed_at = now() WHERE id = $1`,
      [drawId],
    )).rejects.toThrow("published beacon evidence");
    await makeDrawBeaconAvailable(drawId);
    await pool.query(
      `UPDATE draws SET status = 'complete', drand_signature = 'signature',
         drand_randomness = 'randomness', drand_beacon = '{}'::jsonb,
         completed_at = now() WHERE id = $1`,
      [drawId],
    );

    await expect(pool.query(
      "UPDATE draws SET candidate_hash = $2 WHERE id = $1",
      [drawId, "ff".repeat(32)],
    )).rejects.toThrow("immutable");
    await expect(pool.query(
      "UPDATE draws SET drand_randomness = 'changed' WHERE id = $1",
      [drawId],
    )).rejects.toThrow("immutable");
    await expect(pool.query("DELETE FROM draws WHERE id = $1", [drawId])).rejects.toThrow(
      "cannot be deleted",
    );
    await expect(pool.query(
      `INSERT INTO draw_candidates
         (draw_id, user_id, proof_id, username, joined_at, weight, ordinal)
       VALUES ($1, '100000000000000023', 'proof', 'person', now(), 1, 2)`,
      [drawId],
    )).rejects.toThrow("after publication");
    await expect(pool.query(
      "UPDATE draw_candidates SET weight = 2 WHERE draw_id = $1 AND user_id = $2",
      [drawId, winnerId],
    )).rejects.toThrow("immutable");
    await expect(pool.query(
      "DELETE FROM draw_candidates WHERE draw_id = $1 AND user_id = $2",
      [drawId, winnerId],
    )).rejects.toThrow("after publication");
    await expect(pool.query(
      "UPDATE draw_exclusions SET reason = 'changed' WHERE draw_id = $1",
      [drawId],
    )).rejects.toThrow("immutable");
    await expect(pool.query(
      "DELETE FROM draw_exclusions WHERE draw_id = $1",
      [drawId],
    )).rejects.toThrow("cannot be deleted");
    await expect(pool.query(
      `INSERT INTO draw_winners (draw_id, user_id, proof_id, username, position)
       VALUES ($1, $2, $3, 'person', 2)`,
      [drawId, otherId, proofIdForUser({ privacyHashSalt: salt }, giveawayId, otherId)],
    )).rejects.toThrow("published draw");
    await expect(pool.query(
      "UPDATE draw_winners SET position = 2 WHERE draw_id = $1",
      [drawId],
    )).rejects.toThrow("immutable");
    await expect(pool.query("DELETE FROM draw_winners WHERE draw_id = $1", [drawId])).rejects.toThrow(
      "cannot be deleted",
    );

    await expect(pool.query(
      `UPDATE draws SET requested_by_user_id = NULL, proof_redacted_at = now(),
         roles_reconciled_at = now() WHERE id = $1`,
      [drawId],
    )).resolves.toBeDefined();
    await expect(pool.query(
      `UPDATE draw_candidates SET user_id = 'deleted:candidate', username = 'Deleted User'
       WHERE draw_id = $1 AND user_id = $2`,
      [drawId, winnerId],
    )).resolves.toBeDefined();
    await expect(pool.query(
      `UPDATE draw_winners SET user_id = 'deleted:winner', username = 'Deleted User'
       WHERE draw_id = $1 AND user_id = $2`,
      [drawId, winnerId],
    )).resolves.toBeDefined();
  });

  it("redacts display identity while retaining scoped immutable proof identity", async () => {
    const userId = "100000000000000001";
    const firstGiveaway = randomUUID();
    const secondGiveaway = randomUUID();
    await insertGiveaway(firstGiveaway, "ended", 1);
    await insertGiveaway(secondGiveaway, "ended", 1);
    await pool.query(
      `INSERT INTO entries (giveaway_id, user_id, username)
       VALUES ($1, $3, 'person'), ($2, $3, 'person')`,
      [firstGiveaway, secondGiveaway, userId],
    );
    await insertLegacyDraw(randomUUID(), firstGiveaway, userId);
    await insertLegacyDraw(randomUUID(), secondGiveaway, userId);
    const requestId = randomUUID();
    await pool.query(
      "INSERT INTO data_deletion_requests (id, user_id, status) VALUES ($1, $2, 'queued')",
      [requestId, userId],
    );
    await pool.query(
      `INSERT INTO jobs (id, type, payload, run_at, completed_at)
       VALUES ($1, 'refresh_giveaway', jsonb_build_object('actorUserId', $2::text), now(), now())`,
      [randomUUID(), userId],
    );
    const privacyJob = await claimedPrivacyJob(userId, requestId);
    await expect(processJob(
      dependencies(new FakeDiscord()) as never,
      privacyJob,
    )).resolves.toBe(true);

    const candidates = await pool.query(
      `SELECT draw.giveaway_id, candidate.user_id, candidate.proof_id,
              draw.candidate_hash, draw.proof_redacted_at
       FROM draw_candidates candidate JOIN draws draw ON draw.id = candidate.draw_id
       ORDER BY draw.giveaway_id`,
    );
    expect(candidates.rows).toHaveLength(2);
    expect(candidates.rows.every((row) => String(row.user_id).startsWith("deleted:"))).toBe(true);
    expect(new Set(candidates.rows.map((row) => row.user_id)).size).toBe(2);
    expect(new Set(candidates.rows.map((row) => row.proof_id)).size).toBe(2);
    expect(candidates.rows.every((row) => row.candidate_hash === "original-hash")).toBe(true);
    expect(candidates.rows.every((row) => row.proof_redacted_at !== null)).toBe(true);
    expect(candidates.rows.find((row) => row.giveaway_id === firstGiveaway)?.proof_id).toBe(
      proofIdForUser({ privacyHashSalt: salt }, firstGiveaway, userId),
    );
    expect(await previousWinnerProofIds(pool, firstGiveaway)).toContain(
      proofIdForUser({ privacyHashSalt: salt }, firstGiveaway, userId),
    );
    const residual = await pool.query(
      `SELECT
         (SELECT count(*) FROM entries WHERE user_id = $1) +
         (SELECT count(*) FROM draw_candidates WHERE user_id = $1) +
         (SELECT count(*) FROM draw_winners WHERE user_id = $1) +
         (SELECT count(*) FROM draw_exclusions WHERE user_id = $1) +
         (SELECT count(*) FROM draws WHERE requested_by_user_id = $1) +
         (SELECT count(*) FROM data_deletion_requests WHERE user_id = $1) +
         (SELECT count(*) FROM jobs WHERE payload::text LIKE '%' || $1 || '%') AS count`,
      [userId],
    );
    expect(Number(residual.rows[0]!.count)).toBe(0);
    const completedJob = await pool.query(
      "SELECT completed_at, payload, idempotency_key FROM jobs WHERE id = $1",
      [privacyJob.id],
    );
    expect(completedJob.rows[0]).toMatchObject({
      payload: { requestId },
      idempotency_key: null,
    });
    expect(completedJob.rows[0]!.completed_at).not.toBeNull();
  });

  it("defers privacy redaction while an affected v1 draw is in flight", async () => {
    const userId = "100000000000000002";
    const giveawayId = randomUUID();
    const requestId = randomUUID();
    await insertGiveaway(giveawayId, "ending", 1);
    await insertLegacyDraw(randomUUID(), giveawayId, userId, "awaiting_beacon");
    await pool.query(
      "INSERT INTO data_deletion_requests (id, user_id, status) VALUES ($1, $2, 'queued')",
      [requestId, userId],
    );
    const privacyJob = await claimedPrivacyJob(userId, requestId);
    await expect(
      processJob(
        dependencies(new FakeDiscord()) as never,
        privacyJob,
      ),
    ).rejects.toThrow("in-flight legacy draw");
    const candidate = await pool.query("SELECT user_id FROM draw_candidates");
    expect(candidate.rows[0]!.user_id).toBe(userId);
  });

  it("rolls back identity deletion when its job lease is stale, then completes atomically", async () => {
    const userId = "100000000000000024";
    const giveawayId = randomUUID();
    const requestId = randomUUID();
    await insertGiveaway(giveawayId, "ended", 1);
    await pool.query(
      "INSERT INTO entries (giveaway_id, user_id, username) VALUES ($1, $2, 'person')",
      [giveawayId, userId],
    );
    await pool.query(
      "INSERT INTO data_deletion_requests (id, user_id, status) VALUES ($1, $2, 'queued')",
      [requestId, userId],
    );
    const stale = await claimedPrivacyJob(userId, requestId);
    await pool.query(
      "UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [stale.id],
    );
    const current = await claimJob(pool, "replacement-privacy-worker");
    expect(current?.id).toBe(stale.id);
    await expect(processJob(
      dependencies(new FakeDiscord()) as never,
      stale,
    )).rejects.toThrow("lease was lost");
    const afterStale = await pool.query(
      `SELECT entry.user_id, request.status, request.completed_at
       FROM entries entry CROSS JOIN data_deletion_requests request
       WHERE entry.giveaway_id = $1 AND request.id = $2`,
      [giveawayId, requestId],
    );
    expect(afterStale.rows[0]).toMatchObject({
      user_id: userId,
      status: "failed",
      completed_at: null,
    });

    await expect(processJob(
      dependencies(new FakeDiscord()) as never,
      current!,
    )).resolves.toBe(true);
    const completed = await pool.query(
      `SELECT request.status, request.completed_at, job.completed_at AS job_completed_at,
              job.payload, job.idempotency_key
       FROM data_deletion_requests request CROSS JOIN jobs job
       WHERE request.id = $1 AND job.id = $2`,
      [requestId, stale.id],
    );
    expect(completed.rows[0]).toMatchObject({
      status: "complete",
      payload: { requestId },
      idempotency_key: null,
    });
    expect(completed.rows[0]!.completed_at).not.toBeNull();
    expect(completed.rows[0]!.job_completed_at).not.toBeNull();
  });

  it("redacts every delivered winner batch and credited giveaway message before completion", async () => {
    const userId = "100000000000000025";
    const giveawayId = randomUUID();
    const drawId = randomUUID();
    const requestId = randomUUID();
    await insertGiveaway(giveawayId, "ended", 1);
    await pool.query(
      `UPDATE giveaways SET creator_user_id = $2, host_user_id = $2,
         message_id = '100000000000000090' WHERE id = $1`,
      [giveawayId, userId],
    );
    await insertV2Draw(drawId, giveawayId, [userId]);
    for (const ordinal of [0, 1]) {
      await pool.query(
        `INSERT INTO discord_deliveries
           (delivery_key, kind, giveaway_id, draw_id, ordinal, nonce,
            external_id, delivered_at)
         VALUES ($1, 'winner_message', $2, $3, $4, $5, $6, now())`,
        [
          `winner:${drawId}:${ordinal}`,
          giveawayId,
          drawId,
          ordinal,
          `nonce-${ordinal}`,
          `10000000000000009${ordinal}`,
        ],
      );
    }
    await pool.query(
      "INSERT INTO data_deletion_requests (id, user_id, status) VALUES ($1, $2, 'queued')",
      [requestId, userId],
    );
    const privacyJob = await claimedPrivacyJob(userId, requestId);
    const discord = new FakeDiscord();
    await expect(processJob(dependencies(discord) as never, privacyJob)).resolves.toBe(true);
    expect(discord.redactedWinnerMessages).toEqual([
      "100000000000000090",
      "100000000000000091",
    ]);
    expect(discord.redactedGiveawayMessages).toEqual([`${giveawayId}:${userId}`]);
    const identities = await pool.query(
      `SELECT creator_user_id, host_user_id,
              (SELECT user_id FROM draw_winners WHERE draw_id = $2) AS winner_id
       FROM giveaways WHERE id = $1`,
      [giveawayId, drawId],
    );
    expect(identities.rows[0]!.creator_user_id).toBeNull();
    expect(identities.rows[0]!.host_user_id).toBeNull();
    expect(String(identities.rows[0]!.winner_id)).toMatch(/^deleted:/);
  });

  it("reconciles credited giveaway-start messages before privacy completion", async () => {
    const deliveredUserId = "100000000000000032";
    const deliveredGiveawayId = randomUUID();
    const deliveredRequestId = randomUUID();
    const deliveredMessageId = "100000000000000094";
    await insertGiveaway(deliveredGiveawayId, "starting");
    await pool.query(
      `UPDATE giveaways SET creator_user_id = $2, host_user_id = $2
       WHERE id = $1`,
      [deliveredGiveawayId, deliveredUserId],
    );
    await pool.query(
      `INSERT INTO discord_deliveries
         (delivery_key, kind, giveaway_id, nonce, external_id, delivered_at)
       VALUES ($1, 'giveaway_start', $2, $3, $4, now())`,
      [
        `start:${deliveredGiveawayId}`,
        deliveredGiveawayId,
        `nonce-${deliveredGiveawayId}`,
        deliveredMessageId,
      ],
    );
    await pool.query(
      "INSERT INTO data_deletion_requests (id, user_id, status) VALUES ($1, $2, 'queued')",
      [deliveredRequestId, deliveredUserId],
    );
    const deliveredDiscord = new FakeDiscord();
    await expect(
      processJob(
        dependencies(deliveredDiscord) as never,
        await claimedPrivacyJob(deliveredUserId, deliveredRequestId),
      ),
    ).resolves.toBe(true);
    expect(deliveredDiscord.redactedGiveawayMessageIds).toContain(deliveredMessageId);

    const uncertainUserId = "100000000000000033";
    const uncertainGiveawayId = randomUUID();
    const uncertainRequestId = randomUUID();
    await insertGiveaway(uncertainGiveawayId, "starting");
    await pool.query(
      `UPDATE giveaways SET creator_user_id = $2, host_user_id = $2
       WHERE id = $1`,
      [uncertainGiveawayId, uncertainUserId],
    );
    await pool.query(
      `INSERT INTO discord_deliveries
         (delivery_key, kind, giveaway_id, nonce, send_started_at)
       VALUES ($1, 'giveaway_start', $2, $3, now())`,
      [
        `start:${uncertainGiveawayId}`,
        uncertainGiveawayId,
        `nonce-${uncertainGiveawayId}`,
      ],
    );
    await pool.query(
      "INSERT INTO data_deletion_requests (id, user_id, status) VALUES ($1, $2, 'queued')",
      [uncertainRequestId, uncertainUserId],
    );
    await expect(
      processJob(
        dependencies(new FakeDiscord()) as never,
        await claimedPrivacyJob(uncertainUserId, uncertainRequestId),
      ),
    ).rejects.toThrow("giveaway-start message delivery reconciliation");
    const uncertainState = await pool.query(
      `SELECT giveaway.creator_user_id, request.status, request.completed_at
       FROM giveaways giveaway CROSS JOIN data_deletion_requests request
       WHERE giveaway.id = $1 AND request.id = $2`,
      [uncertainGiveawayId, uncertainRequestId],
    );
    expect(uncertainState.rows[0]).toMatchObject({
      creator_user_id: uncertainUserId,
      status: "queued",
      completed_at: null,
    });
  });

  it("persists a stale in-memory winner only through the privacy-redacted candidate row", async () => {
    const userId = "100000000000000026";
    const giveawayId = randomUUID();
    const drawId = randomUUID();
    const requestId = randomUUID();
    await insertGiveaway(giveawayId, "ending", 1);
    await pool.query(
      "INSERT INTO entries (giveaway_id, user_id, username) VALUES ($1, $2, 'person')",
      [giveawayId, userId],
    );
    await insertV2Draw(drawId, giveawayId, [userId], "awaiting_beacon");
    await makeDrawBeaconAvailable(drawId);
    const staleDraw = (await getDraw(pool, drawId))!;
    const staleGiveaway = (await getGiveaway(pool, giveawayId))!;
    const staleWinner: Candidate = {
      userId,
      participantId: proofIdForUser({ privacyHashSalt: salt }, giveawayId, userId),
      username: "person",
      joinedAt: new Date(),
      weight: 1,
      ordinal: 0,
    };
    await pool.query(
      "INSERT INTO data_deletion_requests (id, user_id, status) VALUES ($1, $2, 'queued')",
      [requestId, userId],
    );
    await processJob(
      dependencies(new FakeDiscord()) as never,
      await claimedPrivacyJob(userId, requestId),
    );
    await expect(persistWinners(
      pool,
      staleDraw,
      staleGiveaway,
      [staleWinner],
      { randomness: "randomness", signature: "signature" },
      { [userId]: privacyFenceHash(salt, userId) },
    )).resolves.toBe(true);
    const winner = await pool.query(
      "SELECT user_id, proof_id, username FROM draw_winners WHERE draw_id = $1",
      [drawId],
    );
    expect(String(winner.rows[0]!.user_id)).toMatch(/^deleted:/);
    expect(winner.rows[0]).toMatchObject({
      proof_id: staleWinner.participantId,
      username: "Deleted User",
    });
    expect(winner.rows[0]!.user_id).not.toBe(userId);
  });

  it("suppresses fenced winner mentions while reporting the redacted count", async () => {
    const mentionable = "100000000000000027";
    const fenced = "100000000000000028";
    const giveawayId = randomUUID();
    const drawId = randomUUID();
    await insertGiveaway(giveawayId, "ended", 2);
    await pool.query(
      "UPDATE giveaways SET message_id = '100000000000000092' WHERE id = $1",
      [giveawayId],
    );
    await insertV2Draw(drawId, giveawayId, [mentionable, fenced]);
    await pool.query(
      "INSERT INTO data_deletion_requests (id, user_id, status) VALUES ($1, $2, 'queued')",
      [randomUUID(), fenced],
    );
    const discord = new FakeDiscord();
    await processJob(
      dependencies(discord) as never,
      job({ id: randomUUID(), type: "complete_draw", payload: { drawId } }),
    );
    expect(discord.winnerAnnouncements).toEqual([{
      winnerIds: [mentionable],
      redactedWinnerCount: 1,
    }]);
  });

  it("keeps overlapping role claims and removes only after the last claim ends", async () => {
    const firstGiveaway = randomUUID();
    const secondGiveaway = randomUUID();
    const firstDrawId = randomUUID();
    const secondDrawId = randomUUID();
    const userId = "100000000000000003";
    const roleId = "100000000000000004";
    await insertGiveaway(firstGiveaway);
    await insertGiveaway(secondGiveaway);
    await pool.query(
      "INSERT INTO giveaway_prize_roles (giveaway_id, role_id) VALUES ($1, $3), ($2, $3)",
      [firstGiveaway, secondGiveaway, roleId],
    );
    for (const [drawId, giveawayId] of [
      [firstDrawId, firstGiveaway],
      [secondDrawId, secondGiveaway],
    ] as const) {
      await insertV2Draw(drawId, giveawayId, [userId]);
    }
    const discord = new FakeDiscord();
    const candidate: Candidate = {
      userId,
      participantId: proofIdForUser({ privacyHashSalt: salt }, firstGiveaway, userId),
      ordinal: 0,
      username: "person",
      joinedAt: new Date(),
      weight: 1,
    };
    const first = (await getGiveaway(pool, firstGiveaway))!;
    const second = (await getGiveaway(pool, secondGiveaway))!;
    const draw = (id: string, giveawayId: string): DrawRow => ({
      id,
      giveawayId,
      drawNumber: 1,
      requestedWinnerCount: 1,
      candidateHash: "aa".repeat(32),
      drandChainHash: "00".repeat(32),
      drandRound: 1n,
      drandBeaconTime: new Date(),
      proofVersion: "lilac-weighted-v2",
      commitmentPublishedAt: new Date(),
      rolesReconciledAt: null,
      messageRefreshedAt: null,
      winnersAnnouncedAt: null,
      deliveryCompletedAt: null,
      status: "complete",
    });
    await grantPrizeRoles(dependencies(discord) as never, first, draw(firstDrawId, firstGiveaway), [candidate]);
    await grantPrizeRoles(dependencies(discord) as never, second, draw(secondDrawId, secondGiveaway), [{
      ...candidate,
      participantId: proofIdForUser({ privacyHashSalt: salt }, secondGiveaway, userId),
    }]);
    await deactivateOldRoleClaims(dependencies(discord) as never, first, randomUUID());
    expect(discord.removals).toBe(0);
    await deactivateOldRoleClaims(dependencies(discord) as never, second, randomUUID());
    expect(discord.removals).toBe(1);
    expect(discord.roles.get(userId)?.has(roleId)).toBe(false);
  });

  it("refuses a prize-role restoration after the winner enters the privacy fence", async () => {
    const targetGiveaway = randomUUID();
    const otherGiveaway = randomUUID();
    const oldDraw = randomUUID();
    const otherDraw = randomUUID();
    const currentDraw = randomUUID();
    const userId = "100000000000000029";
    const roleId = "100000000000000030";
    await insertGiveaway(targetGiveaway);
    await insertGiveaway(otherGiveaway);
    await insertV2Draw(oldDraw, targetGiveaway, [userId]);
    await insertV2Draw(otherDraw, otherGiveaway, [userId]);
    await pool.query(
      `INSERT INTO role_ownership
         (guild_id, user_id, role_id, owned_before_bot, bot_added, operation)
       VALUES ('guild', $1, $2, false, true, 'remove_pending')`,
      [userId, roleId],
    );
    await pool.query(
      `INSERT INTO role_grant_claims
         (giveaway_id, draw_id, guild_id, user_id, role_id, bot_added, active)
       VALUES ($1, $2, 'guild', $5, $6, true, true),
              ($3, $4, 'guild', $5, $6, true, true)`,
      [targetGiveaway, oldDraw, otherGiveaway, otherDraw, userId, roleId],
    );
    await pool.query(
      "INSERT INTO data_deletion_requests (id, user_id, status) VALUES ($1, $2, 'queued')",
      [randomUUID(), userId],
    );
    const discord = new FakeDiscord();
    await expect(deactivateOldRoleClaims(
      dependencies(discord) as never,
      (await getGiveaway(pool, targetGiveaway))!,
      currentDraw,
    )).rejects.toThrow("privacy deletion");
    expect(discord.additions).toBe(0);
  });

  it("nulls a stale job actor under the privacy lock before audit insertion", async () => {
    const giveawayId = randomUUID();
    const actorUserId = "100000000000000031";
    const requestId = randomUUID();
    const operationId = randomUUID();
    await insertGiveaway(giveawayId, "queued");
    await pool.query(
      `INSERT INTO data_deletion_requests
         (id, user_id, status, completed_at)
       VALUES ($1, 'deleted:actor', 'complete', now())`,
      [requestId],
    );
    await pool.query(
      `INSERT INTO privacy_deletion_fences
         (user_id_hash, request_id, completed_at)
       VALUES ($1, $2, now())`,
      [privacyFenceHash(salt, actorUserId), requestId],
    );
    await processJob(
      dependencies(new FakeDiscord()) as never,
      job({
        id: operationId,
        type: "start_giveaway",
        giveawayId,
        payload: { actorUserId },
      }),
    );
    const audit = await pool.query(
      "SELECT actor_user_id FROM audit_events WHERE id = $1",
      [operationId],
    );
    expect(audit.rows[0]!.actor_user_id).toBeNull();
  });

  it("exclusively claims Discord sends and reconciles a lost start response by nonce", async () => {
    const giveawayId = randomUUID();
    await insertGiveaway(giveawayId, "queued");
    const deliveryKey = `start:${giveawayId}`;
    const discord = new FakeDiscord();
    const nonce = discord.deliveryNonce(deliveryKey);
    const first = await claimDiscordDelivery(pool, {
      deliveryKey,
      kind: "giveaway_start",
      giveawayId,
      nonce,
    });
    expect(first.state).toBe("claimed");
    const busy = await claimDiscordDelivery(pool, {
      deliveryKey,
      kind: "giveaway_start",
      giveawayId,
      nonce,
    });
    expect(busy).toEqual({ state: "busy" });
    if (first.state !== "claimed") throw new Error("Expected delivery claim.");
    await markDiscordDeliverySending(pool, deliveryKey, first.claimToken);
    await pool.query(
      `UPDATE discord_deliveries
       SET claim_expires_at = now() - interval '1 minute'
       WHERE delivery_key = $1`,
      [deliveryKey],
    );
    discord.reconciliation = {
      status: "found",
      messageId: "100000000000000097",
    };
    await processJob(
      dependencies(discord) as never,
      job({ id: randomUUID(), type: "start_giveaway", giveawayId }),
    );
    expect(discord.posts).toBe(0);
    const state = await pool.query(
      `SELECT delivery.external_id, delivery.delivered_at, giveaway.message_id
       FROM discord_deliveries delivery JOIN giveaways giveaway
         ON giveaway.id = delivery.giveaway_id
       WHERE delivery.delivery_key = $1`,
      [deliveryKey],
    );
    expect(state.rows[0]).toMatchObject({
      external_id: "100000000000000097",
      message_id: "100000000000000097",
    });
    expect(state.rows[0]!.delivered_at).not.toBeNull();
  });

  it("atomically reconciles starting state and does not post twice on retry", async () => {
    const giveawayId = randomUUID();
    const operationId = randomUUID();
    await insertGiveaway(giveawayId, "queued");
    const discord = new FakeDiscord();
    const startJob = job({ id: operationId, type: "start_giveaway", giveawayId });
    await processJob(dependencies(discord) as never, startJob);
    await processJob(dependencies(discord) as never, startJob);
    expect(discord.posts).toBe(1);
    const giveaway = await getGiveaway(pool, giveawayId);
    expect(giveaway?.status).toBe("active");
    const endJobs = await pool.query(
      "SELECT count(*) FROM jobs WHERE idempotency_key = $1 AND completed_at IS NULL",
      [`end:${giveawayId}`],
    );
    expect(Number(endJobs.rows[0]!.count)).toBe(1);
  });

  it("refuses deletion when an error-state giveaway still has a committed draw", async () => {
    const giveawayId = randomUUID();
    const drawId = randomUUID();
    const completeJobId = randomUUID();
    const deleteJobId = randomUUID();
    const userId = "100000000000000034";
    await insertGiveaway(giveawayId, "error", 1);
    await insertV2Draw(drawId, giveawayId, [userId], "awaiting_beacon");
    await pool.query(
      `INSERT INTO jobs (id, type, giveaway_id, payload, run_at, idempotency_key)
       VALUES ($1, 'complete_draw', $2, jsonb_build_object('drawId', $3::text),
               now(), $4)`,
      [completeJobId, giveawayId, drawId, `draw:${drawId}`],
    );

    await expect(
      processJob(
        dependencies(new FakeDiscord()) as never,
        job({ id: deleteJobId, type: "delete_giveaway", giveawayId }),
      ),
    ).resolves.toBe(false);

    const state = await pool.query(
      `SELECT giveaway.status, draw.status AS draw_status,
              completion.completed_at AS completion_cancelled,
              deletion.action AS deletion_action
       FROM giveaways giveaway
       JOIN draws draw ON draw.giveaway_id = giveaway.id
       JOIN jobs completion ON completion.id = $2
       LEFT JOIN audit_events deletion ON deletion.id = $3
       WHERE giveaway.id = $1`,
      [giveawayId, completeJobId, deleteJobId],
    );
    expect(state.rows[0]).toMatchObject({
      status: "error",
      draw_status: "awaiting_beacon",
      completion_cancelled: null,
      deletion_action: "delete_rejected",
    });
  });

  it("does not cancel an unresolved giveaway-start delivery during deletion", async () => {
    const giveawayId = randomUUID();
    const startJobId = randomUUID();
    await insertGiveaway(giveawayId, "starting");
    await pool.query(
      `INSERT INTO jobs (id, type, giveaway_id, run_at, idempotency_key)
       VALUES ($1, 'start_giveaway', $2, now(), $3)`,
      [startJobId, giveawayId, `start:${giveawayId}`],
    );
    await pool.query(
      `INSERT INTO discord_deliveries
         (delivery_key, kind, giveaway_id, nonce, send_started_at)
       VALUES ($1, 'giveaway_start', $2, $3, now())`,
      [`start:${giveawayId}`, giveawayId, `nonce-${giveawayId}`],
    );

    await expect(
      processJob(
        dependencies(new FakeDiscord()) as never,
        job({ id: randomUUID(), type: "delete_giveaway", giveawayId }),
      ),
    ).rejects.toThrow("start-message delivery reconciliation");

    const state = await pool.query(
      `SELECT giveaway.status, start_job.completed_at
       FROM giveaways giveaway JOIN jobs start_job ON start_job.giveaway_id = giveaway.id
       WHERE giveaway.id = $1 AND start_job.id = $2`,
      [giveawayId, startJobId],
    );
    expect(state.rows[0]).toMatchObject({ status: "starting", completed_at: null });
  });
});
