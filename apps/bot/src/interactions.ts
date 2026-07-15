import {
  ActionRowBuilder,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type GuildMember,
  MessageFlags,
  ModalBuilder,
  type ModalSubmitInteraction,
  PermissionsBitField,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import type { Pool } from "pg";
import type pino from "pino";
import {
  COMPONENTS_V2_FLAG,
  MAX_PICKER_GIVEAWAYS,
  draftReadyComponents,
  giveawayPickerComponents,
  requirementDecisionComponents,
  simpleNotice,
} from "@lilac/discord-ui";
import {
  ACTION_JOB_TYPES,
  assertActionAllowed,
  parseManagementAction,
  type ManagementAction,
} from "./action-policy.js";
import {
  parseDraftComponentId,
  parseGiveawayComponentId,
  parseRerollModalId,
  type DraftComponentId,
  type GiveawayComponentId,
  type PickerKind,
} from "./component-ids.js";
import {
  assertDraftPayloadShape,
  assertDraftReferencesCurrent,
} from "./draft-validation.js";
import { fetchCurrentGuildOwnerId } from "./guild-owner.js";
import { searchMessageCount } from "./message-search.js";
import { parseBonusRoles, parseDuration, parseRoleIds, parseStart } from "./parsing.js";
import { parseRerollWinnerCount } from "./reroll.js";
import {
  cancelDraft,
  createDraft,
  createGiveawayFromDraft,
  draftIsReady,
  enqueueAction,
  getAllowedRoleIds,
  getDraft,
  getGiveaway,
  joinGiveaway,
  leaveGiveaway,
  listGiveaways,
  updateDraftDecision,
  type DraftRecord,
  type DraftPayload,
  type GiveawayRecord,
} from "./repository.js";

const EPHEMERAL_COMPONENT_FLAGS = MessageFlags.Ephemeral | COMPONENTS_V2_FLAG;
const PICKER_PAGE_SIZE = MAX_PICKER_GIVEAWAYS;
const componentResponseInteractions = new WeakSet<object>();

interface InteractionDependencies {
  client: Client;
  pool: Pool;
  logger: pino.Logger;
  botToken: string;
  privacyHashSalt: string;
  websiteUrl: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected error occurred.";
}

function memberRoleIds(
  member:
    | GuildMember
    | ChatInputCommandInteraction["member"]
    | ButtonInteraction["member"]
    | ModalSubmitInteraction["member"],
): string[] {
  if (!member) return [];
  if ("roles" in member && Array.isArray(member.roles)) return member.roles;
  if ("roles" in member && "cache" in member.roles) return [...member.roles.cache.keys()];
  return [];
}

export async function isAuthorized(
  interaction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction,
  pool: Pool,
  command: string,
): Promise<boolean> {
  if (!interaction.guildId || !interaction.guild) return false;
  const member = interaction.member;
  if (member && "permissions" in member) {
    const bits =
      typeof member.permissions === "string"
        ? BigInt(member.permissions)
        : member.permissions.bitfield;
    const permissions = new PermissionsBitField(bits);
    if (
      permissions.has(PermissionsBitField.Flags.Administrator) ||
      permissions.has(PermissionsBitField.Flags.ManageGuild)
    ) {
      return true;
    }
  }
  const allowed = await getAllowedRoleIds(pool, interaction.guildId, command);
  if (allowed.some((roleId) => memberRoleIds(member).includes(roleId))) return true;
  if (interaction.guild.ownerId !== interaction.user.id) return false;
  return (await fetchCurrentGuildOwnerId(interaction.guild)) === interaction.user.id;
}

async function assertAuthorized(
  interaction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction,
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

async function buildPicker(
  dependencies: InteractionDependencies,
  guildId: string,
  userId: string,
  kind: PickerKind,
  requestedPage: number,
): Promise<never> {
  const page = Math.max(0, Math.floor(requestedPage));
  const statuses: GiveawayRecord["status"][] =
    kind === "reroll"
      ? ["ended"]
      : kind === "queue" || kind === "start"
      ? ["queued"]
      : ["active", "starting", "ending"];
  const records = await listGiveaways(
    dependencies.pool,
    guildId,
    statuses,
    kind === "start" ? userId : undefined,
    PICKER_PAGE_SIZE + 1,
    page * PICKER_PAGE_SIZE,
  );
  return giveawayPickerComponents(
    kind === "start"
      ? "Your queued giveaways"
      : kind === "reroll"
        ? "Completed giveaways"
      : kind === "queue"
        ? "Queued giveaways"
        : "Active giveaways",
    records.slice(0, PICKER_PAGE_SIZE).map(asView),
    kind === "start" ? "start" : kind === "reroll" ? "reroll" : "view",
    dependencies.websiteUrl,
    {
      page,
      pageAction: kind,
      hasPrevious: page > 0,
      hasNext: records.length > PICKER_PAGE_SIZE,
    },
  ) as never;
}

export async function acknowledgeComponentReply(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (interaction.replied || interaction.deferred) return;
  await interaction.reply({
    components: simpleNotice("Working", "Checking the current giveaway state…") as never,
    flags: EPHEMERAL_COMPONENT_FLAGS,
  });
  componentResponseInteractions.add(interaction);
}

async function deferComponentUpdate(interaction: ButtonInteraction): Promise<void> {
  if (interaction.replied || interaction.deferred) return;
  await interaction.deferUpdate();
  componentResponseInteractions.add(interaction);
}

async function replaceComponents(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  components: never,
): Promise<void> {
  if (interaction.replied || interaction.deferred) {
    await interaction.editReply({ components });
    return;
  }
  if (interaction.isButton()) {
    await interaction.update({ components });
  } else {
    await interaction.reply({ components, flags: EPHEMERAL_COMPONENT_FLAGS });
    componentResponseInteractions.add(interaction);
  }
}

export async function publishComponentReply(
  interaction: ChatInputCommandInteraction,
  components: never,
): Promise<void> {
  if (!interaction.replied && !interaction.deferred) {
    await interaction.reply({ components, flags: COMPONENTS_V2_FLAG });
    return;
  }
  await interaction.followUp({ components, flags: COMPONENTS_V2_FLAG });
  await interaction.deleteReply().catch(() => undefined);
}

export async function replyNotice(
  interaction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction,
  title: string,
  description: string,
  tone: "info" | "success" | "warning" | "danger" = "info",
): Promise<void> {
  const components = simpleNotice(title, description, tone) as never;
  if (componentResponseInteractions.has(interaction)) {
    await interaction.editReply({ components });
    return;
  }
  if (interaction.deferred) {
    await interaction.editReply({
      content: `**${title}**\n${description}`,
      components: [],
    });
    return;
  }
  const payload = {
    components,
    flags: EPHEMERAL_COMPONENT_FLAGS,
  };
  if (interaction.replied) {
    await interaction.followUp(payload);
  } else {
    await interaction.reply(payload);
  }
}

function rerollModal(giveaway: GiveawayRecord): ModalBuilder {
  const count = new TextInputBuilder()
    .setCustomId("winner_count")
    .setLabel("Number of fresh winners")
    .setPlaceholder(`Winner count for ${giveaway.prize.slice(0, 60)}`)
    .setMinLength(1)
    .setMaxLength(10)
    .setRequired(true)
    .setStyle(TextInputStyle.Short);
  return new ModalBuilder()
    .setCustomId(`giveaway:reroll:${giveaway.id}`)
    .setTitle("Reroll giveaway")
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(count));
}

async function showRerollModal(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  giveaway: GiveawayRecord,
): Promise<void> {
  assertActionAllowed("reroll", giveaway.status);
  await interaction.showModal(rerollModal(giveaway));
}

async function queueReroll(
  interaction: ChatInputCommandInteraction | ModalSubmitInteraction,
  dependencies: InteractionDependencies,
  giveaway: GiveawayRecord,
  winnerCount: number,
): Promise<void> {
  assertActionAllowed("reroll", giveaway.status);
  await enqueueAction(
    dependencies.pool,
    "reroll_giveaway",
    giveaway,
    interaction.user.id,
    "discord",
    dependencies.privacyHashSalt,
    winnerCount,
  );
  await replyNotice(
    interaction,
    "Reroll queued",
    `A fresh draw for **${winnerCount.toLocaleString()}** winner${winnerCount === 1 ? "" : "s"} was queued for **${giveaway.prize}**.`,
    "success",
  );
}

async function commitDraft(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  dependencies: InteractionDependencies,
  draft: DraftRecord,
): Promise<GiveawayRecord> {
  if (!interaction.guild || interaction.guildId !== draft.guildId) {
    throw new Error("This draft must be completed in its original server.");
  }
  await assertAuthorized(interaction, dependencies.pool, "create");
  assertDraftPayloadShape(draft.payload);
  if (!draftIsReady(draft.payload)) {
    throw new Error("Requirement choices are incomplete.");
  }
  await assertDraftReferencesCurrent(interaction, draft.payload);
  return createGiveawayFromDraft(
    dependencies.pool,
    draft.id,
    interaction.user.id,
    interaction.guild.name,
    interaction.guild.icon,
    dependencies.privacyHashSalt,
  );
}

async function handleCreate(
  interaction: ChatInputCommandInteraction,
  dependencies: InteractionDependencies,
): Promise<void> {
  const { pool } = dependencies;
  await acknowledgeComponentReply(interaction);
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
  const channel = interaction.options.getChannel("channel");
  const channelId = channel?.id ?? interaction.channelId;

  const now = new Date();
  const scheduledStart = parseStart(interaction.options.getString("start"), now);
  const durationSeconds = parseDuration(
    interaction.options.getString("duration", true),
    scheduledStart,
    now,
  );
  const requiredMessages = interaction.options.getInteger("required_messages");
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
    requiredMessages,
    requiredRoleMode: requiredRoleIds.length === 0 ? null : null,
    messageScope: requiredMessages === null ? null : null,
  };
  assertDraftPayloadShape(payload);
  await assertDraftReferencesCurrent(interaction, payload);
  const draft = await createDraft(
    pool,
    interaction.guildId,
    interaction.user.id,
    payload,
    dependencies.privacyHashSalt,
  );

  if (payload.requiredRoleIds.length > 0 || payload.requiredMessages !== null) {
    await replaceComponents(
      interaction,
      requirementDecisionComponents(
        draft.id,
        payload.requiredRoleIds.length > 0,
        payload.requiredMessages !== null,
      ) as never,
    );
    return;
  }

  const giveaway = await commitDraft(interaction, dependencies, draft);
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
  component: DraftComponentId,
): Promise<void> {
  const { pool } = dependencies;
  await deferComponentUpdate(interaction);
  const draft = await getDraft(pool, component.draftId);
  if (!draft || draft.creatorUserId !== interaction.user.id) {
    throw new Error("This draft expired or belongs to someone else.");
  }

  if (component.type === "cancel") {
    await cancelDraft(pool, draft.id, interaction.user.id);
    await replaceComponents(
      interaction,
      simpleNotice("Draft cancelled", "No giveaway was created.", "warning") as never,
    );
    return;
  }

  if (component.type === "roles") {
    await updateDraftDecision(pool, draft.id, "requiredRoleMode", component.value);
  } else if (component.type === "messages") {
    await updateDraftDecision(
      pool,
      draft.id,
      "messageScope",
      component.value,
    );
  } else if (component.type === "create") {
    const giveaway = await commitDraft(interaction, dependencies, draft);
    await replaceComponents(
      interaction,
      simpleNotice(
        "Giveaway queued",
        `**${giveaway.prize}** will be posted <t:${Math.floor(giveaway.scheduledStartAt.getTime() / 1000)}:R>.`,
        "success",
      ) as never,
    );
    return;
  }

  const updated = await getDraft(pool, draft.id);
  if (!updated) throw new Error("The draft could not be updated.");
  await replaceComponents(
    interaction,
    draftIsReady(updated.payload)
      ? (draftReadyComponents(updated.id) as never)
      : (requirementDecisionComponents(
          updated.id,
          updated.payload.requiredRoleIds.length > 0,
          updated.payload.requiredMessages !== null,
        ) as never),
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
  if (giveaway.status !== "active" || giveaway.endsAt.getTime() <= Date.now()) {
    throw new Error("This giveaway is not active.");
  }
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
  }, dependencies.privacyHashSalt);
  await interaction.editReply(
    result.joined
      ? `You entered **${giveaway.prize}**. There are now ${result.participantCount} participants.`
      : "You are already entered in this giveaway.",
  );
}

