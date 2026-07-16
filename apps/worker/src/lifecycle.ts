import { createHmac, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Logger } from "pino";
import { LEGACY_PROOF_VERSION, PROOF_VERSION } from "@lilac/proof";
import { privacyFenceHash } from "@lilac/core";
import {
  createDrawCommitment,
  getActiveEntries,
  getDraw,
  getDrawCandidates,
  getDrawWinners,
  getGiveaway,
  getGiveawayForUpdate,
  ensureUnpublishedDrawRound,
  markCommitmentPublished,
  markDrawStep,
  deliveredWinnerOrdinals,
  claimDiscordDelivery,
  markDiscordDeliverySending,
  recordDiscordDelivery,
  recordDiscordDeliveryFailure,
  resetDiscordDeliveryAfterReconciliation,
  persistWinners,
  previousWinnerProofIds,
  type DrawRow,
  type Job,
  type WorkerGiveaway,
} from "./database.js";
import type { DiscordApi, DiscordMember } from "./discord.js";
import {
  fetchBeacon,
  fetchChainInfo,
  type ChainInfo,
  type DrandClientOptions,
} from "./drand.js";
import { candidateHash, selectWeightedWinners, type Candidate } from "./selection.js";
import {
  canFulfillReroll,
  countExclusionReasons,
  type RerollExclusion,
} from "./reroll-policy.js";

const MAX_REROLL_WINNERS = 2_147_483_647;

interface LifecycleDependencies {
  pool: Pool;
  discord: DiscordApi;
  logger: Logger;
  websiteUrl: string;
  drand: DrandClientOptions;
  privacyHashSalt: string;
}

async function deliverDiscordMessage(
  dependencies: LifecycleDependencies,
  input: {
    deliveryKey: string;
    kind: "giveaway_start" | "winner_message" | "reroll_rejection";
    giveawayId: string;
    channelId: string;
    drawId?: string;
    ordinal?: number;
    nonce: string;
  },
  send: () => Promise<{ id: string } | null>,
): Promise<string> {
  const claim = await claimDiscordDelivery(dependencies.pool, input);
  if (claim.state === "delivered") return claim.externalId;
  if (claim.state === "busy") {
    throw new Error("Discord delivery is currently owned by another worker.");
  }
  if (claim.sendStartedAt) {
    const reconciled = await dependencies.discord.findMessageByNonce(
      input.channelId,
      input.nonce,
      claim.sendStartedAt,
    );
    if (reconciled.status === "found") {
      await recordDiscordDelivery(
        dependencies.pool,
        input.deliveryKey,
        claim.claimToken,
        reconciled.messageId,
      );
      return reconciled.messageId;
    }
    if (reconciled.status === "unknown") {
      const uncertainty = new Error(
        "Discord delivery is uncertain and message-history reconciliation was inconclusive.",
      );
      await recordDiscordDeliveryFailure(
        dependencies.pool,
        input.deliveryKey,
        claim.claimToken,
        uncertainty,
      );
      throw uncertainty;
    }
    await resetDiscordDeliveryAfterReconciliation(
      dependencies.pool,
      input.deliveryKey,
      claim.claimToken,
    );
  }
  await markDiscordDeliverySending(
    dependencies.pool,
    input.deliveryKey,
    claim.claimToken,
  );
  try {
    const message = await send();
    if (!message) throw new Error("Discord delivery has no destination message.");
    await recordDiscordDelivery(
      dependencies.pool,
      input.deliveryKey,
      claim.claimToken,
      message.id,
    );
    return message.id;
  } catch (error) {
    await recordDiscordDeliveryFailure(
      dependencies.pool,
      input.deliveryKey,
      claim.claimToken,
      error,
    );
    throw error;
  }
}

export function proofIdForUser(
  dependencies: Pick<LifecycleDependencies, "privacyHashSalt">,
  giveawayId: string,
  userId: string,
): string {
  return createHmac("sha256", dependencies.privacyHashSalt)
    .update("lilac-proof-id/v2:")
    .update(giveawayId)
    .update(":")
    .update(userId)
    .digest("hex");
}

function sanitizedDiscordError(error: unknown, operation: string): Error {
  const name = error instanceof Error ? error.name : "DiscordError";
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? String(error.status)
      : null;
  return new Error(`${operation} failed (${name}${status ? `, HTTP ${status}` : ""}).`);
}

let chainInfoPromise: Promise<ChainInfo> | null = null;

async function chainInfo(dependencies: LifecycleDependencies): Promise<ChainInfo> {
  chainInfoPromise ??= fetchChainInfo(dependencies.drand);
  try {
    return await chainInfoPromise;
  } catch (error) {
    chainInfoPromise = null;
    throw error;
  }
}

async function mapConcurrent<T, U>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await mapper(values[index]!);
      }
    }),
  );
  return results;
}

async function withPrivacyIdentityLocks<T>(
  pool: Pool,
  userIds: string[],
  action: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  const locked = [...new Set(userIds)].sort();
  try {
    for (const userId of locked) {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
        `privacy-delete:${userId}`,
      ]);
    }
    return await action(client);
  } finally {
    for (const userId of [...locked].reverse()) {
      await client
        .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
          `privacy-delete:${userId}`,
        ])
        .catch(() => undefined);
    }
    client.release();
  }
}

async function activePrivacyUserIds(
  dependencies: LifecycleDependencies,
  client: PoolClient,
  userIds: string[],
): Promise<Set<string>> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return new Set();
  const hashes = unique.map((userId) =>
    privacyFenceHash(dependencies.privacyHashSalt, userId),
  );
  const result = await client.query(
    `WITH expected(user_id, user_id_hash) AS (
       SELECT * FROM unnest($1::text[], $2::text[])
     )
     SELECT expected.user_id FROM expected
     WHERE EXISTS (
       SELECT 1 FROM data_deletion_requests deletion
       WHERE deletion.user_id = expected.user_id
         AND deletion.status <> 'complete'
     ) OR EXISTS (
       SELECT 1 FROM privacy_deletion_fences fence
       WHERE fence.user_id_hash = expected.user_id_hash
         AND fence.cleared_at IS NULL
     )`,
    [unique, hashes],
  );
  return new Set(result.rows.map((row) => row.user_id as string));
}

function privacyLockableIdentityIds(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter(
    (value): value is string => Boolean(value && value !== "0" && !value.startsWith("deleted:")),
  ))];
}

async function withResolvedGiveawayIdentities<T>(
  dependencies: LifecycleDependencies,
  giveawayId: string,
  actorUserId: string | null,
  action: (
    effectiveActorUserId: string | null,
    redactedUserIds: string[],
  ) => Promise<T>,
): Promise<T> {
  const snapshot = await getGiveaway(dependencies.pool, giveawayId);
  const lockedIds = privacyLockableIdentityIds([
    actorUserId,
    snapshot?.creatorUserId,
    snapshot?.hostUserId,
  ]).sort();
  if (lockedIds.length === 0) return action(actorUserId, []);
  return withPrivacyIdentityLocks(
    dependencies.pool,
    lockedIds,
    async (privacyClient) => {
      const current = await getGiveaway(privacyClient, giveawayId);
      const currentIds = privacyLockableIdentityIds([
        current?.creatorUserId,
        current?.hostUserId,
      ]);
      if (currentIds.some((userId) => !lockedIds.includes(userId))) {
        throw new Error("Giveaway credited identity changed while privacy locks were acquired.");
      }
      const active = await activePrivacyUserIds(
        dependencies,
        privacyClient,
        lockedIds,
      );
      return action(
        actorUserId && active.has(actorUserId) ? null : actorUserId,
        [...active],
      );
    },
  );
}

