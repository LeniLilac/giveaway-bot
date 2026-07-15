import { describe, expect, it, vi } from "vitest";
import type { Guild } from "discord.js";
import { fetchCurrentGuildOwnerId } from "./guild-owner.js";

describe("authoritative guild owner lookup", () => {
  it("forces a REST-backed guild refresh instead of trusting the cache", async () => {
    const fetch = vi.fn(async () => ({ ownerId: "100000000000000099" }));
    const guild = {
      id: "100000000000000001",
      ownerId: "100000000000000010",
      client: { guilds: { fetch } },
    } as unknown as Guild;

    await expect(fetchCurrentGuildOwnerId(guild)).resolves.toBe(
      "100000000000000099",
    );
    expect(fetch).toHaveBeenCalledWith({ guild: guild.id, force: true });
  });

  it("fails closed when the current owner cannot be resolved", async () => {
    const guild = {
      id: "100000000000000001",
      client: {
        guilds: { fetch: vi.fn(async () => Promise.reject(new Error("unavailable"))) },
      },
    } as unknown as Guild;

    await expect(fetchCurrentGuildOwnerId(guild)).rejects.toThrow(
      "could not verify the server's current owner",
    );
  });
});
