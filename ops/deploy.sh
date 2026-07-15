#!/usr/bin/env bash
set -euo pipefail

DEPLOY_PATH="${DEPLOY_PATH:-/opt/giveaway-bot}"
REPOSITORY="${GITHUB_REPOSITORY:-LeniLilac/giveaway-bot}"
DOPPLER_PROJECT="${DOPPLER_PROJECT:-lilac-giveaway-bot}"
DOPPLER_CONFIG="${DOPPLER_CONFIG:-prd}"
DEPLOY_SHA="${DEPLOY_SHA:-}"
DEPLOY_HEALTH_TIMEOUT_SECONDS="${DEPLOY_HEALTH_TIMEOUT_SECONDS:-180}"

if [[ -z "${DOPPLER_TOKEN:-}" ]]; then
  echo "DOPPLER_TOKEN is required." >&2
  exit 1
fi
if [[ ! "${DEPLOY_SHA}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "DEPLOY_SHA must be the full CI-tested commit SHA." >&2
  exit 1
fi
if [[ ! "${DEPLOY_HEALTH_TIMEOUT_SECONDS}" =~ ^[1-9][0-9]*$ ]] \
   || (( DEPLOY_HEALTH_TIMEOUT_SECONDS < 30 || DEPLOY_HEALTH_TIMEOUT_SECONDS > 600 )); then
  echo "DEPLOY_HEALTH_TIMEOUT_SECONDS must be an integer from 30 through 600." >&2
  exit 1
fi

if [[ ! -d "${DEPLOY_PATH}/.git" ]]; then
  mkdir -p "${DEPLOY_PATH}"
  git clone "https://github.com/${REPOSITORY}.git" "${DEPLOY_PATH}"
fi

cd "${DEPLOY_PATH}"
git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main
git merge-base --is-ancestor "${DEPLOY_SHA}" origin/main
if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
  echo "Refusing to deploy with a dirty production worktree." >&2
  exit 1
fi
CURRENT_SHA="$(git rev-parse HEAD)"
if [[ "${CURRENT_SHA}" != "${DEPLOY_SHA}" ]] \
   && git merge-base --is-ancestor "${DEPLOY_SHA}" "${CURRENT_SHA}" \
   && git merge-base --is-ancestor "${CURRENT_SHA}" origin/main; then
  echo "Skipping stale deploy ${DEPLOY_SHA}; production is already at ${CURRENT_SHA}."
  exit 0
fi
git checkout --detach "${DEPLOY_SHA}"
[[ "$(git rev-parse HEAD)" == "${DEPLOY_SHA}" ]]

log_one_shot_failure() {
  local service container_id
  for service in migrate db-provision; do
    container_id="$(
      docker ps -a \
        --filter label=com.docker.compose.project=giveaway-bot \
        --filter "label=com.docker.compose.service=${service}" \
        --format '{{.ID}}' \
        | head -n 1
    )"
    if [[ -n "${container_id}" ]]; then
      printf '%s\n' "${service} logs:" >&2
      docker logs --tail 200 "${container_id}" >&2 || true
    fi
  done
}

if ! doppler run --project "${DOPPLER_PROJECT}" --config "${DOPPLER_CONFIG}" -- \
  docker compose -p giveaway-bot up -d --build --remove-orphans; then
  log_one_shot_failure
  exit 1
fi

container_for_service() {
  local service="$1"
  local -a ids=()
  mapfile -t ids < <(
    docker ps -a \
      --filter label=com.docker.compose.project=giveaway-bot \
      --filter "label=com.docker.compose.service=${service}" \
      --format '{{.ID}}'
  )
  if (( ${#ids[@]} != 1 )); then
    echo "Expected exactly one giveaway-bot/${service} container; found ${#ids[@]}." >&2
    return 1
  fi
  printf '%s\n' "${ids[0]}"
}

wait_for_deployment() {
  local deadline=$((SECONDS + DEPLOY_HEALTH_TIMEOUT_SECONDS))
  local all_ready service container_id state health exit_code
  local -a services=(postgres migrate db-provision bot worker web)

  while (( SECONDS < deadline )); do
    all_ready=true
    for service in "${services[@]}"; do
      if ! container_id="$(container_for_service "${service}")"; then
        return 1
      fi
      read -r state health exit_code < <(
        docker inspect --format \
          '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.State.ExitCode}}' \
          "${container_id}"
      )

      if [[ "${service}" == "migrate" || "${service}" == "db-provision" ]]; then
        if [[ "${state}" == "exited" && "${exit_code}" == "0" ]]; then
          continue
        fi
        if [[ "${state}" == "exited" || "${state}" == "dead" ]]; then
          echo "One-shot service ${service} failed with state=${state}, exit_code=${exit_code}." >&2
          return 1
        fi
        all_ready=false
        continue
      fi

      if [[ "${state}" == "running" && "${health}" == "healthy" ]]; then
        continue
      fi
      if [[ "${health}" == "unhealthy" || "${state}" == "exited" \
            || "${state}" == "dead" || "${state}" == "restarting" ]]; then
        echo "Service ${service} failed readiness with state=${state}, health=${health}, exit_code=${exit_code}." >&2
        return 1
      fi
      all_ready=false
    done

    if [[ "${all_ready}" == "true" ]]; then
      echo "PostgreSQL, migrations, database roles, bot, worker, and web are ready."
      return 0
    fi
    sleep 3
  done

  echo "Timed out after ${DEPLOY_HEALTH_TIMEOUT_SECONDS}s waiting for deployment health." >&2
  for service in "${services[@]}"; do
    if container_id="$(container_for_service "${service}" 2>/dev/null)"; then
      docker inspect --format \
        "${service}: state={{.State.Status}}, health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}, exit_code={{.State.ExitCode}}" \
        "${container_id}" >&2
    fi
  done
  return 1
}

wait_for_deployment

bash "${DEPLOY_PATH}/ops/sync-caddy.sh"

BOT_CONTAINER="$(container_for_service bot)"
docker exec -i "${BOT_CONTAINER}" \
  node --import tsx apps/bot/src/deploy-commands.ts

if ! docker image prune -f --filter "until=168h"; then
  echo "Warning: deployment succeeded, but old Docker images could not be pruned." >&2
fi
docker ps -a \
  --filter label=com.docker.compose.project=giveaway-bot \
  --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'
