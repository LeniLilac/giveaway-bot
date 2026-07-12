"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { canManageGuild, destroySession, getDiscordGuilds, requireSession } from "./auth";
import { db } from "./db";

const COMMANDS = ["create", "start", "end", "reroll", "delete", "queue", "list"] as const;
type Action = "start" | "end" | "reroll" | "delete";
const MAX_REROLL_WINNERS = 2_147_483_647;

function rerollWinnerCount(formData: FormData): number {
  const raw = String(formData.get("winnerCount") ?? "").trim();
  if (!/^\d+$/.test(raw)) throw new Error("A whole-number winner count is required.");
  const count = Number(raw);
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > MAX_REROLL_WINNERS
  ) {
    throw new Error(
      `Winner count must be between 1 and ${MAX_REROLL_WINNERS.toLocaleString()}.`,
    );
  }
  return count;
}

async function userCanRun(
  userId: string,
  guildId: string,
  command: string,
  creatorUserId: string | null,
): Promise<boolean> {
  if (creatorUserId === userId) return true;
  const session = await requireSession();
  const guilds = await getDiscordGuilds(session);
  const guild = guilds.find((candidate) => candidate.id === guildId);
  if (!guild) return false;
  if (canManageGuild(guild)) return true;
  const roleResult = await db.query(
    `SELECT role_id FROM guild_command_roles WHERE guild_id = $1 AND command = $2`,
    [guildId, command],
  );
  if (roleResult.rows.length === 0) return false;
  const response = await fetch(
    `https://discord.com/api/v10/guilds/${guildId}/members/${userId}`,
    {
      headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` },
      cache: "no-store",
    },
  );
  if (!response.ok) return false;
  const member = (await response.json()) as { roles: string[] };
  return roleResult.rows.some((row) => member.roles.includes(row.role_id as string));
}

export async function queueGiveawayAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const giveawayId = String(formData.get("giveawayId") ?? "");
  const action = String(formData.get("action") ?? "") as Action;
  if (!["start", "end", "reroll", "delete"].includes(action)) {
    throw new Error("Invalid giveaway action.");
  }
  const result = await db.query(
    `SELECT id, guild_id, creator_user_id, status FROM giveaways WHERE id = $1`,
    [giveawayId],
  );
  const giveaway = result.rows[0];
  if (!giveaway) throw new Error("Giveaway not found.");
  if (
    !(await userCanRun(
      session.id,
      giveaway.guild_id as string,
      action,
      (giveaway.creator_user_id as string | null) ?? null,
    ))
  ) {
    throw new Error("You are not allowed to run this action.");
  }
  const valid: Record<Action, string[]> = {
    start: ["queued"],
    end: ["active"],
    reroll: ["ended"],
    delete: ["queued", "active", "ended", "error"],
  };
  if (!valid[action].includes(giveaway.status as string)) {
    throw new Error(`This giveaway cannot be ${action}ed from its current status.`);
  }
  const winnerCount = action === "reroll" ? rerollWinnerCount(formData) : undefined;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    if (action === "reroll") {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
        [giveawayId],
      );
    }
    const locked = await client.query(
      "SELECT status FROM giveaways WHERE id = $1 FOR UPDATE",
      [giveawayId],
    );
    if (!valid[action].includes(locked.rows[0]?.status as string)) {
      throw new Error(`This giveaway cannot be ${action}ed from its current status.`);
    }
    if (action === "reroll") {
      const pending = await client.query(
        `SELECT EXISTS (
           SELECT 1 FROM draws
           WHERE giveaway_id = $1 AND status IN ('awaiting_beacon', 'drawing')
         ) OR EXISTS (
           SELECT 1 FROM jobs
           WHERE giveaway_id = $1 AND type = 'reroll_giveaway'
             AND completed_at IS NULL
         ) AS busy`,
        [giveawayId],
      );
      if (pending.rows[0]?.busy) {
        throw new Error("Another reroll is already queued or drawing.");
      }
    }
    const payload = {
      actorUserId: session.id,
      source: "web",
      ...(winnerCount === undefined ? {} : { winnerCount }),
    };
    await client.query(
      `INSERT INTO jobs (id, type, giveaway_id, payload, run_at)
       VALUES ($1, $2, $3, $4::jsonb, now())`,
      [randomUUID(), `${action}_giveaway`, giveawayId, JSON.stringify(payload)],
    );
    await client.query(
      `INSERT INTO audit_events
       (id, guild_id, giveaway_id, actor_user_id, action, source, metadata)
       VALUES ($1, $2, $3, $4, 'action_queued', 'web', $5::jsonb)`,
      [
        randomUUID(),
        giveaway.guild_id,
        giveawayId,
        session.id,
        JSON.stringify({
          requestedAction: action,
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
  revalidatePath("/dashboard");
  revalidatePath(`/dashboard/guild/${giveaway.guild_id as string}`);
  revalidatePath(`/g/${giveawayId}`);
}

export async function saveCommandRoles(formData: FormData): Promise<void> {
  const session = await requireSession();
  const guildId = String(formData.get("guildId") ?? "");
  const guilds = await getDiscordGuilds(session);
  const guild = guilds.find((candidate) => candidate.id === guildId);
  if (!guild || !canManageGuild(guild)) {
    throw new Error("Manage Server is required to change command permissions.");
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO guild_settings (guild_id, guild_name, guild_icon)
       VALUES ($1, $2, $3)
       ON CONFLICT (guild_id) DO UPDATE
       SET guild_name = EXCLUDED.guild_name, guild_icon = EXCLUDED.guild_icon,
           updated_at = now()`,
      [guild.id, guild.name, guild.icon],
    );
    await client.query("DELETE FROM guild_command_roles WHERE guild_id = $1", [guildId]);
    for (const command of COMMANDS) {
      const input = String(formData.get(`roles_${command}`) ?? "");
      const roleIds = [
        ...new Set(Array.from(input.matchAll(/\d{15,22}/g), (match) => match[0])),
      ];
      for (const roleId of roleIds) {
        await client.query(
          `INSERT INTO guild_command_roles (guild_id, command, role_id)
           VALUES ($1, $2, $3)`,
          [guildId, command, roleId],
        );
      }
    }
    await client.query(
      `INSERT INTO audit_events
       (id, guild_id, actor_user_id, action, source)
       VALUES ($1, $2, $3, 'command_permissions_updated', 'web')`,
      [randomUUID(), guildId, session.id],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  revalidatePath(`/dashboard/guild/${guildId}`);
}

export async function requestDataDeletion(): Promise<void> {
  const session = await requireSession();
  const id = randomUUID();
  await db.query(
    `INSERT INTO data_deletion_requests (id, user_id, status)
     VALUES ($1, $2, 'queued')`,
    [id, session.id],
  );
  await db.query(
    `INSERT INTO jobs (id, type, payload, run_at, idempotency_key)
     VALUES ($1, 'privacy_delete', $2::jsonb, now(), $3)`,
    [randomUUID(), JSON.stringify({ userId: session.id, requestId: id }), `privacy:${session.id}`],
  );
  await destroySession();
  redirect("/privacy?deletion=requested");
}

export async function logoutAction(): Promise<void> {
  await destroySession();
  redirect("/");
}