async function startGiveaway(
  dependencies: LifecycleDependencies,
  operationId: string,
  giveawayId: string,
  actorUserId: string | null,
  redactedUserIds: string[],
): Promise<void> {
  const { pool, discord } = dependencies;
  const client = await pool.connect();
  let giveaway: WorkerGiveaway;
  try {
    await client.query("BEGIN");
    const locked = await getGiveawayForUpdate(client, giveawayId);
    if (!locked) {
      await client.query("COMMIT");
      return;
    }
    if (["ending", "ended", "deleted"].includes(locked.status)) {
      await client.query("COMMIT");
      if (locked.status === "deleted") await discord.tombstone(locked);
      return;
    }
    if (!["queued", "starting", "active"].includes(locked.status)) {
      throw new Error(`Giveaway cannot start from status ${locked.status}.`);
    }
    if (locked.status !== "active") {
      await client.query(
        `UPDATE giveaways
         SET status = 'starting',
             started_at = COALESCE(started_at, now()),
             ends_at = COALESCE(ends_at, now() + duration_seconds * interval '1 second'),
             updated_at = now()
         WHERE id = $1`,
        [giveawayId],
      );
    }
    giveaway = (await getGiveawayForUpdate(client, giveawayId))!;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  let messageId = giveaway.messageId;
  if (!messageId) {
    const deliveryKey = `start:${giveaway.id}`;
    const nonce = discord.deliveryNonce(deliveryKey);
    messageId = await deliverDiscordMessage(
      dependencies,
      {
        deliveryKey,
        kind: "giveaway_start",
        giveawayId: giveaway.id,
        channelId: giveaway.channelId,
        nonce,
      },
      () => discord.postGiveaway(giveaway, nonce, redactedUserIds),
    );
  }
  const finalize = await pool.connect();
  try {
    await finalize.query("BEGIN");
    const locked = await getGiveawayForUpdate(finalize, giveaway.id);
    if (!locked) {
      await finalize.query("COMMIT");
      return;
    }
    if (locked.status === "deleted") {
      await finalize.query(
        "UPDATE giveaways SET message_id = COALESCE(message_id, $2) WHERE id = $1",
        [giveaway.id, messageId],
      );
      await finalize.query("COMMIT");
      await discord.tombstone({ ...locked, messageId });
      return;
    }
    if (!["starting", "active"].includes(locked.status)) {
      throw new Error(`Giveaway changed to ${locked.status} while starting.`);
    }
    await finalize.query(
      `UPDATE giveaways SET status = 'active', message_id = $2, updated_at = now()
       WHERE id = $1`,
      [giveaway.id, messageId],
    );
    await finalize.query(
      `INSERT INTO jobs (id, type, giveaway_id, run_at, idempotency_key)
       VALUES ($1, 'end_giveaway', $2, $3, $4)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
       DO UPDATE SET run_at = EXCLUDED.run_at, completed_at = NULL`,
      [randomUUID(), giveaway.id, locked.endsAt, `end:${giveaway.id}`],
    );
    await finalize.query(
      `INSERT INTO audit_events
       (id, guild_id, giveaway_id, actor_user_id, action, source)
       VALUES ($1, $2, $3, $4, 'started', 'worker')
       ON CONFLICT (id) DO NOTHING`,
      [operationId, giveaway.guildId, giveaway.id, actorUserId],
    );
    await finalize.query("COMMIT");
  } catch (error) {
    await finalize.query("ROLLBACK");
    throw error;
  } finally {
    finalize.release();
  }
  const active = await getGiveaway(pool, giveaway.id);
  if (active) await discord.refreshGiveaway(active, redactedUserIds);
}

interface EligibilityResult {
  candidate?: Candidate;
  exclusion?: { userId: string; proofId: string; reason: string };
}

function evaluateMember(
  giveaway: WorkerGiveaway,
  entry: { userId: string; username: string; joinedAt: Date },
  member: DiscordMember | null,
  priorWinners: Set<string>,
  proofId: string,
): EligibilityResult {
  const exclusion = (reason: string): EligibilityResult => ({
    exclusion: { userId: entry.userId, proofId, reason },
  });
  if (priorWinners.has(proofId) || priorWinners.has(entry.userId)) {
    return exclusion("previous_winner");
  }
  if (!member) {
    return exclusion("not_in_server");
  }
  if (member.user?.bot) {
    return exclusion("bot_account");
  }
  if (giveaway.requiredRoleIds.length > 0) {
    const checks = giveaway.requiredRoleIds.map((roleId) => member.roles.includes(roleId));
    const passes =
      giveaway.requiredRoleMode === "one" ? checks.some(Boolean) : checks.every(Boolean);
    if (!passes) {
      return exclusion("required_roles_missing");
    }
  }
  const weight =
    1 +
    giveaway.bonusRoles.reduce(
      (total, bonus) =>
        total + (member.roles.includes(bonus.roleId) ? bonus.bonusEntries : 0),
      0,
    );
  if (!Number.isSafeInteger(weight) || weight < 1) {
    throw new Error("Aggregate candidate weight exceeds the safe integer range.");
  }
  return {
    candidate: {
      userId: entry.userId,
      participantId: proofId,
      username: entry.username,
      joinedAt: entry.joinedAt,
      weight,
      ordinal: -1,
    },
  };
}

type RerollRejectionReason =
  | "insufficient_eligible_candidates"
  | "draw_in_progress";

interface RerollRejectionMetadata {
  requestedWinnerCount: number;
  eligibleCandidateCount: number | null;
  reason: RerollRejectionReason;
  notificationSent?: boolean;
}

async function deliverExistingRerollRejection(
  dependencies: LifecycleDependencies,
  jobId: string,
  giveaway: WorkerGiveaway,
): Promise<boolean> {
  const result = await dependencies.pool.query(
    `SELECT metadata FROM audit_events
     WHERE id = $1 AND action = 'reroll_rejected'`,
    [jobId],
  );
  if (!result.rows[0]) return false;
  const metadata = result.rows[0].metadata as RerollRejectionMetadata;
  if (!metadata.notificationSent) {
    const deliveryKey = `reroll-rejected:${jobId}`;
    const nonce = dependencies.discord.deliveryNonce(deliveryKey);
    await deliverDiscordMessage(
      dependencies,
      {
        deliveryKey,
        kind: "reroll_rejection",
        giveawayId: giveaway.id,
        channelId: giveaway.channelId,
        nonce,
      },
      () => dependencies.discord.postRerollRejected(
        giveaway,
        Number(metadata.requestedWinnerCount),
        metadata.eligibleCandidateCount === null
          ? null
          : Number(metadata.eligibleCandidateCount),
        metadata.reason,
        nonce,
      ),
    );
    await dependencies.pool.query(
      `UPDATE audit_events
       SET metadata = jsonb_set(metadata, '{notificationSent}', 'true'::jsonb, true)
       WHERE id = $1`,
      [jobId],
    );
  }
  return true;
}

async function rejectReroll(
  dependencies: LifecycleDependencies,
  jobId: string,
  giveaway: WorkerGiveaway,
  actorUserId: string | null,
  requestedWinnerCount: number,
  eligibleCandidateCount: number | null,
  reason: RerollRejectionReason,
  exclusions: RerollExclusion[],
): Promise<void> {
  await dependencies.pool.query(
    `INSERT INTO audit_events
     (id, guild_id, giveaway_id, actor_user_id, action, source, metadata)
     VALUES ($1, $2, $3, $4, 'reroll_rejected', 'worker', $5::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [
      jobId,
      giveaway.guildId,
      giveaway.id,
      actorUserId,
      JSON.stringify({
        jobId,
        requestedWinnerCount,
        eligibleCandidateCount,
        reason,
        exclusionCounts: countExclusionReasons(exclusions),
        notificationSent: false,
      }),
    ],
  );
  await deliverExistingRerollRejection(dependencies, jobId, giveaway);
}

async function publishPreparedDraw(
  dependencies: LifecycleDependencies,
  drawId: string,
  redactedUserIds: string[],
): Promise<void> {
  const info = await chainInfo(dependencies);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const draw = await ensureUnpublishedDrawRound(dependencies.pool, drawId, info);
    if (draw.drandChainHash.toLowerCase() !== dependencies.drand.chainHash.toLowerCase()) {
      throw new Error("The prepared draw uses a drand chain that is no longer pinned.");
    }
    if (draw.commitmentPublishedAt) return;
    const giveaway = await getGiveaway(dependencies.pool, draw.giveawayId);
    if (!giveaway || giveaway.status === "deleted") return;
    if (!giveaway.messageId) throw new Error("Cannot publish a draw without a giveaway message.");
    await dependencies.discord.refreshGiveaway(giveaway, redactedUserIds);
    if (await markCommitmentPublished(dependencies.pool, draw.id, giveaway)) return;
  }
  throw new Error("Could not publish the commitment with a 15-second beacon safety window.");
}

async function prepareDraw(
  dependencies: LifecycleDependencies,
  jobId: string,
  giveawayId: string,
  actorUserId: string | null,
  reroll: boolean,
  requestedRerollWinnerCount?: number,
  redactedUserIds: string[] = [],
): Promise<void> {
  const { pool, discord } = dependencies;
  if (await getDraw(pool, jobId)) {
    await publishPreparedDraw(dependencies, jobId, redactedUserIds);
    return;
  }
  let giveaway = await getGiveaway(pool, giveawayId);
  if (!giveaway || giveaway.status === "deleted") return;
  if (reroll && (await deliverExistingRerollRejection(dependencies, jobId, giveaway))) {
    return;
  }
  const requestedWinnerCount = reroll
    ? requestedRerollWinnerCount ?? giveaway.winnerCount
    : giveaway.winnerCount;
  if (
    !Number.isSafeInteger(requestedWinnerCount) ||
    requestedWinnerCount < 1 ||
    requestedWinnerCount > MAX_REROLL_WINNERS
  ) {
    throw new Error("The reroll winner count is invalid.");
  }
  if (reroll) {
    const pending = await pool.query(
      `SELECT 1 FROM draws
       WHERE giveaway_id = $1 AND status IN ('awaiting_beacon', 'drawing')
       LIMIT 1`,
      [giveaway.id],
    );
    if (pending.rows[0]) {
      await rejectReroll(
        dependencies,
        jobId,
        giveaway,
        actorUserId,
        requestedWinnerCount,
        null,
        "draw_in_progress",
        [],
      );
      return;
    }
  }
  if (reroll && giveaway.status !== "ended") {
    throw new Error("Only ended giveaways can be rerolled.");
  }
  if (!reroll && !["active", "ending"].includes(giveaway.status)) {
    if (giveaway.status === "ended") return;
    throw new Error("Only active giveaways can be ended.");
  }
  if (!reroll) {
    const pending = await pool.query(
      `SELECT 1 FROM draws
       WHERE giveaway_id = $1 AND status IN ('awaiting_beacon', 'drawing')
       LIMIT 1`,
      [giveaway.id],
    );
    if (pending.rows[0]) return;
    await pool.query(
      `UPDATE giveaways
       SET status = 'ending',
           ended_at = COALESCE(ended_at, LEAST(now(), ends_at)),
           updated_at = now()
       WHERE id = $1 AND status IN ('active', 'ending')`,
      [giveaway.id],
    );
    giveaway = await getGiveaway(pool, giveaway.id);
    if (!giveaway) return;
  }

  const entries = await getActiveEntries(pool, giveaway.id);
  const priorWinners = reroll
    ? await previousWinnerProofIds(pool, giveaway.id)
    : new Set<string>();
  const memberUserIds = entries
    .filter((entry) => !giveaway.endedAt || entry.joinedAt <= giveaway.endedAt)
    .map((entry) => entry.userId);
  const memberSnapshotStartedAt = Date.now();
  const members = await discord.getMembers(giveaway.guildId, memberUserIds);
  dependencies.logger.info(
    {
      giveawayId: giveaway.id,
      entryCount: entries.length,
      checkedMemberCount: memberUserIds.length,
      durationMs: Date.now() - memberSnapshotStartedAt,
    },
    "draw member snapshot collected",
  );
  const eligibility = await mapConcurrent(entries, 8, async (entry) => {
    const proofId = proofIdForUser(dependencies, giveaway.id, entry.userId);
    if (giveaway.endedAt && entry.joinedAt > giveaway.endedAt) {
      return {
        exclusion: { userId: entry.userId, proofId, reason: "joined_after_end" },
      };
    }
    if (!members.has(entry.userId)) {
      throw new Error("The member snapshot did not resolve every draw entry.");
    }
    const member = members.get(entry.userId) ?? null;
    const evaluated = evaluateMember(giveaway, entry, member, priorWinners, proofId);
    if (!evaluated.candidate || giveaway.requiredMessages === null) return evaluated;
    if (giveaway.messageScope === null) {
      throw new Error("Giveaway message requirement is missing its configured scope.");
    }
    const since = giveaway.messageScope === "since_start" ? giveaway.startedAt : null;
    if (giveaway.messageScope === "since_start" && !since) {
      throw new Error("Giveaway message requirement is missing its actual start time.");
    }
    const messageCount = await discord.searchMessageCount(
      giveaway.guildId,
      entry.userId,
      since,
    );
    if (messageCount < giveaway.requiredMessages) {
      return {
        exclusion: {
          userId: entry.userId,
          proofId,
          reason: "message_requirement_not_met",
        },
      };
    }
    return evaluated;
  });
  const candidates = eligibility.flatMap((result) =>
    result.candidate ? [result.candidate] : [],
  ).map((candidate, ordinal) => ({ ...candidate, ordinal }));
  const exclusions = eligibility.flatMap((result) =>
    result.exclusion ? [result.exclusion] : [],
  );
  if (
    reroll &&
    !canFulfillReroll(requestedWinnerCount, candidates.length)
  ) {
    await rejectReroll(
      dependencies,
      jobId,
      giveaway,
      actorUserId,
      requestedWinnerCount,
      candidates.length,
      "insufficient_eligible_candidates",
      exclusions,
    );
    return;
  }
  const snapshot = await candidateHash(candidates, PROOF_VERSION);
  const info = await chainInfo(dependencies);
  const draw = await createDrawCommitment(pool, {
    drawId: jobId,
    giveaway,
    requestedWinnerCount,
    candidates,
    exclusions,
    privacyFenceHashesByUser: Object.fromEntries(
      [...candidates, ...exclusions].map((entry) => [
        entry.userId,
        privacyFenceHash(dependencies.privacyHashSalt, entry.userId),
      ]),
    ),
    candidateHash: snapshot,
    chainHash: dependencies.drand.chainHash,
    chainInfo: info,
    actorUserId,
  });
  await publishPreparedDraw(dependencies, draw.id, redactedUserIds);
}

export async function deactivateOldRoleClaims(
  dependencies: LifecycleDependencies,
  giveaway: WorkerGiveaway,
  currentDrawId: string,
): Promise<void> {
  const claims = await dependencies.pool.query(
    `SELECT DISTINCT guild_id, user_id, role_id FROM role_grant_claims
     WHERE giveaway_id = $1 AND draw_id <> $2
       AND (active OR EXISTS (
         SELECT 1 FROM role_ownership ownership
         WHERE ownership.guild_id = role_grant_claims.guild_id
           AND ownership.user_id = role_grant_claims.user_id
           AND ownership.role_id = role_grant_claims.role_id
           AND ownership.operation IN ('add_pending', 'remove_pending')
       ))`,
    [giveaway.id, currentDrawId],
  );
  for (const claim of claims.rows) {
    const guildId = claim.guild_id as string;
    const userId = claim.user_id as string;
    const roleId = claim.role_id as string;
    await withPrivacyIdentityLocks(dependencies.pool, [userId], async (privacyClient) => {
    const operation = await withRoleTransaction(
      dependencies.pool,
      guildId,
      userId,
      roleId,
      async (client) => {
      await client.query(
        `UPDATE role_grant_claims SET active = false
         WHERE giveaway_id = $1 AND draw_id <> $2
           AND guild_id = $3 AND user_id = $4 AND role_id = $5`,
        [giveaway.id, currentDrawId, guildId, userId, roleId],
      );
      const ownership = await client.query(
        `SELECT bot_added, operation FROM role_ownership
         WHERE guild_id = $1 AND user_id = $2 AND role_id = $3 FOR UPDATE`,
        [guildId, userId, roleId],
      );
      const active = await client.query(
        `SELECT 1 FROM role_grant_claims
         WHERE guild_id = $1 AND user_id = $2 AND role_id = $3 AND active LIMIT 1`,
        [guildId, userId, roleId],
      );
      if (ownership.rows[0]?.bot_added === true && !active.rows[0]) {
        await client.query(
          `UPDATE role_ownership SET operation = 'remove_pending', operation_error = NULL
           WHERE guild_id = $1 AND user_id = $2 AND role_id = $3`,
          [guildId, userId, roleId],
        );
        return "remove" as const;
      }
      if (
        active.rows[0] &&
        ["add_pending", "remove_pending"].includes(ownership.rows[0]?.operation as string)
      ) {
        await client.query(
          `UPDATE role_ownership SET operation = 'add_pending', operation_error = NULL
           WHERE guild_id = $1 AND user_id = $2 AND role_id = $3`,
          [guildId, userId, roleId],
        );
        return "restore" as const;
      }
      return "none" as const;
      },
    );
    if (operation === "restore") {
      await restoreRoleAfterRemovalRace(
        dependencies,
        privacyClient,
        guildId,
        userId,
        roleId,
      );
      return;
    }
    if (operation !== "remove") return;
    try {
      await dependencies.discord.removeRole(guildId, userId, roleId);
    } catch (error) {
      const removalError = sanitizedDiscordError(error, "Discord prize-role removal");
      await withRoleTransaction(dependencies.pool, guildId, userId, roleId, async (client) => {
        await client.query(
          `UPDATE role_ownership SET operation_error = $4
           WHERE guild_id = $1 AND user_id = $2 AND role_id = $3`,
          [guildId, userId, roleId, removalError.message.slice(0, 4000)],
        );
      });
      dependencies.logger.warn(
        { error: removalError, giveawayId: giveaway.id, guildId },
        "could not remove prior prize role; reconciliation will retry",
      );
      throw removalError;
    }
    const restore = await withRoleTransaction(dependencies.pool, guildId, userId, roleId, async (client) => {
      const active = await client.query(
        `SELECT 1 FROM role_grant_claims
         WHERE guild_id = $1 AND user_id = $2 AND role_id = $3 AND active LIMIT 1`,
        [guildId, userId, roleId],
      );
      if (active.rows[0]) {
        await client.query(
          `UPDATE role_ownership SET operation = 'add_pending', operation_error = NULL
           WHERE guild_id = $1 AND user_id = $2 AND role_id = $3`,
          [guildId, userId, roleId],
        );
        return true;
      }
      await client.query(
        `UPDATE role_ownership SET bot_added = false, operation = 'idle',
           operation_error = NULL, last_observed_at = now()
         WHERE guild_id = $1 AND user_id = $2 AND role_id = $3`,
        [guildId, userId, roleId],
      );
      await client.query(
        `UPDATE role_grant_claims SET removed_at = now(), error = NULL
         WHERE guild_id = $1 AND user_id = $2 AND role_id = $3 AND NOT active`,
        [guildId, userId, roleId],
      );
      return false;
    });
    if (restore) {
      await restoreRoleAfterRemovalRace(
        dependencies,
        privacyClient,
        guildId,
        userId,
        roleId,
      );
    }
    });
  }
}

async function restoreRoleAfterRemovalRace(
  dependencies: LifecycleDependencies,
  privacyClient: PoolClient,
  guildId: string,
  userId: string,
  roleId: string,
): Promise<void> {
  if ((await activePrivacyUserIds(dependencies, privacyClient, [userId])).has(userId)) {
    throw new Error("Prize-role restoration is waiting for participant privacy deletion.");
  }
  await dependencies.discord.addRole(guildId, userId, roleId);
  await withRoleTransaction(dependencies.pool, guildId, userId, roleId, async (client) => {
    await client.query(
      `UPDATE role_ownership SET bot_added = true, owned_before_bot = false,
         operation = 'idle', operation_error = NULL, last_observed_at = now()
       WHERE guild_id = $1 AND user_id = $2 AND role_id = $3`,
      [guildId, userId, roleId],
    );
  });
}

async function lockRole(
  client: PoolClient,
  guildId: string,
  userId: string,
  roleId: string,
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `${guildId}:${userId}:${roleId}`,
  ]);
}

async function withRoleTransaction<T>(
  pool: Pool,
  guildId: string,
  userId: string,
  roleId: string,
  action: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockRole(client, guildId, userId, roleId);
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function grantPrizeRoles(
  dependencies: LifecycleDependencies,
  giveaway: WorkerGiveaway,
  draw: DrawRow,
  winners: Candidate[],
): Promise<void> {
  if (giveaway.prizeRoleIds.length === 0) return;
  for (const winner of winners) {
    if (!/^\d{17,20}$/.test(winner.userId)) continue;
    const member = await dependencies.discord.getMember(giveaway.guildId, winner.userId);
    if (!member) continue;
    for (const roleId of giveaway.prizeRoleIds) {
      await grantPrizeRole(dependencies, giveaway, draw, winner, member, roleId);
    }
  }
}

async function grantPrizeRole(
  dependencies: LifecycleDependencies,
  giveaway: WorkerGiveaway,
  draw: DrawRow,
  winner: Candidate,
  member: DiscordMember,
  roleId: string,
): Promise<void> {
  await withPrivacyIdentityLocks(dependencies.pool, [winner.userId], async () => {
    await grantPrizeRoleUnderPrivacyLock(
      dependencies,
      giveaway,
      draw,
      winner,
      member,
      roleId,
    );
  });
}

async function grantPrizeRoleUnderPrivacyLock(
  dependencies: LifecycleDependencies,
  giveaway: WorkerGiveaway,
  draw: DrawRow,
  winner: Candidate,
  member: DiscordMember,
  roleId: string,
): Promise<void> {
  const alreadyOwned = member.roles.includes(roleId);
  const userIdHash = privacyFenceHash(dependencies.privacyHashSalt, winner.userId);
  const needsAdd = await withRoleTransaction(
    dependencies.pool,
    giveaway.guildId,
    winner.userId,
    roleId,
    async (client) => {
      const deletion = await client.query(
        `SELECT 1 FROM data_deletion_requests
         WHERE user_id = $1 AND status <> 'complete'
         UNION ALL
         SELECT 1 FROM privacy_deletion_fences
         WHERE user_id_hash = $2 AND cleared_at IS NULL
         LIMIT 1`,
        [winner.userId, userIdHash],
      );
      if (deletion.rows[0]) {
        throw new Error("Prize-role delivery is waiting for participant privacy deletion.");
      }
      const ownershipResult = await client.query(
        `SELECT * FROM role_ownership
         WHERE guild_id = $1 AND user_id = $2 AND role_id = $3 FOR UPDATE`,
        [giveaway.guildId, winner.userId, roleId],
      );
      let ownership = ownershipResult.rows[0] as
        | { owned_before_bot: boolean; bot_added: boolean; operation: string }
        | undefined;
      if (!ownership) {
        const inserted = await client.query(
          `INSERT INTO role_ownership
           (guild_id, user_id, role_id, owned_before_bot, bot_added, operation)
           VALUES ($1, $2, $3, $4, false, $5) RETURNING *`,
          [
            giveaway.guildId,
            winner.userId,
            roleId,
            alreadyOwned,
            alreadyOwned ? "idle" : "add_pending",
          ],
        );
        ownership = inserted.rows[0] as typeof ownership;
      } else if (alreadyOwned && ownership.operation === "add_pending") {
        const recovered = await client.query(
          `UPDATE role_ownership SET bot_added = true, owned_before_bot = false,
             operation = 'idle', operation_error = NULL, last_observed_at = now()
           WHERE guild_id = $1 AND user_id = $2 AND role_id = $3 RETURNING *`,
          [giveaway.guildId, winner.userId, roleId],
        );
        ownership = recovered.rows[0] as typeof ownership;
      }
      await client.query(
        `INSERT INTO role_grant_claims
         (giveaway_id, draw_id, guild_id, user_id, role_id, bot_added, active,
          granted_at, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7,
                 CASE WHEN $7 THEN now() ELSE NULL END, NULL)
         ON CONFLICT (draw_id, user_id, role_id) DO UPDATE
         SET bot_added = EXCLUDED.bot_added, active = EXCLUDED.active,
             granted_at = COALESCE(role_grant_claims.granted_at, EXCLUDED.granted_at),
             error = NULL`,
        [
          giveaway.id,
          draw.id,
          giveaway.guildId,
          winner.userId,
          roleId,
          ownership?.bot_added ?? false,
          alreadyOwned,
        ],
      );
      if (!alreadyOwned) {
        await client.query(
          `UPDATE role_ownership SET operation = 'add_pending', operation_error = NULL,
             owned_before_bot = false
           WHERE guild_id = $1 AND user_id = $2 AND role_id = $3`,
          [giveaway.guildId, winner.userId, roleId],
        );
      }
      return !alreadyOwned;
    },
  );
  if (!needsAdd) return;
  try {
    await dependencies.discord.addRole(giveaway.guildId, winner.userId, roleId);
  } catch (error) {
    const grantError = sanitizedDiscordError(error, "Discord prize-role grant");
    await withRoleTransaction(
      dependencies.pool,
      giveaway.guildId,
      winner.userId,
      roleId,
      async (client) => {
        await client.query(
          `UPDATE role_ownership SET operation_error = $4
           WHERE guild_id = $1 AND user_id = $2 AND role_id = $3`,
          [giveaway.guildId, winner.userId, roleId, grantError.message.slice(0, 4000)],
        );
        await client.query(
          `UPDATE role_grant_claims SET error = $4
           WHERE draw_id = $1 AND user_id = $2 AND role_id = $3`,
          [draw.id, winner.userId, roleId, grantError.message.slice(0, 4000)],
        );
      },
    );
    throw grantError;
  }
  member.roles.push(roleId);
  await withRoleTransaction(
    dependencies.pool,
    giveaway.guildId,
    winner.userId,
    roleId,
    async (client) => {
      await client.query(
        `UPDATE role_ownership SET bot_added = true, owned_before_bot = false,
           operation = 'idle', operation_error = NULL, last_observed_at = now()
         WHERE guild_id = $1 AND user_id = $2 AND role_id = $3`,
        [giveaway.guildId, winner.userId, roleId],
      );
      await client.query(
        `UPDATE role_grant_claims SET active = true, bot_added = true,
           granted_at = COALESCE(granted_at, now()), error = NULL
         WHERE draw_id = $1 AND user_id = $2 AND role_id = $3`,
        [draw.id, winner.userId, roleId],
      );
    },
  );
}

async function announceDrawWinners(
  dependencies: LifecycleDependencies,
  giveaway: WorkerGiveaway,
  draw: DrawRow,
): Promise<void> {
  let winners = await getDrawWinners(dependencies.pool, draw.id);
  const delivered = await deliveredWinnerOrdinals(dependencies.pool, draw.id);
  const deliver = async (winnerIds: string[], redactedWinnerCount: number) =>
    dependencies.discord.postWinners(
      giveaway,
      winnerIds,
      redactedWinnerCount,
      draw.id,
      delivered,
      async (ordinal, nonce, send) => {
        await deliverDiscordMessage(
          dependencies,
          {
            deliveryKey: `winner:${draw.id}:${ordinal}`,
            kind: "winner_message",
            giveawayId: giveaway.id,
            channelId: giveaway.channelId,
            drawId: draw.id,
            ordinal,
            nonce,
          },
          send,
        );
      },
    );

  if (winners.length > 1000) {
    await deliver([], winners.length);
    return;
  }

  const initiallyRaw = winners
    .map((winner) => winner.userId)
    .filter((userId) => /^\d{17,20}$/.test(userId));
  await withPrivacyIdentityLocks(dependencies.pool, initiallyRaw, async (privacyClient) => {
    winners = await getDrawWinners(dependencies.pool, draw.id);
    const rawIds = winners
      .map((winner) => winner.userId)
      .filter((userId) => /^\d{17,20}$/.test(userId));
    const active = await activePrivacyUserIds(
      dependencies,
      privacyClient,
      rawIds,
    );
    const mentionable = rawIds.filter((userId) => !active.has(userId));
    await deliver(mentionable, winners.length - mentionable.length);
  });
}

async function completeDraw(
  dependencies: LifecycleDependencies,
  drawId: string,
): Promise<void> {
  let draw = await getDraw(dependencies.pool, drawId);
  if (!draw) return;
  if (!draw.commitmentPublishedAt) {
    throw new Error("The draw commitment was not published before completion.");
  }
  if (draw.drandBeaconTime.getTime() > Date.now()) {
    throw new Error("The committed drand round is not available yet.");
  }
  let giveaway = await getGiveaway(dependencies.pool, draw.giveawayId);
  if (!giveaway || giveaway.status === "deleted") return;
  let winners: Candidate[];
  if (draw.status !== "complete") {
    const candidates = await getDrawCandidates(dependencies.pool, draw.id);
    const proofVersion =
      draw.proofVersion === LEGACY_PROOF_VERSION ? LEGACY_PROOF_VERSION : PROOF_VERSION;
    const recomputedHash = await candidateHash(candidates, proofVersion);
    if (recomputedHash !== draw.candidateHash) {
      throw new Error("The persisted candidate snapshot no longer matches its commitment.");
    }
    const beacon = await fetchBeacon(
      dependencies.drand,
      draw.drandChainHash,
      draw.drandRound,
    );
    winners = await selectWeightedWinners(
      candidates,
      draw.requestedWinnerCount,
      beacon.randomness,
      draw.candidateHash,
      draw.drawNumber,
      proofVersion,
    );
    await persistWinners(
      dependencies.pool,
      draw,
      giveaway,
      winners,
      beacon as { randomness: string; signature: string; [key: string]: unknown },
      Object.fromEntries(
        winners.map((winner) => [
          winner.userId,
          privacyFenceHash(dependencies.privacyHashSalt, winner.userId),
        ]),
      ),
    );
    draw = (await getDraw(dependencies.pool, draw.id))!;
  }
  winners = await getDrawWinners(dependencies.pool, draw.id);
  if (!draw.rolesReconciledAt) {
    if (draw.drawNumber > 1) {
      await deactivateOldRoleClaims(dependencies, giveaway, draw.id);
    }
    await grantPrizeRoles(dependencies, giveaway, draw, winners);
    await markDrawStep(dependencies.pool, draw.id, "roles_reconciled_at");
  }
  giveaway = await getGiveaway(dependencies.pool, giveaway.id);
  if (!giveaway || giveaway.status === "deleted") return;
  if (!draw.messageRefreshedAt) {
    await withResolvedGiveawayIdentities(
      dependencies,
      giveaway.id,
      null,
      async (_actorUserId, redactedUserIds) => {
        const current = await getGiveaway(dependencies.pool, giveaway!.id);
        if (current && current.status !== "deleted") {
          await dependencies.discord.refreshGiveaway(current, redactedUserIds);
        }
      },
    );
    await markDrawStep(dependencies.pool, draw.id, "message_refreshed_at");
  }
  if (!draw.winnersAnnouncedAt) {
    await announceDrawWinners(dependencies, giveaway, draw);
    await markDrawStep(dependencies.pool, draw.id, "winners_announced_at");
  }
  await markDrawStep(dependencies.pool, draw.id, "delivery_completed_at");
}

async function refreshGiveaway(
  dependencies: LifecycleDependencies,
  giveawayId: string,
  redactedUserIds: string[],
): Promise<void> {
  const giveaway = await getGiveaway(dependencies.pool, giveawayId);
  if (giveaway && giveaway.status !== "deleted") {
    await dependencies.discord.refreshGiveaway(giveaway, redactedUserIds);
  }
}

async function deleteGiveaway(
  dependencies: LifecycleDependencies,
  operationId: string,
  giveawayId: string,
  actorUserId: string | null,
): Promise<void> {
  const client = await dependencies.pool.connect();
  let giveaway: WorkerGiveaway | null;
  try {
    await client.query("BEGIN");
    giveaway = await getGiveawayForUpdate(client, giveawayId);
    if (!giveaway) {
      await client.query("COMMIT");
      return;
    }
    const unresolvedStartDelivery = await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM discord_deliveries
         WHERE giveaway_id = $1 AND kind = 'giveaway_start'
           AND (
             (send_started_at IS NOT NULL AND delivered_at IS NULL)
             OR (delivered_at IS NOT NULL AND external_id IS DISTINCT FROM $2::text)
           )
       ) AS unresolved`,
      [giveaway.id, giveaway.messageId],
    );
    if (unresolvedStartDelivery.rows[0]?.unresolved === true) {
      throw new Error(
        "Giveaway deletion is waiting for start-message delivery reconciliation.",
      );
    }
    const pendingDraw = await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM draws
         WHERE giveaway_id = $1
           AND (
             status IN ('awaiting_beacon', 'drawing')
             OR (commitment_published_at IS NOT NULL AND status <> 'complete')
           )
       ) AS pending`,
      [giveaway.id],
    );
    if (giveaway.status === "ending" || pendingDraw.rows[0]?.pending === true) {
      await client.query(
        `INSERT INTO audit_events
         (id, guild_id, giveaway_id, actor_user_id, action, source, metadata)
         VALUES ($1, $2, $3, $4, 'delete_rejected', 'worker',
                 '{"reason":"draw_commitment_locked"}'::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [operationId, giveaway.guildId, giveaway.id, actorUserId],
      );
      await client.query("COMMIT");
      return;
    }
    await client.query(
      `UPDATE giveaways SET status = 'deleted', deleted_at = COALESCE(deleted_at, now()),
         updated_at = now() WHERE id = $1`,
      [giveaway.id],
    );
    await client.query(
      `UPDATE jobs SET completed_at = now(), locked_at = NULL, locked_by = NULL,
         lock_token = NULL, lease_expires_at = NULL
       WHERE giveaway_id = $1 AND completed_at IS NULL AND id <> $2`,
      [giveaway.id, operationId],
    );
    await client.query(
      `INSERT INTO audit_events
       (id, guild_id, giveaway_id, actor_user_id, action, source)
       VALUES ($1, $2, $3, $4, 'deleted', 'worker')
       ON CONFLICT (id) DO NOTHING`,
      [operationId, giveaway.guildId, giveaway.id, actorUserId],
    );
    await client.query("COMMIT");
    giveaway = { ...giveaway, status: "deleted" };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await dependencies.discord.tombstone(giveaway);
}

