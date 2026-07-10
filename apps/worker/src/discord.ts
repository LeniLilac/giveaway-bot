import { REST, Routes, type APIMessage } from "discord.js";
import {
  COMPONENTS_V2_FLAG,
  giveawayComponents,
  proofPendingComponents,
  simpleNotice,
  winnerComponents,
} from "@lilac/discord-ui";
import type { DrawRow, WorkerGiveaway } from "./database.js";

export interface DiscordMember {
  user?: { id: string; username: string; bot?: boolean };
  roles: string[];
}

export class DiscordApi {
  readonly rest: REST;

  constructor(
    token: string,
    private readonly websiteUrl: string,
  ) {
    this.rest = new REST({ version: "10" }).setToken(token);
  }

  async getMember(guildId: string, userId: string): Promise<DiscordMember | null> {
    try {
      return (await this.rest.get(Routes.guildMember(guildId, userId))) as DiscordMember;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        error.status === 404
      ) {
        return null;
      }
      throw error;
    }
  }

  async postGiveaway(giveaway: WorkerGiveaway): Promise<APIMessage> {
    return (await this.rest.post(Routes.channelMessages(giveaway.channelId), {
      body: {
        flags: COMPONENTS_V2_FLAG,
        components: giveawayComponents(giveaway as never),
        allowed_mentions: { parse: [] },
      },
    })) as APIMessage;
  }

  async refreshGiveaway(giveaway: WorkerGiveaway): Promise<void> {
    if (!giveaway.messageId) return;
    await this.rest.patch(Routes.channelMessage(giveaway.channelId, giveaway.messageId), {
      body: {
        components: giveawayComponents(giveaway as never),
        allowed_mentions: { parse: [] },
      },
    });
  }

  async postCommitment(giveaway: WorkerGiveaway, draw: DrawRow): Promise<void> {
    if (!giveaway.messageId) return;
    await this.rest.post(Routes.channelMessages(giveaway.channelId), {
      body: {
        flags: COMPONENTS_V2_FLAG,
        components: proofPendingComponents(
          giveaway as never,
          draw.candidateHash,
          draw.drandRound,
          `${this.websiteUrl}/g/${giveaway.id}`,
        ),
        message_reference: {
          message_id: giveaway.messageId,
          channel_id: giveaway.channelId,
          guild_id: giveaway.guildId,
          fail_if_not_exists: false,
        },
        allowed_mentions: { parse: [] },
      },
    });
  }

  async postWinners(giveaway: WorkerGiveaway, winnerIds: string[]): Promise<void> {
    if (!giveaway.messageId) return;
    const messageUrl = `https://discord.com/channels/${giveaway.guildId}/${giveaway.channelId}/${giveaway.messageId}`;
    const websiteUrl = `${this.websiteUrl}/g/${giveaway.id}`;
    if (winnerIds.length === 0) {
      await this.replyComponents(
        giveaway,
        simpleNotice(
          "Giveaway ended",
          `No eligible participants remained for **${giveaway.prize}**.`,
          "warning",
        ),
        [],
      );
      return;
    }
    if (winnerIds.length > 1000) {
      await this.replyComponents(
        giveaway,
        winnerComponents(giveaway as never, winnerIds, messageUrl, websiteUrl),
        [],
      );
      return;
    }

    const groups: string[][] = [];
    let current: string[] = [];
    let length = 0;
    for (const userId of winnerIds) {
      const mentionLength = userId.length + 4;
      if (current.length >= 50 || length + mentionLength > 1800) {
        groups.push(current);
        current = [];
        length = 0;
      }
      current.push(userId);
      length += mentionLength;
    }
    if (current.length > 0) groups.push(current);
    for (const group of groups) {
      await this.replyComponents(
        giveaway,
        winnerComponents(giveaway as never, group, messageUrl, websiteUrl),
        group,
      );
    }
  }

  private async replyComponents(
    giveaway: WorkerGiveaway,
    components: unknown[],
    allowedUsers: string[],
  ): Promise<void> {
    await this.rest.post(Routes.channelMessages(giveaway.channelId), {
      body: {
        flags: COMPONENTS_V2_FLAG,
        components,
        message_reference: {
          message_id: giveaway.messageId!,
          channel_id: giveaway.channelId,
          guild_id: giveaway.guildId,
          fail_if_not_exists: false,
        },
        allowed_mentions: { parse: [], users: allowedUsers },
      },
    });
  }

  async tombstone(giveaway: WorkerGiveaway): Promise<void> {
    if (!giveaway.messageId) return;
    await this.rest.patch(Routes.channelMessage(giveaway.channelId, giveaway.messageId), {
      body: {
        components: simpleNotice(
          "Giveaway deleted",
          `This giveaway was deleted. Its public audit tombstone remains at ${this.websiteUrl}/g/${giveaway.id}.`,
          "danger",
        ),
        allowed_mentions: { parse: [] },
      },
    });
  }

  async addRole(guildId: string, userId: string, roleId: string): Promise<void> {
    await this.rest.put(Routes.guildMemberRole(guildId, userId, roleId));
  }

  async removeRole(guildId: string, userId: string, roleId: string): Promise<void> {
    await this.rest.delete(Routes.guildMemberRole(guildId, userId, roleId));
  }
}
