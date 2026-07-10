import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { Candidate } from "./selection.js";

export interface Job {
  id: string;
  type: string;
  giveawayId: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

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
  candidateHash: string;
  drandChainHash: string;
  drandRound: bigint;
  drandBeaconTime: Date;
  status: string;
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
  const result = await pool.query(
    `WITH candidate AS (
       SELECT id FROM jobs
       WHERE completed_at IS NULL
         AND run_at <= now()
         AND (locked_at IS NULL OR locked_at < now() - interval '5 minutes')
       ORDER BY run_at, created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE jobs j
     SET locked_at = now(), locked_by = $1, attempts = attempts + 1
     FROM candidate
     WHERE j.id = candidate.id
     RETURNING j.*`,
    [workerId],
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
      }
    : null;
}

export async function completeJob(pool: Pool, jobId: string): Promise<void> {
  await pool.query(
    `UPDATE jobs SET completed_at = now(), locked_at = NULL, locked_by = NULL
     WHERE id = $1`,
    [jobId],
  );
}

export async function retryJob(pool: Pool, job: Job, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const terminal = job.attempts >= job.maxAttempts;
  await pool.query(
    `UPDATE jobs SET
       locked_at = NULL,
       locked_by = NULL,
       last_error = $2,
       completed_at = CASE WHEN $3 THEN now() ELSE NULL END,
       run_at = CASE
         WHEN $3 THEN run_at
         ELSE now() + make_interval(secs => LEAST(300, power(2, attempts)::int))
       END
     WHERE id = $1`,
    [job.id, message.slice(0, 4000), terminal],
  );
  if (terminal && job.giveawayId) {
    await pool.query(
      `UPDATE giveaways SET status = 'error', last_error = $2, updated_at = now()
       WHERE id = $1 AND status NOT IN ('ended', 'deleted')`,
      [job.giveawayId, message.slice(0, 4000)],
    );
  }
}

