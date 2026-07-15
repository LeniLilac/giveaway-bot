# Lilac Giveaway Bot

Lilac is a Discord giveaway bot and public dashboard. It freezes the eligible participant set, publishes its SHA-256 commitment with a future drand Quicknet round, then selects weighted winners deterministically after that beacon exists.

## Features

- `/giveaway create` with flexible durations, Unix timestamps, scheduled starts, large bounded winner counts, role prizes, required message counts, required roles, additive role bonuses, alternate channels, and host credit
- Combined ephemeral confirmation for all-or-one role requirements and all-time-or-since-start message requirements
- `/giveaway start`, `end`, `reroll`, `delete`, `queue`, and `list`; rerolls require an exact fresh-winner count and support a completed-giveaway picker
- Discord Components V2 messages with live participant counts
- Up to 1,000 active or queued giveaways per server
- Public participants, exact join times, winners, exclusions, audit history, activity graph, and drand evidence
- Discord OAuth dashboard for personal entries, created giveaways, server operations, and command-role settings
- PostgreSQL-native worker queue with retry and idempotency controls
- Prize-role ownership tracking across rerolls
- Public privacy/terms disclosures and pseudonymizing deletion workflow

## Repository

```text
apps/bot            Discord interactions and entry operations
apps/worker         Lifecycle jobs, drand draws, Discord messages, prize roles
apps/web            Landing page, public evidence, OAuth dashboards
packages/core       Shared domain parsing and health primitives
packages/db         PostgreSQL access and migration runner
packages/proof      Canonical proof and weighted selection primitives
packages/discord-ui Discord Components V2 builders
db/migrations       Forward-only SQL migrations
ops                 VPS, Caddy, and deployment assets
```

See [docs/architecture.md](docs/architecture.md) and [docs/proof.md](docs/proof.md).

## Local setup

Requirements:

- Node.js 24
- PostgreSQL 17
- Doppler CLI
- A Discord application

Install dependencies:

```bash
npm install
```

The ignored `.local/` directory contains separate stubs for Discord, Doppler, GitHub, VPS, and DNS provisioning. Runtime code does not load those files.

Create Doppler `lilac-giveaway-bot/dev` and add values from the development-safe
`.env.example` template:

```bash
doppler setup --project lilac-giveaway-bot --config dev
doppler secrets upload .env.example
```

Replace every blank secret in Doppler before running the application. Do not use
the production template for local development, and do not put real values in
either example file.

Apply migrations and register development commands:

```powershell
doppler run -- npm run migrate -w @lilac/db
$env:DISCORD_DEV_GUILD_ID="your_server_id"
doppler run -- npm run deploy-commands -w @lilac/bot
```

Start bot, worker, and web processes:

```bash
doppler run -- npm run dev
```

The OAuth redirect URI is:

```text
http://localhost:3000/api/auth/callback
```

Use `https://giveaway.leni.cat/api/auth/callback` in production.

## Discord setup

The installation URL needs the `bot` and `applications.commands` scopes. The landing page generates it with:

- View Channel
- Send Messages
- Embed Links
- Read Message History
- Manage Roles

Place Lilac's role above every prize role it should award. To configure `role_prizes`, the giveaway creator must be the server owner or have Manage Roles with a highest role above every selected prize role. Administrator satisfies Manage Roles but does not bypass role hierarchy; Manage Server and configured giveaway command roles alone are not sufficient. Message Content intent is not required. Required-message eligibility uses Discord's Search Guild Messages endpoint and may briefly wait while a server search index is prepared.

The dashboard requests Discord's `identify`, `guilds`, and
`guilds.members.read` OAuth scopes. The last scope lets it verify configured
command roles using the signed-in member's live role list without enabling the
privileged Guild Members bot intent. Existing dashboard users must sign out and
approve the expanded scope once after this update.

Production deployments register global Discord commands automatically. To manually recover or re-register them from a Doppler-authenticated workstation:

```bash
doppler run --project lilac-giveaway-bot --config prd -- npm run deploy-commands -w @lilac/bot
```

## Duration and role input

Time values accept `s`, `m`, `h`, `d`, `w`, `mo`, and `y` in any order with optional spaces or commas:

```text
1d 3h 2m
1d3h2m
2m,3h,1d
1783689960
```

For role lists, mentions and IDs may be separated by spaces or commas. Bonus entries use `role:bonus` pairs:

```text
@Booster:2, 123456789012345678:5
```

Months are 30 days and years are 365 days. Giveaway durations are capped at one
year. A late scheduled start receives its full configured duration.

## Production deployment

Production runs at `/opt/giveaway-bot` on the same VPS as Vanguard. Compose creates a dedicated PostgreSQL service and joins the existing `vanguard-qc-bot_default` network only for Caddy-to-web traffic.

