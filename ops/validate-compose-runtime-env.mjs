const requiredEnvironment = {
  migrate: ["PGHOST", "PGDATABASE", "PGUSER", "PGPASSWORD"],
  "db-provision": [
    "PGHOST",
    "PGDATABASE",
    "PGUSER",
    "PGPASSWORD",
    "BOT_DATABASE_USER",
    "BOT_DATABASE_PASSWORD",
    "WORKER_DATABASE_USER",
    "WORKER_DATABASE_PASSWORD",
    "WEB_DATABASE_USER",
    "WEB_DATABASE_PASSWORD",
  ],
  bot: [
    "PGHOST",
    "PGDATABASE",
    "PGUSER",
    "PGPASSWORD",
    "DISCORD_TOKEN",
    "DISCORD_APPLICATION_ID",
    "PUBLIC_BASE_URL",
    "PRIVACY_HASH_SALT",
  ],
  worker: [
    "PGHOST",
    "PGDATABASE",
    "PGUSER",
    "PGPASSWORD",
    "DISCORD_TOKEN",
    "DISCORD_APPLICATION_ID",
    "PUBLIC_BASE_URL",
    "DRAND_CHAIN_HASH",
    "DRAND_PUBLIC_KEY",
    "PRIVACY_HASH_SALT",
  ],
  web: [
    "PGHOST",
    "PGDATABASE",
    "PGUSER",
    "PGPASSWORD",
    "DISCORD_APPLICATION_ID",
    "DISCORD_CLIENT_SECRET",
    "PUBLIC_BASE_URL",
    "SESSION_SECRET",
    "OAUTH_ENCRYPTION_KEY",
    "PRIVACY_HASH_SALT",
  ],
};

let input = "";
for await (const chunk of process.stdin) input += chunk;

const compose = JSON.parse(input);
const failures = [];

for (const [serviceName, requiredNames] of Object.entries(requiredEnvironment)) {
  const environment = compose.services?.[serviceName]?.environment;
  if (!environment || typeof environment !== "object") {
    failures.push(`${serviceName}: environment is missing`);
    continue;
  }
  for (const name of requiredNames) {
    if (!Object.hasOwn(environment, name) || String(environment[name]).length === 0) {
      failures.push(`${serviceName}: ${name} is missing`);
    }
  }
}

if (failures.length > 0) {
  throw new Error(`Invalid Compose runtime environment:\n${failures.join("\n")}`);
}

console.log(
  `Validated runtime environment wiring for ${Object.keys(requiredEnvironment).length} services.`,
);
