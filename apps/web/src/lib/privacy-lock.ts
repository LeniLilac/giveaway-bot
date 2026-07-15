import { privacyFenceHash } from "@lilac/core";
import type { Pool, PoolClient } from "pg";

type Queryable = Pick<Pool | PoolClient, "query">;

function userIdHash(userId: string): string {
  const secret = process.env.PRIVACY_HASH_SALT;
  if (!secret) throw new Error("PRIVACY_HASH_SALT is required at runtime.");
  return privacyFenceHash(secret, userId);
}

export async function databaseClockMillis(client: Queryable): Promise<number> {
  const result = await client.query(
    `SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms`,
  );
  const value = Number(result.rows[0]?.now_ms);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("The database returned an invalid clock value.");
  }
  return value;
}

export async function lockPrivacyIdentity(
  client: PoolClient,
  userId: string,
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
    [`privacy-delete:${userId}`],
  );
}

export async function lockPrivacyAffectedGiveaways(
  client: PoolClient,
  userId: string,
): Promise<void> {
  await client.query(
    `SELECT giveaway.id FROM giveaways giveaway
     WHERE EXISTS (
       SELECT 1 FROM entries entry
       WHERE entry.giveaway_id = giveaway.id AND entry.user_id = $1
     )
     ORDER BY giveaway.id
     FOR UPDATE`,
    [userId],
  );
}

export async function hasActivePrivacyDeletion(
  client: PoolClient,
  userId: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM privacy_deletion_fences
       WHERE user_id_hash = $1 AND cleared_at IS NULL
     ) OR EXISTS (
       SELECT 1 FROM data_deletion_requests
       WHERE user_id = $2 AND status IN ('queued', 'processing')
     ) AS active`,
    [userIdHash(userId), userId],
  );
  return Boolean(result.rows[0]?.active);
}

export function completedFenceAllowsFreshConsent(
  completedAt: Date | null,
  oauthIssuedAt: number,
): boolean {
  return completedAt !== null && oauthIssuedAt > completedAt.getTime();
}

export async function authorizeOAuthIdentityAfterLock(
  client: PoolClient,
  userId: string,
  oauthIssuedAt: number,
): Promise<boolean> {
  const activeRequest = await client.query(
    `SELECT 1 FROM data_deletion_requests
     WHERE user_id = $1 AND status IN ('queued', 'processing')
     LIMIT 1`,
    [userId],
  );
  if (activeRequest.rows[0]) return false;

  const hash = userIdHash(userId);
  const fenceResult = await client.query(
    `SELECT completed_at, cleared_at FROM privacy_deletion_fences
     WHERE user_id_hash = $1 FOR UPDATE`,
    [hash],
  );
  const fence = fenceResult.rows[0];
  if (!fence || fence.cleared_at) return true;
  const completedAt = fence.completed_at ? new Date(fence.completed_at as string) : null;
  if (!completedFenceAllowsFreshConsent(completedAt, oauthIssuedAt)) return false;

  const cleared = await client.query(
    `UPDATE privacy_deletion_fences
     SET cleared_at = now(), updated_at = now()
     WHERE user_id_hash = $1 AND cleared_at IS NULL AND completed_at = $2`,
    [hash, completedAt],
  );
  return cleared.rowCount === 1;
}

export async function assertPrivacyIdentityWritable(
  client: PoolClient,
  userId: string,
): Promise<void> {
  await lockPrivacyIdentity(client, userId);
  if (await hasActivePrivacyDeletion(client, userId)) {
    throw new Error("Your data deletion is active; this action cannot be queued.");
  }
}

export async function upsertPrivacyDeletionFence(
  client: PoolClient,
  userId: string,
  requestId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO privacy_deletion_fences
       (user_id_hash, request_id, requested_at, completed_at, cleared_at, updated_at)
     VALUES ($1, $2, now(), NULL, NULL, now())
     ON CONFLICT (user_id_hash) DO UPDATE
     SET request_id = EXCLUDED.request_id,
         requested_at = CASE
           WHEN privacy_deletion_fences.request_id = EXCLUDED.request_id
             THEN privacy_deletion_fences.requested_at
           ELSE now()
         END,
         completed_at = NULL, cleared_at = NULL, updated_at = now()`,
    [userIdHash(userId), requestId],
  );
}