async function handleGiveawayButton(
  interaction: ButtonInteraction,
  dependencies: InteractionDependencies,
  component: GiveawayComponentId,
): Promise<void> {
  if (!interaction.guildId) throw new Error("This giveaway action requires a server.");
  if (component.type === "page") {
    if (component.kind === "list") {
      await assertAuthorized(interaction, dependencies.pool, component.kind);
    }
    await deferComponentUpdate(interaction);
    if (component.kind !== "list") {
      await assertAuthorized(interaction, dependencies.pool, component.kind);
    }
    await replaceComponents(
      interaction,
      await buildPicker(
        dependencies,
        interaction.guildId,
        interaction.user.id,
        component.kind,
        component.page,
      ),
    );
    return;
  }
  if (component.type === "action") {
    if (component.action !== "reroll") {
      await deferComponentUpdate(interaction);
    }
    await assertAuthorized(interaction, dependencies.pool, component.action);
    const giveaway = await getGiveaway(
      dependencies.pool,
      component.giveawayId,
      interaction.guildId,
    );
    if (!giveaway) throw new Error("Giveaway not found.");
    assertActionAllowed(component.action, giveaway.status);
    if (component.action === "reroll") {
      await showRerollModal(interaction, giveaway);
      return;
    }
    await enqueueAction(
      dependencies.pool,
      ACTION_JOB_TYPES[component.action],
      giveaway,
      interaction.user.id,
      "discord",
      dependencies.privacyHashSalt,
    );
    await replyNotice(
      interaction,
      "Action queued",
      `${component.action[0]!.toUpperCase()}${component.action.slice(1)} was queued for **${giveaway.prize}**.`,
      "success",
    );
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const giveaway = await getGiveaway(
    dependencies.pool,
    component.giveawayId,
    interaction.guildId,
  );
  if (!giveaway) throw new Error("Giveaway not found.");
  if (component.type === "join") {
    await performJoin(interaction, dependencies, giveaway);
    return;
  }
  const result = await leaveGiveaway(
    dependencies.pool,
    giveaway.id,
    interaction.user.id,
    dependencies.privacyHashSalt,
  );
  await replyNotice(
    interaction,
    result.left ? "Entry removed" : "Not entered",
    result.left
      ? `You left **${giveaway.prize}**. There are now ${result.participantCount} participants.`
      : "You were not entered in this giveaway.",
    result.left ? "success" : "warning",
  );
}

async function handleManagementCommand(
  interaction: ChatInputCommandInteraction,
  dependencies: InteractionDependencies,
  command: ManagementAction,
): Promise<void> {
  if (!interaction.guildId) throw new Error("This command requires a server.");
  if (command === "reroll") {
    const supplied = interaction.options.getString("message_id");
    const optionCount = interaction.options.getInteger("winners");
    if (!supplied || optionCount !== null) {
      await acknowledgeComponentReply(interaction);
    }
    await assertAuthorized(interaction, dependencies.pool, command);
    if (!supplied) {
      if (optionCount !== null) {
        throw new Error("Provide a message ID with winners, or leave both blank to use the picker.");
      }
      await replaceComponents(
        interaction,
        await buildPicker(
          dependencies,
          interaction.guildId,
          interaction.user.id,
          "reroll",
          0,
        ),
      );
      return;
    }
    const giveaway = await getGiveaway(dependencies.pool, supplied, interaction.guildId);
    if (!giveaway) throw new Error("No giveaway matched that message or giveaway ID.");
    if (optionCount === null) {
      await showRerollModal(interaction, giveaway);
      return;
    }
    await queueReroll(
      interaction,
      dependencies,
      giveaway,
      parseRerollWinnerCount(optionCount),
    );
    return;
  }
  await acknowledgeComponentReply(interaction);
  await assertAuthorized(interaction, dependencies.pool, command);
  const supplied =
    command === "start"
      ? interaction.options.getString("giveaway")
      : interaction.options.getString("message_id", true);
  if (!supplied && command === "start") {
    await replaceComponents(
      interaction,
      await buildPicker(
        dependencies,
        interaction.guildId,
        interaction.user.id,
        "start",
        0,
      ),
    );
    return;
  }
  const giveaway = await getGiveaway(dependencies.pool, supplied!, interaction.guildId);
  if (!giveaway) throw new Error("No giveaway matched that message or giveaway ID.");
  assertActionAllowed(command, giveaway.status);
  await enqueueAction(
    dependencies.pool,
    ACTION_JOB_TYPES[command],
    giveaway,
    interaction.user.id,
    "discord",
    dependencies.privacyHashSalt,
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
  await acknowledgeComponentReply(interaction);
  await assertAuthorized(interaction, dependencies.pool, kind);
  if (!interaction.guildId) throw new Error("This command requires a server.");
  const picker = await buildPicker(
    dependencies,
    interaction.guildId,
    interaction.user.id,
    kind,
    0,
  );
  if (kind === "list") {
    await publishComponentReply(interaction, picker);
  } else {
    await replaceComponents(interaction, picker);
  }
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
        parseManagementAction(subcommand),
      );
    }
  } catch (error) {
    dependencies.logger.warn({ error, guildId: interaction.guildId }, "interaction failed");
    await replyNotice(interaction, "Could not complete action", errorMessage(error), "danger");
  }
}

