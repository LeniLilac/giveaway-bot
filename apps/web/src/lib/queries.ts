import { db } from "./db";

export interface PublicGiveaway {
  id: string;
  guildId: string;
  channelId: string;
  messageId: string | null;
  creatorUserId: string | null;
  hostUserId: string | null;
  prize: string;
  winnerCount: number;
  durationSeconds: number;
  status: string;
  scheduledStartAt: Date;
  startedAt: Date | null;
  endsAt: Date | null;
  endedAt: Date | null;
  participantCount: number;
  requiredRoleMode: string | null;
  requiredMessages: number | null;
  messageScope: string | null;
  requiredRoleIds: string[];
  prizeRoleIds: string[];
  bonusRoles: Array<{ roleId: string; bonusEntries: number }>;
  snapshotHash: string | null;
  drandChainHash: string | null;
  drandRound: string | null;
  drandSignature: string | null;
  drandRandomness: string | null;
  deletedAt: Date | null;
  createdAt: Date;
}

export interface Participant {
  userId: string;
  username: string;
  globalName: string | null;
  avatarHash: string | null;
  joinedAt: Date;
  leftAt: Date | null;
  eligibleAtDraw: boolean | null;
  drawWeight: number | null;
  ineligibleReason: string | null;
}

export interface PublicDraw {
  id: string;
  drawNumber: number;
  requestedAt: Date;
  candidateHash: string | null;
  drandChainHash: string;
  drandRound: string;
  drandBeaconTime: Date;
  drandSignature: string | null;
  drandRandomness: string | null;
  status: string;
  completedAt: Date | null;
  candidates: Array<{
    userId: string;
    username: string;
    joinedAt: Date;
    weight: number;
    ordinal: number;
  }>;
  exclusions: Array<{ userId: string; reason: string }>;
  winners: Array<{ userId: string; username: string; position: number }>;
}

export interface AuditEvent {
  id: string;
  actorUserId: string | null;
  action: string;
  source: string;
  metadata: Record<string, unknown>;
  occurredAt: Date;
}

function mapGiveaway(row: Record<string, unknown>): PublicGiveaway {
  return {
    id: row.id as string,
    guildId: row.guild_id as string,
    channelId: row.channel_id as string,
    messageId: (row.message_id as string | null) ?? null,
    creatorUserId: (row.creator_user_id as string | null) ?? null,
    hostUserId: (row.host_user_id as string | null) ?? null,
    prize: row.prize as string,
    winnerCount: Number(row.winner_count),
    durationSeconds: Number(row.duration_seconds),
    status: row.status as string,
    scheduledStartAt: new Date(row.scheduled_start_at as string),
    startedAt: row.started_at ? new Date(row.started_at as string) : null,
    endsAt: row.ends_at ? new Date(row.ends_at as string) : null,
    endedAt: row.ended_at ? new Date(row.ended_at as string) : null,
    participantCount: Number(row.participant_count),
    requiredRoleMode: (row.required_role_mode as string | null) ?? null,
    requiredMessages:
      row.required_messages === null ? null : Number(row.required_messages),
    messageScope: (row.message_scope as string | null) ?? null,
    requiredRoleIds: (row.required_role_ids as string[] | null) ?? [],
    prizeRoleIds: (row.prize_role_ids as string[] | null) ?? [],
    bonusRoles:
      (row.bonus_roles as Array<{ roleId: string; bonusEntries: number }> | null) ?? [],
    snapshotHash: (row.snapshot_hash as string | null) ?? null,
    drandChainHash: (row.drand_chain_hash as string | null) ?? null,
    drandRound: row.drand_round === null ? null : String(row.drand_round),
    drandSignature: (row.drand_signature as string | null) ?? null,
    drandRandomness: (row.drand_randomness as string | null) ?? null,
    deletedAt: row.deleted_at ? new Date(row.deleted_at as string) : null,
    createdAt: new Date(row.created_at as string),
  };
}

const GIVEAWAY_SELECT = `
  SELECT g.*,
    ARRAY(SELECT role_id FROM giveaway_required_roles r WHERE r.giveaway_id = g.id ORDER BY role_id)
      AS required_role_ids,
    ARRAY(SELECT role_id FROM giveaway_prize_roles p WHERE p.giveaway_id = g.id ORDER BY role_id)
      AS prize_role_ids,
    COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object('roleId', b.role_id, 'bonusEntries', b.bonus_entries)
        ORDER BY b.role_id
      ) FROM giveaway_bonus_roles b WHERE b.giveaway_id = g.id
    ), '[]'::jsonb) AS bonus_roles
  FROM giveaways g
`;