async function redactDeliveredWinnerMessages(
  dependencies: LifecycleDependencies,
  userId: string,
): Promise<void> {
  const pending = await dependencies.pool.query(
    `SELECT 1
     FROM draw_winners winner
     JOIN discord_deliveries delivery ON delivery.draw_id = winner.draw_id
     WHERE winner.user_id = $1
       AND (delivery.external_id IS NULL OR delivery.delivered_at IS NULL)
     LIMIT 1`,
    [userId],
  );
  if (pending.rows[0]) {
    throw new Error(
      "Privacy deletion is waiting for winner-message delivery reconciliation.",
    );
  }

  const deliveries = await dependencies.pool.query(
    `SELECT DISTINCT delivery.external_id, giveaway.channel_id,
            giveaway.id AS giveaway_id, giveaway.prize
     FROM draw_winners winner
     JOIN draws draw ON draw.id = winner.draw_id
     JOIN giveaways giveaway ON giveaway.id = draw.giveaway_id
     JOIN discord_deliveries delivery ON delivery.draw_id = draw.id
     WHERE winner.user_id = $1
       AND delivery.external_id IS NOT NULL
       AND delivery.delivered_at IS NOT NULL
     ORDER BY giveaway.id, delivery.external_id`,
    [userId],
  );
  for (const delivery of deliveries.rows) {
    await dependencies.discord.redactWinnerMessage(
      delivery.channel_id as string,
      delivery.external_id as string,
      delivery.giveaway_id as string,
      delivery.prize as string,
    );
  }
}

