import { randomUUID } from "node:crypto";
import {
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type GuildMember,
  MessageFlags,
  PermissionsBitField,
} from "discord.js";
import type { Pool } from "pg";
import type pino from "pino";
import {
  COMPONENTS_V2_FLAG,
  consentComponents,
  draftReadyComponents,
  giveawayPickerComponents,
  requirementDecisionComponents,
  simpleNotice,
} from "@giveaway/discord-ui";
import { parseBonusRoles, parseDuration, parseRoleIds, parseStart } from "./parsing.js";
import {
  cancelDraft,
  createDraft,
  createGiveawayFromDraft,
  draftIsReady,
  enqueueAction,
  getAllowedRoleIds,
  getDraft,
  getGiveaway,
  hasConsent,
  joinGiveaway,
  leaveGiveaway,
  listGiveaways,
  recordConsent,
  updateDraftDecision,
  type DraftPayload,
  type GiveawayRecord,
} from "./repository.js";

const PRIVACY_POLICY_VERSION = "2026-07-10";
const EPHEMERAL_COMPONENT_FLAGS = MessageFlags.Ephemeral | COMPONENTS_V2_FLAG;
const DISCORD_EPOCH = 1_420_070_400_000n;

interface InteractionDependencies {
  client: Client;
  pool: Pool;
  logger: pino.Logger;
  botToken: string;
  websiteUrl: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected error occurred.";
}

function memberRoleIds(member: GuildMember | ChatInputCommandInteraction["member"]): string[] {
  if (!member) return [];
  if ("roles" in member && Array.isArray(member.roles)) return member.roles;
  if ("roles" in member && "cache" in member.roles) return [...member.roles.cache.keys()];
  return [];
}

async function isAuthorized(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  pool: Pool,
  command: string,
): Promise<boolean> {
  if (!interaction.guildId || !interaction.guild) return false;
  if (interaction.guild.ownerId === interaction.user.id) return true;
  const member = interaction.member;
  if (member && "permissions" in member) {
    const permissions = new PermissionsBitField(member.permissions);
    if (
      permissions.has(PermissionsBitField.Flags.Administrator) ||
      permissions.has(PermissionsBitField.Flags.ManageGuild)
    ) {
      return true;
    }
  }
  const allowed = await getAllowedRoleIds(pool, interaction.guildId, command);
  return allowed.some((roleId) => memberRoleIds(member).includes(roleId));
}

async function assertAuthorized(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  pool: Pool,
  command: string,
): Promise<void> {
  if (!(await isAuthorized(interaction, pool, command))) {
    throw new Error("You are not allowed to use this giveaway action.");
  }
}

function asView(giveaway: GiveawayRecord): never {
  return giveaway as never;
}

async function replyNotice(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  title: string,
  description: string,
  tone: "info" | "success" | "warning" | "danger" = "info",
): Promise<void> {
  const payload = {
    components: simpleNotice(title, description, tone) as never,
    flags: EPHEMERAL_COMPONENT_FLAGS,
  };
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp(payload);
  } else {
    await interaction.reply(payload);
  }
}

function validateRoles(
  interaction: ChatInputCommandInteraction,
  roleIds: string[],
  label: string,
): void {
  if (!interaction.guild) throw new Error("This command can only be used in a server.");
  for (const roleId of roleIds) {
    const role = interaction.guild.roles.cache.get(roleId);
    if (!role || role.id === interaction.guild.id) {
      throw new Error(`${label} contains an unknown or invalid role: ${roleId}.`);
    }
  }
}

