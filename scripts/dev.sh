#!/usr/bin/env bash
# Run the PXDict development stack: wuDict (loopback) + pxdict-gateway + the Vite dev server.
#
#   scripts/dev.sh
#
# Open http://127.0.0.1:5173 (Vite). Vite forwards /app-api, /api, /res, /r and /healthz to the gateway.
# Ctrl-C stops everything; if one process exits, the others are stopped too.
#
# Requirements: Go (version in gateway/go.mod), Node.js 22+, curl.
#
# Environment (all optional):
#   WUDICT_VERSION   wuDict tag (default: contents of ./WUDICT_VERSION)
#   WUDICT_REPO      GitHub repository with the tags (default wuweidict/wudict)
#   WUDICT_BIN       use this wuDict binary instead of downloading one
#   WUDICT_BUILD     "release" (default): download the official -cgo release binary (fine on glibc
#                    Linux and macOS); "source": build the purego binary from source, as the image does
#   DEV_DATA_DIR     data directory with the /data layout (default .cache/dev-data)
#   GATEWAY_PORT     gateway port (default 8080)
#   WUDICT_PORT      wuDict port (default 6888)
# The ( … ) subshells below scope each process's environment on purpose:
# shellcheck disable=SC2030,SC2031
set -euo pipefail
shopt -s inherit_errexit

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

version="${WUDICT_VERSION:-$(tr -d '[:space:]' < WUDICT_VERSION)}"
wudict_repo="${WUDICT_REPO:-wuweidict/wudict}"
data="${DEV_DATA_DIR:-$repo_root/.cache/dev-data}"
gateway_port="${GATEWAY_PORT:-8080}"
wudict_port="${WUDICT_PORT:-6888}"

log() { printf '\033[1;34m[dev]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[dev]\033[0m %s\n' "$*" >&2; exit 1; }

for cmd in go node npm curl; do
  command -v "$cmd" >/dev/null || die "$cmd is required (see the header of scripts/dev.sh)"
done

# --- wuDict binary -------------------------------------------------------------------------------
wudict_bin() {
  if [[ -n "${WUDICT_BIN:-}" ]]; then
    [[ -x "$WUDICT_BIN" ]] || die "WUDICT_BIN=$WUDICT_BIN is not executable"
    printf '%s\n' "$WUDICT_BIN"
    return
  fi

  local mode="${WUDICT_BUILD:-release}" os arch
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) die "unsupported OS $(uname -s): set WUDICT_BIN" ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=amd64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) die "unsupported CPU $(uname -m): set WUDICT_BIN" ;;
  esac

  local dir="$repo_root/.cache/wudict/$version-$mode"
  local bin="$dir/wudict"
  if [[ -x "$bin" ]]; then
    printf '%s\n' "$bin"
    return
  fi
  mkdir -p "$dir"

  case "$mode" in
    release)
      # Releases ship only -cgo binaries (docs/wudict-notes.md, Q0); they run on glibc hosts.
      local url="https://github.com/$wudict_repo/releases/download/$version/wudict-$os-$arch-cgo"
      log "downloading $url"
      curl -fL --proto '=https' --retry 3 -o "$bin.part" "$url" \
        || die "download failed; try WUDICT_BUILD=source or set WUDICT_BIN"
      chmod +x "$bin.part"
      mv "$bin.part" "$bin"
      ;;
    source)
      # Same build as the image (docs/adr/0002-build-wudict-from-source.md).
      local src="$dir/src"
      rm -rf "$src"
      log "building wuDict $version from source (purego)"
      git clone --quiet --depth 1 --branch "$version" "https://github.com/$wudict_repo.git" "$src"
      (cd "$src" && CGO_ENABLED=0 go build -buildvcs=false -trimpath -tags purego \
        -ldflags "-s -w -X github.com/wuweidict/wudict/internal/cli.Version=$version" \
        -o "$bin" .)
      rm -rf "$src"
      ;;
    *) die "WUDICT_BUILD must be release or source" ;;
  esac
  printf '%s\n' "$bin"
}

wudict="$(wudict_bin)"
log "wuDict: $wudict"

# --- gateway binary ------------------------------------------------------------------------------
gateway="$repo_root/.cache/bin/pxdict-gateway"
log "building pxdict-gateway"
(cd gateway && CGO_ENABLED=0 go build -o "$gateway" ./cmd/pxdict-gateway)

# --- PWA dependencies ----------------------------------------------------------------------------
if [[ ! -d pwa/node_modules ]]; then
  log "installing PWA dependencies"
  (cd pwa && npm ci)
fi

# --- data directory (same layout as /data in the image) ------------------------------------------
mkdir -p "$data"/{dictionaries,db,gateway,proposals,tmp} "$data"/.wudict/{config,data,state,home}

# A fresh token per run: only the gateway and wuDict know it.
auth_token="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"

pids=()
# shellcheck disable=SC2329 # invoked by the EXIT trap
cleanup() {
  trap - EXIT INT TERM
  if ((${#pids[@]})); then
    log "stopping"
    kill "${pids[@]}" 2>/dev/null || true
    wait "${pids[@]}" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# wuDict: loopback only, AUTH=on, USE_CACHED=1 (AGENTS.md §2). HOME must not be the data dir
# (docs/wudict-notes.md, Q12).
(
  export HOME="$data/.wudict/home" \
    XDG_CONFIG_HOME="$data/.wudict/config" \
    XDG_DATA_HOME="$data/.wudict/data" \
    XDG_STATE_HOME="$data/.wudict/state" \
    DICT_DIR="$data/dictionaries" \
    DB_DIR="$data/db" \
    AUTH=on \
    AUTH_TOKEN="$auth_token" \
    SERVER_IP=127.0.0.1 \
    SERVER_PORT="$wudict_port" \
    USE_CACHED=1 \
    INDEX_WORKERS=1 \
    NO_BROWSER=1
  exec "$wudict" serve
) &
pids+=($!)
log "wuDict on 127.0.0.1:$wudict_port (data: $data)"

(
  export LISTEN_ADDR="127.0.0.1:$gateway_port" \
    DATA_DIR="$data" \
    WUDICT_URL="http://127.0.0.1:$wudict_port" \
    AUTH_TOKEN="$auth_token" \
    PWA_DIR="$repo_root/pwa/dist"
  exec "$gateway"
) &
pids+=($!)
log "gateway on 127.0.0.1:$gateway_port"

(
  cd pwa
  export PXDICT_GATEWAY_URL="http://127.0.0.1:$gateway_port"
  exec node_modules/.bin/vite
) &
pids+=($!)
log "PWA on http://127.0.0.1:5173"

# Stop everything as soon as one process exits.
set +e
wait -n "${pids[@]}"
status=$?
log "a process exited (status $status)"
exit "$status"
