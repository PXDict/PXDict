# PXDict

> A self-hosted, multi-user dictionary PWA built on top of [wuDict](https://github.com/PXDict/wudict).

[![CI](https://github.com/thanhhvnqb/PXDict/actions/workflows/ci.yml/badge.svg)](https://github.com/thanhhvnqb/PXDict/actions/workflows/ci.yml)
![Status: planning](https://img.shields.io/badge/status-planning-lightgrey)

PXDict packages the wuDict dictionary server together with an installable Progressive Web App and a
small Go gateway that adds accounts and per-user features. Everything ships as **one container, one
port, one volume**, small enough for a 1 GB VPS.

## Features (planned)

- 🔎 Fast lookups across MDX/MDD and other formats supported by wuDict, with suggestions and offline history
- 📱 Installable PWA (Android share target, iOS home screen)
- 👤 Accounts with user/admin roles, invite-based registration
- 🕘 Per-user search history, favorites, settings and dictionary selection
- 📤 Users propose new dictionaries; admins review them in a quarantine area before enabling them
- 🧹 Storage dashboard for admins: delete originals, indexes and leftovers with a dry-run preview
- 🔄 Nightly CI picks up new wuDict releases, tests them, and publishes a multi-arch image to GHCR

## Architecture

```text
Browser / PWA ──▶ Cloudflare tunnel ──▶ pxdict-gateway :8080 ──▶ wuDict 127.0.0.1:6888
                                         ├─ static PWA
                                         ├─ /app-api (users, history, proposals, admin)
                                         └─ /api, /res (allowlisted proxy, token injected)
```

See [`AGENTS.md`](AGENTS.md) for the architecture rules and [`docs/PLAN.md`](docs/PLAN.md) for the roadmap.

## Repository layout

| Path | Contents |
|---|---|
| [`gateway/`](gateway/) | Go gateway: auth, per-user data, proposals, storage admin, wuDict proxy |
| [`pwa/`](pwa/) | Vite + TypeScript Progressive Web App |
| [`docker/`](docker/) | Container entrypoint |
| [`scripts/`](scripts/) | Dev, release and server helper scripts |
| [`deploy/`](deploy/) | Docker Compose + cloudflared + systemd units for self-hosting |
| [`docs/`](docs/) | Plan, ADRs, design notes, operations runbook |

## Quick start

> Not runnable yet — the project is in Phase 0/1 of the [plan](docs/PLAN.md).

```bash
# development (Phase 1)
scripts/dev.sh

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