async function handleCreate(
  interaction: ChatInputCommandInteraction,
  dependencies: InteractionDependencies,
): Promise<void> {
  const { pool } = dependencies;
  await assertAuthorized(interaction, pool, "create");
  if (!interaction.guildId || !interaction.guild || !interaction.channelId) {
    throw new Error("Giveaways can only be created in a server channel.");
  }

  const requiredRolesInput = interaction.options.getString("required_roles");
  const prizeRolesInput = interaction.options.getString("role_prizes");
  const bonusInput = interaction.options.getString("role_bonus_entries");
  const requiredRoleIds = parseRoleIds(requiredRolesInput);
  const prizeRoleIds = parseRoleIds(prizeRolesInput);
  const bonusRoles = parseBonusRoles(bonusInput);
  if (requiredRolesInput && requiredRoleIds.length === 0) {
    throw new Error("No valid required role mentions or IDs were found.");
  }
  if (prizeRolesInput && prizeRoleIds.length === 0) {
    throw new Error("No valid prize role mentions or IDs were found.");
  }
  validateRoles(interaction, requiredRoleIds, "Required roles");
  validateRoles(interaction, prizeRoleIds, "Prize roles");
  validateRoles(
    interaction,
    bonusRoles.map((role) => role.roleId),
    "Bonus roles",
  );
  for (const roleId of prizeRoleIds) {
    if (!interaction.guild.roles.cache.get(roleId)?.editable) {
      throw new Error(`I cannot award <@&${roleId}>. Move my bot role above it.`);
    }
  }

  const channel = interaction.options.getChannel("channel");
  const channelId = channel?.id ?? interaction.channelId;
  const resolvedChannel = interaction.guild.channels.cache.get(channelId);
  if (!resolvedChannel?.isTextBased()) {
    throw new Error("The giveaway channel must support messages.");
  }

  const now = new Date();
  const scheduledStart = parseStart(interaction.options.getString("start"), now);
  const durationSeconds = parseDuration(
    interaction.options.getString("duration", true),
    scheduledStart,
    now,
  );
  const payload: DraftPayload = {
    prize: interaction.options.getString("prize", true),
    winnerCount: interaction.options.getInteger("winners", true),
    durationSeconds,
    scheduledStartAt: scheduledStart.toISOString(),
    channelId,
    hostUserId: interaction.options.getUser("host")?.id ?? interaction.user.id,
    requiredRoleIds,
    prizeRoleIds,
    bonusRoles,
    requiredMessages: interaction.options.getInteger("required_messages"),
    requiredRoleMode: requiredRoleIds.length === 0 ? null : null,
    messageScope:
      interaction.options.getInteger("required_messages") === null ? null : null,
  };
  const draft = await createDraft(pool, interaction.guildId, interaction.user.id, payload);

  if (payload.requiredRoleIds.length > 0 || payload.requiredMessages !== null) {
    await interaction.reply({
      components: requirementDecisionComponents(
        draft.id,
        payload.requiredRoleIds.length > 0,
        payload.requiredMessages !== null,
      ) as never,
      flags: EPHEMERAL_COMPONENT_FLAGS,
    });
    return;
  }

  const giveaway = await createGiveawayFromDraft(
    pool,
    draft.id,
    interaction.user.id,
    interaction.guild.name,
    interaction.guild.icon,
  );
  await replyNotice(
    interaction,
    giveaway.status === "queued" ? "Giveaway queued" : "Giveaway created",
    `**${giveaway.prize}** will be posted <t:${Math.floor(giveaway.scheduledStartAt.getTime() / 1000)}:R>.`,
    "success",
  );
}

async function handleDraftButton(
  interaction: ButtonInteraction,
  dependencies: InteractionDependencies,
  parts: string[],
): Promise<void> {
  const { pool } = dependencies;
  const action = parts[1]!;
  const value = parts[2]!;
  const draftId = parts[3] ?? value;
  const draft = await getDraft(pool, draftId);
  if (!draft || draft.creatorUserId !== interaction.user.id) {
    throw new Error("This draft expired or belongs to someone else.");
  }

  if (action === "cancel") {
    await cancelDraft(pool, draft.id, interaction.user.id);
    await interaction.update({
      components: simpleNotice("Draft cancelled", "No giveaway was created.", "warning") as never,
    });
    return;
  }

  if (action === "roles") {
    await updateDraftDecision(pool, draft.id, "requiredRoleMode", value as "all" | "one");
  } else if (action === "messages") {
    await updateDraftDecision(
      pool,
      draft.id,
      "messageScope",
      value as "all_time" | "since_start",
    );
  } else if (action === "create") {
    if (!interaction.guild) throw new Error("The server is no longer available.");
    const giveaway = await createGiveawayFromDraft(
      pool,
      draft.id,
      interaction.user.id,
      interaction.guild.name,
      interaction.guild.icon,
    );
    await interaction.update({
      components: simpleNotice(
        "Giveaway queued",
        `**${giveaway.prize}** will be posted <t:${Math.floor(giveaway.scheduledStartAt.getTime() / 1000)}:R>.`,
        "success",
      ) as never,
    });
    return;
  }

  const updated = await getDraft(pool, draft.id);
  if (!updated) throw new Error("The draft could not be updated.");
  await interaction.update({
    components: draftIsReady(updated.payload)
      ? (draftReadyComponents(updated.id) as never)
      : (requirementDecisionComponents(
          updated.id,
          updated.payload.requiredRoleIds.length > 0,
          updated.payload.requiredMessages !== null,
        ) as never),
  });
}

