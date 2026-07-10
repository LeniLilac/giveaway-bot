import pg from "pg";
import { v7 as uuidv7 } from "uuid";
import type { BonusRole, CommandName, EntryRecord, GiveawayDraftPayload, GiveawayRecord } from "@lilac/core";

const { Pool } = pg;
let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  pool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.DB_POOL_MAX ?? 20),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000
  });
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) await pool.end();
  pool = undefined;
}

export async function withTransaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function newId(): string { return uuidv7(); }

function mapGiveaway(row: Record<string, unknown>, requiredRoleIds: string[], prizeRoleIds: string[], bonusRoles: BonusRole[]): GiveawayRecord {
  return {
    id: String(row.id),
    guildId: String(row.guild_id),
    channelId: String(row.channel_id),
    messageId: row.message_id ? String(row.message_id) : null,
    creatorId: String(row.creator_id ?? ""),
    hostId: String(row.host_id ?? ""),
    prize: String(row.prize),
    status: row.status as GiveawayRecord["status"],
    winnerCount: String(row.winner_count),
    scheduledStartAt: new Date(String(row.scheduled_start_at)).toISOString(),
    ...(row.duration_seconds !== null ? { durationSeconds: String(row.duration_seconds) } : {}),
    ...(row.absolute_end_at ? { absoluteEndAt: new Date(String(row.absolute_end_at)).toISOString() } : {}),
    ...(row.required_message_count !== null ? { requiredMessageCount: String(row.required_message_count) } : {}),
    ...(row.message_window ? { messageWindow: row.message_window as GiveawayRecord["messageWindow"] } : {}),
    ...(row.required_role_mode ? { requiredRoleMode: row.required_role_mode as GiveawayRecord["requiredRoleMode"] } : {}),
    requiredRoleIds,
    prizeRoleIds,
    bonusRoles,
    startedAt: row.started_at ? new Date(String(row.started_at)).toISOString() : null,
    endsAt: row.ends_at ? new Date(String(row.ends_at)).toISOString() : null,
    closedAt: row.closed_at ? new Date(String(row.closed_at)).toISOString() : null,
    endedAt: row.ended_at ? new Date(String(row.ended_at)).toISOString() : null,
    deletedAt: row.deleted_at ? new Date(String(row.deleted_at)).toISOString() : null,
    createdAt: new Date(String(row.created_at)).toISOString()
  };
}