export async function getGiveaway(
  db: Pool | PoolClient,
  giveawayId: string,
): Promise<WorkerGiveaway | null> {
  const result = await db.query(`${GIVEAWAY_SELECT} WHERE g.id = $1`, [giveawayId]);
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

export async function previousWinnerIds(
  db: Pool | PoolClient,
  giveawayId: string,
): Promise<Set<string>> {
  const result = await db.query(
    `SELECT DISTINCT w.user_id
     FROM draw_winners w
     JOIN draws d ON d.id = w.draw_id
     WHERE d.giveaway_id = $1 AND d.status = 'complete'`,
    [giveawayId],
  );
  return new Set(result.rows.map((row) => row.user_id as string));
}

export async function createDrawCommitment(
  pool: Pool,
  input: {
    giveaway: WorkerGiveaway;
    candidates: Candidate[];
    exclusions: Array<{ userId: string; reason: string }>;
    candidateHash: string;
    chainHash: string;
    round: bigint;
    beaconTime: Date;
    actorUserId: string | null;
  },
): Promise<DrawRow> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM giveaways WHERE id = $1 FOR UPDATE", [
      input.giveaway.id,
    ]);
    const numberResult = await client.query(
      `SELECT COALESCE(max(draw_number), 0)::int + 1 AS draw_number
       FROM draws WHERE giveaway_id = $1`,
      [input.giveaway.id],
    );
    const drawNumber = Number(numberResult.rows[0]!.draw_number);
    const drawId = randomUUID();
    await client.query(
      `INSERT INTO draws (
        id, giveaway_id, draw_number, requested_by_user_id, candidate_hash,
        drand_chain_hash, drand_round, drand_beacon_time, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'awaiting_beacon')`,
      [
        drawId,
        input.giveaway.id,
        drawNumber,
        input.actorUserId,
        input.candidateHash,
        input.chainHash,
        input.round.toString(),
        input.beaconTime,
      ],
    );
    for (const [ordinal, candidate] of input.candidates.entries()) {
      await client.query(
        `INSERT INTO draw_candidates
         (draw_id, user_id, username, joined_at, weight, ordinal)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          drawId,
          candidate.userId,
          candidate.username,
          candidate.joinedAt,
          candidate.weight,
          ordinal,
        ],
      );
      await client.query(
        `UPDATE entries SET eligible_at_draw = true, draw_weight = $3,
           ineligible_reason = NULL
         WHERE giveaway_id = $1 AND user_id = $2`,
        [input.giveaway.id, candidate.userId, candidate.weight],
      );
    }
    for (const exclusion of input.exclusions) {
      await client.query(
        `INSERT INTO draw_exclusions (draw_id, user_id, reason) VALUES ($1, $2, $3)`,
        [drawId, exclusion.userId, exclusion.reason],
      );
      await client.query(
        `UPDATE entries SET eligible_at_draw = false, draw_weight = NULL,
           ineligible_reason = $3
         WHERE giveaway_id = $1 AND user_id = $2`,
        [input.giveaway.id, exclusion.userId, exclusion.reason],
      );
    }
    await client.query(
      `UPDATE giveaways SET status = 'ending', ended_at = COALESCE(ended_at, now()),
         snapshot_hash = $2, drand_chain_hash = $3, drand_round = $4, updated_at = now()
       WHERE id = $1`,
      [input.giveaway.id, input.candidateHash, input.chainHash, input.round.toString()],
    );
    await client.query(
      `INSERT INTO jobs (id, type, giveaway_id, payload, run_at, idempotency_key)
       VALUES ($1, 'complete_draw', $2, jsonb_build_object('drawId', $3::text),
               $4::timestamptz + interval '2 seconds', $5)`,
      [randomUUID(), input.giveaway.id, drawId, input.beaconTime, `draw:${drawId}`],
    );
    await client.query(
      `INSERT INTO audit_events
       (id, guild_id, giveaway_id, actor_user_id, action, source, metadata)
       VALUES ($1, $2, $3, $4, 'draw_committed', 'worker',
               jsonb_build_object('drawId', $5::text, 'candidateHash', $6, 'drandRound', $7::text))`,
      [
        randomUUID(),
        input.giveaway.guildId,
        input.giveaway.id,
        input.actorUserId,
        drawId,
        input.candidateHash,
        input.round.toString(),
      ],
    );
    await client.query("COMMIT");
    return {
      id: drawId,
      giveawayId: input.giveaway.id,
      drawNumber,
      candidateHash: input.candidateHash,
      drandChainHash: input.chainHash,
      drandRound: input.round,
      drandBeaconTime: input.beaconTime,
      status: "awaiting_beacon",
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getDraw(pool: Pool, drawId: string): Promise<DrawRow | null> {
  const result = await pool.query("SELECT * FROM draws WHERE id = $1", [drawId]);
  const row = result.rows[0];
  return row
    ? {
        id: row.id as string,
        giveawayId: row.giveaway_id as string,
        drawNumber: Number(row.draw_number),
        candidateHash: row.candidate_hash as string,
        drandChainHash: row.drand_chain_hash as string,
        drandRound: BigInt(row.drand_round as string),
        drandBeaconTime: new Date(row.drand_beacon_time as string),
        status: row.status as string,
      }
    : null;
}

export async function getDrawCandidates(pool: Pool, drawId: string): Promise<Candidate[]> {
  const result = await pool.query(
    `SELECT user_id, username, joined_at, weight
     FROM draw_candidates WHERE draw_id = $1 ORDER BY ordinal`,
    [drawId],
  );
  return result.rows.map((row) => ({
    userId: row.user_id as string,
    username: row.username as string,
    joinedAt: new Date(row.joined_at as string),
    weight: Number(row.weight),
  }));
}

export async function persistWinners(
  pool: Pool,
  draw: DrawRow,
  giveaway: WorkerGiveaway,
  winners: Candidate[],
  beacon: { randomness: string; signature: string; [key: string]: unknown },
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lock = await client.query("SELECT status FROM draws WHERE id = $1 FOR UPDATE", [draw.id]);
    if (lock.rows[0]?.status === "complete") {
      await client.query("COMMIT");
      return;
    }
    for (const [index, winner] of winners.entries()) {
      await client.query(
        `INSERT INTO draw_winners (draw_id, user_id, username, position)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [draw.id, winner.userId, winner.username, index + 1],
      );
    }
    await client.query(
      `UPDATE draws SET status = 'complete', drand_signature = $2,
         drand_randomness = $3, drand_beacon = $4::jsonb, completed_at = now()
       WHERE id = $1`,
      [draw.id, beacon.signature, beacon.randomness, JSON.stringify(beacon)],
    );
    await client.query(
      `UPDATE giveaways SET status = 'ended', ended_at = COALESCE(ended_at, now()),
         snapshot_hash = $2, drand_chain_hash = $3, drand_round = $4,
         drand_signature = $5, drand_randomness = $6, drand_beacon = $7::jsonb,
         updated_at = now()
       WHERE id = $1`,
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
         jsonb_build_object('drawId', $4::text, 'winnerCount', $5::int))`,
      [randomUUID(), giveaway.guildId, giveaway.id, draw.id, winners.length],
    );
    await client.query(
      `INSERT INTO audit_events
       (id, guild_id, giveaway_id, action, source, metadata)
       VALUES ($1, $2, $3, $4, 'worker',
         jsonb_build_object('drawId', $5::text, 'drawNumber', $6::int))`,
      [
        randomUUID(),
        giveaway.guildId,
        giveaway.id,
        draw.drawNumber === 1 ? "ended" : "rerolled",
        draw.id,
        draw.drawNumber,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
