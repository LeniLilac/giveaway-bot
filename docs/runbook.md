# Production runbook

## Deploy

Push `main` or run the Deploy workflow manually. The remote script fast-forwards `/opt/giveaway-bot`, runs Compose through Doppler, waits for the migration service, registers global Discord commands from the deployed bot image, and reloads the existing Vanguard Caddy container.

Command registration is an idempotent replacement of the global command set. If it fails, the Deploy workflow fails after the containers have been updated; correct the Discord or Doppler configuration and rerun the workflow to reconcile command metadata.

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
doppler run --project lilac-giveaway-bot --config prd -- \
  docker compose exec -T postgres pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB" \
  > "giveaway-$(date +%Y%m%d-%H%M%S).dump"
```

Store backups outside the VPS.

## Stuck jobs

Locks older than five minutes are automatically reclaimable. Inspect:

```sql
SELECT id, type, giveaway_id, attempts, max_attempts, run_at, locked_at, last_error
FROM jobs
WHERE completed_at IS NULL
ORDER BY run_at;
```

Do not manually mark a draw complete. Correct the external or data failure, then clear `locked_at` and set `run_at = now()` for the specific job.

## Drand outage

The complete-draw job retries with exponential backoff up to five minutes. Candidate and round commitments remain unchanged. Never substitute local randomness or choose a different round after commitment.

## Discord permission error

Confirm the bot can view and send messages in the target channel. For prize roles, confirm Lilac's highest role is above every configured role. After correction, retry the failed job.

## Caddy

```bash
docker ps --filter label=com.docker.compose.service=caddy
docker exec <caddy-container> caddy validate --config /etc/caddy/Caddyfile
docker exec <caddy-container> caddy reload --config /etc/caddy/Caddyfile
```

The DNS A record must resolve `giveaway.leni.cat` to `46.224.13.57`.
