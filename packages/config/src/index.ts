import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.string().default("info"),
  PUBLIC_BASE_URL: z.url().default("http://localhost:3000"),
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().regex(/^$d+$/),
  DISCORD_CLIENT_SECRET: z.string().default(""),
  DISCORD_DEV_GUILD_ID: z.string().default(""),
  DATABASE_URL: z.string().min(1),
  SESSION_ENCRYPTION_KEY: z.string().default("development-only-change-me"),
  PRIVACY_POLICY_VERSION: z.string().default("2026-07-10"),
  DRAND_CHAIN_HASH: z.string().regex(/^[a-f0-9]{64}$/).default("52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971"),
  DRAND_PUBLIC_KEY: z.string().default(""),
  DRAND_RELAYS: z.string().default("https://api.drand.sh,https://api2.drand.sh,https://api3.drand.sh,https://drand.cloudflare.com"),
  BOT_HEALTH_PORT: z.coerce.number().int().positive().default(3001),
  WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(3002),
  WORKER_POLL_MS: z.coerce.number().int().positive().default(1000)
});

export type AppConfig = z.infer<typeof schema>;
let cached: AppConfig | undefined;

export function getConfig(): AppConfig {
  cached ??= schema.parse(process.env);
  return cached;
}
