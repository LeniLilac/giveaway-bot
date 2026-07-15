import { randomUUID } from "node:crypto";
import { privacyFenceHash } from "@lilac/core";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import {
  assertActionAllowed,
  parseManagementAction,
} from "./action-policy.js";

export type GiveawayStatus =
  | "queued"
  | "starting"
  | "active"
  | "ending"
  | "ended"
  | "deleted"
  | "error";

export interface DraftPayload {
  prize: string;
  winnerCount: number;
  durationSeconds: number;
  scheduledStartAt: string;
  channelId: string;
  hostUserId: string;
  requiredRoleIds: string[];
  prizeRoleIds: string[];
  bonusRoles: Array<{ roleId: string; bonusEntries: number }>;
  requiredMessages: number | null;
  requiredRoleMode: "all" | "one" | null;
  messageScope: "all_time" | "since_start" | null;
}

export interface DraftRecord {
  id: string;
  guildId: string;
  creatorUserId: string;
  payload: DraftPayload;
  state: string;
  expiresAt: Date;
}

export interface GiveawayRecord {
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
  status: GiveawayStatus;
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

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;
type GiveawayIdentifier =
  | { kind: "uuid"; value: string }
  | { kind: "message"; value: string };

const UUID_IDENTIFIER =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MESSAGE_IDENTIFIER = /^\d{15,22}$/;

interface PrivacyIdentityWrite {
  userId: string;
  allowCompletedReconsent: boolean;
  label: "actor" | "host";
}

async function authorizePrivacyIdentityWrites(
  client: PoolClient,
  identities: PrivacyIdentityWrite[],
  privacyHashSalt: string,
): Promise<void> {
  const unique = new Map<string, PrivacyIdentityWrite>();
  for (const identity of identities) {
    const existing = unique.get(identity.userId);
    unique.set(identity.userId, {
      userId: identity.userId,
      allowCompletedReconsent:
        identity.allowCompletedReconsent || existing?.allowCompletedReconsent === true,
      label: existing?.label === "actor" || identity.label === "actor" ? "actor" : "host",
    });
  }
  const ordered = [...unique.values()].sort((left, right) =>
    left.userId.localeCompare(right.userId),
  );
  for (const identity of ordered) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
      [`privacy-delete:${identity.userId}`],
    );
  }
  for (const identity of ordered) {
    const pending = await client.query(
      `SELECT 1 FROM data_deletion_requests
       WHERE user_id = $1 AND status <> 'complete'
       LIMIT 1`,
      [identity.userId],
    );
    const hash = privacyFenceHash(privacyHashSalt, identity.userId);
    const fenceResult = await client.query(
      `SELECT completed_at, cleared_at FROM privacy_deletion_fences
       WHERE user_id_hash = $1 FOR UPDATE`,
      [hash],
    );
    const fence = fenceResult.rows[0];
    if (pending.rows[0] || (fence && fence.cleared_at === null && fence.completed_at === null)) {
      throw new Error(
        identity.label === "actor"
          ? "Your data deletion must finish before Lilac can store this action."
          : "The credited host cannot currently be stored. Choose another host.",
      );
    }
    if (!fence || fence.cleared_at !== null) continue;
    if (!identity.allowCompletedReconsent) {
      throw new Error("The credited host cannot currently be stored. Choose another host.");
    }
    const cleared = await client.query(
      `UPDATE privacy_deletion_fences
       SET cleared_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE user_id_hash = $1 AND completed_at IS NOT NULL AND cleared_at IS NULL`,
      [hash],
    );
    if (cleared.rowCount !== 1) {
      throw new Error("Your privacy consent could not be updated. Please try again.");
    }
  }
}

export function parseGiveawayIdentifier(value: string): GiveawayIdentifier | null {
  if (UUID_IDENTIFIER.test(value)) return { kind: "uuid", value };
  if (MESSAGE_IDENTIFIER.test(value)) return { kind: "message", value };
  return null;
}

function mapDraft(row: QueryResultRow): DraftRecord {
  return {
    id: row.id as string,
    guildId: row.guild_id as string,
    creatorUserId: row.creator_user_id as string,
    payload: row.payload as DraftPayload,
    state: row.state as string,
    expiresAt: new Date(row.expires_at as string),
  };
}

