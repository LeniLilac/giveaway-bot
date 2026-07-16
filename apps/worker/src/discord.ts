import { createHash } from "node:crypto";
import { REST, Routes, type APIMessage } from "discord.js";
import {
  COMPONENTS_V2_FLAG,
  giveawayComponents,
  simpleNotice,
  winnerComponents,
} from "@lilac/discord-ui";
import type { WorkerGiveaway } from "./database.js";
import type { MemberSnapshotClient } from "./member-snapshot.js";
import { searchMessageCount as searchDiscordMessageCount } from "./message-search.js";

export interface DiscordMember {
  user?: { id: string; username: string; bot?: boolean };
  roles: string[];
}

const DISCORD_SEND_TIMEOUT_MS = 60_000;
const DISCORD_RECONCILIATION_PAGE_TIMEOUT_MS = 30_000;

export class DiscordApi {
  readonly rest: REST;

  constructor(
    private readonly token: string,
    private readonly websiteUrl: string,
    private readonly expectedAuthorId: string,
    private readonly memberSnapshotClient?: MemberSnapshotClient,
  ) {
    this.rest = new REST({ version: "10", timeout: 30_000 }).setToken(this.token);
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

  async getMembers(
    guildId: string,
    userIds: string[],
  ): Promise<Map<string, DiscordMember | null>> {
    if (this.memberSnapshotClient) {
      return this.memberSnapshotClient.getMembers(guildId, userIds);
    }
    const members = new Map<string, DiscordMember | null>();
    let next = 0;
    const workers = Array.from({ length: Math.min(8, userIds.length) }, async () => {
      while (next < userIds.length) {
        const index = next;
        next += 1;
        const userId = userIds[index]!;
        members.set(userId, await this.getMember(guildId, userId));
      }
    });
    await Promise.all(workers);
    return members;
  }

  searchMessageCount(guildId: string, userId: string, since: Date | null): Promise<number> {
    return searchDiscordMessageCount(this.token, guildId, userId, since);
  }

  async postGiveaway(
    giveaway: WorkerGiveaway,
    nonce: string,
    redactedUserIds: string[] = [],
  ): Promise<APIMessage> {
    return (await this.rest.post(Routes.channelMessages(giveaway.channelId), {
      signal: AbortSignal.timeout(DISCORD_SEND_TIMEOUT_MS),
      body: {
        flags: COMPONENTS_V2_FLAG,
        components: this.renderGiveawayComponents(giveaway, redactedUserIds),
        allowed_mentions: { parse: [] },
        nonce,
        enforce_nonce: true,
      },
    })) as APIMessage;
  }

  async refreshGiveaway(
    giveaway: WorkerGiveaway,
    redactedUserIds: string[] = [],
  ): Promise<void> {
    if (!giveaway.messageId) return;
    await this.rest.patch(Routes.channelMessage(giveaway.channelId, giveaway.messageId), {
      body: {
        components: this.renderGiveawayComponents(giveaway, redactedUserIds),
        allowed_mentions: { parse: [] },
      },
    });
  }

  async postWinners(
    giveaway: WorkerGiveaway,
    winnerIds: string[],
    redactedWinnerCount: number,
    drawId: string,
    deliveredOrdinals: Set<number>,
    onDeliver: (
      ordinal: number,
      nonce: string,
      send: () => Promise<APIMessage>,
    ) => Promise<void>,
  ): Promise<void> {
    if (!giveaway.messageId) return;
    const messageUrl = `https://discord.com/channels/${giveaway.guildId}/${giveaway.channelId}/${giveaway.messageId}`;
    const websiteUrl = `${this.websiteUrl}/g/${giveaway.id}`;
    if (winnerIds.length === 0) {
      await this.deliverWinnerBatch(
        giveaway,
        simpleNotice(
          redactedWinnerCount > 0 ? "Giveaway winners" : "Giveaway ended",
          redactedWinnerCount > 0
            ? `Winner identities for **${giveaway.prize}** were privacy-deleted. [Inspect the public result](${websiteUrl}).`
            : `No eligible participants remained for **${giveaway.prize}**.`,
          redactedWinnerCount > 0 ? "info" : "warning",
        ),
        [],
        drawId,
        0,
        deliveredOrdinals,
        onDeliver,
      );
      return;
    }
    const totalWinnerCount = winnerIds.length + redactedWinnerCount;
    if (totalWinnerCount > 1000) {
      await this.deliverWinnerBatch(
        giveaway,
        simpleNotice(
          "Giveaway winners",
          `**${totalWinnerCount.toLocaleString()}** winners were selected for **${giveaway.prize}**. [View the complete list](${websiteUrl}).`,
          "success",
        ),
        [],
        drawId,
        0,
        deliveredOrdinals,
        onDeliver,
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
    for (const [ordinal, group] of groups.entries()) {
      await this.deliverWinnerBatch(
        giveaway,
        winnerComponents(giveaway as never, group, messageUrl, websiteUrl),
        group,
        drawId,
        ordinal,
        deliveredOrdinals,
        onDeliver,
      );
    }
    if (redactedWinnerCount > 0) {
      await this.deliverWinnerBatch(
        giveaway,
        simpleNotice(
          "Additional privacy-redacted winners",
          `**${redactedWinnerCount.toLocaleString()}** of **${totalWinnerCount.toLocaleString()}** winner identities for **${giveaway.prize}** were privacy-deleted. [Inspect the public result](${websiteUrl}).`,
          "info",
        ),
        [],
        drawId,
        groups.length,
        deliveredOrdinals,
          onDeliver,
      );
    }
  }

  async redactWinnerMessage(
    channelId: string,
    messageId: string,
    giveawayId: string,
    prize: string,
  ): Promise<void> {
    try {
      await this.rest.patch(Routes.channelMessage(channelId, messageId), {
        body: {
          components: simpleNotice(
            "Giveaway winners",
            `Winner identities for **${prize}** were privacy-deleted. [Inspect the public result](${this.websiteUrl}/g/${giveawayId}).`,
            "info",
          ),
          allowed_mentions: { parse: [] },
        },
      });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        error.status === 404
      ) {
        return;
      }
      throw error;
    }
  }

  async redactGiveawayIdentity(
    giveaway: WorkerGiveaway,
    userId: string,
  ): Promise<void> {
    if (!giveaway.messageId) return;
    try {
      await this.rest.patch(
        Routes.channelMessage(giveaway.channelId, giveaway.messageId),
        {
          body: {
            components: this.renderGiveawayComponents(giveaway, [userId]),
            allowed_mentions: { parse: [] },
          },
        },
      );
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        error.status === 404
      ) {
        return;
      }
      throw error;
    }
  }

  private async deliverWinnerBatch(
    giveaway: WorkerGiveaway,
    components: unknown[],
    allowedUsers: string[],
    drawId: string,
    ordinal: number,
    deliveredOrdinals: Set<number>,
    onDeliver: (
      ordinal: number,
      nonce: string,
      send: () => Promise<APIMessage>,
    ) => Promise<void>,
  ): Promise<void> {
    if (deliveredOrdinals.has(ordinal)) return;
    const nonce = this.deliveryNonce(`winner:${drawId}:${ordinal}`);
    await onDeliver(
      ordinal,
      nonce,
      () => this.replyComponents(giveaway, components, allowedUsers, nonce),
    );
    deliveredOrdinals.add(ordinal);
  }

  async postRerollRejected(
    giveaway: WorkerGiveaway,
    requestedWinnerCount: number,
    eligibleCandidateCount: number | null,
    reason: "insufficient_eligible_candidates" | "draw_in_progress",
    nonce: string,
  ): Promise<APIMessage | null> {
    if (!giveaway.messageId) return null;
    const description =
      reason === "draw_in_progress"
        ? `Another draw is already in progress for **${giveaway.prize}**. Wait for it to complete before rerolling again.`
        : `The reroll requested **${requestedWinnerCount.toLocaleString()}** fresh winners, but only **${(eligibleCandidateCount ?? 0).toLocaleString()}** eligible non-winners remained.`;
    return this.replyComponents(
      giveaway,
      simpleNotice(
        "Reroll not created",
        `${description}\n[Inspect giveaway](${this.websiteUrl}/g/${giveaway.id})`,
        "warning",
      ),
      [],
      nonce,
    );
  }

  private async replyComponents(
    giveaway: WorkerGiveaway,
    components: unknown[],
    allowedUsers: string[],
    nonce?: string,
  ): Promise<APIMessage> {
    return (await this.rest.post(Routes.channelMessages(giveaway.channelId), {
      signal: AbortSignal.timeout(DISCORD_SEND_TIMEOUT_MS),
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
        ...(nonce ? { nonce, enforce_nonce: true } : {}),
      },
    })) as APIMessage;
  }