async function redactCreditedGiveawayMessages(
  dependencies: LifecycleDependencies,
  userId: string,
): Promise<void> {
  const affected = await dependencies.pool.query(
    `SELECT giveaway.id, giveaway.message_id,
            delivery.external_id AS start_delivery_id,
            delivery.send_started_at, delivery.delivered_at
     FROM giveaways giveaway
     LEFT JOIN discord_deliveries delivery
       ON delivery.giveaway_id = giveaway.id
      AND delivery.kind = 'giveaway_start'
     WHERE (giveaway.creator_user_id = $1 OR giveaway.host_user_id = $1)
     ORDER BY giveaway.id, delivery.created_at`,
    [userId],
  );
  if (
    affected.rows.some(
      (row) => row.send_started_at !== null && row.delivered_at === null,
    )
  ) {
    throw new Error(
      "Privacy deletion is waiting for giveaway-start message delivery reconciliation.",
    );
  }
  const redactedMessageIds = new Set<string>();
  for (const row of affected.rows) {
    const giveaway = await getGiveaway(dependencies.pool, row.id as string);
    if (!giveaway) continue;
    const messageIds = [
      row.message_id as string | null,
      row.start_delivery_id as string | null,
    ].filter((messageId): messageId is string => Boolean(messageId));
    for (const messageId of messageIds) {
      const redactionKey = `${giveaway.channelId}:${messageId}`;
      if (redactedMessageIds.has(redactionKey)) continue;
      await dependencies.discord.redactGiveawayIdentity(
        { ...giveaway, messageId },
        userId,
      );
      redactedMessageIds.add(redactionKey);
    }
  }
}

