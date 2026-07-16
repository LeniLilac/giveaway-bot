# Production runbook

## Deploy

Push `main` or re-run its CI workflow. A successful CI run triggers deployment of
that exact commit SHA. The remote script checks that the commit belongs to
`origin/main`, checks it out detached, runs Compose through Doppler, synchronizes
the tracked Caddy route, and registers global Discord commands from the deployed
bot image. It waits for PostgreSQL, the one-shot migration and runtime-role
provisioning jobs, bot, worker, and web to become healthy before touching Caddy
or Discord commands. The default health
deadline is 180 seconds and can be raised only as high as 600 seconds with
`DEPLOY_HEALTH_TIMEOUT_SECONDS`.

An out-of-order workflow for an older ancestor exits successfully without
changing production when the VPS already runs a newer `main` commit.
Deployment also fails closed when `/opt/giveaway-bot` contains tracked changes
or non-ignored untracked files; inspect and preserve intentional operator files
before cleaning the worktree and retrying CI.

The Deploy workflow verifies the VPS against the pinned
`VPS_SSH_KNOWN_HOSTS` GitHub secret. Rotate that secret through an independently
authenticated channel whenever the VPS host key changes.

Command registration is an idempotent replacement of the global command set. If
it fails, the Deploy workflow fails after the containers and Caddy route have
been updated; correct the Discord or Doppler configuration and rerun the
workflow to reconcile command metadata. A failed health or Caddy check prevents
command registration entirely. Registration executes inside the healthy bot
container; the GitHub-provided Doppler service token is used to inject the
Compose runtime configuration, not as a Discord registration credential.

The bot, worker, and web services each authenticate with a distinct restricted
database role. `POSTGRES_USER` is reserved for the one-shot migration,
provisioning, and backup paths. When a deploy fails in `db-provision`, confirm
that all three runtime role names are distinct lowercase identifiers and that
their passwords are at least 32 bytes, then review
`ops/database-runtime-roles.sql` for grants required by the new migration.
Never work around a missing grant by giving a runtime role superuser, schema
ownership, or the migration administrator password.
The PostgreSQL container is dedicated to Lilac; provisioning revokes default
PUBLIC access to every non-template database in that cluster. On an existing
volume, `POSTGRES_USER` and `POSTGRES_PASSWORD` must match its original owner
credentials because the image initialization variables do not rotate an
already-created role. Add all three new runtime role passwords to Doppler before
deploying this version.

## Inspect

```bash
cd /opt/giveaway-bot
doppler run --project lilac-giveaway-bot --config prd -- docker compose ps
doppler run --project lilac-giveaway-bot --config prd -- docker compose logs --tail=200 worker
doppler run --project lilac-giveaway-bot --config prd -- docker compose logs --tail=200 bot
```

Do not paste logs containing participant data into public issues.

## Back up PostgreSQL

```bash
cd /opt/giveaway-bot
doppler run --project lilac-giveaway-bot --config prd -- bash -c '
  set -euo pipefail
  umask 077
  backup="$(mktemp "/var/backups/giveaway-bot/giveaway-$(date +%Y%m%d-%H%M%S).XXXXXX.dump")"
  partial="${backup}.partial"
  trap '\''rm -f -- "$backup" "$partial"'\'' EXIT
  docker compose -p giveaway-bot exec -T postgres \
    pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB" >"$partial"
  mv -- "$partial" "$backup"
  trap - EXIT
  printf "Backup written to %s\n" "$backup"
'
```

The Doppler-provided database names expand inside the injected shell, not in the
operator's pre-Doppler shell. Bootstrap creates `/var/backups/giveaway-bot`
outside the checkout with mode `0700`; `umask 077` keeps every dump private.
Copy completed dumps to encrypted off-VPS storage and verify restores regularly.

## Stuck jobs

Workers renew a five-minute fenced lease every 30 seconds. An expired lease is
automatically reclaimable; the old worker cannot complete or retry the new
owner's job. Inspect:

```sql
SELECT id, type, giveaway_id, attempts, max_attempts, run_at, locked_at,
       locked_by, lock_token, lease_expires_at, last_error
FROM jobs
WHERE completed_at IS NULL
ORDER BY run_at;
```

Do not manually mark a draw complete. Correct the external or data failure,
then clear `locked_at`, `locked_by`, `lock_token`, and `lease_expires_at`, and
set `run_at = now()` for the specific job.

## Drand outage

The complete-draw job retries persistently with exponential backoff capped at
five minutes. Published candidate and round commitments remain unchanged.
Never substitute local randomness or choose a different round after
publication. A mismatch in chain hash, public key, period, genesis time, or
scheme indicates incorrect pinned configuration and fails closed.

## Incomplete Discord delivery or prize roles

A completed selection may still have null reconciliation timestamps on its
`draws` row. Its complete-draw job keeps retrying role cleanup/grants, giveaway
refresh, and winner-message batches. Role ownership rows with `add_pending` or
`remove_pending` record crash-safe recovery state. Fix the Discord permission or
connectivity problem and let the existing job retry; do not edit claims or add
roles manually unless the persisted ownership state has first been audited.

Giveaway deletion and participant privacy deletion also wait for any uncertain
`giveaway_start` delivery to be reconciled. A ledger row with `send_started_at`
but no `delivered_at` may represent a Discord message whose response was lost;
do not clear it or resend manually. Restore channel history access and let the
start job find the nonce, persist `external_id`/`message_id`, and retry the
waiting deletion. A ledger-delivered start message is privacy-redacted even if
the giveaway row had not yet persisted its `message_id`.

## Discord permission error

Confirm the bot can view and send messages in the target channel. For prize roles, confirm Lilac's highest role is above every configured role. After correction, retry the failed job.

## Member snapshot failure

Draw preparation requests fresh member records from the bot over the private
Compose network. If jobs report `Member snapshot service` errors, confirm both
services are healthy, `INTERNAL_RPC_SECRET` is identical for bot and worker,
and the worker uses
`http://bot:3003/internal/member-snapshot/v1`. A partial or malformed response
fails closed and is never committed as draw evidence. Do not bypass the check
with cached roles or manually insert candidates; restore the bot gateway or
internal network and let the persistent job retry.

## Caddy

```bash
docker ps --filter label=com.docker.compose.service=caddy
docker exec <caddy-container> caddy validate --config /etc/caddy/Caddyfile
docker exec <caddy-container> caddy reload --config /etc/caddy/Caddyfile
```

Do not paste the route into Caddy manually after bootstrap. Deployments maintain
the block between `# BEGIN managed by giveaway-bot` and
`# END managed by giveaway-bot` from `ops/Caddyfile.snippet`. The first deploy
adopts an exact legacy copy of that snippet; it fails closed if an unmanaged
`giveaway.leni.cat` route differs, Caddy is absent or ambiguous, the Caddyfile is
not a bind mount, validation fails, or reload fails. On a validation
or reload error, the sync script restores and reloads the prior configuration.
If a Vanguard update replaces the host Caddyfile inode and drops its deployment
ACL, rerun `ops/bootstrap-vps.sh` before retrying this deployment.

The DNS A record must resolve `giveaway.leni.cat` to `46.224.13.57`.
