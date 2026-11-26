#!/usr/bin/env bash
# Enable a swap file on the host, so indexing a large dictionary runs slower instead of being killed by
# the OOM killer (docs/operations.md#memory). Idempotent; run as root.
#
#   sudo scripts/setup-swap.sh [size]      size: e.g. 2G (default), 1536M
#
# Environment: SWAPFILE (default /swapfile).
# Also sets vm.swappiness=10 (swap only under pressure) and vm.vfs_cache_pressure=50 (keep the
# inode/dentry cache that SQLite benefits from) in /etc/sysctl.d/99-pxdict-swap.conf.
set -euo pipefail

size="${1:-2G}"
swapfile="${SWAPFILE:-/swapfile}"

die() {
  printf 'setup-swap: %s\n' "$*" >&2
  exit 1
}

(($(id -u) == 0)) || die "run as root (sudo $0 $size)"
[[ "$size" =~ ^([0-9]+)([MG])$ ]] || die "size must look like 2G or 1536M, got '$size'"
size_mb="${BASH_REMATCH[1]}"
[[ "${BASH_REMATCH[2]}" == M ]] || size_mb=$((size_mb * 1024))
((size_mb >= 256)) || die "a swap file smaller than 256M is not useful"

if swapon --show=NAME --noheadings | grep -qxF "$swapfile"; then
  echo "swap $swapfile is already on:"
else
  [[ ! -e "$swapfile" ]] || die "$swapfile exists but is not active swap; remove it or set SWAPFILE"
  echo "creating $swapfile (${size_mb}M)..."
  fstype="$(stat -f -c %T "$(dirname "$swapfile")")"
  if [[ "$fstype" == btrfs ]]; then
    # btrfs needs a NOCOW, non-compressed file; its own tool sets that up.
    btrfs filesystem mkswapfile --size "${size_mb}m" "$swapfile"
  else
    # fallocate is fast but unsupported on some filesystems; dd always works.
    fallocate -l "${size_mb}M" "$swapfile" 2>/dev/null ||
      dd if=/dev/zero of="$swapfile" bs=1M count="$size_mb" status=progress
    chmod 600 "$swapfile"
    mkswap "$swapfile" >/dev/null
  fi
  swapon "$swapfile"
  grep -qE "^${swapfile}[[:space:]]" /etc/fstab || printf '%s none swap sw 0 0\n' "$swapfile" >>/etc/fstab
fi

cat >/etc/sysctl.d/99-pxdict-swap.conf <<'EOF'
# Written by PXDict's scripts/setup-swap.sh.
vm.swappiness=10
vm.vfs_cache_pressure=50
EOF
sysctl --system >/dev/null

swapon --show
free -h
# Without cgroup swap accounting, compose's memswap_limit has no effect (the container may still swap).
if docker info 2>&1 | grep -qi 'no swap limit support'; then
  echo "note: Docker reports 'No swap limit support': memswap_limit in compose.yaml is ignored on this host."
fi