async function deleteUserData(
  dependencies: LifecycleDependencies,
  job: Job,
  userId: string,
  requestId: string,
): Promise<boolean> {
  const privacyClient = await dependencies.pool.connect();
  try {
    await privacyClient.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
      `privacy-delete:${userId}`,
    ]);
    return await deleteUserDataUnderPrivacyLock(
      dependencies,
      privacyClient,
      job,
      userId,
      requestId,
    );
  } finally {
    await privacyClient
      .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
        `privacy-delete:${userId}`,
      ])
      .catch(() => undefined);
    privacyClient.release();
  }
}

async function deleteUserDataUnderPrivacyLock(
  dependencies: LifecycleDependencies,
  client: PoolClient,
  job: Job,
  userId: string,
  requestId: string,
): Promise<boolean> {
  const userIdHash = privacyFenceHash(dependencies.privacyHashSalt, userId);
  await client.query(
    `INSERT INTO privacy_deletion_fences
       (user_id_hash, request_id, requested_at, completed_at, cleared_at, updated_at)
     SELECT $1, request.id, request.requested_at, NULL, NULL, now()
     FROM data_deletion_requests request WHERE request.id = $2
     ON CONFLICT (user_id_hash) DO NOTHING`,
    [userIdHash, requestId],
  );
  const fence = await client.query(
    `SELECT request_id, cleared_at FROM privacy_deletion_fences
     WHERE user_id_hash = $1`,
    [userIdHash],
  );
  if (!fence.rows[0]) throw new Error("Privacy deletion request does not exist.");
  if (fence.rows[0].request_id !== requestId || fence.rows[0].cleared_at !== null) {
    return false;
  }
  const inFlightLegacy = await client.query(
    `SELECT 1 FROM draws draw
     WHERE draw.proof_version = 'lilac-weighted-v1'
       AND draw.status IN ('awaiting_beacon', 'drawing')
       AND EXISTS (
         SELECT 1 FROM draw_candidates candidate
         WHERE candidate.draw_id = draw.id AND candidate.user_id = $1
       ) LIMIT 1`,
    [userId],
  );
  if (inFlightLegacy.rows[0]) {
    throw new Error("Privacy deletion is waiting for an in-flight legacy draw to finish.");
  }
  await redactCreditedGiveawayMessages(dependencies, userId);
  await redactDeliveredWinnerMessages(dependencies, userId);
  await removeBotRolesForPrivacy(dependencies, userId);
  const internalPseudonym = `deleted:${createHmac("sha256", dependencies.privacyHashSalt)
    .update("lilac-deletion/v2:")
    .update(requestId)
    .update(":")
    .update(userId)
    .digest("hex")
    .slice(0, 24)}`;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `privacy-delete:${userId}`,
    ]);
    await client.query(
      `UPDATE data_deletion_requests SET status = 'processing', error = NULL
       WHERE id = $1 AND status <> 'complete'`,
      [requestId],
    );
    await client.query(
      `SELECT giveaway.id FROM giveaways giveaway
       WHERE EXISTS (
         SELECT 1 FROM entries entry
         WHERE entry.giveaway_id = giveaway.id AND entry.user_id = $1
       ) ORDER BY giveaway.id FOR UPDATE`,
      [userId],
    );
    await client.query("DELETE FROM web_sessions WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM oauth_accounts WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM privacy_consents WHERE user_id = $1", [userId]);
    await client.query(
      `UPDATE draws SET proof_redacted_at = COALESCE(proof_redacted_at, now())
       WHERE proof_version = 'lilac-weighted-v1' AND id IN (
         SELECT draw_id FROM draw_candidates WHERE user_id = $1
         UNION SELECT draw_id FROM draw_winners WHERE user_id = $1
         UNION SELECT draw_id FROM draw_exclusions WHERE user_id = $1
       )`,
      [userId],
    );
    const affectedGiveaways = await client.query(
      `SELECT giveaway_id FROM entries WHERE user_id = $1
       UNION SELECT giveaway_id FROM entry_events WHERE user_id = $1
       UNION SELECT draw.giveaway_id FROM draws draw
         WHERE draw.id IN (
           SELECT draw_id FROM draw_candidates WHERE user_id = $1
           UNION SELECT draw_id FROM draw_winners WHERE user_id = $1
           UNION SELECT draw_id FROM draw_exclusions WHERE user_id = $1
         )`,
      [userId],
    );
    await client.query(
      `WITH removed AS (
         SELECT giveaway_id, count(*)::int AS count
         FROM entries WHERE user_id = $1 AND left_at IS NULL GROUP BY giveaway_id
       )
       UPDATE giveaways giveaway
       SET participant_count = GREATEST(0, giveaway.participant_count - removed.count),
           updated_at = now()
       FROM removed WHERE giveaway.id = removed.giveaway_id`,
      [userId],
    );
    for (const row of affectedGiveaways.rows) {
      const giveawayId = row.giveaway_id as string;
      const proofId = proofIdForUser(dependencies, giveawayId, userId);
      const displayPseudonym = `deleted:${createHmac(
        "sha256",
        dependencies.privacyHashSalt,
      )
        .update("lilac-public-deletion/v2:")
        .update(requestId)
        .update(":")
        .update(giveawayId)
        .update(":")
        .update(userId)
        .digest("hex")
        .slice(0, 24)}`;
      await client.query(
        `UPDATE draw_candidates candidate SET proof_id = $3
         FROM draws draw WHERE candidate.draw_id = draw.id
           AND draw.giveaway_id = $2 AND candidate.user_id = $1
           AND candidate.proof_id IS NULL`,
        [userId, giveawayId, proofId],
      );
      await client.query(
        `UPDATE draw_winners winner SET proof_id = $3
         FROM draws draw WHERE winner.draw_id = draw.id
           AND draw.giveaway_id = $2 AND winner.user_id = $1
           AND winner.proof_id IS NULL`,
        [userId, giveawayId, proofId],
      );
      await client.query(
        `UPDATE draw_exclusions exclusion SET proof_id = $3
         FROM draws draw WHERE exclusion.draw_id = draw.id
           AND draw.giveaway_id = $2 AND exclusion.user_id = $1
           AND exclusion.proof_id IS NULL`,
        [userId, giveawayId, proofId],
      );
      await client.query(
        `UPDATE entries SET user_id = $3, username = 'Deleted User',
           global_name = NULL, avatar_hash = NULL, left_at = COALESCE(left_at, now())
         WHERE giveaway_id = $2 AND user_id = $1`,
        [userId, giveawayId, displayPseudonym],
      );
      await client.query(
        `UPDATE entry_events SET user_id = $3, username = 'Deleted User'
         WHERE giveaway_id = $2 AND user_id = $1`,
        [userId, giveawayId, displayPseudonym],
      );
      await client.query(
        `UPDATE draw_candidates candidate SET user_id = $3, username = 'Deleted User'
         FROM draws draw WHERE candidate.draw_id = draw.id
           AND draw.giveaway_id = $2 AND candidate.user_id = $1`,
        [userId, giveawayId, displayPseudonym],
      );
      await client.query(
        `UPDATE draw_winners winner SET user_id = $3, username = 'Deleted User'
         FROM draws draw WHERE winner.draw_id = draw.id
           AND draw.giveaway_id = $2 AND winner.user_id = $1`,
        [userId, giveawayId, displayPseudonym],
      );
      await client.query(
        `UPDATE draw_exclusions exclusion SET user_id = $3
         FROM draws draw WHERE exclusion.draw_id = draw.id
           AND draw.giveaway_id = $2 AND exclusion.user_id = $1`,
        [userId, giveawayId, displayPseudonym],
      );
    }
    await client.query(
      `UPDATE draws SET requested_by_user_id = NULL WHERE requested_by_user_id = $1`,
      [userId],
    );
    await client.query(
      `UPDATE audit_events SET actor_user_id = NULL,
         metadata = metadata || jsonb_build_object('actorDeleted', true)
       WHERE actor_user_id = $1`,
      [userId],
    );
    await client.query("DELETE FROM giveaway_drafts WHERE creator_user_id = $1", [userId]);
    await client.query(
      `UPDATE giveaway_drafts SET payload = payload - 'hostUserId'
       WHERE payload->>'hostUserId' = $1`,
      [userId],
    );
    await client.query(
      `UPDATE role_grant_claims SET user_id = $2, active = false
       WHERE user_id = $1`,
      [userId, internalPseudonym],
    );
    await client.query(
      `UPDATE role_ownership SET user_id = $2, bot_added = false,
         operation = 'idle', operation_error = NULL WHERE user_id = $1`,
      [userId, internalPseudonym],
    );
    await client.query(
      `UPDATE jobs SET
         payload = CASE
           WHEN payload->>'actorUserId' = $1 THEN payload - 'actorUserId'
           ELSE payload
         END
       WHERE payload->>'actorUserId' = $1`,
      [userId],
    );
    await client.query(
      `UPDATE giveaways
       SET creator_user_id = CASE WHEN creator_user_id = $1 THEN NULL ELSE creator_user_id END,
           host_user_id = CASE WHEN host_user_id = $1 THEN NULL ELSE host_user_id END
       WHERE creator_user_id = $1 OR host_user_id = $1`,
      [userId],
    );
    const finalizedJob = await client.query(
      `UPDATE jobs SET completed_at = now(), locked_at = NULL, locked_by = NULL,
         lock_token = NULL, lease_expires_at = NULL,
         payload = payload - 'userId' - 'actorUserId', idempotency_key = NULL
       WHERE id = $1 AND type = 'privacy_delete'
         AND locked_by = $2 AND lock_token = $3 AND completed_at IS NULL`,
      [job.id, job.lockedBy, job.lockToken],
    );
    if (finalizedJob.rowCount !== 1) {
      throw new Error("Privacy deletion job lease was lost before atomic completion.");
    }
    const completedRequest = await client.query(
      `UPDATE data_deletion_requests SET user_id = $2, status = 'complete', completed_at = now()
       WHERE id = $1 AND status <> 'complete'`,
      [requestId, internalPseudonym],
    );
    if (completedRequest.rowCount !== 1) {
      throw new Error("Privacy deletion request changed before atomic completion.");
    }
    const completedFence = await client.query(
      `UPDATE privacy_deletion_fences SET completed_at = now(), updated_at = now()
       WHERE user_id_hash = $1 AND request_id = $2 AND cleared_at IS NULL`,
      [userIdHash, requestId],
    );
    if (completedFence.rowCount !== 1) {
      throw new Error("Privacy deletion fence changed before atomic completion.");
    }
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    await dependencies.pool.query(
      `UPDATE data_deletion_requests SET status = 'failed', error = $2 WHERE id = $1`,
      [requestId, error instanceof Error ? error.message : String(error)],
    );
    throw error;
  } finally {
    // The caller owns the session-level privacy lock and releases this client.
  }
}

