import type { PoolClient } from "pg";
import { db } from "./db";
import { INT32_MAX, isUuid } from "./identifiers";
import { withPublicEvidenceSnapshot } from "./public-snapshot";

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
  proofVersion: "lilac-weighted-v1" | "lilac-weighted-v2";
  legacyVerificationStatus: "verifiable" | "redacted_unverifiable" | "not_applicable";
  requestedWinnerCount: number;
  actualWinnerCount: number | null;
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
    participantId: string;
    userId: string;
    username: string;
    joinedAt: Date;
    weight: number;
    ordinal: number;
  }>;
  exclusions: Array<{ participantId: string; userId: string; reason: string }>;
  winners: Array<{
    participantId: string;
    userId: string;
    username: string;
    position: number;
  }>;
  candidateTotal: number;
  exclusionTotal: number;
  winnerTotal: number;
}

export function selectedDrawProofFields(
  draw: PublicDraw | undefined,
): Pick<
  PublicGiveaway,
  | "snapshotHash"
  | "drandChainHash"
  | "drandRound"
  | "drandSignature"
  | "drandRandomness"
> {
  return {
    snapshotHash: draw?.candidateHash ?? null,
    drandChainHash: draw?.drandChainHash ?? null,
    drandRound: draw?.drandRound ?? null,
    drandSignature: draw?.drandSignature ?? null,
    drandRandomness: draw?.drandRandomness ?? null,
  };
}

export interface AuditEvent {
  id: string;
  actorUserId: string | null;
  action: string;
  source: string;
  metadata: Record<string, unknown>;
  occurredAt: Date;
}

export function mapGiveaway(row: Record<string, unknown>): PublicGiveaway {
  const commitmentPublished = row.published_draw_id !== null;
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
    snapshotHash: commitmentPublished
      ? ((row.published_candidate_hash as string | null) ?? null)
      : null,
    drandChainHash: commitmentPublished
      ? ((row.published_drand_chain_hash as string | null) ?? null)
      : null,
    drandRound:
      commitmentPublished && row.published_drand_round !== null
        ? String(row.published_drand_round)
        : null,
    drandSignature: commitmentPublished
      ? ((row.published_drand_signature as string | null) ?? null)
      : null,
    drandRandomness: commitmentPublished
      ? ((row.published_drand_randomness as string | null) ?? null)
      : null,
    deletedAt: row.deleted_at ? new Date(row.deleted_at as string) : null,
    createdAt: new Date(row.created_at as string),
  };
}

export function mapSelectedDrawParticipant(row: Record<string, unknown>): Participant {
  return {
    userId: row.user_id as string,
    username: row.username as string,
    globalName: (row.global_name as string | null) ?? null,
    avatarHash: (row.avatar_hash as string | null) ?? null,
    joinedAt: new Date(row.joined_at as string),
    leftAt: row.left_at ? new Date(row.left_at as string) : null,
    eligibleAtDraw:
      row.selected_eligible_at_draw === null
        ? null
        : Boolean(row.selected_eligible_at_draw),
    drawWeight:
      row.selected_draw_weight === null ? null : Number(row.selected_draw_weight),
    ineligibleReason: (row.selected_ineligible_reason as string | null) ?? null,
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
    ), '[]'::jsonb) AS bonus_roles,
    published_draw.id AS published_draw_id,
    published_draw.candidate_hash AS published_candidate_hash,
    published_draw.drand_chain_hash AS published_drand_chain_hash,
    published_draw.drand_round AS published_drand_round,
    published_draw.drand_signature AS published_drand_signature,
    published_draw.drand_randomness AS published_drand_randomness
  FROM giveaways g
  LEFT JOIN LATERAL (
    SELECT d.id, d.candidate_hash, d.drand_chain_hash, d.drand_round,
           d.drand_signature, d.drand_randomness
    FROM draws d
    WHERE d.giveaway_id = g.id AND d.commitment_published_at IS NOT NULL
    ORDER BY d.draw_number DESC
    LIMIT 1
  ) published_draw ON true
