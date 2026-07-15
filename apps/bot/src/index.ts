import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type Interaction,
} from "discord.js";
import { Pool } from "pg";
import pino from "pino";
import { closeHealthServer, startHealthServer } from "@lilac/core";
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

const databaseConnection = (): { connectionString?: string } => {
  if (process.env.DATABASE_URL) return { connectionString: process.env.DATABASE_URL };
  for (const name of ["PGHOST", "PGDATABASE", "PGUSER", "PGPASSWORD"]) {
    required(name);
  }
  return {};
};

const logger = pino({ name: "giveaway-bot", level: process.env.LOG_LEVEL ?? "info" });
const pool = new Pool({
  ...databaseConnection(),
  max: 10,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  statement_timeout: 15_000,
  query_timeout: 20_000,
});
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const privacyHashSalt = required("PRIVACY_HASH_SALT");
if (Buffer.byteLength(privacyHashSalt, "utf8") < 32) {
  throw new Error("PRIVACY_HASH_SALT must be at least 32 bytes.");
}
const dependencies = {
  client,
  pool,
  logger,
  botToken: required("DISCORD_TOKEN"),
  privacyHashSalt,
  websiteUrl: required("PUBLIC_BASE_URL").replace(/\/$/, ""),
};

client.once(Events.ClientReady, (readyClient) => {
  logger.info({ user: readyClient.user.tag }, "Discord client ready");
});

client.on(Events.Error, (error) => {
  logger.error({ error }, "Discord client error");
});

client.on(Events.Warn, (warning) => {
  logger.warn({ warning }, "Discord client warning");
});

const dispatchInteraction = async (interaction: Interaction): Promise<void> => {
  if (interaction.isChatInputCommand()) {
    await handleChatInput(interaction, dependencies);
  } else if (interaction.isButton()) {
    await handleButton(interaction, dependencies);
  } else if (interaction.isModalSubmit()) {
    await handleModalSubmit(interaction, dependencies);
  } else if (interaction.isAutocomplete()) {
    await handleAutocomplete(interaction, dependencies);
  }
};

client.on(Events.InteractionCreate, (interaction) => {
  void dispatchInteraction(interaction).catch(async (error: unknown) => {
    logger.error(
      { error, guildId: interaction.guildId },
      "unhandled interaction failure",
    );
    try {
      if (interaction.isAutocomplete() && !interaction.responded) {
        await interaction.respond([]);
      } else if (
        interaction.isRepliable() &&
        !interaction.replied &&
        !interaction.deferred
      ) {
        await interaction.reply({
          content: "The interaction could not be completed. Please try again.",
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (fallbackError) {
      logger.error(
        { error: fallbackError, guildId: interaction.guildId },
        "interaction fallback response failed",
      );
    }
  });
});

const healthServer = startHealthServer({
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

let shutdownPromise: Promise<void> | null = null;
const shutdown = async (signal: string): Promise<void> => {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    logger.info({ signal }, "shutting down");
    client.destroy();
    const results = await Promise.allSettled([
      closeHealthServer(healthServer),
      pool.end(),
    ]);
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, "Bot shutdown did not complete cleanly.");
    }
  })();
  return shutdownPromise;
};
const handleShutdown = (signal: string): void => {
  void shutdown(signal).catch((error: unknown) => {
    logger.error({ error, signal }, "bot shutdown failed");
    process.exitCode = 1;
  });
};
process.once("SIGTERM", () => handleShutdown("SIGTERM"));
process.once("SIGINT", () => handleShutdown("SIGINT"));

await client.login(dependencies.botToken);
