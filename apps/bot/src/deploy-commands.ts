import { REST, Routes } from "discord.js";
import { commandData } from "./commands.js";

const token = process.env.DISCORD_TOKEN;
const applicationId = process.env.DISCORD_APPLICATION_ID;
if (!token || !applicationId) {
  throw new Error("DISCORD_TOKEN and DISCORD_APPLICATION_ID are required.");
}

const rest = new REST({ version: "10" }).setToken(token);
const route = process.env.DISCORD_DEV_GUILD_ID
  ? Routes.applicationGuildCommands(applicationId, process.env.DISCORD_DEV_GUILD_ID)
  : Routes.applicationCommands(applicationId);

await rest.put(route, { body: commandData });
process.stdout.write(
  process.env.DISCORD_DEV_GUILD_ID
    ? "Registered development guild commands.\n"
    : "Registered global commands.\n",
);