export async function hydrateGiveaway(idOrMessageId: string, client: pg.Pool | pg.PoolClient = getPool()): Promise<GiveawayRecord | null> {
  const result = await client.query("SELECT * FROM giveaways WHERE id::text = $1 OR message_id = $1 LIMIT 1", [idOrMessageId]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const [required, prizes, bonuses] = await Promise.all([
    client.query("SELECT role_id FROM giveaway_required_roles WHERE giveaway_id = $1 ORDER BY role_id::numeric", [row.id]),
    client.query("SELECT role_id FROM giveaway_prize_roles WHERE giveaway_id = $1 ORDER BY role_id::numeric", [row.id]),
    client.query("SELECT role_id, bonus FROM giveaway_bonus_roles WHERE giveaway_id = $1 ORDER BY role_id::numeric", [row.id])
  ]);
  return mapGiveaway(
    row,
    required.rows.map((item) => String(item.role_id)),
    prizes.rows.map((item) => String(item.role_id)),
    bonuses.rows.map((item) => ({ roleId: String(item.role_id), bonus: String(item.bonus) }))
  );
}

export async function createDraft(payload: GiveawayDraftPayload): Promise<string> {
  const id = newId();
  await getPool().query(
    "INSERT INTO giveaway_drafts (id, guild_id, creator_id, payload, expires_at) VALUES ($1, $2, $3, $4, now() + interval '15 minutes')",
    [id, payload.guildId, payload.creatorId, payload]
  );
  return id;
}

export async function getDraft(id: string): Promise<{ id: string; guildId: string; creatorId: string; payload: GiveawayDraftPayload; expiresAt: string } | null> {
  const { rows } = await getPool().query("SELECT * FROM giveaway_drafts WHERE id = $1 AND expires_at > now()", [id]);
  const row = rows[0];
  return row ? {
    id: String(row.id),
    guildId: String(row.guild_id),
    creatorId: String(row.creator_id),
    payload: row.payload as GiveawayDraftPayload,
    expiresAt: new Date(row.expires_at).toISOString()
  } : null;
}

export async function updateDraft(id: string, payload: GiveawayDraftPayload): Promise<void> {
  await getPool().query("UPDATE giveaway_drafts SET payload = $2 WHERE id = $1 AND expires_at > now()", [id, payload]);
}

export async function consumeDraft(id: string): Promise<GiveawayRecord> {
  const giveawayId = newId();
  await withTransaction(async (client) => {
    const draftResult = await client.query("SELECT * FROM giveaway_drafts WHERE id = $1 AND expires_at > now() FOR UPDATE", [id]);
    const draft = draftResult.rows[0];
    if (!draft) throw new Error("This giveaway draft expired.");
    const payload = draft.payload as GiveawayDraftPayload;
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`giveaway-cap:${payload.guildId}`]);
    const cap = await client.query("SELECT count(*)::int AS count FROM giveaways WHERE guild_id = $1 AND status IN ('queued','starting','active','closing')", [payload.guildId]);
    if (Number(cap.rows[0].count) >= 1000) throw new Error("This server already has 1000 queued or active giveaways.");
    if (payload.requiredRoleIds.length && !payload.requiredRoleMode) throw new Error("Choose whether all or one required role is needed.");
    if (payload.requiredMessageCount && !payload.messageWindow) throw new Error("Choose the required-message time window.");
    await client.query(
      `INSERT INTO giveaways (
        id, guild_id, channel_id, creator_id, host_id, prize, status, winner_count,
        scheduled_start_at, duration_seconds, absolute_end_at, required_message_count,
        message_window, required_role_mode
      ) VALUES ($1,$2,$3,$4,$5,$6,'queued',$7,$8,$9,$10,$11,$12,$13)`,
      [
        giveawayId, payload.guildId, payload.channelId, payload.creatorId, payload.hostId,
        payload.prize, payload.winnerCount, payload.scheduledStartAt,
        payload.durationSeconds ?? null, payload.absoluteEndAt ?? null,
        payload.requiredMessageCount ?? null, payload.messageWindow ?? null,
        payload.requiredRoleMode ?? null
      ]
    );
    for (const roleId of payload.requiredRoleIds) await client.query("INSERT INTO giveaway_required_roles (giveaway_id, role_id) VALUES ($1,$2)", [giveawayId, roleId]);
    for (const roleId of payload.prizeRoleIds) await client.query("INSERT INTO giveaway_prize_roles (giveaway_id, role_id) VALUES ($1,$2)", [giveawayId, roleId]);
    for (const role of payload.bonusRoles) await client.query("INSERT INTO giveaway_bonus_roles (giveaway_id, role_id, bonus) VALUES ($1,$2,$3)", [giveawayId, role.roleId, role.bonus]);
    await client.query(
      "INSERT INTO audit_events (guild_id, giveaway_id, actor_id, event_type, metadata) VALUES ($1,$2,$3,'created',$4)",
      [payload.guildId, giveawayId, payload.creatorId, { scheduledStartAt: payload.scheduledStartAt }]
    );
    await client.query(
      "INSERT INTO jobs (id, kind, payload, run_at, idempotency_key) VALUES ($1,'start_giveaway',$2,$3,$4) ON CONFLICT (idempotency_key) DO NOTHING",
      [newId(), { giveawayId }, payload.scheduledStartAt, `start:${giveawayId}`]
    );
    await client.query("DELETE FROM giveaway_drafts WHERE id = $1", [id]);
  });
  const giveaway = await hydrateGiveaway(giveawayId);
  if (!giveaway) throw new Error("Created giveaway could not be loaded.");
  return giveaway;
}

export async function listGuildGiveaways(args: {
  guildId: string;
  statuses: GiveawayRecord["status"][];
  limit?: number;
  offset?: number;
  creatorId?: string;
}): Promise<GiveawayRecord[]> {
  const values: unknown[] = [args.guildId, args.statuses, args.limit ?? 25, args.offset ?? 0];
  const creatorClause = args.creatorId ? "AND creator_id = $5" : "";
  if (args.creatorId) values.push(args.creatorId);
  const { rows } = await getPool().query(
    `SELECT id FROM giveaways WHERE guild_id = $1 AND status = ANY($2::text[]) ${creatorClause}
     ORDER BY COALESCE(started_at, scheduled_start_at), id LIMIT $3 OFFSET $4`,
    values
  );
  return (await Promise.all(rows.map((row) => hydrateGiveaway(String(row.id))))).filter((item): item is GiveawayRecord => Boolean(item));
}