  deliveryNonce(value: string): string {
    return createHash("sha256").update(value).digest("hex").slice(0, 24);
  }

  private renderGiveawayComponents(
    giveaway: WorkerGiveaway,
    redactedUserIds: string[],
  ): unknown[] {
    const mentions = new Set(["0", ...redactedUserIds].map((id) => `<@${id}>`));
    const redact = (value: unknown): unknown => {
      if (typeof value === "string") {
        let result = value;
        for (const mention of mentions) result = result.replaceAll(mention, "Deleted User");
        return result;
      }
      if (Array.isArray(value)) return value.map(redact);
      if (value && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
            key,
            redact(entry),
          ]),
        );
      }
      return value;
    };
    return redact(giveawayComponents(giveaway as never)) as unknown[];
  }

  async findMessageByNonce(
    channelId: string,
    nonce: string,
    notBefore: Date,
  ): Promise<{ status: "found"; messageId: string } | { status: "absent" } | { status: "unknown" }> {
    let before: string | undefined;
    const lowerBound = notBefore.getTime() - 60_000;
    for (let page = 0; page < 20; page += 1) {
      const query = new URLSearchParams({ limit: "100" });
      if (before) query.set("before", before);
      const messages = (await this.rest.get(Routes.channelMessages(channelId), {
        query,
        signal: AbortSignal.timeout(DISCORD_RECONCILIATION_PAGE_TIMEOUT_MS),
      })) as APIMessage[];
      const match = messages.find(
        (message) =>
          String(message.nonce ?? "") === nonce &&
          message.author.id === this.expectedAuthorId,
      );
      if (match) return { status: "found", messageId: match.id };
      if (messages.length === 0) return { status: "unknown" };
      const oldest = messages.at(-1)!;
      const oldestTime = Date.parse(oldest.timestamp);
      if (!Number.isFinite(oldestTime)) return { status: "unknown" };
      if (oldestTime < lowerBound) {
        return { status: "absent" };
      }
      if (messages.length < 100) return { status: "absent" };
      if (oldest.id === before) return { status: "unknown" };
      before = oldest.id;
    }
    return { status: "unknown" };
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
    try {
      await this.rest.delete(Routes.guildMemberRole(guildId, userId, roleId));
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        error.status === 404
      ) {
        return;
      }
      throw error;
    }
  }
}