async function removeBotRolesForPrivacy(
  dependencies: LifecycleDependencies,
  userId: string,
): Promise<void> {
  const roles = await dependencies.pool.query(
    `SELECT guild_id, role_id FROM role_ownership
     WHERE user_id = $1 AND (bot_added OR operation IN ('add_pending', 'remove_pending'))`,
    [userId],
  );
  for (const row of roles.rows) {
    const guildId = row.guild_id as string;
    const roleId = row.role_id as string;
    const shouldRemove = await withRoleTransaction(
      dependencies.pool,
      guildId,
      userId,
      roleId,
      async (client) => {
      const ownership = await client.query(
        `SELECT bot_added, operation FROM role_ownership
         WHERE guild_id = $1 AND user_id = $2 AND role_id = $3 FOR UPDATE`,
        [guildId, userId, roleId],
      );
      await client.query(
        `UPDATE role_grant_claims SET active = false
         WHERE guild_id = $1 AND user_id = $2 AND role_id = $3`,
        [guildId, userId, roleId],
      );
      if (
        ownership.rows[0]?.bot_added === true ||
        ownership.rows[0]?.operation === "add_pending" ||
        ownership.rows[0]?.operation === "remove_pending"
      ) {
        await client.query(
          `UPDATE role_ownership SET operation = 'remove_pending', operation_error = NULL
           WHERE guild_id = $1 AND user_id = $2 AND role_id = $3`,
          [guildId, userId, roleId],
        );
        return true;
      }
      return false;
      },
    );
    if (!shouldRemove) continue;
    try {
      await dependencies.discord.removeRole(guildId, userId, roleId);
    } catch (error) {
      const removalError = sanitizedDiscordError(error, "Discord privacy role removal");
      await withRoleTransaction(dependencies.pool, guildId, userId, roleId, async (client) => {
        await client.query(
          `UPDATE role_ownership SET operation_error = $4
           WHERE guild_id = $1 AND user_id = $2 AND role_id = $3`,
          [guildId, userId, roleId, removalError.message.slice(0, 4000)],
        );
      });
      throw removalError;
    }
    await withRoleTransaction(dependencies.pool, guildId, userId, roleId, async (client) => {
      await client.query(
        `UPDATE role_ownership SET bot_added = false, operation = 'idle',
           operation_error = NULL WHERE guild_id = $1 AND user_id = $2 AND role_id = $3`,
        [guildId, userId, roleId],
      );
      await client.query(
        `UPDATE role_grant_claims SET removed_at = COALESCE(removed_at, now()), error = NULL
         WHERE guild_id = $1 AND user_id = $2 AND role_id = $3`,
        [guildId, userId, roleId],
      );
    });
  }
}

