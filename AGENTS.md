# AGENTS.md

## Purpose

Lilac Giveaway Bot runs Discord giveaways whose entry snapshot, drand beacon, and deterministic weighted selection can be inspected publicly. Preserve auditability before optimizing convenience.

## Instruction Priority

1. Follow system, developer, and user instructions.
2. Follow this file for repository-wide work.
3. Follow narrower `AGENTS.md` files if they are added under a package.
4. Never weaken a security, privacy, data-integrity, or proof invariant to satisfy a style preference.

## Stack

- Node.js 24 and TypeScript
- npm workspaces
- discord.js for interactions and Discord REST
- Next.js App Router
- PostgreSQL through `pg` with SQL-first migrations
- Doppler for every production secret
- Docker Compose on the Vanguard VPS
- Existing Caddy instance on `vanguard-qc-bot_default`

## Architecture Boundaries

- `apps/bot` handles Discord gateway interactions only. It may validate input, update entry state, and enqueue lifecycle work.
- `apps/worker` is the sole lifecycle authority. Starting, ending, drawing, rerolling, deleting, Discord message refreshes, and prize-role mutation belong here.
- `apps/web` renders public evidence and authenticated dashboards. Mutations enqueue worker jobs; they do not execute lifecycle transitions inline.
- `packages/core` contains side-effect-free domain behavior.
- `packages/proof` contains portable proof primitives. Changes require a proof-version decision.
- `packages/db` owns shared database setup and migrations.
- `packages/discord-ui` owns Discord Components V2 payloads.

## Non-negotiable Invariants

- A guild may have at most 1,000 giveaways in `queued`, `starting`, `active`, or `ending` state. Enforce this inside a transaction with a guild-scoped advisory lock.
- A draw candidate snapshot is immutable after its hash and future drand round are committed.
- The committed drand round must not be knowable when the snapshot is published. Keep the minimum 15-second future offset.
- Candidate ordering is join time ascending, then Discord user ID ascending.
- Base weight is one. Bonus-role entries are additive.
- Weighted selection is without replacement and uses rejection sampling, never modulo reduction alone.
- Rerolls exclude all winners from every prior completed draw for that giveaway.
- Required roles are checked both when joining and when a draw snapshot is made.
- Prize roles may be removed only when Lilac added the role and no other active Lilac claim remains.
- Deleting a giveaway leaves a public tombstone and audit event.
- The public giveaway route never requires authentication.
- At 1,000 winners, Discord winner mentions may be split across messages. At 1,001 or more, publish the full list on the website only.

## Discord Rules

- Use Components V2 for giveaway, commitment, winner, picker, consent, and draft messages.
- Treat every interaction as untrusted input, including component custom IDs.
- Authorization bypass is limited to guild owner, Administrator, or Manage Server. Configured command roles are additive.
- Do not request Message Content intent. Message-count requirements use Discord Search Guild Messages.
- Handle HTTP 202 indexing responses from message search and respect `retry_after`.
- Do not allow prize roles the bot cannot manage.
- Never ping roles from requirement or bonus displays. Winner messages may mention only selected user IDs.

## Database and Jobs

- Add migrations; never edit a migration that has reached production.
- Use transactions for cross-table state changes.
- Use `FOR UPDATE` or advisory locks for contested state.
- Job handlers must be idempotent. External Discord operations need a persisted state check before retry.
- Claim work with `FOR UPDATE SKIP LOCKED`.
- Store Discord snowflakes as text, not JavaScript numbers.
- Store timestamps as `timestamptz` and pass `Date` values at application boundaries.
- Do not remove audit records during ordinary cleanup.

## Secrets and Privacy

- Never commit tokens, passwords, private keys, OAuth credentials, or copied Doppler values.
- `.local/` is ignored and may contain provisioning values. Do not read or print its populated contents in logs, tests, issues, or pull requests.
- Production values live in Doppler project `lilac-giveaway-bot`.
- OAuth tokens must remain encrypted at rest; browser session tokens must remain hashed.
- Logs may include giveaway, guild, job, and draw IDs. Do not log OAuth tokens, Discord tokens, session cookies, participant payloads, or raw HTTP authorization headers.
- Preserve one-time consent before the first entry in a guild.
- Privacy deletion must remove sessions and OAuth data and pseudonymize public participant identity.

## Development

```bash
npm install
doppler run --project giveaway-bot --config dev -- npm run dev
```

Useful checks:

```bash
npm run typecheck
npm test
npm run build -w @giveaway/web
npm run deploy-commands -w @giveaway/bot
```

Do not run production Discord command registration from a feature branch. Use `DISCORD_DEV_GUILD_ID` for development registration.

## Testing

- Add unit coverage for time parsing, role parsing, candidate canonicalization, hashing, and deterministic selection.
- Add integration coverage for the 1,000-giveaway lock, join/leave races, duplicate jobs, role claims, and privacy pseudonymization when those paths change.
- Proof fixtures must include enough information for an independent implementation to reproduce winners.
- Never use a real production token or production database in tests.

## Documentation

- Update `docs/proof.md` when proof inputs, ordering, seed derivation, or sampling changes.
- Update `README.md` for environment, command, Discord permission, or deployment changes.
- Update `docs/runbook.md` for new operational failure modes.
- Keep public copy factual. Do not call a result "verified" until the beacon and deterministic draw are complete.

## Releases and Deployment

- `main` is the production branch.
- CI must pass before the Deploy workflow runs.
- Production deploys use `/opt/giveaway-bot` and compose project `giveaway-bot`.
- The website is reachable internally as `giveaway-bot-web:3000` from `vanguard-qc-bot_default`.
- Do not expose PostgreSQL, bot health, or worker health ports publicly.
- Reload, do not restart, the shared Caddy service after route changes.
- Use forward-only database migrations. Take a PostgreSQL backup before destructive schema work.

## Commits and Reviews

- Keep commits scoped and describe behavioral impact.
- Never mix secret provisioning with source changes.
- Reviews prioritize authorization, race conditions, replay/idempotency, proof reproducibility, privacy, Discord rate limits, and migration safety.
- Do not rewrite unrelated user changes or amend commits unless explicitly requested.

## Maintenance

- Prefer small, explicit SQL and typed boundaries over implicit ORM behavior.
- Keep dependencies current through grouped Dependabot changes.
- Pin architecture decisions in `docs/architecture.md` and proof decisions in `docs/proof.md`.
- If an invariant changes, document the migration and compatibility behavior before code is merged.
