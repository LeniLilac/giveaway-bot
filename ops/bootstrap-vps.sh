#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_USER="${DEPLOY_USER:-giveaway-deploy}"
DEPLOY_PATH="${DEPLOY_PATH:-/opt/giveaway-bot}"
BACKUP_PATH="${BACKUP_PATH:-/var/backups/giveaway-bot}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this bootstrap script as root." >&2
  exit 1
fi
if [[ ! "${DEPLOY_USER}" =~ ^[a-z_][a-z0-9_-]*[$]?$ ]]; then
  echo "DEPLOY_USER is not a valid local account name." >&2
  exit 1
fi
DEPLOY_PATH="$(realpath -m -- "${DEPLOY_PATH}")"
BACKUP_PATH="$(realpath -m -- "${BACKUP_PATH}")"
if [[ "${DEPLOY_PATH}" != /opt/* || "${BACKUP_PATH}" != /var/backups/* ]]; then
  echo "DEPLOY_PATH must be below /opt and BACKUP_PATH must be below /var/backups." >&2
  exit 1
fi
if [[ -L "${DEPLOY_PATH}" || -L "${BACKUP_PATH}" ]]; then
  echo "Deployment and backup paths must not be symbolic links." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y acl ca-certificates curl git gnupg util-linux

command -v docker >/dev/null || {
  echo "Docker is expected to be installed by the existing Vanguard deployment." >&2
  exit 1
}
docker info >/dev/null || {
  echo "The Docker daemon is unavailable." >&2
  exit 1
}
docker compose version >/dev/null || {
  echo "Docker Compose v2 is required." >&2
  exit 1
}
getent group docker >/dev/null || {
  echo "The Docker installation must provide a docker group." >&2
  exit 1
}

if ! command -v doppler >/dev/null; then
  curl -sLf --retry 3 --tlsv1.2 --proto "=https" \
    "https://packages.doppler.com/public/cli/gpg.DE2A7741A397C129.key" |
    gpg --batch --yes --dearmor -o /usr/share/keyrings/doppler-archive-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/doppler-archive-keyring.gpg] https://packages.doppler.com/public/cli/deb/debian any-version main" \
    >/etc/apt/sources.list.d/doppler-cli.list
  apt-get update
  apt-get install -y doppler
fi

docker network inspect vanguard-qc-bot_default >/dev/null

if ! id "${DEPLOY_USER}" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash --user-group "${DEPLOY_USER}"
fi
if [[ "$(id -u "${DEPLOY_USER}")" == "0" ]]; then
  echo "DEPLOY_USER must be a dedicated non-root account." >&2
  exit 1
fi
usermod -aG docker "${DEPLOY_USER}"
DEPLOY_GROUP="$(id -gn "${DEPLOY_USER}")"

install -d -o "${DEPLOY_USER}" -g "${DEPLOY_GROUP}" -m 0750 "${DEPLOY_PATH}"
install -d -o "${DEPLOY_USER}" -g "${DEPLOY_GROUP}" -m 0700 "${BACKUP_PATH}"
chown -R --preserve-root "${DEPLOY_USER}:${DEPLOY_GROUP}" "${DEPLOY_PATH}" "${BACKUP_PATH}"
runuser -u "${DEPLOY_USER}" -- docker info >/dev/null
runuser -u "${DEPLOY_USER}" -- docker compose version >/dev/null
runuser -u "${DEPLOY_USER}" -- doppler --version >/dev/null

CADDYFILE_PATH="$(bash "${SCRIPT_DIR}/sync-caddy.sh" --print-host-path)"
setfacl -m "u:${DEPLOY_USER}:rw" "${CADDYFILE_PATH}"
runuser -u "${DEPLOY_USER}" -- test -r "${CADDYFILE_PATH}"
runuser -u "${DEPLOY_USER}" -- test -w "${CADDYFILE_PATH}"
bash "${SCRIPT_DIR}/sync-caddy.sh" --check

cat <<EOF
Bootstrap complete.

- Deployment user: ${DEPLOY_USER}
- Deployment checkout: ${DEPLOY_PATH}
- Private backup directory: ${BACKUP_PATH}
- Managed host Caddyfile: ${CADDYFILE_PATH}

Install the deployment SSH public key for ${DEPLOY_USER}, set GitHub VPS_USER to
that same account, then add the remaining GitHub deployment secrets. A new login
is required before the account's docker-group membership is active.
EOF
