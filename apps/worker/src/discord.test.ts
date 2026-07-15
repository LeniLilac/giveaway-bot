import { describe, expect, it, vi } from "vitest";
import { DiscordApi } from "./discord.js";
import type { WorkerGiveaway } from "./database.js";

function giveaway(): WorkerGiveaway {
  const now = new Date();
  return {
    id: "giveaway-id",
    guildId: "100000000000000001",
    channelId: "100000000000000002",
    messageId: "100000000000000003",
    creatorUserId: "100000000000000004",
    hostUserId: "100000000000000004",
    prize: "Prize",
    winnerCount: 3,
    durationSeconds: 60,
    scheduledStartAt: now,
    startedAt: now,
    endsAt: now,
    endedAt: now,
    status: "ended",
    requiredRoleMode: null,
    requiredMessages: null,
    messageScope: null,
    participantCount: 3,
    requiredRoleIds: [],
    prizeRoleIds: [],
    bonusRoles: [],
    createdAt: now,
    updatedAt: now,
  };
}

describe("Discord winner delivery", () => {
  it("renders deleted giveaway hosts as literal text instead of a fake mention", async () => {
    const discord = new DiscordApi(
      "test-token",
      "https://example.invalid",
      "100000000000000004",
    );
    const post = vi.spyOn(discord.rest, "post").mockResolvedValue({
      id: "giveaway-message",
    } as never);
    await discord.postGiveaway(
      { ...giveaway(), creatorUserId: "0", hostUserId: "0" },
      "nonce",
      [],
    );
    const body = post.mock.calls[0]![1] as { body: { components: unknown[] } };
    const rendered = JSON.stringify(body.body.components);
    expect(rendered).toContain("Hosted by Deleted User");
    expect(rendered).not.toContain("<@0>");
  });

  it("durably reports privacy-redacted winners alongside mentionable winners", async () => {
    const discord = new DiscordApi(
      "test-token",
      "https://example.invalid",
      "100000000000000004",
    );
    const post = vi
      .spyOn(discord.rest, "post")
      .mockResolvedValueOnce({ id: "winner-message" } as never)
      .mockResolvedValueOnce({ id: "privacy-message" } as never);
    const pending: number[] = [];
    const delivered: number[] = [];

    await discord.postWinners(
      giveaway(),
      ["100000000000000010", "100000000000000011"],
      1,
      "draw-id",
      new Set(),
      async (ordinal, _nonce, send) => {
        pending.push(ordinal);
        await send();
        delivered.push(ordinal);
      },
    );

    expect(post).toHaveBeenCalledTimes(2);
    expect(pending).toEqual([0, 1]);
    expect(delivered).toEqual([0, 1]);
    const privacyBody = post.mock.calls[1]![1] as { body: { components: unknown[] } };
    const rendered = JSON.stringify(privacyBody.body.components);
    expect(rendered).toContain("Additional privacy-redacted winners");
    expect(rendered).toContain("**1** of **3** winner identities");
    expect(rendered).not.toContain("100000000000000010");
    expect(rendered).not.toContain("100000000000000011");
  });

  it("caps nonce reconciliation and fails closed on malformed history", async () => {
    const discord = new DiscordApi(
      "test-token",
      "https://example.invalid",
      "100000000000000004",
    );
    expect(discord.rest.options.timeout).toBe(30_000);
    let pageNumber = 0;
    const get = vi.spyOn(discord.rest, "get").mockImplementation(async () => {
      const newest = 100_000 - pageNumber * 100;
      pageNumber += 1;
      return Array.from({ length: 100 }, (_value, index) => ({
        id: String(newest - index),
        nonce: null,
        timestamp: new Date().toISOString(),
        author: { id: "100000000000000004" },
      })) as never;
    });
    await expect(discord.findMessageByNonce(
      "100000000000000002",
      "missing-nonce",
      new Date(Date.now() - 3_600_000),
    )).resolves.toEqual({ status: "unknown" });
    expect(get).toHaveBeenCalledTimes(20);

    get.mockReset().mockResolvedValue([{
      id: "999",
      nonce: null,
      timestamp: "not-a-timestamp",
      author: { id: "100000000000000004" },
    }] as never);
    await expect(discord.findMessageByNonce(
      "100000000000000002",
      "missing-nonce",
      new Date(),
    )).resolves.toEqual({ status: "unknown" });
  });
});
