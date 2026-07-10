# Lilac Giveaway Bot

Lilac is a Discord giveaway bot and public dashboard. It freezes the eligible participant set, publishes its SHA-256 commitment with a future drand Quicknet round, then selects weighted winners deterministically after that beacon exists.

## Features

- `/giveaway create` with flexible durations, Unix timestamps, scheduled starts, unlimited winner counts, role prizes, required message counts, required roles, additive role bonuses, alternate channels, and host credit
- Combined ephemeral confirmation for all-or-one role requirements and all-time-or-since-start message requirements
- `/giveaway start`, `end`, `reroll`, `delete`, `queue`, and `list`
- Discord Components V2 messages with live participant counts
- Up to 1,000 active or queued giveaways per server
- Public participants, exact join times, winners, exclusions, audit history, activity graph, and drand evidence
- Discord OAuth dashboard for personal entries, created giveaways, server operations, and command-role settings
- PostgreSQL-native worker queue with retry and idempotency controls
- Prize-role ownership tracking across rerolls
- Privacy consent and pseudonymizing deletion workflow

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

Create Doppler `lilac-giveaway-bot/dev` and add values based on `doppler.secrets.env.example`:

```bash
doppler setup --project lilac-giveaway-bot --config dev
doppler secrets upload doppler.secrets.env.example
```

Replace every placeholder in Doppler before running the application. Do not put real values in the example file.

Apply migrations and register development commands:

```powershell
doppler run -- npm run migrate
$env:DISCORD_DEV_GUILD_ID="your_server_id"
doppler run -- npm run deploy-commands -w @giveaway/bot
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

Place Lilac's role above every prize role it should award. Message Content intent is not required. Required-message eligibility uses Discord's Search Guild Messages endpoint and may briefly wait while a server search index is prepared.

Register global production commands:

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

Months are 30 days and years are 365 days. A late scheduled start receives its full configured duration.

## Production deployment

Production runs at `/opt/giveaway-bot` on the same VPS as Vanguard. Compose creates a dedicated PostgreSQL service and joins the existing `vanguard-qc-bot_default` network only for Caddy-to-web traffic.

1. Run `ops/bootstrap-vps.sh` once as root.
2. Create Doppler `lilac-giveaway-bot/prd` with every secret in the example.
3. Add GitHub Actions secrets `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`, and `DOPPLER_TOKEN`.
4. Add `ops/Caddyfile.snippet` to the Vanguard Caddyfile.
5. Push `main`. CI completion triggers deployment.

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

The authoritative Quicknet chain hash is configured through `DRAND_CHAIN_HASH`. The implementation exposes every draw through `/api/giveaways/:id`. See [docs/proof.md](docs/proof.md) for byte-level selection rules.

## Operations

Health endpoints:

- Web: `/api/health` through the public route
- Bot: `http://bot:3001/health` inside Compose
- Worker: `http://worker:3002/health` inside Compose

Runbook: [docs/runbook.md](docs/runbook.md).

## License

[MIT](LICENSE)