1. From a trusted checkout on the VPS, run
   `sudo env DEPLOY_USER=giveaway-deploy bash ops/bootstrap-vps.sh`. This creates
   or validates the dedicated non-root deployment account, checkout and private
   backup directories, Docker/Compose prerequisites, external network, and the
   Caddy bind mount and host-file ACL. The deploy account is placed in the `docker` group,
   which is root-equivalent and must not be shared with application processes.
2. Install the deployment SSH public key in that account's `authorized_keys` and
   confirm a fresh SSH session can run `docker info` and `doppler --version`.
3. Create Doppler `lilac-giveaway-bot/prd` with every secret in
   `doppler.secrets.env.example`. Generate independent passwords of at least 32
   bytes for `BOT_DATABASE_PASSWORD`, `WORKER_DATABASE_PASSWORD`, and
   `WEB_DATABASE_PASSWORD`; none may match the PostgreSQL migration
   administrator password or each other. On an existing PostgreSQL volume,
   `POSTGRES_USER` and `POSTGRES_PASSWORD` must still match the credentials used
   when that volume was initialized; changing those environment values does not
   rotate the database owner password.
4. Add GitHub Actions secrets `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`,
   `VPS_SSH_KNOWN_HOSTS`, and `DOPPLER_TOKEN`. The known-hosts value must contain
   the VPS's pinned SSH host key; do not generate it during a deployment.
   `VPS_USER` must match `DEPLOY_USER`. The Doppler service token is delivered
   only to the remote deployment process so Compose can receive production
   configuration; it is not stored by the repository. Discord command
   registration then runs inside the already-configured bot container and does
   not perform a separate Doppler fetch.
5. Push `main`. CI completion triggers deployment.

The existing Vanguard Caddy service must bind-mount `/etc/caddy/Caddyfile` (or
the containing `/etc/caddy` directory); a read-only container mount is
preferred. Bootstrap grants only the dedicated deploy account write access to
that host file. Each deployment replaces the
marker-delimited block with the tracked `ops/Caddyfile.snippet`, validates the
full Caddyfile, reloads Caddy, and restores the prior file if either operation
fails. A missing, ambiguous, or unmanaged conflicting route fails deployment.

Deployments are accepted only from a successful CI run for `main`, and the VPS
checks out that exact tested commit SHA. Re-run the CI workflow when a manual
production reconciliation is needed. If CI runs finish out of order, a stale
successful run cannot roll production back from a newer `main` commit.
The deploy script waits up to three minutes for PostgreSQL, the migration job,
the one-shot runtime-role provisioning job, and the bot, worker, and web health
checks. It then synchronizes Caddy before replacing the global Discord command
set. An unhealthy service, missing database grant, or Caddy failure prevents
command registration. Only the one-shot migration and provisioning containers
receive the PostgreSQL administrator credential. The long-running bot, worker,
and web services use separate least-privilege logins whose passwords can be
rotated independently in Doppler.
CI Actions and production base images are pinned to immutable revisions; update
their human-readable version and digest/SHA together during dependency upgrades.

Required DNS:

```text
Type: A
Name: giveaway
Value: 46.224.13.57
TTL: Auto or 300
Proxy: DNS only until Caddy issues the first certificate
```

The exact same instruction is in ignored file `.local/dns-record.txt`.

## Proof

The authoritative Quicknet chain hash and BLS public key are configured through
`DRAND_CHAIN_HASH` and required `DRAND_PUBLIC_KEY`. The worker also pins period,
genesis time, and signature scheme through `DRAND_PERIOD`,
`DRAND_GENESIS_TIME`, and `DRAND_SCHEME`; production must change these together
when intentionally moving to another chain. Relay metadata is never a trust
root. The implementation exposes every draw through `/api/giveaways/:id`. See
[docs/proof.md](docs/proof.md) for byte-level selection rules and v1/v2
compatibility.

`PRIVACY_HASH_SALT` is also a proof-security key: it must contain at least 32
bytes, remain private, and remain stable for the lifetime of stored giveaways.
Rotating it without a deliberate proof-identity migration would break reroll
exclusion for previously privacy-deleted winners.

`SESSION_SECRET` and `OAUTH_ENCRYPTION_KEY` must each contain at least 32 bytes
of independently generated secret material. Keep all three values in Doppler;
the pinned drand chain metadata and public key are public configuration.

The public evidence API returns at most 250 participants, candidates,
exclusions, and winners per request. Use `participant_page_size`,
`evidence_page_size`, and `draw`, then continue with the cursor values returned
under `pagination.next` via `participant_after_joined_at`,
`participant_after_user_id`, `candidate_after_ordinal`,
`exclusion_after_user_id`, and `winner_after_position`. Cursor pagination
keeps large public proofs available without unbounded database scans.
Public activity graphs cover the most recent 90 days, while immutable draw
evidence and the bounded audit-event history remain available separately.

## Operations

Health endpoints:

- Web: `/api/health` through the public route
- Bot: `http://bot:3001/health` inside Compose
- Worker: `http://worker:3002/health` inside Compose

Runbook: [docs/runbook.md](docs/runbook.md).

## License

[MIT](LICENSE)