function timestampToSnowflake(timestamp: number): string {
  return ((BigInt(timestamp) - DISCORD_EPOCH) << 22n).toString();
}

async function searchMessageCount(
  botToken: string,
  guildId: string,
  userId: string,
  since: Date | null,
): Promise<number> {
  const query = new URLSearchParams({ author_id: userId });
  if (since) query.set("min_id", timestampToSnowflake(since.getTime()));
  const url = `https://discord.com/api/v10/guilds/${guildId}/messages/search?${query.toString()}`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(url, {
      headers: { Authorization: `Bot ${botToken}` },
    });
    const body = (await response.json()) as {
      total_results?: number;
      retry_after?: number;
      message?: string;
    };
    if (response.status === 202 && body.retry_after) {
      await new Promise((resolve) => setTimeout(resolve, Math.ceil(body.retry_after! * 1000)));
      continue;
    }
    if (!response.ok) {
      throw new Error(body.message ?? "Discord could not search this server's messages.");
    }
    return body.total_results ?? 0;
  }
  throw new Error("Discord is still indexing messages. Try joining again shortly.");
}

async function queueRefresh(pool: Pool, giveawayId: string): Promise<void> {
  await pool.query(
    `INSERT INTO jobs (id, type, giveaway_id, run_at)
     VALUES ($1, 'refresh_giveaway', $2, now() + interval '2 seconds')`,
    [randomUUID(), giveawayId],
  );
}