function mapGiveaway(row: QueryResultRow): GiveawayRecord {
  const scheduled = new Date(row.scheduled_start_at as string);
  const duration = Number(row.duration_seconds);
  const started = row.started_at ? new Date(row.started_at as string) : null;
  const storedEnd = row.ends_at ? new Date(row.ends_at as string) : null;
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
    endsAt: storedEnd ?? new Date((started ?? scheduled).getTime() + duration * 1000),
    endedAt: row.ended_at ? new Date(row.ended_at as string) : null,
    status: row.status as GiveawayStatus,
    requiredRoleMode: (row.required_role_mode as "all" | "one" | null) ?? null,
    requiredMessages:
      row.required_messages === null || row.required_messages === undefined
        ? null
        : Number(row.required_messages),
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

export async function upsertGuild(
  db: Queryable,
  guildId: string,
  guildName: string,
  guildIcon: string | null,
): Promise<void> {
  await db.query(
    `INSERT INTO guild_settings (guild_id, guild_name, guild_icon)
     VALUES ($1, $2, $3)
     ON CONFLICT (guild_id) DO UPDATE
     SET guild_name = EXCLUDED.guild_name,
         guild_icon = EXCLUDED.guild_icon,
         updated_at = now()`,
    [guildId, guildName, guildIcon],
  );
}

export async function getAllowedRoleIds(
  db: Queryable,
  guildId: string,
  command: string,
): Promise<string[]> {
  const result = await db.query(
    `SELECT role_id FROM guild_command_roles
     WHERE guild_id = $1 AND command = $2`,
    [guildId, command],
  );
  return result.rows.map((row) => row.role_id as string);
}

export async function createDraft(
  pool: Pool,
  guildId: string,
  creatorUserId: string,
  payload: DraftPayload,
  privacyHashSalt: string,
): Promise<DraftRecord> {
  const id = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await authorizePrivacyIdentityWrites(
      client,
      [
        { userId: creatorUserId, allowCompletedReconsent: true, label: "actor" },
        { userId: payload.hostUserId, allowCompletedReconsent: false, label: "host" },
      ],
      privacyHashSalt,
    );
    const result = await client.query(
      `INSERT INTO giveaway_drafts
         (id, guild_id, creator_user_id, channel_id, payload, expires_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, now() + interval '15 minutes')
       RETURNING *`,
      [id, guildId, creatorUserId, payload.channelId, JSON.stringify(payload)],
    );
    await client.query("COMMIT");
    return mapDraft(result.rows[0]!);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getDraft(pool: Pool, id: string): Promise<DraftRecord | null> {
  const result = await pool.query(
    `SELECT * FROM giveaway_drafts
     WHERE id = $1 AND state = 'pending' AND expires_at > now()`,
    [id],
  );
  return result.rows[0] ? mapDraft(result.rows[0]) : null;
}

export async function updateDraftDecision(
  pool: Pool,
  id: string,
  field: "requiredRoleMode" | "messageScope",
  value: "all" | "one" | "all_time" | "since_start",
): Promise<DraftRecord | null> {
  const jsonKey = field === "requiredRoleMode" ? "requiredRoleMode" : "messageScope";
  const result = await pool.query(
    `UPDATE giveaway_drafts
     SET payload = jsonb_set(payload, ARRAY[$2], to_jsonb($3::text), true)
     WHERE id = $1 AND state = 'pending' AND expires_at > now()
     RETURNING *`,
    [id, jsonKey, value],
  );
  return result.rows[0] ? mapDraft(result.rows[0]) : null;
}

export async function cancelDraft(pool: Pool, id: string, userId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE giveaway_drafts SET state = 'cancelled'
     WHERE id = $1 AND creator_user_id = $2 AND state = 'pending'`,
    [id, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

export function draftIsReady(payload: DraftPayload): boolean {
  const rolesReady = payload.requiredRoleIds.length === 0 || payload.requiredRoleMode !== null;
  const messagesReady = payload.requiredMessages === null || payload.messageScope !== null;
  return rolesReady && messagesReady;
}

export async function createGiveawayFromDraft(
  pool: Pool,
  draftId: string,
  userId: string,
  guildName: string,
  guildIcon: string | null,
  privacyHashSalt: string,
): Promise<GiveawayRecord> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const privacyPreflight = await client.query(
      `SELECT creator_user_id, payload FROM giveaway_drafts
       WHERE id = $1 AND state = 'pending' AND expires_at > now()`,
      [draftId],
    );
    if (!privacyPreflight.rows[0]) throw new Error("This draft has expired.");
    if (privacyPreflight.rows[0].creator_user_id !== userId) {
      throw new Error("Only the draft creator can continue.");
    }
    const preflightPayload = privacyPreflight.rows[0].payload as DraftPayload;
    if (typeof preflightPayload?.hostUserId !== "string") {
      throw new Error("The draft changed while its privacy state was being checked.");
    }
    await authorizePrivacyIdentityWrites(
      client,
      [
        {
          userId,
          allowCompletedReconsent: true,
          label: "actor",
        },
        {
          userId: preflightPayload.hostUserId,
          allowCompletedReconsent: false,
          label: "host",
        },
      ],
      privacyHashSalt,
    );
    const draftResult = await client.query(
      `SELECT * FROM giveaway_drafts WHERE id = $1 FOR UPDATE`,
      [draftId],
    );
    if (!draftResult.rows[0]) throw new Error("Draft not found.");
    const draft = mapDraft(draftResult.rows[0]);
    if (draft.creatorUserId !== userId) throw new Error("Only the draft creator can continue.");
    if (draft.state !== "pending" || draft.expiresAt <= new Date()) {
      throw new Error("This draft has expired.");
    }
    if (!draftIsReady(draft.payload)) throw new Error("Requirement choices are incomplete.");

    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `giveaway-cap:${draft.guildId}`,
    ]);
    await upsertGuild(client, draft.guildId, guildName, guildIcon);
    const countResult = await client.query(
      `SELECT count(*)::int AS count FROM giveaways
       WHERE guild_id = $1 AND status IN ('queued', 'starting', 'active', 'ending')`,
      [draft.guildId],
    );
    if (Number(countResult.rows[0]!.count) >= 1000) {
      throw new Error("This server already has 1,000 active or queued giveaways.");
    }

    const giveawayId = randomUUID();
    const payload = draft.payload;
    await client.query(
      `INSERT INTO giveaways (
        id, guild_id, channel_id, creator_user_id, host_user_id, prize,
        winner_count, duration_seconds, scheduled_start_at, status,
        required_role_mode, required_messages, message_scope
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, 'queued', $10, $11, $12
      )`,
      [
        giveawayId,
        draft.guildId,
        payload.channelId,
        userId,
        payload.hostUserId,
        payload.prize,
        payload.winnerCount,
        payload.durationSeconds,
        payload.scheduledStartAt,
        payload.requiredRoleMode,
        payload.requiredMessages,
        payload.messageScope,
      ],
    );
    for (const roleId of payload.requiredRoleIds) {
      await client.query(
        "INSERT INTO giveaway_required_roles (giveaway_id, role_id) VALUES ($1, $2)",
        [giveawayId, roleId],
      );
    }
    for (const roleId of payload.prizeRoleIds) {
      await client.query(
        "INSERT INTO giveaway_prize_roles (giveaway_id, role_id) VALUES ($1, $2)",
        [giveawayId, roleId],
      );
    }
    for (const bonus of payload.bonusRoles) {
      await client.query(
        `INSERT INTO giveaway_bonus_roles (giveaway_id, role_id, bonus_entries)
         VALUES ($1, $2, $3)`,
        [giveawayId, bonus.roleId, bonus.bonusEntries],
      );
    }

    await client.query(
      `INSERT INTO jobs (id, type, giveaway_id, run_at, idempotency_key)
       VALUES ($1, 'start_giveaway', $2, $3, $4)`,
      [randomUUID(), giveawayId, payload.scheduledStartAt, `start:${giveawayId}`],
    );
    await client.query(
      `INSERT INTO audit_events
       (id, guild_id, giveaway_id, actor_user_id, action, source, metadata)
       VALUES ($1, $2, $3, $4, 'created', 'discord', '{}'::jsonb)`,
      [randomUUID(), draft.guildId, giveawayId, userId],
    );
    await client.query(
      `UPDATE giveaway_drafts SET state = 'consumed', consumed_at = now() WHERE id = $1`,
      [draftId],
    );
    await client.query("COMMIT");
    const giveaway = await getGiveaway(pool, giveawayId);
    if (!giveaway) throw new Error("Giveaway was created but could not be loaded.");
    return giveaway;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getGiveaway(
  db: Queryable,
  identifier: string,
  guildId?: string,
): Promise<GiveawayRecord | null> {
  const parsed = parseGiveawayIdentifier(identifier);
  if (!parsed) return null;
  const params: unknown[] = [parsed.value];
  let where = parsed.kind === "uuid" ? "g.id = $1::uuid" : "g.message_id = $1";
  if (guildId) {
    params.push(guildId);
    where += " AND g.guild_id = $2";
  }
  const result = await db.query(`${GIVEAWAY_SELECT} WHERE ${where} LIMIT 1`, params);
  return result.rows[0] ? mapGiveaway(result.rows[0]) : null;
}

export async function listGiveaways(
  db: Queryable,
  guildId: string,
  statuses: GiveawayStatus[],
  creatorUserId?: string,
  limit = 20,
  offset = 0,
): Promise<GiveawayRecord[]> {
  const params: unknown[] = [guildId, statuses, limit, offset];
  let creatorFilter = "";
  if (creatorUserId) {
    params.push(creatorUserId);
    creatorFilter = " AND g.creator_user_id = $5";
  }
  const result = await db.query(
    `${GIVEAWAY_SELECT}
     WHERE g.guild_id = $1 AND g.status = ANY($2::text[])${creatorFilter}
     ORDER BY g.scheduled_start_at ASC
     LIMIT $3 OFFSET $4`,
    params,
  );
  return result.rows.map(mapGiveaway);
}

async function queueGiveawayRefresh(
  client: PoolClient,
  giveawayId: string,
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
    [`giveaway-refresh:${giveawayId}`],
  );
  const queued = await client.query(
    `SELECT id FROM jobs
     WHERE giveaway_id = $1
       AND type = 'refresh_giveaway'
       AND completed_at IS NULL
       AND locked_at IS NULL
     ORDER BY run_at DESC
     LIMIT 1
     FOR UPDATE`,
    [giveawayId],
  );
  if (queued.rows[0]) {
    await client.query(
      `UPDATE jobs
       SET run_at = LEAST(run_at, now() + interval '2 seconds'),
           attempts = 0,
           last_error = NULL
       WHERE id = $1`,
      [queued.rows[0].id],
    );
    return;
  }
  await client.query(
    `INSERT INTO jobs (id, type, giveaway_id, run_at)
     VALUES ($1, 'refresh_giveaway', $2, now() + interval '2 seconds')`,
    [randomUUID(), giveawayId],
  );
}

export async function joinGiveaway(
  pool: Pool,
  giveawayId: string,
  user: { id: string; username: string; globalName: string | null; avatar: string | null },
  privacyHashSalt: string,
): Promise<{ joined: boolean; participantCount: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
      [`privacy-delete:${user.id}`],
    );
    const pendingDeletion = await client.query(
      `SELECT 1 FROM data_deletion_requests
       WHERE user_id = $1 AND status <> 'complete'
       LIMIT 1`,
      [user.id],
    );
    if (pendingDeletion.rows[0]) {
      throw new Error("Your data deletion request must finish before you can enter giveaways.");
    }
    const userIdHash = privacyFenceHash(privacyHashSalt, user.id);
    const fenceResult = await client.query(
      `SELECT completed_at, cleared_at FROM privacy_deletion_fences
       WHERE user_id_hash = $1
       FOR UPDATE`,
      [userIdHash],
    );
    const fence = fenceResult.rows[0];
    if (fence && fence.cleared_at === null) {
      if (fence.completed_at === null) {
        throw new Error("Your data deletion request must finish before you can enter giveaways.");
      }
      const cleared = await client.query(
        `UPDATE privacy_deletion_fences
         SET cleared_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE user_id_hash = $1
           AND completed_at IS NOT NULL
           AND cleared_at IS NULL`,
        [userIdHash],
      );
      if (cleared.rowCount !== 1) {
        throw new Error("Your privacy consent could not be updated. Please try again.");
      }
    }
    const giveawayResult = await client.query(
      `SELECT guild_id, status, ends_at,
              status = 'active'
                AND ends_at IS NOT NULL
                AND ends_at > clock_timestamp() AS entry_open
       FROM giveaways WHERE id = $1 FOR UPDATE`,
      [giveawayId],
    );
    const giveaway = giveawayResult.rows[0];
    if (!giveaway?.entry_open) {
      throw new Error("This giveaway is not active.");
    }
    const existing = await client.query(
      "SELECT left_at FROM entries WHERE giveaway_id = $1 AND user_id = $2",
      [giveawayId, user.id],
    );
    if (existing.rows[0] && existing.rows[0].left_at === null) {
      const count = await client.query(
        "SELECT participant_count FROM giveaways WHERE id = $1",
        [giveawayId],
      );
      await client.query("COMMIT");
      return { joined: false, participantCount: Number(count.rows[0]!.participant_count) };
    }
    const eventType = existing.rows[0] ? "rejoin" : "join";
    await client.query(
      `INSERT INTO entries
       (giveaway_id, user_id, username, global_name, avatar_hash, joined_at, left_at)
       VALUES ($1, $2, $3, $4, $5, now(), NULL)
       ON CONFLICT (giveaway_id, user_id) DO UPDATE
       SET username = EXCLUDED.username,
           global_name = EXCLUDED.global_name,
           avatar_hash = EXCLUDED.avatar_hash,
           joined_at = now(),
           left_at = NULL,
           eligible_at_draw = NULL,
           draw_weight = NULL,
           ineligible_reason = NULL`,
      [giveawayId, user.id, user.username, user.globalName, user.avatar],
    );
    const count = await client.query(
      `UPDATE giveaways
       SET participant_count = participant_count + 1, updated_at = now()
       WHERE id = $1 RETURNING participant_count`,
      [giveawayId],
    );
    await client.query(
      `INSERT INTO entry_events
       (id, giveaway_id, user_id, event_type, username)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), giveawayId, user.id, eventType, user.username],
    );
    await client.query(
      `INSERT INTO audit_events
       (id, guild_id, giveaway_id, actor_user_id, action, source)
       VALUES ($1, $2, $3, $4, 'joined', 'discord')`,
      [randomUUID(), giveaway.guild_id, giveawayId, user.id],
    );
    await queueGiveawayRefresh(client, giveawayId);
    await client.query("COMMIT");
    return { joined: true, participantCount: Number(count.rows[0]!.participant_count) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function leaveGiveaway(
  pool: Pool,
  giveawayId: string,
  userId: string,
  privacyHashSalt: string,
): Promise<{ left: boolean; participantCount: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
      [`privacy-delete:${userId}`],
    );
    const pendingDeletion = await client.query(
      `SELECT 1 FROM data_deletion_requests
       WHERE user_id = $1 AND status <> 'complete'
       LIMIT 1`,
      [userId],
    );
    if (pendingDeletion.rows[0]) {
      throw new Error("Your data deletion request must finish before entries can change.");
    }
    const fenceResult = await client.query(
      `SELECT 1 FROM privacy_deletion_fences
       WHERE user_id_hash = $1 AND cleared_at IS NULL
       LIMIT 1`,
      [privacyFenceHash(privacyHashSalt, userId)],
    );
    if (fenceResult.rows[0]) {
      throw new Error(
        "Your privacy deletion fence is active. Join a giveaway to explicitly re-enable participation.",
      );
    }
    const giveawayResult = await client.query(
      `SELECT guild_id, status,
              status = 'active'
                AND ends_at IS NOT NULL
                AND ends_at > clock_timestamp() AS entry_open
       FROM giveaways WHERE id = $1 FOR UPDATE`,
      [giveawayId],
    );
    const giveaway = giveawayResult.rows[0];
    if (!giveaway?.entry_open) throw new Error("This giveaway is not active.");
    const entry = await client.query(
      `UPDATE entries SET left_at = now()
       WHERE giveaway_id = $1 AND user_id = $2 AND left_at IS NULL
       RETURNING username`,
      [giveawayId, userId],
    );
    if (!entry.rows[0]) {
      const count = await client.query(
        "SELECT participant_count FROM giveaways WHERE id = $1",
        [giveawayId],
      );
      await client.query("COMMIT");
      return { left: false, participantCount: Number(count.rows[0]!.participant_count) };
    }
    const count = await client.query(
      `UPDATE giveaways SET participant_count = GREATEST(participant_count - 1, 0),
         updated_at = now() WHERE id = $1 RETURNING participant_count`,
      [giveawayId],
    );
    await client.query(
      `INSERT INTO entry_events
       (id, giveaway_id, user_id, event_type, username)
       VALUES ($1, $2, $3, 'leave', $4)`,
      [randomUUID(), giveawayId, userId, entry.rows[0].username],
    );
    await client.query(
      `INSERT INTO audit_events
       (id, guild_id, giveaway_id, actor_user_id, action, source)
       VALUES ($1, $2, $3, $4, 'left', 'discord')`,
      [randomUUID(), giveaway.guild_id, giveawayId, userId],
    );
    await queueGiveawayRefresh(client, giveawayId);
    await client.query("COMMIT");
    return { left: true, participantCount: Number(count.rows[0]!.participant_count) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function enqueueAction(
  db: Pool,
  type: "start_giveaway" | "end_giveaway" | "reroll_giveaway" | "delete_giveaway",
  giveaway: GiveawayRecord,
  actorUserId: string,
  source: "discord" | "web",
  privacyHashSalt: string,
  winnerCount?: number,
): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await authorizePrivacyIdentityWrites(
      client,
      [{ userId: actorUserId, allowCompletedReconsent: true, label: "actor" }],
      privacyHashSalt,
    );
    if (type === "reroll_giveaway") {
      if (!winnerCount) throw new Error("A winner count is required for rerolls.");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
        [giveaway.id],
      );
    }
    const current = await client.query(
      "SELECT status FROM giveaways WHERE id = $1 FOR UPDATE",
      [giveaway.id],
    );
    if (!current.rows[0]) throw new Error("Giveaway not found.");
    const action = parseManagementAction(type.replace(/_giveaway$/, ""));
    assertActionAllowed(action, current.rows[0].status as GiveawayStatus);
    const payload = {
      actorUserId,
      source,
      ...(winnerCount === undefined ? {} : { winnerCount }),
    };
    const duplicate = await client.query(
      `SELECT id, run_at <= clock_timestamp() AS immediate FROM jobs
       WHERE giveaway_id = $1
         AND type = $2
         AND completed_at IS NULL
       ORDER BY run_at ASC
       LIMIT 1
       FOR UPDATE`,
      [giveaway.id, type],
    );
    let insertJob = true;
    const existingJob = duplicate.rows[0];
    if (existingJob) {
      if (type === "reroll_giveaway") {
        throw new Error("Another reroll is already queued or drawing.");
      }
      const scheduledLifecycleJob =
        (type === "start_giveaway" || type === "end_giveaway") &&
        !existingJob.immediate;
      if (!scheduledLifecycleJob) {
        await client.query("COMMIT");
        return;
      }
      await client.query(
        `UPDATE jobs
         SET run_at = LEAST(run_at, now()),
             payload = payload || $2::jsonb,
             attempts = 0,
             last_error = NULL
         WHERE id = $1`,
        [existingJob.id, JSON.stringify(payload)],
      );
      insertJob = false;
    }
    if (type === "reroll_giveaway") {
      const pending = await client.query(
        `SELECT EXISTS (
           SELECT 1 FROM draws
           WHERE giveaway_id = $1 AND status IN ('awaiting_beacon', 'drawing')
         ) OR EXISTS (
           SELECT 1 FROM jobs
           WHERE giveaway_id = $1 AND type = 'reroll_giveaway'
             AND completed_at IS NULL
         ) AS busy`,
        [giveaway.id],
      );
      if (pending.rows[0]?.busy) {
        throw new Error("Another reroll is already queued or drawing.");
      }
    }
    if (insertJob) {
      await client.query(
        `INSERT INTO jobs (id, type, giveaway_id, payload, run_at)
         VALUES ($1, $2, $3, $4::jsonb, now())`,
        [randomUUID(), type, giveaway.id, JSON.stringify(payload)],
      );
    }
    await client.query(
      `INSERT INTO audit_events
       (id, guild_id, giveaway_id, actor_user_id, action, source, metadata)
       VALUES ($1, $2, $3, $4, 'action_queued', $5, $6::jsonb)`,
      [
        randomUUID(),
        giveaway.guildId,
        giveaway.id,
        actorUserId,
        source,
        JSON.stringify({
          requestedAction: type.replace(/_giveaway$/, ""),
          ...(winnerCount === undefined ? {} : { winnerCount }),
        }),
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
