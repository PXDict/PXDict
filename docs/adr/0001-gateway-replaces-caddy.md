# 0001. A Go gateway replaces Caddy in front of wuDict

- Status: accepted
- Date: 2026-11-24

## Context

The original design ([design/wudict-pwa.md](../design/wudict-pwa.md)) put Caddy in front of wuDict and
relied on Cloudflare Access plus wuDict's single access token. PXDict needs multiple users with roles,
per-user history/dictionaries/favorites, file uploads with admin review, and storage management.
wuDict has one global token and global (single-user) preferences, and several of its endpoints need no
token at all (`/api/dicts`, `/api/search`, `/res/`).

## Decision

A small Go service, `pxdict-gateway`, listens on `:8080` and:

- serves the static PWA (Caddy is removed);
- owns accounts, sessions and all per-user data in its own SQLite database;
- proxies an **allowlist** of wuDict routes, injecting the wuDict token server-side and setting
  `Host: 127.0.0.1:6888`;
- exposes PXDict's own API under `/app-api`.

The container still has one port and one volume; `entrypoint.sh` supervises wuDict + gateway.

## Consequences

- Users never see the wuDict token; wuDict admin routes are unreachable for regular users.
- Cloudflare Access becomes optional rather than required.
- `TRUSTED_HOSTS` is no longer needed.
- We maintain more code (auth, proxy) and must keep the allowlist in sync with wuDict — covered by
  contract tests in CI.
- Go keeps the runtime footprint small and matches wuDict's toolchain.
