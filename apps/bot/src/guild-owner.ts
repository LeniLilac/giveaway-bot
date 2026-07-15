import type { Guild } from "discord.js";

export async function fetchCurrentGuildOwnerId(guild: Guild): Promise<string> {
  try {
    const current = await guild.client.guilds.fetch({ guild: guild.id, force: true });
    if (!current.ownerId) throw new Error("Discord returned no guild owner.");
    return current.ownerId;
  } catch {
    throw new Error("I could not verify the server's current owner. Try again.");
  }
}
