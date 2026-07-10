import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type pino from "pino";
import {
  createDrawCommitment,
  getActiveEntries,
  getDraw,
  getDrawCandidates,
  getGiveaway,
  persistWinners,
  previousWinnerIds,
  type DrawRow,
  type Job,
  type WorkerGiveaway,
} from "./database.js";
import { DiscordApi, type DiscordMember } from "./discord.js";
import {
  fetchBeacon,
  fetchChainInfo,
  roundAtOrAfter,
  roundTime,
  type ChainInfo,
  type DrandClientOptions,
} from "./drand.js";
import { candidateHash, selectWeightedWinners, type Candidate } from "./selection.js";

interface LifecycleDependencies {
  pool: Pool;
  discord: DiscordApi;
  logger: pino.Logger;
  websiteUrl: string;
  drand: DrandClientOptions;
  privacyHashSalt: string;
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

async function startGiveaway(
  dependencies: LifecycleDependencies,
  giveawayId: string,
  actorUserId: string | null,
): Promise<void> {
  const { pool, discord } = dependencies;
  const client = await pool.connect();
  let giveaway: WorkerGiveaway;
  try {
    await client.query("BEGIN");
    const locked = await getGiveaway(client, giveawayId);
    if (!locked || ["active", "ending", "ended", "deleted"].includes(locked.status)) {
      await client.query("COMMIT");
      return;
    }
    if (!["queued", "starting"].includes(locked.status)) {
      throw new Error(`Giveaway cannot start from status ${locked.status}.`);
    }
    await client.query(
      `UPDATE giveaways
       SET status = 'starting',
           started_at = COALESCE(started_at, now()),
           ends_at = COALESCE(ends_at, now() + duration_seconds * interval '1 second'),
           updated_at = now()
       WHERE id = $1`,
      [giveawayId],
    );
    giveaway = (await getGiveaway(client, giveawayId))!;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  let messageId = giveaway.messageId;
  if (!messageId) {
    const message = await discord.postGiveaway(giveaway);
    messageId = message.id;
  }
  await pool.query(
    `UPDATE giveaways SET status = 'active', message_id = $2, updated_at = now()
     WHERE id = $1 AND status = 'starting'`,
    [giveaway.id, messageId],
  );
  await pool.query(
    `INSERT INTO jobs (id, type, giveaway_id, run_at, idempotency_key)
     VALUES ($1, 'end_giveaway', $2, $3, $4)
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
     DO UPDATE SET run_at = EXCLUDED.run_at, completed_at = NULL`,
    [randomUUID(), giveaway.id, giveaway.endsAt, `end:${giveaway.id}`],
  );
  await pool.query(
    `INSERT INTO audit_events
     (id, guild_id, giveaway_id, actor_user_id, action, source)
     VALUES ($1, $2, $3, $4, 'started', 'worker')`,
    [randomUUID(), giveaway.guildId, giveaway.id, actorUserId],
  );
  const active = await getGiveaway(pool, giveaway.id);
  if (active) await discord.refreshGiveaway(active);
}

interface EligibilityResult {
  candidate?: Candidate;
  exclusion?: { userId: string; reason: string };
}

function evaluateMember(
  giveaway: WorkerGiveaway,
  entry: { userId: string; username: string; joinedAt: Date },
  member: DiscordMember | null,
  priorWinners: Set<string>,
): EligibilityResult {
  if (priorWinners.has(entry.userId)) {
    return { exclusion: { userId: entry.userId, reason: "previous_winner" } };
  }
  if (!member) {
    return { exclusion: { userId: entry.userId, reason: "not_in_server" } };
  }
  if (member.user?.bot) {
    return { exclusion: { userId: entry.userId, reason: "bot_account" } };
  }
  if (giveaway.requiredRoleIds.length > 0) {
    const checks = giveaway.requiredRoleIds.map((roleId) => member.roles.includes(roleId));
    const passes =
      giveaway.requiredRoleMode === "one" ? checks.some(Boolean) : checks.every(Boolean);
    if (!passes) {
      return { exclusion: { userId: entry.userId, reason: "required_roles_missing" } };
    }
  }
  const weight =
    1 +
    giveaway.bonusRoles.reduce(
      (total, bonus) =>
        total + (member.roles.includes(bonus.roleId) ? bonus.bonusEntries : 0),
      0,
    );
  return {
    candidate: {
      userId: entry.userId,
      username: entry.username,
      joinedAt: entry.joinedAt,
      weight,
    },
  };
}

async function prepareDraw(
  dependencies: LifecycleDependencies,
  giveawayId: string,
  actorUserId: string | null,
  reroll: boolean,
): Promise<void> {
  const { pool, discord } = dependencies;
  let giveaway = await getGiveaway(pool, giveawayId);
  if (!giveaway || giveaway.status === "deleted") return;
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
  const priorWinners = reroll ? await previousWinnerIds(pool, giveaway.id) : new Set<string>();
  const eligibility = await mapConcurrent(entries, 8, async (entry) => {
    if (giveaway.endedAt && entry.joinedAt > giveaway.endedAt) {
      return { exclusion: { userId: entry.userId, reason: "joined_after_end" } };
    }
    const member = await discord.getMember(giveaway.guildId, entry.userId);
    return evaluateMember(giveaway, entry, member, priorWinners);
  });
  const candidates = eligibility.flatMap((result) =>
    result.candidate ? [result.candidate] : [],
  );
  const exclusions = eligibility.flatMap((result) =>
    result.exclusion ? [result.exclusion] : [],
  );
  const snapshot = await candidateHash(candidates);
  const info = await chainInfo(dependencies);
  const target = Math.ceil(Date.now() / 1000) + 15;
  const round = roundAtOrAfter(info, target);
  const draw = await createDrawCommitment(pool, {
    giveaway,
    candidates,
    exclusions,
    candidateHash: snapshot,
    chainHash: dependencies.drand.chainHash,
    round,
    beaconTime: roundTime(info, round),
    actorUserId,
  });
  const committed = await getGiveaway(pool, giveaway.id);
  if (committed) {
    await discord.refreshGiveaway(committed);
    await discord.postCommitment(committed, draw);
  }
}

async function deactivateOldRoleClaims(
  dependencies: LifecycleDependencies,
  giveaway: WorkerGiveaway,
  currentDrawId: string,
): Promise<void> {
  const claims = await dependencies.pool.query(
    `UPDATE role_grant_claims
     SET active = false
     WHERE giveaway_id = $1 AND draw_id <> $2 AND active
     RETURNING guild_id, user_id, role_id, bot_added`,
    [giveaway.id, currentDrawId],
  );
  for (const claim of claims.rows) {
    if (!claim.bot_added) continue;
    const other = await dependencies.pool.query(
      `SELECT 1 FROM role_grant_claims
       WHERE guild_id = $1 AND user_id = $2 AND role_id = $3 AND active
       LIMIT 1`,
      [claim.guild_id, claim.user_id, claim.role_id],
    );
    if (!other.rows[0]) {
      try {
        await dependencies.discord.removeRole(
          claim.guild_id as string,
          claim.user_id as string,
          claim.role_id as string,
        );
        await dependencies.pool.query(
          `UPDATE role_grant_claims SET removed_at = now()
           WHERE giveaway_id = $1 AND user_id = $2 AND role_id = $3 AND NOT active`,
          [giveaway.id, claim.user_id, claim.role_id],
        );
      } catch (error) {
        dependencies.logger.warn({ error, claim }, "could not remove prior prize role");
      }
    }
  }
}

async function grantPrizeRoles(
  dependencies: LifecycleDependencies,
  giveaway: WorkerGiveaway,
  draw: DrawRow,
  winners: Candidate[],
): Promise<void> {
  if (giveaway.prizeRoleIds.length === 0) return;
  for (const winner of winners) {
    const member = await dependencies.discord.getMember(giveaway.guildId, winner.userId);
    if (!member) continue;
    for (const roleId of giveaway.prizeRoleIds) {
      const alreadyOwned = member.roles.includes(roleId);
      let botAdded = false;
      let errorMessage: string | null = null;
      if (!alreadyOwned) {
        try {
          await dependencies.discord.addRole(giveaway.guildId, winner.userId, roleId);
          botAdded = true;
          member.roles.push(roleId);
        } catch (error) {
          errorMessage = error instanceof Error ? error.message : String(error);
        }
      }
      await dependencies.pool.query(
        `INSERT INTO role_ownership
         (guild_id, user_id, role_id, owned_before_bot)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (guild_id, user_id, role_id) DO UPDATE
         SET owned_before_bot = role_ownership.owned_before_bot OR EXCLUDED.owned_before_bot,
             last_observed_at = now()`,
        [giveaway.guildId, winner.userId, roleId, alreadyOwned],
      );
      await dependencies.pool.query(
        `INSERT INTO role_grant_claims
         (giveaway_id, draw_id, guild_id, user_id, role_id, bot_added, active,
          granted_at, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7,
                 CASE WHEN $8::text IS NULL THEN now() ELSE NULL END, $8)
         ON CONFLICT (draw_id, user_id, role_id) DO UPDATE
         SET bot_added = EXCLUDED.bot_added, active = EXCLUDED.active,
             granted_at = EXCLUDED.granted_at, error = EXCLUDED.error`,
        [
          giveaway.id,
          draw.id,
          giveaway.guildId,
          winner.userId,
          roleId,
          botAdded,
          errorMessage === null,
          errorMessage,
        ],
      );
    }
  }
}

async function completeDraw(
  dependencies: LifecycleDependencies,
  drawId: string,
): Promise<void> {
  const draw = await getDraw(dependencies.pool, drawId);
  if (!draw || draw.status === "complete") return;
  if (draw.drandBeaconTime.getTime() > Date.now()) {
    throw new Error("The committed drand round is not available yet.");
  }
  const giveaway = await getGiveaway(dependencies.pool, draw.giveawayId);
  if (!giveaway || giveaway.status === "deleted") return;
  const candidates = await getDrawCandidates(dependencies.pool, draw.id);
  const beacon = await fetchBeacon(dependencies.drand, draw.drandRound);
  const winners = await selectWeightedWinners(
    candidates,
    giveaway.winnerCount,
    beacon.randomness,
    draw.candidateHash,
    draw.drawNumber,
  );
  await persistWinners(
    dependencies.pool,
    draw,
    giveaway,
    winners,
    beacon as unknown as { randomness: string; signature: string; [key: string]: unknown },
  );
  if (draw.drawNumber > 1) {
    await deactivateOldRoleClaims(dependencies, giveaway, draw.id);
  }
  await grantPrizeRoles(dependencies, giveaway, draw, winners);
  const ended = await getGiveaway(dependencies.pool, giveaway.id);
  if (ended) {
    await dependencies.discord.refreshGiveaway(ended);
    await dependencies.discord.postWinners(
      ended,
      winners.map((winner) => winner.userId),
    );
  }
}

async function refreshGiveaway(
  dependencies: LifecycleDependencies,
  giveawayId: string,
): Promise<void> {
  const giveaway = await getGiveaway(dependencies.pool, giveawayId);
  if (giveaway && giveaway.status !== "deleted") {
    await dependencies.discord.refreshGiveaway(giveaway);
  }
}

async function deleteGiveaway(
  dependencies: LifecycleDependencies,
  giveawayId: string,
  actorUserId: string | null,
): Promise<void> {
  const giveaway = await getGiveaway(dependencies.pool, giveawayId);
  if (!giveaway || giveaway.status === "deleted") return;
  await dependencies.pool.query(
    `UPDATE giveaways SET status = 'deleted', deleted_at = now(), updated_at = now()
     WHERE id = $1`,
    [giveaway.id],
  );
  await dependencies.pool.query(
    `UPDATE jobs SET completed_at = now(), locked_at = NULL, locked_by = NULL
     WHERE giveaway_id = $1 AND completed_at IS NULL AND type <> 'delete_giveaway'`,
    [giveaway.id],
  );
  await dependencies.pool.query(
    `INSERT INTO audit_events
     (id, guild_id, giveaway_id, actor_user_id, action, source)
     VALUES ($1, $2, $3, $4, 'deleted', 'worker')`,
    [randomUUID(), giveaway.guildId, giveaway.id, actorUserId],
  );
  await dependencies.discord.tombstone(giveaway);
}

async function deleteUserData(
  dependencies: LifecycleDependencies,
  userId: string,
  requestId: string,
): Promise<void> {
  const pseudonym =
    "deleted:" +
    createHash("sha256")
      .update(dependencies.privacyHashSalt)
      .update(":")
      .update(userId)
      .digest("hex")
      .slice(0, 24);
  const client = await dependencies.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM web_sessions WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM oauth_accounts WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM privacy_consents WHERE user_id = $1", [userId]);
    await client.query(
      `UPDATE entries SET user_id = $2, username = 'Deleted User',
         global_name = NULL, avatar_hash = NULL WHERE user_id = $1`,
      [userId, pseudonym],
    );
    await client.query(
      `UPDATE entry_events SET user_id = $2, username = 'Deleted User'
       WHERE user_id = $1`,
      [userId, pseudonym],
    );
    await client.query(
      `UPDATE draw_candidates SET user_id = $2, username = 'Deleted User'
       WHERE user_id = $1`,
      [userId, pseudonym],
    );
    await client.query(
      `UPDATE draw_winners SET user_id = $2, username = 'Deleted User'
       WHERE user_id = $1`,
      [userId, pseudonym],
    );
    await client.query(
      `UPDATE audit_events SET actor_user_id = NULL,
         metadata = metadata || jsonb_build_object('actorDeleted', true)
       WHERE actor_user_id = $1`,
      [userId],
    );
    await client.query(
      `UPDATE giveaways
       SET creator_user_id = CASE WHEN creator_user_id = $1 THEN NULL ELSE creator_user_id END,
           host_user_id = CASE WHEN host_user_id = $1 THEN NULL ELSE host_user_id END
       WHERE creator_user_id = $1 OR host_user_id = $1`,
      [userId],
    );
    await client.query(
      `UPDATE data_deletion_requests SET status = 'complete', completed_at = now()
       WHERE id = $1`,
      [requestId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    await dependencies.pool.query(
      `UPDATE data_deletion_requests SET status = 'failed', error = $2 WHERE id = $1`,
      [requestId, error instanceof Error ? error.message : String(error)],
    );
    throw error;
  } finally {
    client.release();
  }
}

export async function processJob(
  dependencies: LifecycleDependencies,
  job: Job,
): Promise<void> {
  const actorUserId =
    typeof job.payload.actorUserId === "string" ? job.payload.actorUserId : null;
  switch (job.type) {
    case "start_giveaway":
      if (job.giveawayId) await startGiveaway(dependencies, job.giveawayId, actorUserId);
      return;
    case "refresh_giveaway":
      if (job.giveawayId) await refreshGiveaway(dependencies, job.giveawayId);
      return;
    case "end_giveaway":
      if (job.giveawayId) await prepareDraw(dependencies, job.giveawayId, actorUserId, false);
      return;
    case "reroll_giveaway":
      if (job.giveawayId) await prepareDraw(dependencies, job.giveawayId, actorUserId, true);
      return;
    case "complete_draw":
      if (typeof job.payload.drawId === "string") {
        await completeDraw(dependencies, job.payload.drawId);
      }
      return;
    case "delete_giveaway":
      if (job.giveawayId) await deleteGiveaway(dependencies, job.giveawayId, actorUserId);
      return;
    case "privacy_delete":
      if (
        typeof job.payload.userId === "string" &&
        typeof job.payload.requestId === "string"
      ) {
        await deleteUserData(dependencies, job.payload.userId, job.payload.requestId);
      }
      return;
    default:
      throw new Error(`Unknown job type: ${job.type}.`);
  }
}
