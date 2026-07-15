import { describe, expect, it, vi } from "vitest";
import type { ChatInputCommandInteraction } from "discord.js";
import type { Pool } from "pg";
import { isAuthorized } from "./interactions.js";

function interaction(currentOwnerId: string): ChatInputCommandInteraction {
  const guildId = "100000000000000001";
  return {
    guildId,
    guild: {
      id: guildId,
      ownerId: "100000000000000010",
      client: {
        guilds: {
          fetch: vi.fn(async () => ({ ownerId: currentOwnerId })),
        },
      },
    },
    user: { id: "100000000000000010" },
    member: { permissions: "0", roles: [] },
  } as unknown as ChatInputCommandInteraction;
}

function pool(): Pool {
  return {
    query: vi.fn(async () => ({ rows: [] })),
  } as unknown as Pool;
}

describe("Discord command owner authorization", () => {
  it("rejects a former owner even while the guild cache is stale", async () => {
    await expect(
      isAuthorized(interaction("100000000000000099"), pool(), "delete"),
    ).resolves.toBe(false);
  });

  it("accepts the owner returned by the forced guild refresh", async () => {
    await expect(
      isAuthorized(interaction("100000000000000010"), pool(), "delete"),
    ).resolves.toBe(true);
  });

  it("does not fetch the guild for an arbitrary denied user", async () => {
    const denied = interaction("100000000000000099");
    (denied.guild as unknown as { ownerId: string }).ownerId = "100000000000000099";
    const fetchGuild = denied.guild!.client.guilds.fetch;

    await expect(isAuthorized(denied, pool(), "delete")).resolves.toBe(false);
    expect(fetchGuild).not.toHaveBeenCalled();
  });
});