`;

export interface PublicGiveawayQuery {
  participantPage?: number;
  participantPageSize?: number;
  drawNumber?: number;
  evidencePage?: number;
  evidencePageSize?: number;
  includeCandidates?: boolean;
  includeExclusions?: boolean;
  participantAfter?: { joinedAt: string; userId: string };
  candidateAfterOrdinal?: number;
  exclusionAfterUserId?: string;
  winnerAfterPosition?: number;
}

const MAX_PUBLIC_PAGE_SIZE = 250;
const MAX_PUBLIC_OFFSET = 100_000;

export function publicOffsetPageCount(total: number, pageSize: number): number {
  const boundedPageSize = Math.max(1, Math.trunc(pageSize));
  const totalPages = Math.max(1, Math.ceil(Math.max(0, total) / boundedPageSize));
  const accessiblePages = Math.floor(MAX_PUBLIC_OFFSET / boundedPageSize) + 1;
  return Math.min(totalPages, accessiblePages);
}

function boundedPage(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function boundedPageSize(value: number | undefined, fallback: number): number {
  return Math.min(MAX_PUBLIC_PAGE_SIZE, boundedPage(value, fallback));
}

const DRAW_SELECT = `
  SELECT d.*,
    (SELECT count(*)::int FROM draw_candidates c WHERE c.draw_id = d.id) AS candidate_total,
    (SELECT count(*)::int FROM draw_exclusions x WHERE x.draw_id = d.id) AS exclusion_total,
    (SELECT count(*)::int FROM draw_winners w WHERE w.draw_id = d.id) AS winner_total,
    EXISTS (
      SELECT 1 FROM draw_candidates c
      WHERE c.draw_id = d.id AND c.user_id LIKE 'deleted:%'
    ) AS has_unverifiable_redaction
  FROM draws d