export async function getCommandRoles(guildId: string, command: CommandName): Promise<string[]> {
  const { rows } = await getPool().query("SELECT role_id FROM guild_command_roles WHERE guild_id = $1 AND command_name = $2 ORDER BY role_id::numeric", [guildId, command]);
  return rows.map((row) => String(row.role_id));
}

export async function hasConsent(userId: string, policyVersion: string): Promise<boolean> {
  const { rowCount } = await getPool().query("SELECT 1 FROM privacy_consents WHERE user_id = $1 AND policy_version = $2", [userId, policyVersion]);
  return Boolean(rowCount);
}

export async function recordConsent(userId: string, policyVersion: string): Promise<void> {
  await getPool().query("INSERT INTO privacy_consents (user_id, policy_version) VALUES ($1,$2) ON CONFLICT DO NOTHING", [userId, policyVersion]);
}

export async function joinGiveaway(args: {
  giveaway: GiveawayRecord;
  userId: string;
  username: string;
  avatarUrl: string | null;
  messageCount: bigint | null;
  roleIds: string[];
  consentVersion: string;
}): Promise<{ joined: boolean; participants: number }> {
  return withTransaction(async (client) => {
    const locked = await client.query("SELECT status, ends_at FROM giveaways WHERE id = $1 FOR UPDATE", [args.giveaway.id]);
    const current = locked.rows[0];
    if (!current || current.status !== "active" || !current.ends_at || new Date(current.ends_at).getTime() <= Date.now()) throw new Error("This giveaway is no longer accepting entries.");
    const existing = await client.query("SELECT active FROM entries WHERE giveaway_id = $1 AND user_id = $2", [args.giveaway.id, args.userId]);
    if (existing.rows[0]?.active) {
      const count = await client.query("SELECT count(*)::int AS count FROM entries WHERE giveaway_id = $1 AND active", [args.giveaway.id]);
      return { joined: false, participants: Number(count.rows[0].count) };
    }
    await client.query(
      `INSERT INTO entries (
        giveaway_id,user_id,username,avatar_url,joined_at,left_at,active,message_count_at_join,
        role_ids,role_verified_at,consent_version
      ) VALUES ($1,$2,$3,$4,now(),NULL,true,$5,$6,now(),$7)
      ON CONFLICT (giveaway_id,user_id) DO UPDATE SET
        username=EXCLUDED.username,avatar_url=EXCLUDED.avatar_url,joined_at=now(),left_at=NULL,
        active=true,message_count_at_join=EXCLUDED.message_count_at_join,role_ids=EXCLUDED.role_ids,
        role_verified_at=now(),consent_version=EXCLUDED.consent_version`,
      [args.giveaway.id, args.userId, args.username, args.avatarUrl, args.messageCount?.toString() ?? null, args.roleIds, args.consentVersion]
    );
    await client.query(
      "INSERT INTO entry_events (giveaway_id,user_id,event_type,username,avatar_url,metadata) VALUES ($1,$2,'joined',$3,$4,$5)",
      [args.giveaway.id, args.userId, args.username, args.avatarUrl, { messageCount: args.messageCount?.toString() ?? null }]
    );
    await client.query("INSERT INTO audit_events (guild_id,giveaway_id,actor_id,event_type,metadata) VALUES ($1,$2,$3,'joined','{}')", [args.giveaway.guildId, args.giveaway.id, args.userId]);
    await enqueueJob("refresh_giveaway_message", { giveawayId: args.giveaway.id }, new Date(), null, client);
    const count = await client.query("SELECT count(*)::int AS count FROM entries WHERE giveaway_id = $1 AND active", [args.giveaway.id]);
    return { joined: true, participants: Number(count.rows[0].count) };
  });
}

