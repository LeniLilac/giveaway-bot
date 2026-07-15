import { describe, expect, it, vi } from "vitest";
import {
  type ChatInputCommandInteraction,
  PermissionsBitField,
} from "discord.js";
import {
  assertDraftPayloadShape,
  assertDraftReferencesCurrent,
} from "./draft-validation.js";
import {
  MAX_DURATION_SECONDS,
  MAX_TOTAL_BONUS_ENTRIES,
  MAX_WINNER_COUNT,
} from "./limits.js";
import type { DraftPayload } from "./repository.js";

const guildId = "100000000000000001";
const channelId = "100000000000000002";
const hostUserId = "100000000000000003";

function payload(overrides: Partial<DraftPayload> = {}): DraftPayload {
  return {
    prize: "Prize",
    winnerCount: 1,
    durationSeconds: 3_600,
    scheduledStartAt: "2026-07-15T00:00:00.000Z",
    channelId,
    hostUserId,
    requiredRoleIds: [],
    prizeRoleIds: [],
    bonusRoles: [],
    requiredMessages: null,
    requiredRoleMode: null,
    messageScope: null,
    ...overrides,
  };
}

function interaction(options: {
  permissions?: bigint;
  thread?: boolean;
  sendable?: boolean;
  archived?: boolean;
  locked?: boolean;
} = {}): ChatInputCommandInteraction {
  const thread = options.thread ?? false;
  const channel = {
    archived: options.archived ?? false,
    locked: options.locked ?? false,
    sendable: options.sendable ?? true,
    isTextBased: () => true,
    isSendable: () => true,
    isThread: () => thread,
    permissionsFor: () =>
      new PermissionsBitField(
        options.permissions ??
          (PermissionsBitField.Flags.ViewChannel |
            (thread
              ? PermissionsBitField.Flags.SendMessagesInThreads
              : PermissionsBitField.Flags.SendMessages)),
      ),
  };
  const guild = {
    id: guildId,
    roles: { fetch: vi.fn(async () => new Map()), cache: new Map() },
    channels: { fetch: vi.fn(async () => channel) },
    members: { me: { id: "100000000000000004" }, fetchMe: vi.fn() },
  };
  return { guildId, guild } as unknown as ChatInputCommandInteraction;
}

describe("draft commit validation", () => {
  it("accepts exact downstream numeric bounds", () => {
    expect(() =>
      assertDraftPayloadShape(
        payload({
          winnerCount: MAX_WINNER_COUNT,
          requiredMessages: MAX_WINNER_COUNT,
          bonusRoles: [
            {
              roleId: "100000000000000005",
              bonusEntries: MAX_TOTAL_BONUS_ENTRIES,
            },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it("rejects values that overflow draw integers or aggregate candidate weight", () => {
    expect(() =>
      assertDraftPayloadShape(payload({ winnerCount: MAX_WINNER_COUNT + 1 })),
    ).toThrow("Winner count");
    expect(() =>
      assertDraftPayloadShape(
        payload({
          bonusRoles: [
            { roleId: "100000000000000005", bonusEntries: MAX_TOTAL_BONUS_ENTRIES },
            { roleId: "100000000000000006", bonusEntries: 1 },
          ],
        }),
      ),
    ).toThrow("Combined role bonuses");
    expect(() =>
      assertDraftPayloadShape(
        payload({ requiredRoleIds: ["100000000000000005 trailing"] }),
      ),
    ).toThrow("invalid or duplicate role IDs");
  });

  it("enforces duration and scheduled-end timestamp boundaries", () => {
    expect(() =>
      assertDraftPayloadShape(payload({ durationSeconds: MAX_DURATION_SECONDS })),
    ).not.toThrow();
    expect(() =>
      assertDraftPayloadShape(payload({ durationSeconds: MAX_DURATION_SECONDS + 1 })),
    ).toThrow("1 year");
    expect(() =>
      assertDraftPayloadShape(
        payload({ scheduledStartAt: "+275760-09-13T00:00:00.000Z" }),
      ),
    ).toThrow("supported timestamp range");
  });

  it("requires View Channel plus the channel-specific send permission", async () => {
    await expect(
      assertDraftReferencesCurrent(
        interaction({ permissions: PermissionsBitField.Flags.SendMessages }),
        payload(),
      ),
    ).rejects.toThrow("View Channel and Send Messages");
    await expect(
      assertDraftReferencesCurrent(
        interaction({ permissions: PermissionsBitField.Flags.ViewChannel }),
        payload(),
      ),
    ).rejects.toThrow("View Channel and Send Messages");
    await expect(
      assertDraftReferencesCurrent(
        interaction({
          thread: true,
          permissions:
            PermissionsBitField.Flags.ViewChannel |
            PermissionsBitField.Flags.SendMessages,
        }),
        payload(),
      ),
    ).rejects.toThrow("Send Messages in Threads");
  });

  it("accepts a sendable thread and rejects an unsendable archived thread", async () => {
    await expect(
      assertDraftReferencesCurrent(interaction({ thread: true }), payload()),
    ).resolves.toBeUndefined();
    await expect(
      assertDraftReferencesCurrent(
        interaction({ thread: true, archived: true, sendable: false }),
        payload(),
      ),
    ).rejects.toThrow("archived or locked");
  });

  it("fails closed when a referenced role no longer exists", async () => {
    await expect(
      assertDraftReferencesCurrent(
        interaction(),
        payload({ requiredRoleIds: ["100000000000000005"] }),
      ),
    ).rejects.toThrow("unknown or invalid role");
  });

  it("does not fetch the guild role list when the draft references no roles", async () => {
    const current = interaction();
    await assertDraftReferencesCurrent(current, payload());
    expect(current.guild!.roles.fetch).not.toHaveBeenCalled();
    expect(current.guild!.members.fetchMe).toHaveBeenCalledWith({ force: true });
  });
});
