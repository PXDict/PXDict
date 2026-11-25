#!/usr/bin/env bash
# Container entry point (run by tini): prepares /data, then supervises wuDict (loopback only) and
# pxdict-gateway. If either process exits, the other is stopped and the container exits with that
# status, so Docker / PikaPods restarts it (original design §3.2).
#
# Environment (beyond the gateway's own, see gateway/src/config.ts):
#   AUTH_TOKEN                 wuDict's access token, shared only by wuDict and the gateway.
#                              Default: a fresh random token on every start (nothing else needs it).
#   BETTER_AUTH_SECRET         signs session cookies and encrypts OAuth tokens; must stay the same
#                              across restarts. Default: generated once and kept in
#                              /data/gateway/better-auth-secret (mode 600).
#   GATEWAY_MAX_OLD_SPACE_MB   V8 heap limit of the gateway (default 128).
#   INDEX_WORKERS, PREVIEW_MEMORY, SEARCH_MEMORY, MORPH_CACHE, MEMORY_LIMIT, COMPRESSION, AUTO_INDEX,
#   GOGC, GOMEMLIMIT, TZ       passed to wuDict when set. No other variable reaches wuDict.
set -euo pipefail

log() {
  # One JSON line, like the gateway's logs. Messages are fixed strings (no user input).
  printf '{"time":"%s","level":"%s","msg":"%s","component":"entrypoint"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2"
}
die() {
  log error "$1"
  exit 1
}

data="/data"
wudict_addr="127.0.0.1:6888"

[[ -d "$data" && -w "$data" ]] ||
  die "$data is not writable by uid $(id -u); give the volume to uid 1000 (e.g. chown -R 1000:1000)"

if [[ -z "${AUTH_TOKEN:-}" ]]; then
  AUTH_TOKEN="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
fi
((${#AUTH_TOKEN} >= 32)) || die "AUTH_TOKEN must be at least 32 characters (e.g. openssl rand -hex 32)"

mkdir -p "$data"/{dictionaries,db,gateway,proposals,tmp} "$data"/.wudict/{config,data,state,home}

# Unlike AUTH_TOKEN, this secret must survive restarts (sessions, encrypted OAuth tokens), so a
# generated one is stored on the volume. Changing it signs everyone out.
secret_file="$data/gateway/better-auth-secret"
if [[ -z "${BETTER_AUTH_SECRET:-}" ]]; then
  if [[ ! -s "$secret_file" ]]; then
    (umask 077 && od -An -N32 -tx1 /dev/urandom | tr -d ' \n' >"$secret_file.tmp" && mv "$secret_file.tmp" "$secret_file")
    log info "generated BETTER_AUTH_SECRET in $secret_file"
  fi
  BETTER_AUTH_SECRET="$(<"$secret_file")"
fi
((${#BETTER_AUTH_SECRET} >= 32)) || die "BETTER_AUTH_SECRET must be at least 32 characters (e.g. openssl rand -hex 32)"

# --- wuDict ---------------------------------------------------------------------------------------
# A clean environment: only the tuning variables below are passed through, and the settings PXDict
# depends on are forced (AGENTS.md §2). HOME must not contain .wudict (docs/wudict-notes.md Q12).
wudict_env=(
  "PATH=$PATH"
  "HOME=$data/.wudict/home"
  "XDG_CONFIG_HOME=$data/.wudict/config"
  "XDG_DATA_HOME=$data/.wudict/data"
  "XDG_STATE_HOME=$data/.wudict/state"
  "DICT_DIR=$data/dictionaries"
  "DB_DIR=$data/db"
  "AUTH=on"
  "AUTH_TOKEN=$AUTH_TOKEN"
  "SERVER_IP=${wudict_addr%:*}"
  "SERVER_PORT=${wudict_addr#*:}"
  "USE_CACHED=1"
  "NO_BROWSER=1"
  "TRAY=0"
)
for name in INDEX_WORKERS PREVIEW_MEMORY SEARCH_MEMORY MORPH_CACHE MEMORY_LIMIT COMPRESSION AUTO_INDEX \
  GOGC GOMEMLIMIT TZ; do
  if [[ -n "${!name:-}" ]]; then wudict_env+=("$name=${!name}"); fi
done

# wuDict prints its access key (`?k=<token>`) at startup; never let it reach the container logs.
redact() {
  local line
  while IFS= read -r line || [[ -n "$line" ]]; do
    printf '%s\n' "${line//"$AUTH_TOKEN"/[redacted]}"
  done
}

log info "starting wuDict ${WUDICT_VERSION:-unknown} on $wudict_addr"
env -i "${wudict_env[@]}" /usr/local/bin/wudict serve > >(redact) 2>&1 &
wudict_pid=$!

# --- gateway --------------------------------------------------------------------------------------
log info "starting pxdict-gateway"
AUTH_TOKEN="$AUTH_TOKEN" BETTER_AUTH_SECRET="$BETTER_AUTH_SECRET" DATA_DIR="$data" WUDICT_URL="http://$wudict_addr" \
  node --max-old-space-size="${GATEWAY_MAX_OLD_SPACE_MB:-128}" /app/pxdict-gateway.mjs &
gateway_pid=$!

# --- supervision ----------------------------------------------------------------------------------
stopping=0
stop() {
  kill -TERM "$wudict_pid" "$gateway_pid" 2>/dev/null || true
}
trap 'stopping=1; log info "stopping"; stop' TERM INT

set +e
wait -n "$wudict_pid" "$gateway_pid"
status=$?
# `wait -n` also returns when a trapped signal arrives; either way, stop both and wait for them.
stop
wait "$wudict_pid" "$gateway_pid" 2>/dev/null
if ((stopping)); then
  log info "stopped"
  exit 0
fi
# A process ended on its own: always a failure, so restart policies (on-failure) apply.
((status != 0)) || status=1
log error "a process exited unexpectedly (status $status)"
exit "$status"
