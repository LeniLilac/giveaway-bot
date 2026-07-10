#!/usr/bin/env bash
set -euo pipefail

DEPLOY_PATH="${DEPLOY_PATH:-/opt/giveaway-bot}"
REPOSITORY="${GITHUB_REPOSITORY:-LeniLilac/giveaway-bot}"
DOPPLER_PROJECT="${DOPPLER_PROJECT:-giveaway-bot}"
DOPPLER_CONFIG="${DOPPLER_CONFIG:-prd}"

if [[ -z "${DOPPLER_TOKEN:-}" ]]; then
  echo "DOPPLER_TOKEN is required." >&2
  exit 1
fi

if [[ ! -d "${DEPLOY_PATH}/.git" ]]; then
  mkdir -p "${DEPLOY_PATH}"
  git clone "https://github.com/${REPOSITORY}.git" "${DEPLOY_PATH}"
fi

cd "${DEPLOY_PATH}"
git fetch origin main
git checkout main
git pull --ff-only origin main

doppler run --project "${DOPPLER_PROJECT}" --config "${DOPPLER_CONFIG}" -- \
  docker compose -p giveaway-bot up -d --build --remove-orphans

CADDY_CONTAINER="$(docker ps \
  --filter label=com.docker.compose.project=vanguard-qc-bot \
  --filter label=com.docker.compose.service=caddy \
  --format '{{.ID}}' | head -n 1)"
if [[ -n "${CADDY_CONTAINER}" ]]; then
  docker exec "${CADDY_CONTAINER}" caddy reload --config /etc/caddy/Caddyfile
fi

docker image prune -f --filter "until=168h"
docker compose -p giveaway-bot ps
