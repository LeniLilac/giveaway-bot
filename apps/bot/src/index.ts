import { Client, Events, GatewayIntentBits } from "discord.js";
import { Pool } from "pg";
import pino from "pino";
import { startHealthServer } from "@lilac/core";
import {
  handleAutocomplete,
  handleButton,
  handleChatInput,
  handleModalSubmit,
} from "./interactions.js";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
};

const logger = pino({ name: "giveaway-bot", level: process.env.LOG_LEVEL ?? "info" });
const pool = new Pool({ connectionString: required("DATABASE_URL") });
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const dependencies = {
  client,
  pool,
  logger,
  botToken: required("DISCORD_TOKEN"),
  websiteUrl: required("PUBLIC_BASE_URL").replace(/\/$/, ""),
};

client.once(Events.ClientReady, (readyClient) => {
  logger.info({ user: readyClient.user.tag }, "Discord client ready");
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) {
    await handleChatInput(interaction, dependencies);
  } else if (interaction.isButton()) {
    await handleButton(interaction, dependencies);
  } else if (interaction.isModalSubmit()) {
    await handleModalSubmit(interaction, dependencies);
  } else if (interaction.isAutocomplete()) {
    await handleAutocomplete(interaction, dependencies);
  }
});

startHealthServer({
  port: Number(process.env.HEALTH_PORT ?? 3001),
  checks: {
    database: async () => {
      await pool.query("SELECT 1");
    },
    discord: async () => {
      if (!client.isReady()) throw new Error("Discord gateway is not ready.");
    },
  },
});

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, "shutting down");
  client.destroy();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await client.login(dependencies.botToken);