async function performJoin(
  interaction: ButtonInteraction,
  dependencies: InteractionDependencies,
  giveaway: GiveawayRecord,
): Promise<void> {
  if (!interaction.guildId || !interaction.guild || !interaction.member) {
    throw new Error("This giveaway is no longer available in its server.");
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const roles = memberRoleIds(interaction.member);
  if (giveaway.requiredRoleIds.length > 0) {
    const checks = giveaway.requiredRoleIds.map((roleId) => roles.includes(roleId));
    const passes =
      giveaway.requiredRoleMode === "one" ? checks.some(Boolean) : checks.every(Boolean);
    if (!passes) {
      await interaction.editReply("You do not currently meet the required role condition.");
      return;
    }
  }
  if (giveaway.requiredMessages !== null) {
    const since =
      giveaway.messageScope === "since_start" ? giveaway.startedAt ?? giveaway.scheduledStartAt : null;
    const count = await searchMessageCount(
      dependencies.botToken,
      interaction.guildId,
      interaction.user.id,
      since,
    );
    if (count < giveaway.requiredMessages) {
      await interaction.editReply(
        `You have ${count} qualifying messages; ${giveaway.requiredMessages} are required.`,
      );
      return;
    }
  }
  const result = await joinGiveaway(dependencies.pool, giveaway.id, {
    id: interaction.user.id,
    username: interaction.user.username,
    globalName: interaction.user.globalName,
    avatar: interaction.user.avatar,
  });
  await queueRefresh(dependencies.pool, giveaway.id);
  await interaction.editReply(
    result.joined
      ? `You entered **${giveaway.prize}**. There are now ${result.participantCount} participants.`
      : "You are already entered in this giveaway.",
  );
}

async function handleGiveawayButton(
  interaction: ButtonInteraction,
  dependencies: InteractionDependencies,
  parts: string[],
): Promise<void> {
  const action = parts[1]!;
  if (action === "action") {
    const command = parts[2] as "start" | "end" | "reroll" | "delete";
    const giveawayId = parts[3]!;
    await assertAuthorized(interaction, dependencies.pool, command);
    const giveaway = await getGiveaway(dependencies.pool, giveawayId, interaction.guildId ?? undefined);
    if (!giveaway) throw new Error("Giveaway not found.");
    await enqueueAction(
      dependencies.pool,
      `${command}_giveaway` as
        | "start_giveaway"
        | "end_giveaway"
        | "reroll_giveaway"
        | "delete_giveaway",
      giveaway,
      interaction.user.id,
      "discord",
    );
    await replyNotice(
      interaction,
      "Action queued",
      `${command[0]!.toUpperCase()}${command.slice(1)} was queued for **${giveaway.prize}**.`,
      "success",
    );
    return;
  }

  const giveawayId = parts[2]!;
  const giveaway = await getGiveaway(dependencies.pool, giveawayId, interaction.guildId ?? undefined);
  if (!giveaway) throw new Error("Giveaway not found.");
  if (action === "join") {
    const consented = await hasConsent(
      dependencies.pool,
      giveaway.guildId,
      interaction.user.id,
      PRIVACY_POLICY_VERSION,
    );
    if (!consented) {
      await interaction.reply({
        components: consentComponents(giveaway.id) as never,
        flags: EPHEMERAL_COMPONENT_FLAGS,
      });
      return;
    }
    await performJoin(interaction, dependencies, giveaway);
    return;
  }
  if (action === "leave") {
    const result = await leaveGiveaway(dependencies.pool, giveaway.id, interaction.user.id);
    await queueRefresh(dependencies.pool, giveaway.id);
    await replyNotice(
      interaction,
      result.left ? "Entry removed" : "Not entered",
      result.left
        ? `You left **${giveaway.prize}**. There are now ${result.participantCount} participants.`
        : "You were not entered in this giveaway.",
      result.left ? "success" : "warning",
    );
  }
}

async function handleConsentButton(
  interaction: ButtonInteraction,
  dependencies: InteractionDependencies,
  parts: string[],
): Promise<void> {
  const action = parts[1]!;
  const giveawayId = parts[2]!;
  if (action === "cancel") {
    await interaction.update({
      components: simpleNotice("Entry cancelled", "No data was stored.", "warning") as never,
    });
    return;
  }
  const giveaway = await getGiveaway(
    dependencies.pool,
    giveawayId,
    interaction.guildId ?? undefined,
  );
  if (!giveaway || !interaction.guildId) throw new Error("Giveaway not found.");
  await recordConsent(
    dependencies.pool,
    interaction.guildId,
    interaction.user.id,
    PRIVACY_POLICY_VERSION,
  );
  await performJoin(interaction, dependencies, giveaway);
}

async function handleManagementCommand(
  interaction: ChatInputCommandInteraction,
  dependencies: InteractionDependencies,
  command: "start" | "end" | "reroll" | "delete",
): Promise<void> {
  await assertAuthorized(interaction, dependencies.pool, command);
  if (!interaction.guildId) throw new Error("This command requires a server.");
  const supplied =
    command === "start"
      ? interaction.options.getString("giveaway")
      : interaction.options.getString("message_id", true);
  if (!supplied && command === "start") {
    const queued = await listGiveaways(
      dependencies.pool,
      interaction.guildId,
      ["queued"],
      interaction.user.id,
    );
    await interaction.reply({
      components: giveawayPickerComponents(
        "Your queued giveaways",
        queued.map(asView),
        "start",
        dependencies.websiteUrl,
      ) as never,
      flags: EPHEMERAL_COMPONENT_FLAGS,
    });
    return;
  }
  const giveaway = await getGiveaway(dependencies.pool, supplied!, interaction.guildId);
  if (!giveaway) throw new Error("No giveaway matched that message or giveaway ID.");
  const validStatuses: Record<string, GiveawayRecord["status"][]> = {
    start: ["queued"],
    end: ["active"],
    reroll: ["ended"],
    delete: ["queued", "active", "ended", "error"],
  };
  if (!validStatuses[command]!.includes(giveaway.status)) {
    throw new Error(`This giveaway cannot be ${command}ed while it is ${giveaway.status}.`);
  }
  await enqueueAction(
    dependencies.pool,
    `${command}_giveaway` as
      | "start_giveaway"
      | "end_giveaway"
      | "reroll_giveaway"
      | "delete_giveaway",
    giveaway,
    interaction.user.id,
    "discord",
  );
  await replyNotice(
    interaction,
    "Action queued",
    `${command[0]!.toUpperCase()}${command.slice(1)} was queued for **${giveaway.prize}**.`,
    "success",
  );
}

async function handleListCommand(
  interaction: ChatInputCommandInteraction,
  dependencies: InteractionDependencies,
  kind: "queue" | "list",
): Promise<void> {
  await assertAuthorized(interaction, dependencies.pool, kind);
  if (!interaction.guildId) throw new Error("This command requires a server.");
  const giveaways = await listGiveaways(
    dependencies.pool,
    interaction.guildId,
    kind === "queue" ? ["queued"] : ["active", "starting", "ending"],
  );
  await interaction.reply({
    components: giveawayPickerComponents(
      kind === "queue" ? "Queued giveaways" : "Active giveaways",
      giveaways.map(asView),
      "view",
      dependencies.websiteUrl,
    ) as never,
    flags: EPHEMERAL_COMPONENT_FLAGS,
  });
}

export async function handleChatInput(
  interaction: ChatInputCommandInteraction,
  dependencies: InteractionDependencies,
): Promise<void> {
  if (interaction.commandName !== "giveaway") return;
  try {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "create") {
      await handleCreate(interaction, dependencies);
    } else if (subcommand === "queue" || subcommand === "list") {
      await handleListCommand(interaction, dependencies, subcommand);
    } else {
      await handleManagementCommand(
        interaction,
        dependencies,
        subcommand as "start" | "end" | "reroll" | "delete",
      );
    }
  } catch (error) {
    dependencies.logger.warn({ error, userId: interaction.user.id }, "interaction failed");
    await replyNotice(interaction, "Could not complete action", errorMessage(error), "danger");
  }
}

