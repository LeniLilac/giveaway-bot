#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this bootstrap script as root." >&2
  exit 1
fi

command -v docker >/dev/null || {
  echo "Docker is expected to be installed by the existing Vanguard deployment." >&2
  exit 1
}

if ! command -v doppler >/dev/null; then
  apt-get update
  apt-get install -y apt-transport-https ca-certificates curl gnupg
  curl -sLf --retry 3 --tlsv1.2 --proto "=https" \
    "https://packages.doppler.com/public/cli/gpg.DE2A7741A397C129.key" |
    gpg --dearmor -o /usr/share/keyrings/doppler-archive-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/doppler-archive-keyring.gpg] https://packages.doppler.com/public/cli/deb/debian any-version main" \
    >/etc/apt/sources.list.d/doppler-cli.list
  apt-get update
  apt-get install -y doppler
fi

docker network inspect vanguard-qc-bot_default >/dev/null
install -d -m 0755 /opt/giveaway-bot

echo "Bootstrap complete. Add GitHub deployment secrets, then run the deployment workflow."