export async function getPublicGiveaway(
  id: string,
  page = 1,
  pageSize = 100,
): Promise<{
  giveaway: PublicGiveaway;
  participants: Participant[];
  participantTotal: number;
  draws: PublicDraw[];
  audit: AuditEvent[];
  activity: Array<{ bucket: Date; joins: number; leaves: number }>;
} | null> {
  const giveawayResult = await db.query(`${GIVEAWAY_SELECT} WHERE g.id::text = $1 LIMIT 1`, [
    id,
  ]);
  if (!giveawayResult.rows[0]) return null;
  const giveaway = mapGiveaway(giveawayResult.rows[0]);
  const offset = Math.max(0, page - 1) * pageSize;
  const [participantsResult, participantCount, drawsResult, auditResult, activityResult] =
    await Promise.all([
      db.query(
        `SELECT user_id, username, global_name, avatar_hash, joined_at, left_at,
           eligible_at_draw, draw_weight, ineligible_reason
         FROM entries WHERE giveaway_id = $1
         ORDER BY joined_at, user_id LIMIT $2 OFFSET $3`,
        [id, pageSize, offset],
      ),
      db.query("SELECT count(*)::int AS count FROM entries WHERE giveaway_id = $1", [id]),
      db.query(
        `SELECT * FROM draws WHERE giveaway_id = $1 ORDER BY draw_number DESC`,
        [id],
      ),
      db.query(
        `SELECT * FROM audit_events WHERE giveaway_id = $1
         ORDER BY occurred_at DESC LIMIT 250`,
        [id],
      ),
      db.query(
        `SELECT date_trunc('hour', occurred_at) AS bucket,
           count(*) FILTER (WHERE event_type IN ('join', 'rejoin'))::int AS joins,
           count(*) FILTER (WHERE event_type = 'leave')::int AS leaves
         FROM entry_events WHERE giveaway_id = $1
         GROUP BY 1 ORDER BY 1`,
        [id],
      ),
    ]);

  const draws: PublicDraw[] = [];
  for (const row of drawsResult.rows) {
    const [candidateResult, exclusionResult, winnerResult] = await Promise.all([
      db.query("SELECT * FROM draw_candidates WHERE draw_id = $1 ORDER BY ordinal", [row.id]),
      db.query("SELECT * FROM draw_exclusions WHERE draw_id = $1 ORDER BY user_id", [row.id]),
      db.query("SELECT * FROM draw_winners WHERE draw_id = $1 ORDER BY position", [row.id]),
    ]);
    draws.push({
      id: row.id as string,
      drawNumber: Number(row.draw_number),
      requestedAt: new Date(row.requested_at as string),
      candidateHash: (row.candidate_hash as string | null) ?? null,
      drandChainHash: row.drand_chain_hash as string,
      drandRound: String(row.drand_round),
      drandBeaconTime: new Date(row.drand_beacon_time as string),
      drandSignature: (row.drand_signature as string | null) ?? null,
      drandRandomness: (row.drand_randomness as string | null) ?? null,
      status: row.status as string,
      completedAt: row.completed_at ? new Date(row.completed_at as string) : null,
      candidates: candidateResult.rows.map((candidate) => ({
        userId: candidate.user_id as string,
        username: candidate.username as string,
        joinedAt: new Date(candidate.joined_at as string),
        weight: Number(candidate.weight),
        ordinal: Number(candidate.ordinal),
      })),
      exclusions: exclusionResult.rows.map((exclusion) => ({
        userId: exclusion.user_id as string,
        reason: exclusion.reason as string,
      })),
      winners: winnerResult.rows.map((winner) => ({
        userId: winner.user_id as string,
        username: winner.username as string,
        position: Number(winner.position),
      })),
    });
  }

  return {
    giveaway,
    participants: participantsResult.rows.map((row) => ({
      userId: row.user_id as string,
      username: row.username as string,
      globalName: (row.global_name as string | null) ?? null,
      avatarHash: (row.avatar_hash as string | null) ?? null,
      joinedAt: new Date(row.joined_at as string),
      leftAt: row.left_at ? new Date(row.left_at as string) : null,
      eligibleAtDraw:
        row.eligible_at_draw === null ? null : Boolean(row.eligible_at_draw),
      drawWeight: row.draw_weight === null ? null : Number(row.draw_weight),
      ineligibleReason: (row.ineligible_reason as string | null) ?? null,
    })),
    participantTotal: Number(participantCount.rows[0]!.count),
    draws,
    audit: auditResult.rows.map((row) => ({
      id: row.id as string,
      actorUserId: (row.actor_user_id as string | null) ?? null,
      action: row.action as string,
      source: row.source as string,
      metadata: (row.metadata as Record<string, unknown>) ?? {},
      occurredAt: new Date(row.occurred_at as string),
    })),
    activity: activityResult.rows.map((row) => ({
      bucket: new Date(row.bucket as string),
      joins: Number(row.joins),
      leaves: Number(row.leaves),
    })),
  };
}

export interface DashboardGiveaway {
  id: string;
  guildId: string;
  prize: string;
  status: string;
  participantCount: number;
  winnerCount: number;
  scheduledStartAt: Date;
  endsAt: Date | null;
  creatorUserId: string | null;
}

