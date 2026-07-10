import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";

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
): Promise<DraftRecord> {
  const id = randomUUID();
  const result = await pool.query(
    `INSERT INTO giveaway_drafts
       (id, guild_id, creator_user_id, channel_id, payload, expires_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, now() + interval '15 minutes')
     RETURNING *`,
    [id, guildId, creatorUserId, payload.channelId, JSON.stringify(payload)],
  );
  return mapDraft(result.rows[0]!);
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
): Promise<GiveawayRecord> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
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

    await upsertGuild(client, draft.guildId, guildName, guildIcon);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [draft.guildId]);
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
  const params: unknown[] = [identifier];
  let where = "(g.id::text = $1 OR g.message_id = $1)";
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
): Promise<GiveawayRecord[]> {
  const params: unknown[] = [guildId, statuses, limit];
  let creatorFilter = "";
  if (creatorUserId) {
    params.push(creatorUserId);
    creatorFilter = " AND g.creator_user_id = $4";
  }
  const result = await db.query(
    `${GIVEAWAY_SELECT}
     WHERE g.guild_id = $1 AND g.status = ANY($2::text[])${creatorFilter}
     ORDER BY g.scheduled_start_at ASC
     LIMIT $3`,
    params,
  );
  return result.rows.map(mapGiveaway);
}

export async function hasConsent(
  db: Queryable,
  guildId: string,
  userId: string,
  policyVersion: string,
): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM privacy_consents
     WHERE guild_id = $1 AND user_id = $2 AND policy_version = $3 AND revoked_at IS NULL`,
    [guildId, userId, policyVersion],
  );
  return Boolean(result.rows[0]);
}

export async function recordConsent(
  db: Queryable,
  guildId: string,
  userId: string,
  policyVersion: string,
): Promise<void> {
  await db.query(
    `INSERT INTO privacy_consents (guild_id, user_id, policy_version)
     VALUES ($1, $2, $3)
     ON CONFLICT (guild_id, user_id, policy_version)
     DO UPDATE SET consented_at = now(), revoked_at = NULL`,
    [guildId, userId, policyVersion],
  );
}

export async function joinGiveaway(
  pool: Pool,
  giveawayId: string,
  user: { id: string; username: string; globalName: string | null; avatar: string | null },
): Promise<{ joined: boolean; participantCount: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const giveawayResult = await client.query(
      "SELECT guild_id, status FROM giveaways WHERE id = $1 FOR UPDATE",
      [giveawayId],
    );
    const giveaway = giveawayResult.rows[0];
    if (!giveaway || giveaway.status !== "active") throw new Error("This giveaway is not active.");
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
): Promise<{ left: boolean; participantCount: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const giveawayResult = await client.query(
      "SELECT guild_id, status FROM giveaways WHERE id = $1 FOR UPDATE",
      [giveawayId],
    );
    const giveaway = giveawayResult.rows[0];
    if (!giveaway || giveaway.status !== "active") throw new Error("This giveaway is not active.");
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
  db: Queryable,
  type: "start_giveaway" | "end_giveaway" | "reroll_giveaway" | "delete_giveaway",
  giveaway: GiveawayRecord,
  actorUserId: string,
  source: "discord" | "web",
): Promise<void> {
  await db.query(
    `INSERT INTO jobs (id, type, giveaway_id, payload, run_at)
     VALUES ($1, $2, $3, $4::jsonb, now())`,
    [randomUUID(), type, giveaway.id, JSON.stringify({ actorUserId, source })],
  );
}
