# Homelab deployment

Production moved from the QC VPS to `leni-server` on 2026-09-24.
The deploy workflow builds images on GitHub-hosted runners and publishes immutable
commit tags to GHCR. A dedicated `giveaway-bot-homelab-deploy` listener can invoke only
the root-owned deployment helper for this project; it has no Docker group access.
The helper verifies the current main revision and image labels, saves and
independently downloads a private B2 backup, then updates application containers
and checks startup health. Database migrations are forward-only.

Host policy and secrets: `/etc/side-projects/giveaway-bot`. Service:
`side-project@giveaway-bot.service`. Daily backups:
`side-project-backup@giveaway-bot.timer`. Deployment and backup receipts:
`/var/lib/side-projects/giveaway-bot`. The maintained host operators live in the
`leni-homelab` repository under `scripts/side-projects`.

Secrets were transferred privately from the existing production configuration;
keep Doppler as their recovery source and update the protected host environment
when rotating values. Runtime CI does not receive production credentials.
PostgreSQL stays on a private Docker network. Existing R2 objects remain in R2.
The old VPS runtime is stopped and retained for rollback; do not run both copies.
After destination writes begin, rollback requires reconciling the newer data.
Legacy `ops/deploy*` scripts target the retired VPS and must not be used for
production; the current GitHub workflow and protected host helper are authoritative.
