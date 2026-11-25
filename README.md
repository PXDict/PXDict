# PXDict

> A self-hosted, multi-user dictionary PWA built on top of [wuDict](https://github.com/PXDict/wudict).

[![CI](https://github.com/thanhhvnqb/PXDict/actions/workflows/ci.yml/badge.svg)](https://github.com/thanhhvnqb/PXDict/actions/workflows/ci.yml)
![Status: planning](https://img.shields.io/badge/status-planning-lightgrey)

PXDict packages the unmodified wuDict dictionary server together with an installable Progressive Web
App and a small TypeScript gateway (Node.js + Hono) that adds accounts and per-user features. Everything ships as **one container, one
port, one volume**, small enough for a 1 GB VPS.

## Features (planned)

- 🔎 Fast lookups across MDX/MDD and other formats supported by wuDict, with suggestions and offline history
- 📱 Installable PWA (Android share target, iOS home screen)
- 👤 Self-managed accounts with user/admin roles and invite-based registration; sign in with a password,
  passkeys, Google/GitHub/Microsoft/Apple/…, any OpenID Connect provider, or an email link/code, with
  optional two-factor authentication ([Better Auth](https://www.better-auth.com/))
- 🕘 Per-user search history, favorites, settings and dictionary selection
- 📤 Users propose new dictionaries; admins review them in a quarantine area before enabling them
- 🧹 Storage dashboard for admins: delete originals, indexes and leftovers with a dry-run preview
- 🔄 Nightly CI picks up new wuDict releases, tests them, and publishes a multi-arch image to GHCR

## Architecture

```text
Browser / PWA ──▶ TLS (e.g. Cloudflare tunnel) ──▶ pxdict-gateway :8080 ──▶ wuDict 127.0.0.1:6888
                                         ├─ static PWA
                                         ├─ /app-api/auth (Better Auth sign-in methods)
                                         ├─ /app-api (users, history, proposals, admin)
                                         └─ /api, /res (allowlisted proxy, token injected)
```

See [`AGENTS.md`](AGENTS.md) for the architecture rules and [`docs/PLAN.md`](docs/PLAN.md) for the roadmap.

## Repository layout

| Path | Contents |
|---|---|
| [`gateway/`](gateway/) | TypeScript gateway: auth, per-user data, proposals, storage admin, wuDict proxy |
| [`shared/`](shared/) | Contract between gateway and PWA: zod schemas, wuDict's generated types |
| [`pwa/`](pwa/) | Vite + Preact + TypeScript Progressive Web App |
| [`docker/`](docker/) | Container entrypoint |
| [`scripts/`](scripts/) | Dev, release and server helper scripts |
| [`deploy/`](deploy/) | Docker Compose + cloudflared + systemd units for self-hosting |
| [`docs/`](docs/) | Plan, ADRs, design notes, operations runbook |

## Quick start

> Not usable yet — Phase 1 (skeleton) of the [plan](docs/PLAN.md) is done.

```bash
# development: Node.js 26 LTS (see .nvmrc)
npm ci
scripts/dev.sh                       # http://127.0.0.1:5173
npm run typecheck && npm run lint && npm test

# self-hosting (Phase 9)
cp deploy/.env.example deploy/.env   # fill in values
docker compose -f deploy/compose.yaml up -d
```

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md). Security issues: see [`SECURITY.md`](SECURITY.md).

## License

PXDict is licensed under the [GNU General Public License v3.0 or later](LICENSE).

The published container image also bundles the wuDict binary, built without modification from
<https://github.com/wuweidict/wudict> (GPL-3.0-or-later) at the tag recorded in the image label
`io.github.wudict.version`; that tag is its corresponding source. `wudict licenses` inside the
container prints wuDict's third-party notices.