export async function handleButton(
  interaction: ButtonInteraction,
  dependencies: InteractionDependencies,
): Promise<void> {
  const parts = interaction.customId.split(":");
  try {
    if (parts[0] === "draft") {
      await handleDraftButton(interaction, dependencies, parts);
    } else if (parts[0] === "giveaway") {
      await handleGiveawayButton(interaction, dependencies, parts);
    } else if (parts[0] === "consent") {
      await handleConsentButton(interaction, dependencies, parts);
    }
  } catch (error) {
    dependencies.logger.warn({ error, userId: interaction.user.id }, "button failed");
    await replyNotice(interaction, "Could not complete action", errorMessage(error), "danger");
  }
}

export async function handleAutocomplete(
  interaction: AutocompleteInteraction,
  dependencies: InteractionDependencies,
): Promise<void> {
  if (interaction.commandName !== "giveaway" || interaction.options.getSubcommand() !== "start") {
    return;
  }
  if (!interaction.guildId) {
    await interaction.respond([]);
    return;
  }
  const focused = interaction.options.getFocused().toLowerCase();
  const queued = await listGiveaways(
    dependencies.pool,
    interaction.guildId,
    ["queued"],
    interaction.user.id,
    25,
  );
  await interaction.respond(
    queued
      .filter(
        (giveaway) =>
          giveaway.prize.toLowerCase().includes(focused) || giveaway.id.includes(focused),
      )
      .slice(0, 25)
      .map((giveaway) => ({
        name: `${giveaway.prize.slice(0, 75)} • ${giveaway.id.slice(0, 8)}`,
        value: giveaway.id,
      })),
  );
}
