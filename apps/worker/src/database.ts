import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { Candidate } from "./selection.js";
import { roundAtOrAfter, roundTime, type ChainInfo } from "./drand.js";

export const MIN_BEACON_FUTURE_SECONDS = 15;
export const COMMITMENT_SAFETY_SECONDS = 60;

export interface Job {
  id: string;
  type: string;
  giveawayId: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  lockedBy: string;
  lockToken: string;
}

export type DiscordDeliveryKind =
  | "giveaway_start"
  | "winner_message"
  | "reroll_rejection";

export type DiscordDeliveryClaim =
  | { state: "delivered"; externalId: string }
  | { state: "busy" }
  | {
      state: "claimed";
      claimToken: string;
      sendStartedAt: Date | null;
    };

export interface WorkerGiveaway {
  id: string;
  guildId: string;
  channelId: string;
  messageId: string | null;
  creatorUserId: string;
  hostUserId: string;
  prize: string;
  winnerCount: number;
  durationSeconds: number;
  scheduledStartAt: Date;
  startedAt: Date | null;
  endsAt: Date;
  endedAt: Date | null;
  status: string;
  requiredRoleMode: "all" | "one" | null;
  requiredMessages: number | null;
  messageScope: "all_time" | "since_start" | null;
  participantCount: number;
  requiredRoleIds: string[];
  prizeRoleIds: string[];
  bonusRoles: Array<{ roleId: string; bonusEntries: number }>;
  createdAt: Date;
  updatedAt: Date;
}

export interface EntryRow {
  userId: string;
  username: string;
  joinedAt: Date;
}

export interface DrawRow {
  id: string;
  giveawayId: string;
  drawNumber: number;
  requestedWinnerCount: number;
  candidateHash: string;
  drandChainHash: string;
  drandRound: bigint;
  drandBeaconTime: Date;
  proofVersion: "lilac-weighted-v1" | "lilac-weighted-v2";
  commitmentPublishedAt: Date | null;
  rolesReconciledAt: Date | null;
  messageRefreshedAt: Date | null;
  winnersAnnouncedAt: Date | null;
  deliveryCompletedAt: Date | null;
  status: string;
}

function mapDraw(row: QueryResultRow): DrawRow {
  return {
    id: row.id as string,
    giveawayId: row.giveaway_id as string,
    drawNumber: Number(row.draw_number),
    requestedWinnerCount: Number(row.requested_winner_count),
    candidateHash: row.candidate_hash as string,
    drandChainHash: row.drand_chain_hash as string,
    drandRound: BigInt(row.drand_round as string),
    drandBeaconTime: new Date(row.drand_beacon_time as string),
    proofVersion: row.proof_version as DrawRow["proofVersion"],
    commitmentPublishedAt: row.commitment_published_at
      ? new Date(row.commitment_published_at as string)
      : null,
    rolesReconciledAt: row.roles_reconciled_at
      ? new Date(row.roles_reconciled_at as string)
      : null,
    messageRefreshedAt: row.message_refreshed_at
      ? new Date(row.message_refreshed_at as string)
      : null,
    winnersAnnouncedAt: row.winners_announced_at
      ? new Date(row.winners_announced_at as string)
      : null,
    deliveryCompletedAt: row.delivery_completed_at
      ? new Date(row.delivery_completed_at as string)
      : null,
    status: row.status as string,
  };
}