export async function leaveGiveaway(giveaway: GiveawayRecord, userId: string): Promise<{ left: boolean; participants: number }> {
  return withTransaction(async (client) => {
    const locked = await client.query("SELECT status, ends_at FROM giveaways WHERE id = $1 FOR UPDATE", [giveaway.id]);
    const current = locked.rows[0];
    if (!current || current.status !== "active" || new Date(current.ends_at).getTime() <= Date.now()) throw new Error("This giveaway is no longer accepting changes.");
    const result = await client.query("UPDATE entries SET active=false,left_at=now() WHERE giveaway_id=$1 AND user_id=$2 AND active", [giveaway.id, userId]);
    if (result.rowCount) {
      await client.query("INSERT INTO entry_events (giveaway_id,user_id,event_type) VALUES ($1,$2,'left')", [giveaway.id, userId]);
      await client.query("INSERT INTO audit_events (guild_id,giveaway_id,actor_id,event_type,metadata) VALUES ($1,$2,$3,'left','{}')", [giveaway.guildId, giveaway.id, userId]);
      await enqueueJob("refresh_giveaway_message", { giveawayId: giveaway.id }, new Date(), null, client);
    }
    const count = await client.query("SELECT count(*)::int AS count FROM entries WHERE giveaway_id = $1 AND active", [giveaway.id]);
    return { left: Boolean(result.rowCount), participants: Number(count.rows[0].count) };
  });
}

export interface JobRecord {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

export async function enqueueJob(
  kind: string,
  payload: Record<string, unknown>,
  runAt = new Date(),
  idempotencyKey: string | null = null,
  client: pg.Pool | pg.PoolClient = getPool()
): Promise<void> {
  await client.query(
    `INSERT INTO jobs (id,kind,payload,run_at,idempotency_key)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
     DO UPDATE SET run_at = LEAST(jobs.run_at, EXCLUDED.run_at), status = CASE WHEN jobs.status='complete' THEN jobs.status ELSE 'queued' END`,
    [newId(), kind, payload, runAt, idempotencyKey]
  );
}

export async function claimJobs(workerId: string, limit = 10): Promise<JobRecord[]> {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `WITH selected AS (
        SELECT id FROM jobs WHERE status='queued' AND run_at <= now()
        ORDER BY run_at,id FOR UPDATE SKIP LOCKED LIMIT $2
      )
      UPDATE jobs SET status='running',locked_at=now(),locked_by=$1,attempts=attempts+1
      WHERE id IN (SELECT id FROM selected)
      RETURNING id,kind,payload,attempts,max_attempts`,
      [workerId, limit]
    );
    return rows.map((row) => ({
      id: String(row.id),
      kind: String(row.kind),
      payload: row.payload as Record<string, unknown>,
      attempts: Number(row.attempts),
      maxAttempts: Number(row.max_attempts)
    }));
  });
}

export async function completeJob(id: string): Promise<void> {
  await getPool().query("UPDATE jobs SET status='complete',completed_at=now(),locked_at=NULL,locked_by=NULL WHERE id=$1", [id]);
}

export async function failJob(job: JobRecord, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  const exhausted = job.attempts >= job.maxAttempts;
  const delaySeconds = Math.min(900, 2 ** Math.min(job.attempts, 9));
  await getPool().query(
    `UPDATE jobs SET status=$2,last_error=$3,run_at=now()+($4::text||' seconds')::interval,
      locked_at=NULL,locked_by=NULL,failed_at=CASE WHEN $2='failed' THEN now() ELSE NULL END
      WHERE id=$1`,
    [job.id, exhausted ? "failed" : "queued", message.slice(0, 10_000), delaySeconds]
  );
}

export async function listActiveEntries(giveawayId: string): Promise<EntryRecord[]> {
  const { rows } = await getPool().query("SELECT * FROM entries WHERE giveaway_id=$1 AND active ORDER BY user_id::numeric", [giveawayId]);
  return rows.map((row) => ({
    giveawayId: String(row.giveaway_id),
    userId: String(row.user_id),
    username: row.username ? String(row.username) : null,
    avatarUrl: row.avatar_url ? String(row.avatar_url) : null,
    joinedAt: new Date(row.joined_at).toISOString(),
    leftAt: row.left_at ? new Date(row.left_at).toISOString() : null,
    active: Boolean(row.active),
    messageCountAtJoin: row.message_count_at_join !== null ? String(row.message_count_at_join) : null,
    roleIds: Array.isArray(row.role_ids) ? row.role_ids.map(String) : [],
    roleVerifiedAt: new Date(row.role_verified_at).toISOString()
  }));
}