export async function handleButton(
  interaction: ButtonInteraction,
  dependencies: InteractionDependencies,
): Promise<void> {
  try {
    if (interaction.customId.startsWith("draft:")) {
      await handleDraftButton(
        interaction,
        dependencies,
        parseDraftComponentId(interaction.customId),
      );
    } else if (interaction.customId.startsWith("giveaway:")) {
      await handleGiveawayButton(
        interaction,
        dependencies,
        parseGiveawayComponentId(interaction.customId),
      );
    } else {
      throw new Error("Unknown component action.");
    }
  } catch (error) {
    dependencies.logger.warn({ error, guildId: interaction.guildId }, "button failed");
    await replyNotice(interaction, "Could not complete action", errorMessage(error), "danger");
  }
}

export async function handleModalSubmit(
  interaction: ModalSubmitInteraction,
  dependencies: InteractionDependencies,
): Promise<void> {
  try {
    const giveawayId = parseRerollModalId(interaction.customId);
    if (!interaction.guildId) throw new Error("Invalid reroll request.");
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await assertAuthorized(interaction, dependencies.pool, "reroll");
    const giveaway = await getGiveaway(
      dependencies.pool,
      giveawayId,
      interaction.guildId,
    );
    if (!giveaway) throw new Error("Giveaway not found.");
    const winnerCount = parseRerollWinnerCount(
      interaction.fields.getTextInputValue("winner_count"),
    );
    await queueReroll(interaction, dependencies, giveaway, winnerCount);
  } catch (error) {
    dependencies.logger.warn({ error, guildId: interaction.guildId }, "modal failed");
    await replyNotice(interaction, "Could not complete action", errorMessage(error), "danger");
  }
}

export async function handleAutocomplete(
  interaction: AutocompleteInteraction,
  dependencies: InteractionDependencies,
): Promise<void> {
  try {
    if (
      interaction.commandName !== "giveaway" ||
      interaction.options.getSubcommand() !== "start"
    ) {
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
            giveaway.prize.toLowerCase().includes(focused) ||
            giveaway.id.includes(focused),
        )
        .slice(0, 25)
        .map((giveaway) => ({
          name: `${giveaway.prize.slice(0, 75)} • ${giveaway.id.slice(0, 8)}`,
          value: giveaway.id,
        })),
    );
  } catch (error) {
    dependencies.logger.warn({ error }, "autocomplete failed");
    if (!interaction.responded) await interaction.respond([]);
  }
}