function mapGiveaway(row: QueryResultRow): WorkerGiveaway {
  const scheduled = new Date(row.scheduled_start_at as string);
  const duration = Number(row.duration_seconds);
  const started = row.started_at ? new Date(row.started_at as string) : null;
  return {
    id: row.id as string,
    guildId: row.guild_id as string,
    channelId: row.channel_id as string,
    messageId: (row.message_id as string | null) ?? null,
    creatorUserId: (row.creator_user_id as string | null) ?? "0",
    hostUserId: (row.host_user_id as string | null) ?? (row.creator_user_id as string),
    prize: row.prize as string,
    winnerCount: Number(row.winner_count),
    durationSeconds: duration,
    scheduledStartAt: scheduled,
    startedAt: started,
    endsAt: row.ends_at
      ? new Date(row.ends_at as string)
      : new Date((started ?? scheduled).getTime() + duration * 1000),
    endedAt: row.ended_at ? new Date(row.ended_at as string) : null,
    status: row.status as string,
    requiredRoleMode: (row.required_role_mode as "all" | "one" | null) ?? null,
    requiredMessages:
      row.required_messages === null ? null : Number(row.required_messages),
    messageScope: (row.message_scope as "all_time" | "since_start" | null) ?? null,
    participantCount: Number(row.participant_count),
    requiredRoleIds: (row.required_role_ids as string[] | null) ?? [],
    prizeRoleIds: (row.prize_role_ids as string[] | null) ?? [],
    bonusRoles:
      (row.bonus_roles as Array<{ roleId: string; bonusEntries: number }> | null) ?? [],
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

const GIVEAWAY_SELECT = `
  SELECT g.*,
    ARRAY(
      SELECT role_id FROM giveaway_required_roles r
      WHERE r.giveaway_id = g.id ORDER BY role_id
    ) AS required_role_ids,
    ARRAY(
      SELECT role_id FROM giveaway_prize_roles p
      WHERE p.giveaway_id = g.id ORDER BY role_id
    ) AS prize_role_ids,
    COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object('roleId', b.role_id, 'bonusEntries', b.bonus_entries)
        ORDER BY b.role_id
      )
      FROM giveaway_bonus_roles b WHERE b.giveaway_id = g.id
    ), '[]'::jsonb) AS bonus_roles
  FROM giveaways g
`;

export async function claimJob(pool: Pool, workerId: string): Promise<Job | null> {
  const lockToken = randomUUID();
  const result = await pool.query(
    `WITH candidate AS (
       SELECT id FROM jobs
       WHERE completed_at IS NULL
         AND run_at <= now()
         AND (lease_expires_at IS NULL OR lease_expires_at <= now())
       ORDER BY run_at, created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE jobs j
     SET locked_at = now(), locked_by = $1, lock_token = $2,
         lease_expires_at = now() + interval '5 minutes', attempts = attempts + 1
     FROM candidate
     WHERE j.id = candidate.id
     RETURNING j.*`,
    [workerId, lockToken],
  );
  const row = result.rows[0];
  return row
    ? {
        id: row.id as string,
        type: row.type as string,
        giveawayId: (row.giveaway_id as string | null) ?? null,
        payload: (row.payload as Record<string, unknown>) ?? {},
        attempts: Number(row.attempts),
        maxAttempts: Number(row.max_attempts),
        lockedBy: workerId,
        lockToken,
      }
    : null;
}

export async function heartbeatJob(pool: Pool, job: Job): Promise<boolean> {
  const result = await pool.query(
    `UPDATE jobs SET lease_expires_at = now() + interval '5 minutes'
     WHERE id = $1 AND locked_by = $2 AND lock_token = $3
       AND completed_at IS NULL AND lease_expires_at > now()`,
    [job.id, job.lockedBy, job.lockToken],
  );
  return result.rowCount === 1;
}

export async function completeJob(pool: Pool, job: Job): Promise<boolean> {
  const result = await pool.query(
    `UPDATE jobs SET completed_at = now(), locked_at = NULL, locked_by = NULL,
       lock_token = NULL, lease_expires_at = NULL,
       payload = CASE WHEN type = 'privacy_delete'
                      THEN payload - 'userId' - 'actorUserId' ELSE payload END,
       idempotency_key = CASE WHEN type = 'privacy_delete' THEN NULL ELSE idempotency_key END
     WHERE id = $1 AND locked_by = $2 AND lock_token = $3 AND completed_at IS NULL`,
    [job.id, job.lockedBy, job.lockToken],
  );
  return result.rowCount === 1;
}

export async function retryJob(
  pool: Pool,
  job: Job,
  error: unknown,
  options: { forceTerminal?: boolean; markGiveawayError?: boolean } = {},
): Promise<boolean> {
  const message = error instanceof Error ? error.message : String(error);
  const persistent =
    job.type === "start_giveaway" ||
    job.type === "end_giveaway" ||
    job.type === "reroll_giveaway" ||
    job.type === "complete_draw" ||
    job.type === "delete_giveaway" ||
    job.type === "privacy_delete";
  const terminal =
    options.forceTerminal === true || (!persistent && job.attempts >= job.maxAttempts);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE jobs SET
         locked_at = NULL,
         locked_by = NULL,
         lock_token = NULL,
         lease_expires_at = NULL,
         last_error = $2,
         completed_at = CASE WHEN $3 THEN now() ELSE NULL END,
         run_at = CASE
           WHEN $3 THEN run_at
           ELSE now() + make_interval(
             secs => LEAST(300, power(2::numeric, LEAST(attempts, 9))::int)
           )
         END,
         payload = CASE
           WHEN $3 AND type = 'privacy_delete'
             THEN payload - 'userId' - 'actorUserId'
           ELSE payload
         END,
         idempotency_key = CASE
           WHEN $3 AND type = 'privacy_delete' THEN NULL
           ELSE idempotency_key
         END
       WHERE id = $1 AND locked_by = $4 AND lock_token = $5 AND completed_at IS NULL
       RETURNING payload->>'requestId' AS request_id`,
      [job.id, message.slice(0, 4000), terminal, job.lockedBy, job.lockToken],
    );
    if (result.rowCount !== 1) {
      await client.query("ROLLBACK");
      return false;
    }
    const requestId = result.rows[0]?.request_id as string | null | undefined;
    if (terminal && job.type === "privacy_delete" && requestId) {
      await client.query(
        `UPDATE data_deletion_requests
         SET status = 'failed', error = $2
         WHERE id::text = $1 AND status <> 'complete'`,
        [requestId, message.slice(0, 4000)],
      );
      await client.query(
        `UPDATE privacy_deletion_fences SET updated_at = now()
         WHERE request_id::text = $1
           AND completed_at IS NULL AND cleared_at IS NULL`,
        [requestId],
      );
    }
    if (
      terminal &&
      job.type !== "refresh_giveaway" &&
      job.giveawayId &&
      options.markGiveawayError !== false
    ) {
      await client.query(
        `UPDATE giveaways SET status = 'error', last_error = $2, updated_at = now()
         WHERE id = $1 AND status NOT IN ('ended', 'deleted')`,
        [job.giveawayId, message.slice(0, 4000)],
      );
    }
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getGiveaway(
  db: Pool | PoolClient,
  giveawayId: string,
): Promise<WorkerGiveaway | null> {
  const result = await db.query(`${GIVEAWAY_SELECT} WHERE g.id = $1`, [giveawayId]);
  return result.rows[0] ? mapGiveaway(result.rows[0]) : null;
}

export async function getGiveawayForUpdate(
  client: PoolClient,
  giveawayId: string,
): Promise<WorkerGiveaway | null> {
  const result = await client.query(
    `${GIVEAWAY_SELECT} WHERE g.id = $1 FOR UPDATE OF g`,
    [giveawayId],
  );
  return result.rows[0] ? mapGiveaway(result.rows[0]) : null;
}

export async function getActiveEntries(
  db: Pool | PoolClient,
  giveawayId: string,
): Promise<EntryRow[]> {
  const result = await db.query(
    `SELECT user_id, username, joined_at FROM entries
     WHERE giveaway_id = $1 AND left_at IS NULL
     ORDER BY joined_at, user_id`,
    [giveawayId],
  );
  return result.rows.map((row) => ({
    userId: row.user_id as string,
    username: row.username as string,
    joinedAt: new Date(row.joined_at as string),
  }));
}

export async function previousWinnerProofIds(
  db: Pool | PoolClient,
  giveawayId: string,
): Promise<Set<string>> {
  const result = await db.query(
    `SELECT DISTINCT COALESCE(w.proof_id, w.user_id) AS proof_id
     FROM draw_winners w
     JOIN draws d ON d.id = w.draw_id
     WHERE d.giveaway_id = $1 AND d.status = 'complete'`,
    [giveawayId],
  );
  return new Set(result.rows.map((row) => row.proof_id as string));
}

export async function createDrawCommitment(
  pool: Pool,
  input: {
    drawId: string;
    giveaway: WorkerGiveaway;
    requestedWinnerCount: number;
    candidates: Candidate[];
    exclusions: Array<{ userId: string; proofId: string; reason: string }>;
    privacyFenceHashesByUser: Record<string, string>;
    candidateHash: string;
    chainHash: string;
    chainInfo: ChainInfo;
    actorUserId: string | null;
  },
): Promise<DrawRow> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const lockedGiveaway = await getGiveawayForUpdate(client, input.giveaway.id);
      if (!lockedGiveaway || lockedGiveaway.status === "deleted") {
        throw new Error("The giveaway was deleted before its draw could be committed.");
      }
      const existing = await client.query("SELECT * FROM draws WHERE id = $1", [input.drawId]);
      if (existing.rows[0]) {
        await client.query("COMMIT");
        return mapDraw(existing.rows[0]);
      }
      const pending = await client.query(
        `SELECT id FROM draws
         WHERE giveaway_id = $1 AND status IN ('awaiting_beacon', 'drawing') LIMIT 1`,
        [input.giveaway.id],
      );
      if (pending.rows[0]) throw new Error("Another draw is already awaiting its drand beacon.");

      const snapshotUserIds = [
        ...input.candidates.map((candidate) => candidate.userId),
        ...input.exclusions.map((exclusion) => exclusion.userId),
      ];
      if (snapshotUserIds.length > 0) {
        const snapshotFenceHashes = snapshotUserIds.map((userId) => {
          const hash = input.privacyFenceHashesByUser[userId];
          if (!hash) throw new Error("Snapshot input is missing a privacy fence hash.");
          return hash;
        });
        const stale = await client.query(
          `WITH expected(user_id, user_id_hash) AS (
             SELECT DISTINCT * FROM unnest($2::text[], $3::text[])
           )
           SELECT expected.user_id
           FROM expected
           LEFT JOIN entries entry
             ON entry.giveaway_id = $1 AND entry.user_id = expected.user_id
                AND entry.left_at IS NULL
           WHERE entry.user_id IS NULL OR EXISTS (
             SELECT 1 FROM data_deletion_requests deletion
             WHERE deletion.user_id = expected.user_id
               AND deletion.status <> 'complete'
           ) OR EXISTS (
             SELECT 1 FROM privacy_deletion_fences fence
             WHERE fence.user_id_hash = expected.user_id_hash
               AND fence.cleared_at IS NULL
           )
           LIMIT 1`,
          [input.giveaway.id, snapshotUserIds, snapshotFenceHashes],
        );
        if (stale.rows[0]) {
          throw new Error("Entry or privacy state changed while the snapshot was prepared.");
        }
      }

      const numberResult = await client.query(
        `SELECT COALESCE(max(draw_number), 0)::int + 1 AS draw_number
         FROM draws WHERE giveaway_id = $1`,
        [input.giveaway.id],
      );
      const drawNumber = Number(numberResult.rows[0]!.draw_number);
      const clock = await client.query("SELECT extract(epoch FROM clock_timestamp()) AS epoch");
      const target = Math.ceil(Number(clock.rows[0]!.epoch)) + COMMITMENT_SAFETY_SECONDS;
      const round = roundAtOrAfter(input.chainInfo, target);
      const beaconTime = roundTime(input.chainInfo, round);

      await client.query(
        `INSERT INTO draws (
          id, giveaway_id, draw_number, requested_by_user_id, requested_winner_count,
          candidate_hash, drand_chain_hash, drand_round, drand_beacon_time,
          proof_version, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                  'lilac-weighted-v2', 'awaiting_beacon')`,
        [
          input.drawId,
          input.giveaway.id,
          drawNumber,
          input.actorUserId,
          input.requestedWinnerCount,
          input.candidateHash,
          input.chainHash,
          round.toString(),
          beaconTime,
        ],
      );

      if (input.candidates.length > 0) {
        await client.query(
          `INSERT INTO draw_candidates
             (draw_id, user_id, proof_id, username, joined_at, weight, ordinal)
           SELECT $1, * FROM unnest(
             $2::text[], $3::text[], $4::text[], $5::timestamptz[], $6::bigint[], $7::int[]
           )`,
          [
            input.drawId,
            input.candidates.map((candidate) => candidate.userId),
            input.candidates.map((candidate) => candidate.participantId),
            input.candidates.map((candidate) => candidate.username),
            input.candidates.map((candidate) => candidate.joinedAt),
            input.candidates.map((candidate) => candidate.weight),
            input.candidates.map((candidate) => candidate.ordinal),
          ],
        );
        await client.query(
          `UPDATE entries entry SET eligible_at_draw = true, draw_weight = value.weight,
             ineligible_reason = NULL
           FROM unnest($2::text[], $3::bigint[]) AS value(user_id, weight)
           WHERE entry.giveaway_id = $1 AND entry.user_id = value.user_id`,
          [
            input.giveaway.id,
            input.candidates.map((candidate) => candidate.userId),
            input.candidates.map((candidate) => candidate.weight),
          ],
        );
      }
      if (input.exclusions.length > 0) {
        await client.query(
          `INSERT INTO draw_exclusions (draw_id, user_id, proof_id, reason)
           SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[])`,
          [
            input.drawId,
            input.exclusions.map((exclusion) => exclusion.userId),
            input.exclusions.map((exclusion) => exclusion.proofId),
            input.exclusions.map((exclusion) => exclusion.reason),
          ],
        );
        await client.query(
          `UPDATE entries entry SET eligible_at_draw = false, draw_weight = NULL,
             ineligible_reason = value.reason
           FROM unnest($2::text[], $3::text[]) AS value(user_id, reason)
           WHERE entry.giveaway_id = $1 AND entry.user_id = value.user_id`,
          [
            input.giveaway.id,
            input.exclusions.map((exclusion) => exclusion.userId),
            input.exclusions.map((exclusion) => exclusion.reason),
          ],
        );
      }
      const giveawayUpdate = await client.query(
        `UPDATE giveaways SET status = 'ending', ended_at = COALESCE(ended_at, now()),
           snapshot_hash = $2, drand_chain_hash = $3, drand_round = $4, updated_at = now()
         WHERE id = $1 AND status IN ('active', 'ending', 'ended')`,
        [input.giveaway.id, input.candidateHash, input.chainHash, round.toString()],
      );
      if (giveawayUpdate.rowCount !== 1) {
        throw new Error("The giveaway changed state before its draw could be committed.");
      }
      await client.query(
        `INSERT INTO jobs (id, type, giveaway_id, payload, run_at, idempotency_key)
         VALUES ($1, 'complete_draw', $2, jsonb_build_object('drawId', $3::text),
                 $4::timestamptz + interval '2 seconds', $5)
         ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE
         SET run_at = EXCLUDED.run_at, payload = EXCLUDED.payload, completed_at = NULL`,
        [randomUUID(), input.giveaway.id, input.drawId, beaconTime, `draw:${input.drawId}`],
      );

      const guard = await client.query(
        `SELECT $1::timestamptz >= clock_timestamp() + make_interval(secs => $2) AS safe`,
        [beaconTime, MIN_BEACON_FUTURE_SECONDS],
      );
      if (guard.rows[0]?.safe !== true) {
        throw new Error("Drand round safety window elapsed while committing the snapshot.");
      }
      await client.query("COMMIT");
      return (await getDraw(pool, input.drawId))!;
    } catch (error) {
      await client.query("ROLLBACK");
      if (
        attempt < 2 &&
        error instanceof Error &&
        error.message.includes("safety window elapsed")
      ) {
        continue;
      }
      throw error;
    } finally {
      client.release();
    }
  }
  throw new Error("Could not commit a draw inside the drand safety window.");
}

export async function getDraw(pool: Pool, drawId: string): Promise<DrawRow | null> {
  const result = await pool.query("SELECT * FROM draws WHERE id = $1", [drawId]);
  const row = result.rows[0];
  return row ? mapDraw(row) : null;
}

export async function ensureUnpublishedDrawRound(
  pool: Pool,
  drawId: string,
  info: ChainInfo,
): Promise<DrawRow> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query("SELECT * FROM draws WHERE id = $1 FOR UPDATE", [drawId]);
    if (!result.rows[0]) throw new Error("Draw not found.");
    let draw = mapDraw(result.rows[0]);
    if (draw.commitmentPublishedAt) {
      await client.query("COMMIT");
      return draw;
    }
    const clock = await client.query("SELECT extract(epoch FROM clock_timestamp()) AS epoch");
    const target = Math.ceil(Number(clock.rows[0]!.epoch)) + COMMITMENT_SAFETY_SECONDS;
    if (draw.drandBeaconTime.getTime() < target * 1000) {
      const round = roundAtOrAfter(info, target);
      const beaconTime = roundTime(info, round);
      await client.query(
        `UPDATE draws SET drand_round = $2, drand_beacon_time = $3 WHERE id = $1`,
        [draw.id, round.toString(), beaconTime],
      );
      await client.query(
        `UPDATE giveaways SET drand_round = $2, updated_at = now()
         WHERE id = $1 AND status = 'ending'`,
        [draw.giveawayId, round.toString()],
      );
      await client.query(
        `UPDATE jobs SET run_at = $1::timestamptz + interval '2 seconds'
         WHERE idempotency_key = $2 AND completed_at IS NULL`,
        [beaconTime, `draw:${draw.id}`],
      );
      draw = { ...draw, drandRound: round, drandBeaconTime: beaconTime };
    }
    await client.query("COMMIT");
    return draw;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function markCommitmentPublished(
  pool: Pool,
  drawId: string,
  giveaway: WorkerGiveaway,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query("SELECT * FROM draws WHERE id = $1 FOR UPDATE", [drawId]);
    if (!result.rows[0]) throw new Error("Draw not found.");
    const draw = mapDraw(result.rows[0]);
    if (draw.commitmentPublishedAt) {
      await client.query("COMMIT");
      return true;
    }
    const guard = await client.query(
      `SELECT $1::timestamptz >= clock_timestamp() + make_interval(secs => $2) AS safe`,
      [draw.drandBeaconTime, MIN_BEACON_FUTURE_SECONDS],
    );
    if (guard.rows[0]?.safe !== true) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(
      "UPDATE draws SET commitment_published_at = clock_timestamp() WHERE id = $1",
      [draw.id],
    );
    await client.query(
      `INSERT INTO audit_events
       (id, guild_id, giveaway_id, actor_user_id, action, source, metadata)
       VALUES ($1::uuid, $2, $3, NULL, 'draw_committed', 'worker',
         jsonb_build_object(
           'drawId', ($1::uuid)::text,
           'proofVersion', $4::text,
           'candidateHash', $5::text,
           'drandChainHash', $6::text,
           'drandRound', $7::text,
           'requestedWinnerCount', $8::bigint
         ))
       ON CONFLICT (id) DO NOTHING`,
      [
        draw.id,
        giveaway.guildId,
        giveaway.id,
        draw.proofVersion,
        draw.candidateHash,
        draw.drandChainHash,
        draw.drandRound.toString(),
        draw.requestedWinnerCount,
      ],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getDrawCandidates(pool: Pool, drawId: string): Promise<Candidate[]> {
  const result = await pool.query(
    `SELECT user_id, proof_id, username, joined_at, weight, ordinal
     FROM draw_candidates WHERE draw_id = $1 ORDER BY ordinal`,
    [drawId],
  );
  return result.rows.map((row) => ({
    userId: row.user_id as string,
    participantId: (row.proof_id as string | null) ?? (row.user_id as string),
    username: row.username as string,
    joinedAt: new Date(row.joined_at as string),
    weight: Number(row.weight),
    ordinal: Number(row.ordinal),
  }));
}

export async function getDrawWinners(pool: Pool, drawId: string): Promise<Candidate[]> {
  const result = await pool.query(
    `SELECT winner.user_id, winner.proof_id, winner.username, winner.position,
            candidate.joined_at, candidate.weight, candidate.ordinal
     FROM draw_winners winner
     JOIN draw_candidates candidate
       ON candidate.draw_id = winner.draw_id
      AND (
        (winner.proof_id IS NOT NULL AND candidate.proof_id = winner.proof_id)
        OR (winner.proof_id IS NULL AND candidate.user_id = winner.user_id)
      )
     WHERE winner.draw_id = $1 ORDER BY winner.position`,
    [drawId],
  );
  return result.rows.map((row) => ({
    userId: row.user_id as string,
    participantId: (row.proof_id as string | null) ?? (row.user_id as string),
    username: row.username as string,
    joinedAt: new Date(row.joined_at as string),
    weight: Number(row.weight),
    ordinal: Number(row.ordinal),
  }));
}

export async function persistWinners(
  pool: Pool,
  draw: DrawRow,
  giveaway: WorkerGiveaway,
  winners: Candidate[],
  beacon: { randomness: string; signature: string; [key: string]: unknown },
  privacyFenceHashesByUser: Record<string, string>,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const preflight = await client.query("SELECT status FROM draws WHERE id = $1", [draw.id]);
    if (preflight.rows[0]?.status === "complete") {
      await client.query("COMMIT");
      return false;
    }

    const rawWinnerIds = [...new Set(winners.map((winner) => winner.userId))].sort();
    if (rawWinnerIds.length > 0) {
      await client.query(
        `WITH ordered AS MATERIALIZED (
           SELECT DISTINCT user_id FROM unnest($1::text[]) AS requested(user_id)
           ORDER BY user_id
         )
         SELECT pg_advisory_xact_lock(
           hashtextextended('privacy-delete:' || user_id, 0)
         ) FROM ordered ORDER BY user_id`,
        [rawWinnerIds],
      );
      const fenceHashes = rawWinnerIds.map((userId) => {
        const hash = privacyFenceHashesByUser[userId];
        if (!hash) throw new Error("Winner persistence is missing a privacy fence hash.");
        return hash;
      });
      const activeDeletion = await client.query(
        `WITH expected(user_id, user_id_hash) AS (
           SELECT * FROM unnest($1::text[], $2::text[])
         )
         SELECT 1 FROM expected
         WHERE EXISTS (
           SELECT 1 FROM data_deletion_requests deletion
           WHERE deletion.user_id = expected.user_id
             AND deletion.status <> 'complete'
         ) OR EXISTS (
           SELECT 1 FROM privacy_deletion_fences fence
           WHERE fence.user_id_hash = expected.user_id_hash
             AND fence.cleared_at IS NULL
             AND fence.completed_at IS NULL
         )
         LIMIT 1`,
        [rawWinnerIds, fenceHashes],
      );
      if (activeDeletion.rows[0] && draw.proofVersion === "lilac-weighted-v2") {
        throw new Error("Draw completion is waiting for winner privacy deletion.");
      }
    }

    const lock = await client.query("SELECT status FROM draws WHERE id = $1 FOR UPDATE", [draw.id]);
    if (lock.rows[0]?.status === "complete") {
      await client.query("COMMIT");
      return false;
    }
    if (lock.rows[0]?.status !== "awaiting_beacon" && lock.rows[0]?.status !== "drawing") {
      throw new Error("Draw is not in a completable state.");
    }
    const giveawayLock = await client.query(
      "SELECT status FROM giveaways WHERE id = $1 FOR UPDATE",
      [giveaway.id],
    );
    if (giveawayLock.rows[0]?.status === "deleted") {
      throw new Error("A deleted giveaway cannot be completed.");
    }
    for (const [index, winner] of winners.entries()) {
      const inserted = await client.query(
        `INSERT INTO draw_winners (draw_id, user_id, proof_id, username, position)
         SELECT candidate.draw_id, candidate.user_id, candidate.proof_id,
                candidate.username, $3
         FROM draw_candidates candidate
         WHERE candidate.draw_id = $1
           AND (
             ($2::text IS NOT NULL AND candidate.proof_id = $2)
             OR ($2::text IS NULL AND candidate.proof_id IS NULL
                 AND candidate.user_id = $4)
           )`,
        [
          draw.id,
          draw.proofVersion === "lilac-weighted-v2" ? winner.participantId : null,
          index + 1,
          winner.userId,
        ],
      );
      if (inserted.rowCount !== 1) {
        throw new Error("Selected winner no longer matches its committed candidate.");
      }
    }
    const drawUpdate = await client.query(
      `UPDATE draws SET status = 'complete', drand_signature = $2,
         drand_randomness = $3, drand_beacon = $4::jsonb, completed_at = now()
       WHERE id = $1 AND commitment_published_at IS NOT NULL`,
      [draw.id, beacon.signature, beacon.randomness, JSON.stringify(beacon)],
    );
    if (drawUpdate.rowCount !== 1) {
      throw new Error("Draw completion requires a published commitment.");
    }
    await client.query(
      `UPDATE giveaways SET status = 'ended', ended_at = COALESCE(ended_at, now()),
         snapshot_hash = $2, drand_chain_hash = $3, drand_round = $4,
         drand_signature = $5, drand_randomness = $6, drand_beacon = $7::jsonb,
         updated_at = now()
       WHERE id = $1 AND status = 'ending'`,
      [
        giveaway.id,
        draw.candidateHash,
        draw.drandChainHash,
        draw.drandRound.toString(),
        beacon.signature,
        beacon.randomness,
        JSON.stringify(beacon),
      ],
    );
    await client.query(
      `INSERT INTO audit_events
       (id, guild_id, giveaway_id, action, source, metadata)
       VALUES ($1, $2, $3, 'draw_completed', 'worker',
         jsonb_build_object(
           'drawId', $4::text,
           'requestedWinnerCount', $5::int,
           'winnerCount', $6::int
         ))`,
      [
        randomUUID(),
        giveaway.guildId,
        giveaway.id,
        draw.id,
        draw.requestedWinnerCount,
        winners.length,
      ],
    );
    await client.query(
      `INSERT INTO audit_events
       (id, guild_id, giveaway_id, action, source, metadata)
       VALUES ($1, $2, $3, $4, 'worker',
         jsonb_build_object(
           'drawId', $5::text,
           'drawNumber', $6::int,
           'requestedWinnerCount', $7::int,
           'winnerCount', $8::int
         ))`,
      [
        randomUUID(),
        giveaway.guildId,
        giveaway.id,
        draw.drawNumber === 1 ? "ended" : "rerolled",
        draw.id,
        draw.drawNumber,
        draw.requestedWinnerCount,
        winners.length,
      ],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function markDrawStep(
  pool: Pool,
  drawId: string,
  step:
    | "roles_reconciled_at"
    | "message_refreshed_at"
    | "winners_announced_at"
    | "delivery_completed_at",
): Promise<void> {
  await pool.query(`UPDATE draws SET ${step} = COALESCE(${step}, now()) WHERE id = $1`, [drawId]);
}

export async function deliveredWinnerOrdinals(pool: Pool, drawId: string): Promise<Set<number>> {
  const result = await pool.query(
    `SELECT ordinal FROM discord_deliveries
     WHERE draw_id = $1 AND kind = 'winner_message' AND delivered_at IS NOT NULL`,
    [drawId],
  );
  return new Set(result.rows.map((row) => Number(row.ordinal)));
}

export async function claimDiscordDelivery(
  pool: Pool,
  input: {
    deliveryKey: string;
    kind: DiscordDeliveryKind;
    giveawayId: string;
    drawId?: string;
    ordinal?: number;
    nonce: string;
  },
): Promise<DiscordDeliveryClaim> {
  const client = await pool.connect();
  const claimToken = randomUUID();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO discord_deliveries
         (delivery_key, kind, giveaway_id, draw_id, ordinal, nonce)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (delivery_key) DO NOTHING`,
      [
        input.deliveryKey,
        input.kind,
        input.giveawayId,
        input.drawId ?? null,
        input.ordinal ?? null,
        input.nonce,
      ],
    );
    const existing = await client.query(
      `SELECT kind, giveaway_id, draw_id, ordinal, nonce, external_id,
              delivered_at, claim_expires_at, send_started_at
       FROM discord_deliveries WHERE delivery_key = $1 FOR UPDATE`,
      [input.deliveryKey],
    );
    const row = existing.rows[0];
    if (!row) throw new Error("Discord delivery ledger row could not be created.");
    if (
      row.kind !== input.kind ||
      row.giveaway_id !== input.giveawayId ||
      (row.draw_id ?? null) !== (input.drawId ?? null) ||
      (row.ordinal === null ? null : Number(row.ordinal)) !== (input.ordinal ?? null) ||
      row.nonce !== input.nonce
    ) {
      throw new Error("Discord delivery idempotency key was reused for different content.");
    }
    if (row.delivered_at !== null) {
      await client.query("COMMIT");
      return { state: "delivered", externalId: row.external_id as string };
    }
    if (
      row.claim_expires_at !== null &&
      new Date(row.claim_expires_at as string).getTime() > Date.now()
    ) {
      await client.query("COMMIT");
      return { state: "busy" };
    }
    const claimed = await client.query(
      `UPDATE discord_deliveries
       SET claim_token = $2, claim_expires_at = now() + interval '30 minutes',
           last_error = NULL, updated_at = now()
       WHERE delivery_key = $1
       RETURNING send_started_at`,
      [input.deliveryKey, claimToken],
    );
    await client.query("COMMIT");
    return {
      state: "claimed",
      claimToken,
      sendStartedAt: claimed.rows[0]?.send_started_at
        ? new Date(claimed.rows[0].send_started_at as string)
        : null,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function markDiscordDeliverySending(
  pool: Pool,
  deliveryKey: string,
  claimToken: string,
): Promise<Date> {
  const result = await pool.query(
    `UPDATE discord_deliveries
     SET send_started_at = COALESCE(send_started_at, now()), updated_at = now()
     WHERE delivery_key = $1 AND claim_token = $2 AND delivered_at IS NULL
     RETURNING send_started_at`,
    [deliveryKey, claimToken],
  );
  if (result.rowCount !== 1) throw new Error("Discord delivery claim was lost before send.");
  return new Date(result.rows[0]!.send_started_at as string);
}

export async function resetDiscordDeliveryAfterReconciliation(
  pool: Pool,
  deliveryKey: string,
  claimToken: string,
): Promise<void> {
  const result = await pool.query(
    `UPDATE discord_deliveries
     SET send_started_at = NULL, last_error = NULL, updated_at = now()
     WHERE delivery_key = $1 AND claim_token = $2 AND delivered_at IS NULL`,
    [deliveryKey, claimToken],
  );
  if (result.rowCount !== 1) {
    throw new Error("Discord delivery claim was lost during reconciliation.");
  }
}

export async function recordDiscordDelivery(
  pool: Pool,
  deliveryKey: string,
  claimToken: string,
  externalId: string,
): Promise<void> {
  const result = await pool.query(
    `UPDATE discord_deliveries
     SET external_id = $3, delivered_at = now(), claim_token = NULL,
         claim_expires_at = NULL, last_error = NULL, updated_at = now()
     WHERE delivery_key = $1 AND claim_token = $2 AND delivered_at IS NULL`,
    [deliveryKey, claimToken, externalId],
  );
  if (result.rowCount === 1) return;
  const existing = await pool.query(
    `SELECT external_id FROM discord_deliveries
     WHERE delivery_key = $1 AND delivered_at IS NOT NULL`,
    [deliveryKey],
  );
  if (existing.rows[0]?.external_id !== externalId) {
    throw new Error("Discord delivery claim was lost before finalization.");
  }
}

export async function recordDiscordDeliveryFailure(
  pool: Pool,
  deliveryKey: string,
  claimToken: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await pool.query(
    `UPDATE discord_deliveries SET last_error = $3, updated_at = now()
     WHERE delivery_key = $1 AND claim_token = $2 AND delivered_at IS NULL`,
    [deliveryKey, claimToken, message.slice(0, 4000)],
  );
}