`;

export interface PublicGiveawayEvidence {
  giveaway: PublicGiveaway;
  participants: Participant[];
  participantTotal: number;
  draws: PublicDraw[];
  selectedDrawNumber: number | null;
  drawTotal: number;
  audit: AuditEvent[];
  activity: Array<{ bucket: Date; joins: number; leaves: number }>;
  pagination: {
    participants: { page: number; pageSize: number; total: number };
    evidence: { page: number; pageSize: number };
    next: {
      participant: { joinedAt: string; userId: string } | null;
      candidateOrdinal: number | null;
      exclusionUserId: string | null;
      winnerPosition: number | null;
    };
  };
}

export async function getPublicGiveaway(
  id: string,
  options: PublicGiveawayQuery = {},
): Promise<PublicGiveawayEvidence | null> {
  if (!isUuid(id)) return null;
  if (
    (options.drawNumber !== undefined &&
      (!Number.isSafeInteger(options.drawNumber) ||
        options.drawNumber < 1 ||
        options.drawNumber > INT32_MAX)) ||
    (options.candidateAfterOrdinal !== undefined &&
      (!Number.isSafeInteger(options.candidateAfterOrdinal) ||
        options.candidateAfterOrdinal < 0 ||
        options.candidateAfterOrdinal > INT32_MAX)) ||
    (options.winnerAfterPosition !== undefined &&
      (!Number.isSafeInteger(options.winnerAfterPosition) ||
        options.winnerAfterPosition < 0 ||
        options.winnerAfterPosition > INT32_MAX))
  ) {
    return null;
  }
  return withPublicEvidenceSnapshot((client) =>
    loadPublicGiveawaySnapshot(client, id, options),
  );
}

async function loadPublicGiveawaySnapshot(
  client: PoolClient,
  id: string,
  options: PublicGiveawayQuery,
): Promise<PublicGiveawayEvidence | null> {
  const giveawayResult = await client.query(`${GIVEAWAY_SELECT} WHERE g.id = $1::uuid LIMIT 1`, [
    id,
  ]);
  if (!giveawayResult.rows[0]) return null;
  const giveaway = mapGiveaway(giveawayResult.rows[0]);
  const participantPageSize = boundedPageSize(options.participantPageSize, 100);
  const evidencePageSize = boundedPageSize(options.evidencePageSize, 100);
  const participantPage = Math.min(
    boundedPage(options.participantPage, 1),
    Math.floor(MAX_PUBLIC_OFFSET / participantPageSize) + 1,
  );
  const evidencePage =
    options.winnerAfterPosition === undefined
      ? Math.min(
          boundedPage(options.evidencePage, 1),
          Math.floor(MAX_PUBLIC_OFFSET / evidencePageSize) + 1,
        )
      : boundedPage(options.evidencePage, 1);
  const participantOffset = (participantPage - 1) * participantPageSize;
  const evidenceOffset = (evidencePage - 1) * evidencePageSize;
  const [participantCount, drawsResult, drawCount, auditResult, activityResult] =
    await Promise.all([
      client.query("SELECT count(*)::int AS count FROM entries WHERE giveaway_id = $1", [id]),
      client.query(
        `${DRAW_SELECT}
         WHERE d.giveaway_id = $1 AND d.commitment_published_at IS NOT NULL
         ORDER BY d.draw_number DESC
         LIMIT 250`,
        [id],
      ),
      client.query(
        `SELECT count(*)::int AS count FROM draws
         WHERE giveaway_id = $1 AND commitment_published_at IS NOT NULL`,
        [id],
      ),
      client.query(
        `SELECT * FROM audit_events WHERE giveaway_id = $1
         ORDER BY occurred_at DESC LIMIT 250`,
        [id],
      ),
      client.query(
        `SELECT bucket, joins, leaves FROM (
           SELECT date_trunc('hour', occurred_at) AS bucket,
             count(*) FILTER (WHERE event_type IN ('join', 'rejoin'))::int AS joins,
             count(*) FILTER (WHERE event_type = 'leave')::int AS leaves
           FROM entry_events
           WHERE giveaway_id = $1
             AND occurred_at >= now() - interval '90 days'
           GROUP BY 1 ORDER BY 1 DESC LIMIT 2000
         ) recent_activity ORDER BY bucket`,
        [id],
      ),
    ]);

  let drawRows = drawsResult.rows;
  let selectedRow =
    options.drawNumber === undefined
      ? drawRows[0]
      : drawRows.find((row) => Number(row.draw_number) === options.drawNumber);
  if (!selectedRow && options.drawNumber !== undefined) {
    const requestedDraw = await client.query(
      `${DRAW_SELECT}
       WHERE d.giveaway_id = $1 AND d.draw_number = $2
         AND d.commitment_published_at IS NOT NULL
       LIMIT 1`,
      [id, options.drawNumber],
    );
    selectedRow = requestedDraw.rows[0];
    if (selectedRow) drawRows = [...drawRows, selectedRow];
  }

  const selectedDrawId = selectedRow?.id as string | undefined;
  const participantQuery = options.participantAfter
    ? client.query(
        `SELECT entry.user_id, entry.username, entry.global_name, entry.avatar_hash,
           entry.joined_at, entry.left_at,
           CASE
             WHEN candidate.user_id IS NOT NULL THEN true
             WHEN exclusion.user_id IS NOT NULL THEN false
             ELSE NULL
           END AS selected_eligible_at_draw,
           candidate.weight AS selected_draw_weight,
           exclusion.reason AS selected_ineligible_reason
         FROM entries entry
         LEFT JOIN draw_candidates candidate
           ON candidate.draw_id = $2::uuid AND candidate.user_id = entry.user_id
         LEFT JOIN draw_exclusions exclusion
           ON exclusion.draw_id = $2::uuid AND exclusion.user_id = entry.user_id
         WHERE entry.giveaway_id = $1
           AND (entry.joined_at, entry.user_id) > ($3::timestamptz, $4::text)
         ORDER BY entry.joined_at, entry.user_id LIMIT $5`,
        [
          id,
          selectedDrawId ?? null,
          options.participantAfter.joinedAt,
          options.participantAfter.userId,
          participantPageSize,
        ],
      )
    : client.query(
        `SELECT entry.user_id, entry.username, entry.global_name, entry.avatar_hash,
           entry.joined_at, entry.left_at,
           CASE
             WHEN candidate.user_id IS NOT NULL THEN true
             WHEN exclusion.user_id IS NOT NULL THEN false
             ELSE NULL
           END AS selected_eligible_at_draw,
           candidate.weight AS selected_draw_weight,
           exclusion.reason AS selected_ineligible_reason
         FROM entries entry
         LEFT JOIN draw_candidates candidate
           ON candidate.draw_id = $2::uuid AND candidate.user_id = entry.user_id
         LEFT JOIN draw_exclusions exclusion
           ON exclusion.draw_id = $2::uuid AND exclusion.user_id = entry.user_id
         WHERE entry.giveaway_id = $1
         ORDER BY entry.joined_at, entry.user_id LIMIT $3 OFFSET $4`,
        [id, selectedDrawId ?? null, participantPageSize, participantOffset],
      );
  const [participantsResult, candidateResult, exclusionResult, winnerResult] = selectedDrawId
    ? await Promise.all([
        participantQuery,
        options.candidateAfterOrdinal === undefined
          ? client.query(
              `SELECT * FROM draw_candidates
               WHERE draw_id = $1 ORDER BY ordinal LIMIT $2 OFFSET $3`,
              [
                selectedDrawId,
                options.includeCandidates === false ? 0 : evidencePageSize,
                evidenceOffset,
              ],
            )
          : client.query(
              `SELECT * FROM draw_candidates
               WHERE draw_id = $1 AND ordinal > $2
               ORDER BY ordinal LIMIT $3`,
              [
                selectedDrawId,
                options.candidateAfterOrdinal,
                options.includeCandidates === false ? 0 : evidencePageSize,
              ],
            ),
        options.exclusionAfterUserId === undefined
          ? client.query(
              `SELECT * FROM draw_exclusions
               WHERE draw_id = $1
               ORDER BY user_id LIMIT $2 OFFSET $3`,
              [
                selectedDrawId,
                options.includeExclusions === false ? 0 : evidencePageSize,
                evidenceOffset,
              ],
            )
          : client.query(
              `SELECT * FROM draw_exclusions
               WHERE draw_id = $1 AND user_id > $2
               ORDER BY user_id LIMIT $3`,
              [
                selectedDrawId,
                options.exclusionAfterUserId,
                options.includeExclusions === false ? 0 : evidencePageSize,
              ],
            ),
        options.winnerAfterPosition === undefined
          ? client.query(
              `SELECT * FROM draw_winners
               WHERE draw_id = $1 ORDER BY position LIMIT $2 OFFSET $3`,
              [selectedDrawId, evidencePageSize, evidenceOffset],
            )
          : client.query(
              `SELECT * FROM draw_winners
               WHERE draw_id = $1 AND position > $2
               ORDER BY position LIMIT $3`,
              [selectedDrawId, options.winnerAfterPosition, evidencePageSize],
            ),
      ])
    : [await participantQuery, { rows: [] }, { rows: [] }, { rows: [] }];

  const draws: PublicDraw[] = drawRows.map((row) => {
    const isSelected = row.id === selectedDrawId;
    const proofVersion = row.proof_version as PublicDraw["proofVersion"];
    return {
      id: row.id as string,
      drawNumber: Number(row.draw_number),
      proofVersion,
      legacyVerificationStatus:
        proofVersion === "lilac-weighted-v2"
          ? "not_applicable"
          : row.has_unverifiable_redaction
            ? "redacted_unverifiable"
            : "verifiable",
      requestedWinnerCount: Number(row.requested_winner_count),
      actualWinnerCount: row.status === "complete" ? Number(row.winner_total) : null,
      requestedAt: new Date(row.requested_at as string),
      candidateHash: (row.candidate_hash as string | null) ?? null,
      drandChainHash: row.drand_chain_hash as string,
      drandRound: String(row.drand_round),
      drandBeaconTime: new Date(row.drand_beacon_time as string),
      drandSignature: (row.drand_signature as string | null) ?? null,
      drandRandomness: (row.drand_randomness as string | null) ?? null,
      status: row.status as string,
      completedAt: row.completed_at ? new Date(row.completed_at as string) : null,
      candidates: (isSelected ? candidateResult.rows : []).map((candidate) => ({
        participantId:
          (candidate.proof_id as string | null) ?? (candidate.user_id as string),
        userId: candidate.user_id as string,
        username: candidate.username as string,
        joinedAt: new Date(candidate.joined_at as string),
        weight: Number(candidate.weight),
        ordinal: Number(candidate.ordinal),
      })),
      exclusions: (isSelected ? exclusionResult.rows : []).map((exclusion) => ({
        participantId:
          (exclusion.proof_id as string | null) ?? (exclusion.user_id as string),
        userId: exclusion.user_id as string,
        reason: exclusion.reason as string,
      })),
      winners: (isSelected ? winnerResult.rows : []).map((winner) => ({
        participantId: (winner.proof_id as string | null) ?? (winner.user_id as string),
        userId: winner.user_id as string,
        username: winner.username as string,
        position: Number(winner.position),
      })),
      candidateTotal: Number(row.candidate_total),
      exclusionTotal: Number(row.exclusion_total),
      winnerTotal: Number(row.winner_total),
    };
  });

  const participantTotal = Number(participantCount.rows[0]!.count);
  const lastParticipant = participantsResult.rows.at(-1);
  const lastCandidate = candidateResult.rows.at(-1);
  const lastExclusion = exclusionResult.rows.at(-1);
  const lastWinner = winnerResult.rows.at(-1);
  return {
    giveaway,
    participants: participantsResult.rows.map(mapSelectedDrawParticipant),
    participantTotal,
    draws,
    selectedDrawNumber: selectedRow ? Number(selectedRow.draw_number) : null,
    drawTotal: Number(drawCount.rows[0]!.count),
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
    pagination: {
      participants: {
        page: participantPage,
        pageSize: participantPageSize,
        total: participantTotal,
      },
      evidence: { page: evidencePage, pageSize: evidencePageSize },
      next: {
        participant:
          participantsResult.rows.length === participantPageSize && lastParticipant
            ? {
                joinedAt: new Date(lastParticipant.joined_at as string).toISOString(),
                userId: lastParticipant.user_id as string,
              }
            : null,
        candidateOrdinal:
          candidateResult.rows.length === evidencePageSize && lastCandidate
            ? Number(lastCandidate.ordinal)
            : null,
        exclusionUserId:
          exclusionResult.rows.length === evidencePageSize && lastExclusion
            ? (lastExclusion.user_id as string)
            : null,
        winnerPosition:
          winnerResult.rows.length === evidencePageSize && lastWinner
            ? Number(lastWinner.position)
            : null,
      },
    },
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
  const boundedPageSize = Math.min(100, Math.max(1, Math.trunc(pageSize) || 50));
  const boundedCreatedPage = Math.min(2_001, Math.max(1, Math.trunc(createdPage) || 1));
  const boundedJoinedPage = Math.min(2_001, Math.max(1, Math.trunc(joinedPage) || 1));
  const createdOffset = (boundedCreatedPage - 1) * boundedPageSize;
  const joinedOffset = (boundedJoinedPage - 1) * boundedPageSize;
  const [created, joined, createdCount, joinedCount] = await Promise.all([
    db.query(
      `SELECT * FROM giveaways WHERE creator_user_id = $1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [userId, boundedPageSize, createdOffset],
    ),
    db.query(
      `SELECT g.* FROM giveaways g
       JOIN entries e ON e.giveaway_id = g.id
       WHERE e.user_id = $1
       ORDER BY e.joined_at DESC LIMIT $2 OFFSET $3`,
      [userId, boundedPageSize, joinedOffset],
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
