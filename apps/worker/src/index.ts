import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import pino from "pino";
import { closeHealthServer, startHealthServer } from "@lilac/core";
import { claimJob, completeJob, heartbeatJob, retryJob } from "./database.js";
import { DiscordApi } from "./discord.js";
import { JobPayloadError, processJob } from "./lifecycle.js";
import { assertWorkerHealthy, type WorkerHealthState } from "./worker-health.js";

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

const workerId = process.env.WORKER_ID ?? `worker-${randomUUID()}`;
const logger = pino({ name: "giveaway-worker", level: process.env.LOG_LEVEL ?? "info" });
const pool = new Pool({
  ...databaseConnection(),
  max: 12,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  statement_timeout: 120_000,
  query_timeout: 125_000,
});
const websiteUrl = required("PUBLIC_BASE_URL").replace(/\/$/, "");
const privacyHashSalt = required("PRIVACY_HASH_SALT");
if (Buffer.byteLength(privacyHashSalt, "utf8") < 32) {
  throw new Error("PRIVACY_HASH_SALT must contain at least 32 bytes.");
}
const dependencies = {
  pool,
  logger,
  websiteUrl,
  discord: new DiscordApi(
    required("DISCORD_TOKEN"),
    websiteUrl,
    required("DISCORD_APPLICATION_ID"),
  ),
  drand: {
    chainHash: required("DRAND_CHAIN_HASH"),
    publicKey: required("DRAND_PUBLIC_KEY"),
    period: Number(process.env.DRAND_PERIOD ?? 3),
    genesisTime: Number(process.env.DRAND_GENESIS_TIME ?? 1692803367),
    scheme: process.env.DRAND_SCHEME ?? "bls-unchained-g1-rfc9380",
    baseUrls: (process.env.DRAND_BASE_URLS ?? process.env.DRAND_RELAYS ?? "https://api.drand.sh,https://api2.drand.sh")
      .split(",")
      .map((url) => url.trim())
      .filter(Boolean),
  },
  privacyHashSalt,
};

let stopping = false;
const healthState: WorkerHealthState = {
  lastSuccessfulPollAt: Date.now(),
  activeJob: null,
};

function requestShutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "worker shutting down");
}

const healthServer = startHealthServer({
  port: Number(process.env.HEALTH_PORT ?? 3002),
  checks: {
    database: async () => {
      await pool.query("SELECT 1");
    },
    worker: () => assertWorkerHealthy(healthState),
  },
});
process.once("SIGTERM", () => requestShutdown("SIGTERM"));
process.once("SIGINT", () => requestShutdown("SIGINT"));

while (!stopping) {
  const job = await claimJob(pool, workerId);
  healthState.lastSuccessfulPollAt = Date.now();
  if (!job) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    continue;
  }
  const activeJob = {
    jobId: job.id,
    lockToken: job.lockToken,
    lastLeaseHeartbeatAt: Date.now(),
    leaseLost: false,
  };
  healthState.activeJob = activeJob;
  const heartbeat = setInterval(() => {
    void heartbeatJob(pool, job)
      .then((renewed) => {
        if (healthState.activeJob !== activeJob) return;
        if (!renewed) {
          activeJob.leaseLost = true;
          logger.warn({ jobId: job.id }, "job lease was lost");
          return;
        }
        activeJob.lastLeaseHeartbeatAt = Date.now();
      })
      .catch((error: unknown) => {
        logger.error({ error, jobId: job.id }, "job lease heartbeat failed");
      });
  }, 30_000);
  heartbeat.unref();
  try {
    let succeeded = false;
    let finalizedInHandler = false;
    let failure: unknown;
    try {
      finalizedInHandler = await processJob(dependencies, job);
      succeeded = true;
    } catch (error) {
      failure = error;
    }
    if (succeeded) {
      if (finalizedInHandler || (await completeJob(pool, job))) {
        logger.info({ jobId: job.id, type: job.type }, "job completed");
      } else {
        logger.warn({ jobId: job.id, type: job.type }, "stale worker did not complete job");
      }
    } else {
      logger.error({ error: failure, jobId: job.id, type: job.type }, "job failed");
      await retryJob(pool, job, failure, {
        forceTerminal: failure instanceof JobPayloadError,
        markGiveawayError: !(failure instanceof JobPayloadError),
      });
    }
  } catch (error) {
    logger.error({ error, jobId: job.id, type: job.type }, "job lease finalization failed");
  } finally {
    clearInterval(heartbeat);
    if (healthState.activeJob === activeJob) healthState.activeJob = null;
    healthState.lastSuccessfulPollAt = Date.now();
  }
}

let shutdownFailed = false;
try {
  await closeHealthServer(healthServer);
} catch (error) {
  shutdownFailed = true;
  logger.error({ error }, "worker health server shutdown failed");
}
try {
  await pool.end();
} catch (error) {
  shutdownFailed = true;
  logger.error({ error }, "worker database pool shutdown failed");
}
if (shutdownFailed) process.exitCode = 1;