export async function processJob(
  dependencies: LifecycleDependencies,
  job: Job,
): Promise<boolean> {
  const actorUserId =
    typeof job.payload.actorUserId === "string" ? job.payload.actorUserId : null;
  switch (job.type) {
    case "start_giveaway":
      if (!job.giveawayId) throw new JobPayloadError("Start job is missing giveawayId.");
      await withResolvedGiveawayIdentities(
        dependencies,
        job.giveawayId,
        actorUserId,
        (effectiveActorUserId, redactedUserIds) =>
        startGiveaway(
          dependencies,
          job.id,
          job.giveawayId!,
          effectiveActorUserId,
          redactedUserIds,
        ),
      );
      return false;
    case "refresh_giveaway":
      if (!job.giveawayId) throw new JobPayloadError("Refresh job is missing giveawayId.");
      await withResolvedGiveawayIdentities(
        dependencies,
        job.giveawayId,
        null,
        (_actorUserId, redactedUserIds) =>
          refreshGiveaway(dependencies, job.giveawayId!, redactedUserIds),
      );
      return false;
    case "end_giveaway":
      if (!job.giveawayId) throw new JobPayloadError("End job is missing giveawayId.");
      await withResolvedGiveawayIdentities(
        dependencies,
        job.giveawayId,
        actorUserId,
        (effectiveActorUserId, redactedUserIds) =>
        prepareDraw(
          dependencies,
          job.id,
          job.giveawayId!,
          effectiveActorUserId,
          false,
          undefined,
          redactedUserIds,
        ),
      );
      return false;
    case "reroll_giveaway":
      if (!job.giveawayId) throw new JobPayloadError("Reroll job is missing giveawayId.");
      if (
        job.payload.winnerCount !== undefined &&
        typeof job.payload.winnerCount !== "number"
      ) {
        throw new JobPayloadError("Reroll job winnerCount is malformed.");
      }
      await withResolvedGiveawayIdentities(
        dependencies,
        job.giveawayId,
        actorUserId,
        (effectiveActorUserId, redactedUserIds) =>
        prepareDraw(
          dependencies,
          job.id,
          job.giveawayId!,
          effectiveActorUserId,
          true,
          job.payload.winnerCount as number | undefined,
          redactedUserIds,
        ),
      );
      return false;
    case "complete_draw":
      if (typeof job.payload.drawId !== "string") {
        throw new JobPayloadError("Complete-draw job is missing drawId.");
      }
      await completeDraw(dependencies, job.payload.drawId);
      return false;
    case "delete_giveaway":
      if (!job.giveawayId) throw new JobPayloadError("Delete job is missing giveawayId.");
      await withResolvedGiveawayIdentities(
        dependencies,
        job.giveawayId,
        actorUserId,
        (effectiveActorUserId) =>
        deleteGiveaway(
          dependencies,
          job.id,
          job.giveawayId!,
          effectiveActorUserId,
        ),
      );
      return false;
    case "privacy_delete":
      if (
        typeof job.payload.userId !== "string" ||
        typeof job.payload.requestId !== "string"
      ) {
        throw new JobPayloadError("Privacy job payload is malformed.");
      }
      return deleteUserData(
        dependencies,
        job,
        job.payload.userId,
        job.payload.requestId,
      );
    default:
      throw new JobPayloadError(`Unknown job type: ${job.type}.`);
  }
}

export class JobPayloadError extends Error {}
