#!/usr/bin/env bash
# Back up a self-hosted PXDict (docs/operations.md#backups): a consistent snapshot of the gateway
# database (`pxdict-gateway db backup`, safe while running), the generated BETTER_AUTH_SECRET, wuDict's
# config (/data/.wudict) and the host's compose.yaml + .env, in one encrypted archive.
# Run by deploy/systemd/pxdict-backup.timer; restore with scripts/restore.sh.
#
#   scripts/backup.sh
#
# Not included (large, back them up separately, e.g. rsync): data/dictionaries/ (originals),
# data/db/ (wuDict indexes, rebuilt from the originals) and data/proposals/.
#
# The archive contains session tokens, OAuth tokens, password hashes and secrets, so it is encrypted:
#   BACKUP_AGE_RECIPIENTS        file of age public keys (age -R; recommended: the private key stays off
#                                the server), or
#   BACKUP_GPG_PASSPHRASE_FILE   file with a passphrase (gpg --symmetric, AES256), or
#   BACKUP_UNENCRYPTED=1         write a plain .tar.gz (only onto storage that is itself encrypted).
# Other settings:
#   PXDICT_DIR    folder with compose.yaml and .env (default /opt/pxdict)
#   BACKUP_DIR    where archives go (default /var/backups/pxdict; created with mode 700)
#   BACKUP_KEEP   archives to keep, oldest removed first (default 14; 0 keeps all)
set -euo pipefail
shopt -s inherit_errexit

dir="${PXDICT_DIR:-/opt/pxdict}"
out_dir="${BACKUP_DIR:-/var/backups/pxdict}"
keep="${BACKUP_KEEP:-14}"

log() { printf '%s backup: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() {
  log "error: $*"
  exit 1
}

[[ "$keep" =~ ^[0-9]+$ ]] || die "BACKUP_KEEP must be a whole number"
if [[ -n "${BACKUP_AGE_RECIPIENTS:-}" ]]; then
  command -v age >/dev/null || die "age is not installed (apt install age)"
  [[ -r "$BACKUP_AGE_RECIPIENTS" ]] || die "cannot read BACKUP_AGE_RECIPIENTS=$BACKUP_AGE_RECIPIENTS"
  ext=tar.gz.age
  encrypt() { age -R "$BACKUP_AGE_RECIPIENTS"; }
elif [[ -n "${BACKUP_GPG_PASSPHRASE_FILE:-}" ]]; then
  command -v gpg >/dev/null || die "gpg is not installed"
  [[ -r "$BACKUP_GPG_PASSPHRASE_FILE" ]] || die "cannot read BACKUP_GPG_PASSPHRASE_FILE=$BACKUP_GPG_PASSPHRASE_FILE"
  ext=tar.gz.gpg
  encrypt() {
    gpg --batch --quiet --symmetric --cipher-algo AES256 --pinentry-mode loopback \
      --passphrase-file "$BACKUP_GPG_PASSPHRASE_FILE" -o -
  }
elif [[ "${BACKUP_UNENCRYPTED:-0}" == 1 ]]; then
  ext=tar.gz
  encrypt() { cat; }
else
  die "set BACKUP_AGE_RECIPIENTS or BACKUP_GPG_PASSPHRASE_FILE (or BACKUP_UNENCRYPTED=1)"
fi

umask 077
mkdir -p "$out_dir"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir "$work/data"

cd "$dir"
[[ -n "$(docker compose ps -q app)" ]] || die "the app container is not running (cd $dir && docker compose up -d)"

# Inside the container (busybox sh): stage the files under /data/tmp, stream them out as a tar, clean up.
# The snapshot is written by the gateway itself, so no sqlite3 binary is needed on the host or image.
# shellcheck disable=SC2016 # expanded by the container's shell
docker compose exec -T app sh -euc '
  stage="/data/tmp/backup-$$"
  trap "rm -rf \"$stage\"" EXIT
  mkdir -p "$stage/gateway"
  node /app/pxdict-gateway.mjs db backup "$stage/gateway/pxdict.db" >/dev/null
  [ ! -f /data/gateway/better-auth-secret ] || cp -p /data/gateway/better-auth-secret "$stage/gateway/"
  [ ! -d /data/.wudict ] || cp -a /data/.wudict "$stage/.wudict"
  tar -C "$stage" -cf - .
' | tar -C "$work/data" -xf -
[[ -s "$work/data/gateway/pxdict.db" ]] || die "the database snapshot is missing or empty"

mkdir "$work/host"
for f in compose.yaml .env; do
  [[ ! -f "$f" ]] || cp -p "$f" "$work/host/"
done
container="$(docker compose ps -q app)"
{
  echo "format=1"
  echo "created=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "host=$(hostname)"
  docker inspect -f 'image={{.Config.Image}}
image_id={{.Image}}
pxdict_version={{index .Config.Labels "org.opencontainers.image.version"}}
wudict_version={{index .Config.Labels "io.github.wudict.version"}}' "$container"
} >"$work/MANIFEST"

name="pxdict-$(date -u +%Y%m%dT%H%M%SZ).$ext"
tar -C "$work" -czf - MANIFEST data host | encrypt >"$out_dir/.$name.partial"
mv "$out_dir/.$name.partial" "$out_dir/$name"
log "wrote $out_dir/$name ($(du -h "$out_dir/$name" | cut -f1))"

if ((keep > 0)); then
  mapfile -t old < <(find "$out_dir" -maxdepth 1 -type f -name 'pxdict-*.tar.gz*' -printf '%f\n' | sort -r | tail -n +$((keep + 1)))
  for f in "${old[@]}"; do
    rm -f -- "${out_dir:?}/$f"
    log "removed old backup $f"
  done
fi
