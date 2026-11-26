#!/usr/bin/env bash
# Smoke-test a built PXDict image: start it, wait until healthy, and check what users and attackers
# can reach.
#
#   scripts/smoke-test.sh [image]        (default pxdict:dev)
#
# Checks: the PWA (/, /manifest.webmanifest, a client-side route), /healthz, security headers,
# non-allowlisted wuDict routes answer 404, wuDict listens on loopback only, secrets never reach the
# logs, sign-in (the bootstrapped admin and a regular user), the proxy and admin routes refuse
# requests without the right session, and a lookup through the gateway finds a word in a small
# generated DSL dictionary.
# Requirements: docker, curl.
set -euo pipefail
shopt -s inherit_errexit

image="${1:-pxdict:dev}"
name="pxdict-smoke-$$"
token="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
admin_password="smoke-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
user_password="smoke-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
jar="$(mktemp -d)"
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
  rm -rf "$jar"
}
trap cleanup EXIT

log "starting $image"
# PUBLIC_URL must match the address curl uses (Origin checks); the port is only known after start, so
# requests send Origin/Host for http://localhost:8080 explicitly.
docker run -d --name "$name" -e AUTH_TOKEN="$token" -e PUBLIC_URL=http://localhost:8080 \
  -e ADMIN_EMAIL=admin@example.com -e ADMIN_USERNAME=admin -e ADMIN_PASSWORD="$admin_password" \
  -p 127.0.0.1::8080 "$image" >/dev/null
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
# Off unless METRICS=true (ADR 0010).
status /metrics 404
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

# as COOKIE-JAR curl-args…: curl with a browser's session cookies and Origin.
as() {
  local who="$1"
  shift
  curl -sS -b "$jar/$who" -c "$jar/$who" -H "Origin: http://localhost:8080" "$@"
}
# as_status COOKIE-JAR URL expected-status [extra curl args…]
as_status() {
  local who="$1" url="$2" want="$3" got
  shift 3
  got="$(as "$who" -o /dev/null -w '%{http_code}' "$@" "$base$url")"
  if [[ "$got" == "$want" ]]; then pass "$who: $url → $got"; else fail "$who: $url → $got (want $want)"; fi
}

log "sessions and roles"
status "/api/search?q=hello" 401
status "/api/dicts" 401
status /app-api/me 401
status /app-api/admin/invites 401
body /app-api/auth/methods '"registration":"closed"'
status /app-api/auth/sign-up/email 403 -X POST -H "Origin: http://localhost:8080" -H 'Content-Type: application/json' \
  -d '{"email":"x@example.com","password":"long enough password","name":"x"}'
status /app-api/auth/sign-in/username 403 -X POST -H "Origin: https://evil.example" -H 'Content-Type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$admin_password\"}"
as_status admin /app-api/auth/sign-in/username 401 -X POST -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"wrong password here"}'
as_status admin /app-api/auth/sign-in/username 200 -X POST -H 'Content-Type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$admin_password\"}"
if as admin "$base/app-api/me" | grep -q '"role":"admin"'; then pass "admin: /app-api/me says admin"; else fail "admin: /app-api/me"; fi
as_status admin /app-api/admin/invites 200
as_status admin /app-api/auth/admin/create-user 200 -X POST -H 'Content-Type: application/json' \
  -d "{\"email\":\"reader@example.com\",\"name\":\"Reader\",\"password\":\"$user_password\"}"
as_status reader /app-api/auth/sign-in/email 200 -X POST -H 'Content-Type: application/json' \
  -d "{\"email\":\"reader@example.com\",\"password\":\"$user_password\"}"
as_status reader /app-api/admin/invites 403
as_status reader /app-api/auth/admin/list-users 403
as_status reader "/api/search?q=hello" 200

log "rescue CLI"
if docker exec "$name" node /app/pxdict-gateway.mjs user reset-password reader@example.com | grep -Eq '^[a-zA-Z0-9]{20}$'; then
  pass "user reset-password prints a new password"
else
  fail "user reset-password"
fi
# Only the session token: the cookie cache (pxdict.session_data) is valid for up to a minute.
status /app-api/me 401 -H "Cookie: pxdict.session_token=$(grep -F session_token "$jar/reader" | awk '{print $7}')"

log "a lookup through the gateway"
printf '#NAME "PXDict Smoke"\n#INDEX_LANGUAGE "English"\n#CONTENTS_LANGUAGE "English"\n\nhello\n\t[m1]a greeting[/m]\nhelp\n\t[m1]assistance[/m]\n' |
  docker exec -i "$name" sh -c 'mkdir -p /data/dictionaries/smoke && cat > /data/dictionaries/smoke/smoke.dsl'
# New files are not picked up automatically (docs/wudict-notes.md Q10); rescan from inside the container.
docker exec -e T="$token" "$name" sh -c \
  'wget -q -O /dev/null --header "Authorization: Bearer $T" http://127.0.0.1:6888/api/rescan'
# The gateway caches wuDict's dictionary list for a few seconds; wait for the new one.
for _ in $(seq 1 15); do
  if as admin "$base/api/dicts" | grep -q '"name":"PXDict Smoke"'; then break; fi
  sleep 1
done
as_body() {
  local url="$1" pattern="$2" got
  got="$(as admin "$base$url")"
  if grep -Eq -- "$pattern" <<<"$got"; then pass "$url matches /$pattern/"; else fail "$url does not match /$pattern/: ${got:0:300}"; fi
}
as_body /api/dicts '"name":"PXDict Smoke"'
as_body /api/dicts '^[^/]*$'
as_body "/api/search?q=hello&mode=exact" '"Headword":"hello".*a greeting'
as_body "/api/suggest?q=hel" '"words":\["hello","help"\]'
got="$(as admin -o /dev/null -D - "$base/api/search?q=hello" | tr -d '\r' | grep -i '^content-type:' || true)"
if grep -qi 'application/x-ndjson' <<<"$got"; then pass "/api/search content-type"; else fail "/api/search content-type: ${got:-missing}"; fi

log "logs"
secret="$(docker exec "$name" cat /data/gateway/better-auth-secret)"
logs="$(docker logs "$name" 2>&1)"
for s in "$token" "$secret" "$admin_password" "$user_password"; do
  if grep -qF -- "$s" <<<"$logs"; then fail "a secret appears in the logs"; else pass "a secret is not in the logs"; fi
done

if ((failures)); then
  log "$failures check(s) failed"
  exit 1
fi
log "all checks passed"
