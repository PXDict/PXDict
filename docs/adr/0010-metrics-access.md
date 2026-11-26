# 0010. Who may read /metrics

- Status: accepted
- Date: 2026-11-26

## Context

Phase 10 of [`PLAN.md`](../PLAN.md) asks for an optional Prometheus `/metrics` endpoint "admin or loopback
only". The gateway is the only entry point of the container, so the endpoint is reachable from wherever
the gateway is.

"Loopback only" cannot be checked safely. The gateway sees the TCP peer of each request, and a reverse
proxy or tunnel on the same network namespace (cloudflared or Caddy on the host with
`network_mode: host`, a PaaS sidecar) makes every public request arrive from `127.0.0.1`. In the
default `deploy/compose.yaml` the peer is the cloudflared container instead, which is not loopback
either, so a loopback rule would both be unsafe in some deployments and useless in the documented one.
`CLIENT_IP_HEADER` does not help: it is only trustworthy when every request passes the proxy, and a
scraper on loopback would not.

## Decision

- `/metrics` exists only when `METRICS=true`; otherwise it answers 404 like any reserved path.
- It is served to an **admin session** (the same `requireAdmin` check as `/app-api/admin/*`: database
  role, ban, the 2FA policy), or to a request with `Authorization: Bearer <METRICS_TOKEN>` when
  `METRICS_TOKEN` (at least 32 characters) is set. The token is compared in constant time and treated
  as a secret in configuration errors.
- No address-based exception.
- Labels are bounded: route groups (`/api/search`, `/app-api/me`, `static`, …), method and status. Paths,
  queries, user ids and dictionary ids never appear.
- The metrics are written by hand (`gateway/src/http/metrics.ts`, Prometheus text format 0.0.4) instead
  of adding `prom-client`, which keeps the gateway's dependency list short (AGENTS.md §5).

## Consequences

- A Prometheus server scrapes with `authorization: { credentials: <METRICS_TOKEN> }`; an admin can open
  `/metrics` in the browser.
- The endpoint is safe to leave enabled behind any proxy: without a session or the token it answers 401.
- The plan's "loopback" wording is replaced by this ADR.
