#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SNIPPET_PATH="${CADDY_SNIPPET_PATH:-${SCRIPT_DIR}/Caddyfile.snippet}"
CADDY_PROJECT="${CADDY_COMPOSE_PROJECT:-vanguard-qc-bot}"
CADDY_SERVICE="${CADDY_COMPOSE_SERVICE:-caddy}"
BEGIN_MARKER="# BEGIN managed by giveaway-bot"
END_MARKER="# END managed by giveaway-bot"
MODE="sync"

case "${1:-}" in
  "") ;;
  --check) MODE="check" ;;
  --print-host-path) MODE="print-host-path" ;;
  *)
    echo "Usage: $0 [--check|--print-host-path]" >&2
    exit 2
    ;;
esac

if [[ ! -s "${SNIPPET_PATH}" ]]; then
  echo "Caddy snippet is missing or empty: ${SNIPPET_PATH}" >&2
  exit 1
fi

mapfile -t caddy_containers < <(
  docker ps \
    --filter "label=com.docker.compose.project=${CADDY_PROJECT}" \
    --filter "label=com.docker.compose.service=${CADDY_SERVICE}" \
    --format '{{.ID}}'
)
if (( ${#caddy_containers[@]} != 1 )); then
  echo "Expected exactly one running ${CADDY_PROJECT}/${CADDY_SERVICE} container; found ${#caddy_containers[@]}." >&2
  exit 1
fi
CADDY_CONTAINER="${caddy_containers[0]}"

mapfile -t caddy_mounts < <(
  docker inspect --format \
    '{{range .Mounts}}{{printf "%s|%s|%s|%t\n" .Destination .Type .Source .RW}}{{end}}' \
    "${CADDY_CONTAINER}"
)

CADDYFILE_PATH=""
for mount in "${caddy_mounts[@]}"; do
  IFS='|' read -r destination mount_type source _read_write <<<"${mount}"
  if [[ "${destination}" == "/etc/caddy/Caddyfile" ]]; then
    if [[ "${mount_type}" != "bind" ]]; then
      echo "/etc/caddy/Caddyfile must be a bind mount so deployments can update its host source safely." >&2
      exit 1
    fi
    CADDYFILE_PATH="${source}"
    break
  fi
  if [[ "${destination}" == "/etc/caddy" ]]; then
    if [[ "${mount_type}" != "bind" ]]; then
      echo "/etc/caddy must be a bind mount so deployments can update its host Caddyfile safely." >&2
      exit 1
    fi
    CADDYFILE_PATH="${source%/}/Caddyfile"
  fi
done

if [[ -z "${CADDYFILE_PATH}" ]]; then
  echo "The Caddy container does not expose /etc/caddy/Caddyfile through a supported bind mount." >&2
  exit 1
fi
if [[ ! -f "${CADDYFILE_PATH}" || ! -r "${CADDYFILE_PATH}" ]]; then
  echo "The host Caddyfile is not a readable regular file: ${CADDYFILE_PATH}" >&2
  exit 1
fi

if [[ "${MODE}" == "print-host-path" ]]; then
  printf '%s\n' "${CADDYFILE_PATH}"
  exit 0
fi
if [[ ! -w "${CADDYFILE_PATH}" ]]; then
  echo "The host Caddyfile is not writable by $(id -un): ${CADDYFILE_PATH}" >&2
  exit 1
fi

if [[ "${MODE}" == "sync" ]]; then
  exec 9<"${CADDYFILE_PATH}"
  if ! flock -x -w 30 9; then
    echo "Timed out waiting for the Caddyfile deployment lock." >&2
    exit 1
  fi
fi

begin_count="$(grep -Fxc -- "${BEGIN_MARKER}" "${CADDYFILE_PATH}" || true)"
end_count="$(grep -Fxc -- "${END_MARKER}" "${CADDYFILE_PATH}" || true)"
if [[ "${begin_count}" != "${end_count}" || "${begin_count}" -gt 1 ]]; then
  echo "The managed giveaway-bot markers in ${CADDYFILE_PATH} are malformed; refusing to edit Caddy configuration." >&2
  exit 1
fi

docker exec "${CADDY_CONTAINER}" caddy validate --config /etc/caddy/Caddyfile >/dev/null
if [[ "${MODE}" == "check" ]]; then
  echo "Caddy bootstrap check passed for ${CADDYFILE_PATH}."
  exit 0
fi

candidate="$(mktemp)"
backup="$(mktemp)"
config_replaced=false

restore_previous_config() {
  echo "Restoring the previous Caddy configuration." >&2
  if ! cat -- "${backup}" >"${CADDYFILE_PATH}"; then
    echo "CRITICAL: the previous Caddy configuration could not be restored on disk." >&2
    return 1
  fi
  config_replaced=false
  if ! docker exec "${CADDY_CONTAINER}" caddy validate --config /etc/caddy/Caddyfile >/dev/null \
     || ! docker exec "${CADDY_CONTAINER}" caddy reload --config /etc/caddy/Caddyfile >/dev/null; then
    echo "CRITICAL: the previous Caddy configuration was restored on disk but could not be reloaded." >&2
    return 1
  fi
}

cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  if [[ "${config_replaced}" == "true" ]] && ! restore_previous_config; then
    status=1
  fi
  rm -f -- "${candidate}" "${backup}"
  exit "${status}"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
chmod 0600 "${candidate}" "${backup}"
cp -- "${CADDYFILE_PATH}" "${backup}"

current="$(<"${CADDYFILE_PATH}")"
snippet="$(<"${SNIPPET_PATH}")"

if [[ "${begin_count}" -eq 1 ]]; then
  prefix="${current%%"${BEGIN_MARKER}"*}"
  after_begin="${current#*"${BEGIN_MARKER}"}"
  if [[ "${after_begin}" != *"${END_MARKER}"* ]]; then
    echo "The managed Caddy block ends before it begins; refusing to edit it." >&2
    exit 1
  fi
  suffix="${after_begin#*"${END_MARKER}"}"
  printf '%s%s\n%s\n%s%s\n' \
    "${prefix}" "${BEGIN_MARKER}" "${snippet}" "${END_MARKER}" "${suffix}" \
    >"${candidate}"
elif [[ "${current}" == *"${snippet}"* ]]; then
  prefix="${current%%"${snippet}"*}"
  suffix="${current#*"${snippet}"}"
  if [[ "${suffix}" == *"${snippet}"* ]]; then
    echo "The legacy Caddy snippet appears more than once; refusing an ambiguous migration." >&2
    exit 1
  fi
  printf '%s%s\n%s\n%s%s\n' \
    "${prefix}" "${BEGIN_MARKER}" "${snippet}" "${END_MARKER}" "${suffix}" \
    >"${candidate}"
elif grep -Fq -- 'giveaway.leni.cat' "${CADDYFILE_PATH}"; then
  echo "An unmanaged giveaway.leni.cat Caddy block differs from the tracked snippet; reconcile it manually before deploying." >&2
  exit 1
else
  printf '%s\n\n%s\n%s\n%s\n' \
    "${current}" "${BEGIN_MARKER}" "${snippet}" "${END_MARKER}" \
    >"${candidate}"
fi

config_replaced=true
cat -- "${candidate}" >"${CADDYFILE_PATH}"

if ! docker exec "${CADDY_CONTAINER}" caddy validate --config /etc/caddy/Caddyfile; then
  exit 1
fi
if ! docker exec "${CADDY_CONTAINER}" caddy reload --config /etc/caddy/Caddyfile; then
  exit 1
fi

config_replaced=false
echo "Installed and reloaded the tracked giveaway-bot Caddy snippet."
