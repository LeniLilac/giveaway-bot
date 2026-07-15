import {
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  PermissionsBitField,
} from "discord.js";
import {
  assertBonusEntriesFit,
  assertDurationSeconds,
  assertRequiredMessages,
  assertScheduledWindow,
  assertWinnerCount,
} from "./limits.js";
import { fetchCurrentGuildOwnerId } from "./guild-owner.js";
import { assertPrizeRolesAwardable } from "./prize-roles.js";
import type { DraftPayload } from "./repository.js";

type DraftInteraction = ChatInputCommandInteraction | ButtonInteraction;

const SNOWFLAKE = /^\d{15,22}$/;

function assertRoleIdArray(
  value: unknown,
  label: string,
): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.some((roleId) => typeof roleId !== "string" || !SNOWFLAKE.test(roleId)) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`${label} contains invalid or duplicate role IDs.`);
  }
}

export function assertDraftPayloadShape(
  value: unknown,
): asserts value is DraftPayload {
  if (!value || typeof value !== "object") {
    throw new Error("The giveaway draft is invalid.");
  }
  const payload = value as Partial<DraftPayload>;
  if (
    typeof payload.prize !== "string" ||
    payload.prize.length < 1 ||
    payload.prize.length > 256
  ) {
    throw new Error("The giveaway prize is invalid.");
  }
  assertWinnerCount(payload.winnerCount);
  assertDurationSeconds(payload.durationSeconds);
  if (
    typeof payload.scheduledStartAt !== "string" ||
    !Number.isFinite(Date.parse(payload.scheduledStartAt))
  ) {
    throw new Error("The giveaway start time is invalid.");
  }
  assertScheduledWindow(payload.scheduledStartAt, payload.durationSeconds);
  if (
    typeof payload.channelId !== "string" ||
    !SNOWFLAKE.test(payload.channelId) ||
    typeof payload.hostUserId !== "string" ||
    !SNOWFLAKE.test(payload.hostUserId)
  ) {
    throw new Error("The giveaway destination or credited host is invalid.");
  }
  assertRoleIdArray(payload.requiredRoleIds, "Required roles");
  assertRoleIdArray(payload.prizeRoleIds, "Prize roles");
  if (
    !Array.isArray(payload.bonusRoles) ||
    payload.bonusRoles.some(
      (bonus) =>
        !bonus ||
        typeof bonus !== "object" ||
        typeof bonus.roleId !== "string" ||
        !SNOWFLAKE.test(bonus.roleId),
    ) ||
    new Set(payload.bonusRoles.map((bonus) => bonus.roleId)).size !==
      payload.bonusRoles.length
  ) {
    throw new Error("Bonus roles contain invalid or duplicate role IDs.");
  }
  assertBonusEntriesFit(payload.bonusRoles);
  assertRequiredMessages(payload.requiredMessages);
  if (
    payload.requiredRoleMode !== null &&
    payload.requiredRoleMode !== "all" &&
    payload.requiredRoleMode !== "one"
  ) {
    throw new Error("The required-role mode is invalid.");
  }
  if (
    payload.messageScope !== null &&
    payload.messageScope !== "all_time" &&
    payload.messageScope !== "since_start"
  ) {
    throw new Error("The message-history scope is invalid.");
  }
  if (payload.requiredRoleIds.length === 0 && payload.requiredRoleMode !== null) {
    throw new Error("The draft has a role mode without required roles.");
  }
  if (payload.requiredMessages === null && payload.messageScope !== null) {
    throw new Error("The draft has a message scope without a message requirement.");
  }
}

export async function assertDraftReferencesCurrent(
  interaction: DraftInteraction,
  payload: DraftPayload,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild || interaction.guildId !== guild.id) {
    throw new Error("This draft must be completed in its original server.");
  }

  let botMember;
  try {
    botMember = await guild.members.fetchMe({ force: true });
  } catch {
    throw new Error(
      "I could not refresh my current server permissions. Try again.",
    );
  }

  const referencedRoles = [
    ...payload.requiredRoleIds.map((roleId) => ({
      roleId,
      label: "Required roles",
    })),
    ...payload.prizeRoleIds.map((roleId) => ({
      roleId,
      label: "Prize roles",
    })),
    ...payload.bonusRoles.map(({ roleId }) => ({ roleId, label: "Bonus roles" })),
  ];
  if (referencedRoles.length > 0) {
    try {
      await guild.roles.fetch();
    } catch {
      throw new Error("I could not refresh this server's roles. Try again.");
    }
    for (const { roleId, label } of referencedRoles) {
      const role = guild.roles.cache.get(roleId);
      if (!role || role.id === guild.id) {
        throw new Error(`${label} contains an unknown or invalid role: ${roleId}.`);
      }
    }
    if (payload.prizeRoleIds.length > 0) {
      const currentOwnerId = await fetchCurrentGuildOwnerId(guild);
      assertPrizeRolesAwardable(interaction, payload.prizeRoleIds, currentOwnerId);
    }
  }

  let channel;
  try {
    channel = await guild.channels.fetch(payload.channelId);
  } catch {
    throw new Error("I could not refresh the giveaway channel. Try again.");
  }
  if (!channel || !channel.isTextBased() || !channel.isSendable()) {
    throw new Error("The giveaway channel no longer supports bot messages.");
  }
  if (
    channel.isThread() &&
    (channel.archived || channel.locked) &&
    !channel.sendable
  ) {
    throw new Error(
      "The giveaway thread is archived or locked and I cannot send in it.",
    );
  }
  const permissions = channel.permissionsFor(botMember);
  const sendPermission = channel.isThread()
    ? PermissionsBitField.Flags.SendMessagesInThreads
    : PermissionsBitField.Flags.SendMessages;
  if (
    !permissions?.has(PermissionsBitField.Flags.ViewChannel) ||
    !permissions.has(sendPermission)
  ) {
    throw new Error(
      channel.isThread()
        ? "I need View Channel and Send Messages in Threads in the giveaway thread."
        : "I need View Channel and Send Messages in the giveaway channel.",
    );
  }
  if (channel.isThread() && !channel.sendable) {
    throw new Error("The giveaway thread is not currently sendable.");
  }
}
