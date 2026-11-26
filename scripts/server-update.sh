#!/usr/bin/env bash
# Self-hosted update (docs/operations.md#updates): pull the app image, and when it changed, optionally
# back up, recreate the container and wait until it is healthy. Run by deploy/systemd/pxdict-update.timer.
#
#   scripts/server-update.sh
#
# Environment:
#   PXDICT_DIR                     folder with compose.yaml and .env (default /opt/pxdict)
#   PXDICT_BACKUP_BEFORE_UPDATE=1  run scripts/backup.sh (next to this script) before restarting;
#                                  its own settings (BACKUP_*) come from the same environment
#   PXDICT_HEALTH_TIMEOUT          seconds to wait for "healthy" (default 300)
# Exits non-zero when the pull, the backup or the health check fails, so systemd shows the failure.
# A pinned tag in PXDICT_IMAGE never moves, so updates then happen only when you change the pin.
set -euo pipefail
shopt -s inherit_errexit

dir="${PXDICT_DIR:-/opt/pxdict}"
timeout="${PXDICT_HEALTH_TIMEOUT:-300}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf '%s server-update: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

cd "$dir"
image="$(docker compose config --images app)"
container="$(docker compose ps -q app)"
running="$([[ -n "$container" ]] && docker inspect -f '{{.Image}}' "$container" || true)"

docker compose pull --quiet app
pulled="$(docker image inspect -f '{{.Id}}' "$image")"

if [[ -n "$running" && "$running" == "$pulled" ]]; then
  log "up to date: $image ($pulled)"
  docker image prune -f >/dev/null
  exit 0
fi

log "updating $image: ${running:-not running} -> $pulled"
if [[ "${PXDICT_BACKUP_BEFORE_UPDATE:-0}" == 1 ]]; then
  log "backing up first"
  PXDICT_DIR="$dir" "$here/backup.sh"
fi

docker compose up -d --remove-orphans
container="$(docker compose ps -q app)"
state=unknown
for ((waited = 0; waited < timeout; waited += 5)); do
  state="$(docker inspect -f '{{.State.Health.Status}}' "$container")"
  [[ "$state" == healthy ]] && break
  sleep 5
done
if [[ "$state" != healthy ]]; then
  log "the new container is '$state' after ${timeout}s; see 'docker compose logs app'. To roll back, pin the previous tag in PXDICT_IMAGE (docs/operations.md#rolling-back)."
  exit 1
fi
log "healthy: $(docker inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}} (wuDict {{index .Config.Labels "io.github.wudict.version"}})' "$container")"
# Removes the untagged previous image. Rolling back pulls an older tag from the registry again.
docker image prune -f >/dev/null
