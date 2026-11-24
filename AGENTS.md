# AGENTS.md — PXDict

Guidance for AI agents (Claude Code, Codex, Cursor, …) and human contributors working in this repository.
Read this whole file before changing anything. The phased plan is in [`docs/PLAN.md`](docs/PLAN.md);
the original single-user design is in [`docs/design/wudict-pwa.md`](docs/design/wudict-pwa.md).

---

## 0. Language rule (mandatory)

**Always work and answer in English**, even when the request is written in another language
(e.g. Vietnamese). This applies to:

- replies, explanations, plans and summaries given to the user;
- code, identifiers, comments, log messages, error messages;
- commit messages, PR titles/descriptions, issues;
- documentation in `docs/` and every Markdown file in the repo.

The only exceptions:

- user-facing UI strings, which live in i18n files (`pwa/src/i18n/<lang>.json`) — English is the source
  locale, Vietnamese (`vi`) is a translation;
- quoting text verbatim (e.g. an error message or a user's words);
- `docs/design/wudict-pwa.md`, which is an archived source document kept in its original Vietnamese.
  Do not edit it; if you need its content elsewhere, translate it into English there.

If a request in another language is ambiguous, restate your understanding **in English** before acting.

## 1. What this project is

PXDict is a **multi-user dictionary PWA** built on top of [wuDict](https://github.com/PXDict/wudict)
(a Go dictionary server, GPL-3.0). wuDict is **not modified**: the image builds the unmodified upstream
source (`wuweidict/wudict`) at a pinned stable tag as a static `-tags purego` binary, because releases ship
only glibc-linked `-cgo` binaries ([ADR 0002](docs/adr/0002-build-wudict-from-source.md)).
PXDict itself is licensed GPL-3.0-or-later.

Compared to the original design, PXDict adds:

- **User management and login** (regular users / admins).
- **Per-user data:** search history, choice of dictionaries from the approved set, favorites, settings.
- **Dictionary proposals:** a user uploads dictionary files → they sit in a quarantine area → an admin
  reviews and approves them (system-wide, or private to the proposer) or rejects them.
- **Storage administration:** admins see disk usage and can delete original dictionary files, indexes,
  rejected proposals and orphaned files to save space.

## 2. Architecture (must be followed)

```text
Browser / installed PWA ──https──▶ Cloudflare (tunnel, optional Access)
                                        │
              ┌─────────────────────────▼────────────────────────────┐
              │ 1 container, 1 port :8080, 1 volume /data             │
              │                                                       │
              │  pxdict-gateway (Go) :8080                            │
              │   ├─ /              → static PWA (/srv/pwa)           │
              │   ├─ /app-api/*     → PXDict's own API                │
              │   └─ /api/* /res/*… → controlled proxy ──┐            │
              │                       (allowlist + token) │            │
              │  wuDict 127.0.0.1:6888  ◀─────────────────┘            │
              │                                                       │
              │  /data                                                │
              │   ├─ dictionaries/    approved dictionaries (wuDict)  │
              │   ├─ db/              wuDict indexes                  │
              │   ├─ .wudict/         wuDict config                   │
              │   ├─ gateway/         pxdict.db (gateway SQLite)      │
              │   └─ proposals/<id>/  quarantine, invisible to wuDict │
              └───────────────────────────────────────────────────────┘
```

Architecture rules:

1. **The gateway is the only entry point.** Browsers never talk to wuDict directly and **never learn
   wuDict's `AUTH_TOKEN`**. The gateway adds `Authorization: Bearer <AUTH_TOKEN>` when proxying and sets
   `Host: 127.0.0.1:6888` (so `TRUSTED_HOSTS` is not needed).
2. **Allowlist, not denylist.** The gateway proxies only the wuDict routes listed in
   `gateway/internal/wudict/routes.go`. wuDict admin routes (`/setup`, library, delete, ingest, …) are
   admin-only and preferably reached indirectly through `/app-api/admin/*`.
3. **All per-user data lives in the gateway.** Do not use wuDict's `/api/words`, `/api/prefs`,
   `/api/groups` (they are global, single-user).
4. **The gateway replaces Caddy** from the original design (fewer processes, less RAM). Do not bring
   Caddy back without an ADR.
5. **Still one image, one port, one volume, configured via environment variables**
   (PikaPods / Fly.io compatible).
6. wuDict keeps `AUTH=on` and `SERVER_IP=127.0.0.1`. Never change these. wuDict serves `/api/dicts`,
   `/api/search` and `/res/` **without a token by design**, so loopback-only binding is what protects them.
7. wuDict runs with `USE_CACHED=1` (needed to keep dictionaries whose originals were deleted) and with
   `HOME`/`XDG_*` under `/data/.wudict/`. wuDict dictionary ids are path hashes and change; the gateway
   keys dictionaries on its own id + the library `uuid` (see `docs/wudict-notes.md`).

## 3. Repository layout

```text
PXDict/
├── AGENTS.md, CLAUDE.md, README.md, CONTRIBUTING.md, SECURITY.md, CHANGELOG.md
├── WUDICT_VERSION              # pinned wuDict tag (dev.sh, gen:api, Dockerfile default)
├── docs/
│   ├── PLAN.md                 # phased plan; tick checklist items as work lands
│   ├── design/wudict-pwa.md    # original design (archived, read-only, Vietnamese)
│   ├── wudict-notes.md         # verified wuDict behaviour (Phase 0 output)
│   ├── operations.md           # runbook (Phase 9)
│   └── adr/NNNN-*.md           # architecture decision records
├── gateway/                    # Go module: github.com/thanhhvnqb/pxdict/gateway
│   ├── cmd/pxdict-gateway/
│   ├── internal/
│   │   ├── config/             # env parsing, defaults, validation
│   │   ├── store/              # SQLite (modernc.org/sqlite), embedded migrations
│   │   ├── auth/               # argon2id, sessions, middleware, CSRF
│   │   ├── users/  history/  dicts/  favorites/
│   │   ├── proposals/          # upload, validation, quarantine, review
│   │   ├── storage/            # disk usage, cleanup, SafeJoin
│   │   ├── audit/
│   │   ├── wudict/             # client + reverse proxy + allowlist
│   │   └── httpapi/            # router, handlers, error format
│   ├── migrations/NNNN_*.sql
│   └── openapi.yaml            # /app-api contract (source of PWA types)
├── pwa/                        # Vite + TypeScript
│   └── src/
│       ├── api/
│       │   ├── wudict.ts           # the ONLY adapter for wuDict /api, /res
│       │   ├── app.ts              # the ONLY adapter for /app-api
│       │   ├── wudict.schema.d.ts  # generated from wuDict's openapi.yaml
│       │   └── app.schema.d.ts     # generated from gateway/openapi.yaml
│       └── i18n/               # en.json (source), vi.json
├── docker/entrypoint.sh
├── Dockerfile
├── scripts/                    # latest-wudict.sh, setup-swap.sh, server-update.sh, dev.sh, smoke-test.sh, backup.sh
├── deploy/                     # compose.yaml, .env.example, systemd/
└── .github/                    # workflows, issue/PR templates, dependabot
```

## 4. Common commands

> These are Phase 1 targets. If a command does not exist yet, create it with exactly this name.

| Task | Command |
|---|---|
| Run dev stack (wuDict + gateway + Vite) | `scripts/dev.sh` |
| Gateway tests | `cd gateway && go test ./...` |
| Gateway lint | `cd gateway && go vet ./... && staticcheck ./...` |
| PWA typecheck + lint | `cd pwa && npm run typecheck && npm run lint` |
| PWA tests | `cd pwa && npm test` |
| Generate API types | `cd pwa && npm run gen:api` |
| Build image locally | `docker build --build-arg WUDICT_VERSION=v3.7.11 -t pxdict:dev .` |
| Smoke-test image | `scripts/smoke-test.sh pxdict:dev` |

Before reporting work as done: run the tests and linters for what you changed. If you could not run
them, say so and why.

## 5. Code conventions

**General**
- English everywhere (see §0). UI strings go through i18n, never hard-coded.
- Conventional Commits: `feat(gateway): ...`, `fix(pwa): ...`, `docs: ...`, `chore(ci): ...`.
- Never commit `.env`, tokens, dictionary files, or `*.db` files.

**Gateway (Go)**
- Go ≥ 1.26, no cgo (`CGO_ENABLED=0`), pure-Go SQLite `modernc.org/sqlite`.
- Prefer the standard library (`net/http` with `http.ServeMux` method/path patterns). New dependencies
  need a justification in the PR.
- Migrations are numbered SQL files embedded with `embed`; append-only, never edit a released migration.
- One API error shape: `{"error": {"code": "snake_case", "message": "..."}}`.
- Every admin write action is recorded in `audit_log`.
- File operations stay inside `/data` and go through `storage.SafeJoin` (path traversal and symlink
  safe). Never build paths from user input with `filepath.Join` directly.
- Tests: table-driven, `httptest`, SQLite in a temp dir. wuDict is faked by
  `internal/wudict/wudicttest`; contract tests run against the real binary in CI.

**PWA (TypeScript)**
- `strict: true`. UI code **never calls `fetch` directly**, only through `src/api/*.ts`.
- `build.assetsDir = "app-assets"` (avoids wuDict's `/assets/*`) — do not change.
- Service worker caches are **namespaced per user** and **wiped on logout** (shared devices).
- Never cache `/app-api/*` in the service worker.

## 6. Security — things that must not go wrong

- Passwords: argon2id. Sessions: `HttpOnly`, `Secure` (behind HTTPS), `SameSite=Lax` cookie, 256-bit
  random ID, only the **hash** of the ID stored in the DB.
- State-changing requests (`POST/PUT/PATCH/DELETE` on `/app-api`) require an `X-PXDict-CSRF` header
  matching the session's token.
- Rate-limit logins (per IP and per username). Login errors never reveal whether a username exists.
- **Dictionary content is untrusted**, especially user-proposed dictionaries. Render by default in an
  iframe with `sandbox="allow-scripts"` (opaque origin); only dictionaries an admin marks `trusted_render`
  may render same-origin.
- Proposed files stay in `/data/proposals/` (outside `DICT_DIR`) until approved. Check size, extension,
  file count, zip bombs, file names.
- Deletion always has a **dry-run preview** (paths + bytes) before confirmation. No unconfirmed bulk delete.
- Never log passwords, tokens, cookies, or `Authorization` header values.

## 7. Unverified wuDict behaviour

The original design marks several points **[needs verification]**. Phase 0 answers them in
`docs/wudict-notes.md`. **Do not write code that depends on assumed wuDict behaviour** that the notes
have not confirmed. If you must assume, mark it `// ASSUMPTION(wudict): ...` in code and add it to the
"Open questions" section of the notes.

wuDict's API has no version prefix. Generating types from its `openapi.yaml` + `tsc` in CI, plus the Go
contract tests, are the main guard rails.

## 8. Working with the plan

- Follow the phase order in `docs/PLAN.md`. Keep each PR within one phase.
- When an item is done, tick `[x]` in `docs/PLAN.md` in the same PR.
- Any deviation from this file or the plan → write a short ADR in `docs/adr/` and update this file.
