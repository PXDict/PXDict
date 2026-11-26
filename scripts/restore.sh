#!/usr/bin/env bash
# Restore an archive written by scripts/backup.sh (docs/operations.md#restoring-a-backup). Stops the app,
# puts the database, BETTER_AUTH_SECRET and wuDict config back into data/, starts the app and waits
# until it is healthy. What it replaces is moved aside to data/restore-<time>/, never deleted.
# Run as root (it sets the owner of the restored files to uid 1000).
#
#   sudo scripts/restore.sh [-y] <archive>
#
#   -y   do not ask for confirmation
# Decryption: .age needs BACKUP_AGE_IDENTITY (age -i, the private key); .gpg uses
# BACKUP_GPG_PASSPHRASE_FILE, or asks for the passphrase.
# PXDICT_DIR: folder with compose.yaml and .env (default /opt/pxdict); data/ is its bind-mounted /data.
# compose.yaml and .env are restored only when missing; otherwise they are written next to the current
# ones as *.from-backup for you to compare (BETTER_AUTH_SECRET in .env must match the backup's).
set -euo pipefail
shopt -s inherit_errexit

dir="${PXDICT_DIR:-/opt/pxdict}"
yes=0
log() { printf 'restore: %s\n' "$*" >&2; }
die() {
  log "error: $*"
  exit 1
}

[[ "${1:-}" == -y ]] && yes=1 && shift
(($# == 1)) || die "usage: $0 [-y] <archive>"
archive="$1"
[[ -r "$archive" ]] || die "cannot read $archive"
(($(id -u) == 0)) || die "run as root (sudo $0 ...)"

umask 077
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
case "$archive" in
  *.tar.gz.age)
    [[ -r "${BACKUP_AGE_IDENTITY:-}" ]] || die "set BACKUP_AGE_IDENTITY to the age private key file"
    age -d -i "$BACKUP_AGE_IDENTITY" "$archive" ;;
  *.tar.gz.gpg)
    if [[ -n "${BACKUP_GPG_PASSPHRASE_FILE:-}" ]]; then
      gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$BACKUP_GPG_PASSPHRASE_FILE" -d "$archive"
    else
      gpg --quiet -d "$archive"
    fi ;;
  *.tar.gz) cat "$archive" ;;
  *) die "unknown archive type (expected .tar.gz, .tar.gz.age or .tar.gz.gpg)" ;;
esac | tar -C "$work" -xzf -

grep -qx 'format=1' "$work/MANIFEST" 2>/dev/null || die "not a PXDict backup (no MANIFEST with format=1)"
[[ -s "$work/data/gateway/pxdict.db" ]] || die "the archive has no database"

data="$dir/data"
echo "Backup:"
sed 's/^/  /' "$work/MANIFEST"
echo "This replaces $data/gateway/pxdict.db, better-auth-secret and $data/.wudict (moved aside first)."
if ((!yes)); then
  read -r -p "Continue? [y/N] " answer
  [[ "$answer" == [yY]* ]] || die "cancelled"
fi

cd "$dir"
[[ -f compose.yaml ]] || cp -p "$work/host/compose.yaml" compose.yaml 2>/dev/null || die "no compose.yaml in $dir or in the backup"
for f in compose.yaml .env; do
  [[ -f "$work/host/$f" ]] || continue
  if [[ -f "$f" ]]; then
    cmp -s "$f" "$work/host/$f" || { cp -p "$work/host/$f" "$f.from-backup" && log "wrote $dir/$f.from-backup (differs from the current $f)"; }
  else
    cp -p "$work/host/$f" "$f"
    log "restored $dir/$f"
  fi
done

docker compose stop app
aside="$data/restore-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$aside/gateway" "$data/gateway"
for f in pxdict.db pxdict.db-wal pxdict.db-shm better-auth-secret; do
  [[ ! -e "$data/gateway/$f" ]] || mv "$data/gateway/$f" "$aside/gateway/"
done
[[ ! -e "$data/.wudict" ]] || mv "$data/.wudict" "$aside/.wudict"

cp -p "$work/data/gateway/pxdict.db" "$data/gateway/pxdict.db"
[[ ! -f "$work/data/gateway/better-auth-secret" ]] || cp -p "$work/data/gateway/better-auth-secret" "$data/gateway/"
[[ ! -d "$work/data/.wudict" ]] || cp -a "$work/data/.wudict" "$data/.wudict"
chown -R 1000:1000 "$data/gateway" "$aside"
[[ ! -d "$data/.wudict" ]] || chown -R 1000:1000 "$data/.wudict"
log "previous files moved to $aside (delete it once the restore is verified)"

docker compose up -d
container="$(docker compose ps -q app)"
state=unknown
for ((waited = 0; waited < 300; waited += 5)); do
  state="$(docker inspect -f '{{.State.Health.Status}}' "$container")"
  [[ "$state" == healthy ]] && break
  sleep 5
done
[[ "$state" == healthy ]] || die "the app is '$state' after 300s; see 'docker compose logs app'"
log "done: the app is healthy (data/dictionaries and data/db were not touched)"
