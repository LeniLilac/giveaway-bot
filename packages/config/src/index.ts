import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.string().default("info"),
  PUBLIC_BASE_URL: z.url().default("http://localhost:3000"),
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_APPLICATION_ID: z.string().regex(/^\d+$/),
  DISCORD_CLIENT_SECRET: z.string().default(""),
  DISCORD_DEV_GUILD_ID: z.string().default(""),
  DATABASE_URL: z.string().min(1).optional(),
  PGHOST: z.string().min(1).optional(),
  PGDATABASE: z.string().min(1).optional(),
  PGUSER: z.string().min(1).optional(),
  PGPASSWORD: z.string().min(1).optional(),
  SESSION_SECRET: z.string().min(32),
  OAUTH_ENCRYPTION_KEY: z.string().min(32),
  PRIVACY_HASH_SALT: z.string().min(32),
  INTERNAL_RPC_SECRET: z.string().min(32),
  MEMBER_SNAPSHOT_URL: z.url().default("http://127.0.0.1:3003/internal/member-snapshot/v1"),
  MEMBER_SNAPSHOT_PORT: z.coerce.number().int().positive().default(3003),
  DRAND_CHAIN_HASH: z.string().regex(/^[a-f0-9]{64}$/).default("52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971"),
  DRAND_PUBLIC_KEY: z.string().regex(/^[a-f0-9]{192}$/),
  DRAND_PERIOD: z.coerce.number().int().positive().default(3),
  DRAND_GENESIS_TIME: z.coerce.number().int().positive().default(1692803367),
  DRAND_SCHEME: z.string().min(1).default("bls-unchained-g1-rfc9380"),
  DRAND_BASE_URLS: z.string().min(1).default("https://api.drand.sh,https://api2.drand.sh"),
  HEALTH_PORT: z.coerce.number().int().positive().optional()
}).superRefine((value, context) => {
  if (value.DATABASE_URL) return;
  for (const name of ["PGHOST", "PGDATABASE", "PGUSER", "PGPASSWORD"] as const) {
    if (!value[name]) {
      context.addIssue({
        code: "custom",
        path: [name],
        message: "DATABASE_URL or complete PostgreSQL connection settings are required",
      });
    }
  }
});

export type AppConfig = z.infer<typeof schema>;
let cached: AppConfig | undefined;

export function getConfig(): AppConfig {
  cached ??= schema.parse(process.env);
  return cached;
}