function mapDashboardGiveaway(row: Record<string, unknown>): DashboardGiveaway {
  return {
    id: row.id as string,
    guildId: row.guild_id as string,
    prize: row.prize as string,
    status: row.status as string,
    participantCount: Number(row.participant_count),
    winnerCount: Number(row.winner_count),
    scheduledStartAt: new Date(row.scheduled_start_at as string),
    endsAt: row.ends_at ? new Date(row.ends_at as string) : null,
    creatorUserId: (row.creator_user_id as string | null) ?? null,
  };
}

export async function getUserDashboard(
  userId: string,
  createdPage = 1,
  joinedPage = 1,
  pageSize = 50,
): Promise<{
  created: DashboardGiveaway[];
  joined: DashboardGiveaway[];
  createdTotal: number;
  joinedTotal: number;
}> {
  const createdOffset = Math.max(0, createdPage - 1) * pageSize;
  const joinedOffset = Math.max(0, joinedPage - 1) * pageSize;
  const [created, joined, createdCount, joinedCount] = await Promise.all([
    db.query(
      `SELECT * FROM giveaways WHERE creator_user_id = $1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [userId, pageSize, createdOffset],
    ),
    db.query(
      `SELECT g.* FROM giveaways g
       JOIN entries e ON e.giveaway_id = g.id
       WHERE e.user_id = $1
       ORDER BY e.joined_at DESC LIMIT $2 OFFSET $3`,
      [userId, pageSize, joinedOffset],
    ),
    db.query("SELECT count(*)::int AS count FROM giveaways WHERE creator_user_id = $1", [userId]),
    db.query("SELECT count(*)::int AS count FROM entries WHERE user_id = $1", [userId]),
  ]);
  return {
    created: created.rows.map(mapDashboardGiveaway),
    joined: joined.rows.map(mapDashboardGiveaway),
    createdTotal: Number(createdCount.rows[0]!.count),
    joinedTotal: Number(joinedCount.rows[0]!.count),
  };
}

export async function getGuildDashboard(guildId: string): Promise<{
  giveaways: DashboardGiveaway[];
  commandRoles: Record<string, string[]>;
  audit: AuditEvent[];
}> {
  const [liveGiveaways, history, roles, audit] = await Promise.all([
    db.query(
      `SELECT * FROM giveaways
       WHERE guild_id = $1 AND status IN ('queued', 'starting', 'active', 'ending')
       ORDER BY scheduled_start_at ASC LIMIT 1000`,
      [guildId],
    ),
    db.query(
      `SELECT * FROM giveaways
       WHERE guild_id = $1 AND status NOT IN ('queued', 'starting', 'active', 'ending')
       ORDER BY created_at DESC LIMIT 250`,
      [guildId],
    ),
    db.query(
      `SELECT command, role_id FROM guild_command_roles
       WHERE guild_id = $1 ORDER BY command, role_id`,
      [guildId],
    ),
    db.query(
      `SELECT * FROM audit_events WHERE guild_id = $1
       ORDER BY occurred_at DESC LIMIT 250`,
      [guildId],
    ),
  ]);
  const commandRoles: Record<string, string[]> = {};
  for (const row of roles.rows) {
    const command = row.command as string;
    commandRoles[command] ??= [];
    commandRoles[command]!.push(row.role_id as string);
  }
  return {
    giveaways: [...liveGiveaways.rows, ...history.rows].map(mapDashboardGiveaway),
    commandRoles,
    audit: audit.rows.map((row) => ({
      id: row.id as string,
      actorUserId: (row.actor_user_id as string | null) ?? null,
      action: row.action as string,
      source: row.source as string,
      metadata: (row.metadata as Record<string, unknown>) ?? {},
      occurredAt: new Date(row.occurred_at as string),
    })),
  };
}

export interface PublicStats {
  servers: number;
  giveaways: number;
  liveGiveaways: number;
  completedGiveaways: number;
  entryRecords: number;
  completedDraws: number;
  winners: number;
}

export async function getPublicStats(): Promise<PublicStats> {
  const result = await db.query(
    `SELECT
       (SELECT count(DISTINCT guild_id) FROM giveaways)::bigint AS servers,
       (SELECT count(*) FROM giveaways)::bigint AS giveaways,
       (SELECT count(*) FROM giveaways
        WHERE status IN ('queued', 'starting', 'active', 'ending'))::bigint AS live_giveaways,
       (SELECT count(*) FROM giveaways WHERE status = 'ended')::bigint AS completed_giveaways,
       (SELECT count(*) FROM entries)::bigint AS entry_records,
       (SELECT count(*) FROM draws WHERE status = 'complete')::bigint AS completed_draws,
       (SELECT count(*) FROM draw_winners)::bigint AS winners`,
  );
  const row = result.rows[0]!;
  return {
    servers: Number(row.servers),
    giveaways: Number(row.giveaways),
    liveGiveaways: Number(row.live_giveaways),
    completedGiveaways: Number(row.completed_giveaways),
    entryRecords: Number(row.entry_records),
    completedDraws: Number(row.completed_draws),
    winners: Number(row.winners),
  };
}
