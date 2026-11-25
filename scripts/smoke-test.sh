#!/usr/bin/env bash
# Smoke-test a built PXDict image: start it, wait until healthy, and check what users and attackers
# can reach.
#
#   scripts/smoke-test.sh [image]        (default pxdict:dev)
#
# Checks: the PWA (/, /manifest.webmanifest, a client-side route), /healthz, security headers,
# non-allowlisted wuDict routes answer 404, wuDict listens on loopback only, the token never reaches
# the logs, and a lookup through the gateway finds a word in a small generated DSL dictionary.
# Requirements: docker, curl.
set -euo pipefail
shopt -s inherit_errexit

image="${1:-pxdict:dev}"
name="pxdict-smoke-$$"
token="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
failures=0

log() { printf '\033[1;34m[smoke]\033[0m %s\n' "$*" >&2; }
pass() { printf '  \033[32mok\033[0m   %s\n' "$*" >&2; }
fail() {
  printf '  \033[31mFAIL\033[0m %s\n' "$*" >&2
  failures=$((failures + 1))
}

# shellcheck disable=SC2329 # invoked by the EXIT trap
cleanup() {
  local status=$?
  if ((status != 0 || failures != 0)); then
    log "container logs:"
    docker logs "$name" 2>&1 | tail -n 50 >&2 || true
  fi
  docker rm -f "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

log "starting $image"
docker run -d --name "$name" -e AUTH_TOKEN="$token" -p 127.0.0.1::8080 "$image" >/dev/null
port="$(docker port "$name" 8080/tcp | head -n 1 | sed 's/.*://')"
base="http://127.0.0.1:$port"
docker exec "$name" true

log "waiting for $base/healthz"
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "$base/healthz" 2>/dev/null; then break; fi
  if [[ "$(docker inspect -f '{{.State.Running}}' "$name")" != true ]]; then
    log "the container stopped"
    exit 1
  fi
  sleep 1
done

# status URL expected-status [extra curl args…]: checks the HTTP status code.
status() {
  local url="$1" want="$2" got
  shift 2
  got="$(curl -sS -o /dev/null -w '%{http_code}' "$@" "$base$url")"
  if [[ "$got" == "$want" ]]; then pass "$url → $got"; else fail "$url → $got (want $want)"; fi
}
# body URL pattern: checks that the body matches an extended regex.
body() {
  local url="$1" pattern="$2" got
  got="$(curl -sS "$base$url")"
  if grep -Eq -- "$pattern" <<<"$got"; then pass "$url matches /$pattern/"; else fail "$url does not match /$pattern/: ${got:0:300}"; fi
}
# header URL name pattern
header() {
  local url="$1" header="$2" pattern="$3" got
  got="$(curl -sS -o /dev/null -D - "$base$url" | tr -d '\r' | grep -i "^$header:" | head -n 1 || true)"
  if grep -Eiq -- "$pattern" <<<"$got"; then pass "$url $header"; else fail "$url $header: ${got:-missing} (want /$pattern/)"; fi
}

log "PWA and health"
status / 200
body / '<div id="app">'
status /some/client/route 200
status /manifest.webmanifest 200
header /manifest.webmanifest content-type 'application/manifest\+json'
header / cache-control 'no-cache'
header / content-security-policy "default-src 'self'"
header / x-content-type-options nosniff
body /healthz '"status":"ok"'
body /healthz '"wudict":"ok"'

log "docker health status"
for _ in $(seq 1 30); do
  health="$(docker inspect -f '{{.State.Health.Status}}' "$name")"
  [[ "$health" == starting ]] || break
  sleep 1
done
if [[ "$health" == healthy ]]; then pass "container is healthy"; else fail "container health: $health"; fi

log "wuDict routes that are not allowlisted"
for path in /setup /api/setup /api/library /api/rescan /api/config /api/prefs /api/words /api/groups \
  /api/ingest /api/openapi.yaml /assets/frame.js /style/x.css /files/x /lemmas /browse; do
  status "$path" 404
done
status "/api/library?dict=x" 404 -X DELETE
status "/?k=$token" 200
header "/?k=$token" set-cookie '^$'

log "wuDict is reachable on loopback only"
listeners="$(docker exec "$name" netstat -ltn)"
if grep -Eq '127\.0\.0\.1:6888 ' <<<"$listeners" && ! grep -Eq '(0\.0\.0\.0|::|\[::\]):6888 ' <<<"$listeners"; then
  pass "wuDict listens on 127.0.0.1:6888 only"
else
  fail "unexpected wuDict listeners: $listeners"
fi
ip="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$name")"
if [[ -n "$ip" ]]; then
  if curl -s -m 3 -o /dev/null "http://$ip:6888/api/dicts"; then
    fail "wuDict answers on $ip:6888"
  else
    pass "wuDict does not answer on $ip:6888"
  fi
fi

log "a lookup through the gateway"
printf '#NAME "PXDict Smoke"\n#INDEX_LANGUAGE "English"\n#CONTENTS_LANGUAGE "English"\n\nhello\n\t[m1]a greeting[/m]\nhelp\n\t[m1]assistance[/m]\n' |
  docker exec -i "$name" sh -c 'mkdir -p /data/dictionaries/smoke && cat > /data/dictionaries/smoke/smoke.dsl'
# New files are not picked up automatically (docs/wudict-notes.md Q10); rescan from inside the container.
docker exec -e T="$token" "$name" sh -c \
  'wget -q -O /dev/null --header "Authorization: Bearer $T" http://127.0.0.1:6888/api/rescan'
body /api/dicts '"name":"PXDict Smoke"'
body /api/dicts '^[^/]*$'
body "/api/search?q=hello&mode=exact" '"Headword":"hello".*a greeting'
body "/api/suggest?q=hel" '"words":\["hello","help"\]'
header "/api/search?q=hello" content-type 'application/x-ndjson'

log "logs"
if docker logs "$name" 2>&1 | grep -qF "$token"; then fail "the token appears in the logs"; else pass "the token is not in the logs"; fi

if ((failures)); then
  log "$failures check(s) failed"
  exit 1
fi
log "all checks passed"
