import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import pino from "pino";
import { startHealthServer } from "@giveaway/core";
import { claimJob, completeJob, retryJob } from "./database.js";
import { DiscordApi } from "./discord.js";
import { processJob } from "./lifecycle.js";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
};

const workerId = process.env.WORKER_ID ?? `worker-${randomUUID()}`;
const logger = pino({ name: "giveaway-worker", level: process.env.LOG_LEVEL ?? "info" });
const pool = new Pool({ connectionString: required("DATABASE_URL"), max: 12 });
const websiteUrl = required("PUBLIC_BASE_URL").replace(/\/$/, "");
const dependencies = {
  pool,
  logger,
  websiteUrl,
  discord: new DiscordApi(required("DISCORD_TOKEN"), websiteUrl),
  drand: {
    chainHash: required("DRAND_CHAIN_HASH"),
    baseUrls: (process.env.DRAND_BASE_URLS ?? "https://api.drand.sh,https://api2.drand.sh")
      .split(",")
      .map((url) => url.trim())
      .filter(Boolean),
  },
  privacyHashSalt: required("PRIVACY_HASH_SALT"),
};

let stopping = false;
let lastSuccessfulPoll = Date.now();

async function shutdown(signal: string): Promise<void> {
  stopping = true;
  logger.info({ signal }, "worker shutting down");
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

startHealthServer({
  port: Number(process.env.HEALTH_PORT ?? 3002),
  checks: {
    database: async () => {
      await pool.query("SELECT 1");
    },
    worker: async () => {
      if (Date.now() - lastSuccessfulPoll > 30_000) {
        throw new Error("Worker poll loop is stale.");
      }
    },
  },
});

while (!stopping) {
  const job = await claimJob(pool, workerId);
  lastSuccessfulPoll = Date.now();
  if (!job) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    continue;
  }
  try {
    await processJob(dependencies, job);
    await completeJob(pool, job.id);
    logger.info({ jobId: job.id, type: job.type }, "job completed");
  } catch (error) {
    logger.error({ error, jobId: job.id, type: job.type }, "job failed");
    await retryJob(pool, job, error);
  }
}
await pool.end();
