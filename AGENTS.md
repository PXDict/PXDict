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
only glibc-linked `-cgo` binaries ([ADR 0002](docs/adr/0002-build-wudict-from-source.md)). PXDict talks
to it only over loopback HTTP and contains **no Go code of its own**.
PXDict itself is licensed GPL-3.0-or-later and written in **TypeScript** end to end
([ADR 0004](docs/adr/0004-typescript-gateway-better-auth.md)).

Compared to the original design, PXDict adds:

- **Its own user management and login** (regular users / admins) with several sign-in methods:
  password, passkeys, social/OIDC providers, email links/codes, optional two-factor
  ([Better Auth](https://www.better-auth.com/)).
- **Per-user data:** search history, choice of dictionaries from the approved set, favorites, settings.
- **Dictionary proposals:** a user uploads dictionary files → they sit in a quarantine area → an admin
  reviews and approves them (system-wide, or private to the proposer) or rejects them.
- **Storage administration:** admins see disk usage and can delete original dictionary files, indexes,
  rejected proposals and orphaned files to save space.

## 2. Architecture (must be followed)

```text
Browser / installed PWA ──https──▶ reverse proxy / Cloudflare tunnel (TLS only)
                                        │
              ┌─────────────────────────▼────────────────────────────┐
              │ 1 container, 1 port :8080, 1 volume /data             │
              │                                                       │
              │  pxdict-gateway (Node.js + Hono) :8080                │
              │   ├─ /              → static PWA (/srv/pwa)           │
              │   ├─ /app-api/auth/* → Better Auth (sign-in methods)  │
              │   ├─ /app-api/*     → PXDict's own API                │
              │   └─ /api/* /res/*… → controlled proxy ──┐            │
              │                       (allowlist + token) │            │
              │  wuDict 127.0.0.1:6888  ◀─────────────────┘            │
              │  (unmodified upstream Go binary)                      │
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
   `gateway/src/wudict/routes.ts`. wuDict admin routes (`/setup`, library, delete, ingest, …) are
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
8. **PXDict accounts are the only login layer.** Authentication goes through Better Auth; do not
   hand-roll password hashing, sessions or OAuth flows, and do not add an outer login layer (Cloudflare
   Access, basic auth) without an ADR.

## 3. Repository layout

One npm workspace (root `package.json`, one `package-lock.json`). Directories are created when the
phase that needs them lands, not ahead of time as empty placeholders.

```text
PXDict/
├── AGENTS.md, CLAUDE.md, README.md, CONTRIBUTING.md, SECURITY.md, CHANGELOG.md
├── WUDICT_VERSION              # pinned wuDict tag (dev.sh, gen:api, Dockerfile default)
├── package.json                # workspaces + scripts that run across them
├── eslint.config.js, tsconfig.base.json
├── docs/
│   ├── PLAN.md                 # phased plan; tick checklist items as work lands
│   ├── design/wudict-pwa.md    # original design (archived, read-only, Vietnamese)
│   ├── wudict-notes.md         # verified wuDict behaviour (Phase 0 output)
│   ├── operations.md           # runbook (Phase 9)
│   └── adr/NNNN-*.md           # architecture decision records
├── shared/                     # @pxdict/shared: the contract between gateway and PWA
│   ├── scripts/gen-api.mjs     # generates src/wudict.schema.d.ts
│   └── src/
│       ├── api/                # zod schemas + inferred types for /app-api
│       ├── wudict.ts           # named wuDict types
│       └── wudict.schema.d.ts  # generated from wuDict's openapi.yaml
├── gateway/                    # @pxdict/gateway: Node.js 26 + Hono, bundled with esbuild
│   ├── src/
│   │   ├── main.ts             # entry point: config, listen, graceful shutdown
│   │   ├── app.ts              # builds the Hono app (routes, middleware)
│   │   ├── config.ts           # env parsing (zod), defaults, validation
│   │   ├── http/               # error shape, shared middleware
│   │   ├── db/                 # Drizzle schema + client (Phase 2)
│   │   ├── auth/               # Better Auth instance, plugins, guards (Phase 3)
│   │   ├── wudict/             # client, proxy, route allowlist, test fake (Phase 2)
│   │   └── history/ dicts/ favorites/ proposals/ storage/ audit/   (later phases)
│   └── drizzle/                # generated SQL migrations (append-only)
├── pwa/                        # @pxdict/pwa: Vite + Preact + TypeScript
│   └── src/
│       ├── api/
│       │   ├── wudict.ts       # the ONLY adapter for wuDict /api, /res
│       │   └── app.ts          # the ONLY adapter for /app-api
│       └── i18n/               # en.json (source), vi.json
├── docker/entrypoint.sh
├── Dockerfile
├── scripts/                    # dev.sh, smoke-test.sh, latest-wudict.sh, setup-swap.sh, server-update.sh, backup.sh
├── deploy/                     # compose.yaml, .env.example, systemd/
└── .github/                    # workflows, issue/PR templates, dependabot
```

## 4. Common commands

Run from the repository root unless noted.

| Task | Command |
|---|---|
| Install dependencies | `npm ci` |
| Run dev stack (wuDict + gateway + Vite) | `scripts/dev.sh` |
| Typecheck + lint + test everything | `npm run typecheck && npm run lint && npm test` |
| Gateway tests only | `npm test -w @pxdict/gateway` |
| PWA tests only | `npm test -w @pxdict/pwa` |
| Generate wuDict API types | `npm run gen:api` (`-- --check` in CI) |
| Build gateway bundle + PWA | `npm run build` |
| Build image locally | `docker build --build-arg WUDICT_VERSION=v3.7.11 -t pxdict:dev .` |
| Smoke-test image | `scripts/smoke-test.sh pxdict:dev` |

Before reporting work as done: run the tests and linters for what you changed. If you could not run
them, say so and why.

## 5. Code conventions

**General**
- English everywhere (see §0). UI strings go through i18n, never hard-coded.
- Conventional Commits: `feat(gateway): ...`, `fix(pwa): ...`, `feat(shared): ...`, `docs: ...`,
  `chore(ci): ...`.
- Never commit `.env`, tokens, dictionary files, or `*.db` files.
- TypeScript everywhere with `strict: true` (plus `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`); ESLint `strictTypeChecked`. No `any` without a comment saying why.
- Prefer well-maintained libraries over hand-written code for solved problems (auth, validation, ORM).
  New runtime dependencies need a justification in the PR; keep the gateway's dependency list short.

**Shared contract (`shared/`)**
- Every `/app-api` request and response body has a zod schema in `shared/src/api/`. The gateway
  validates with it; the PWA imports only the inferred types (`import type`), so zod is not bundled into
  the PWA unless needed.
- `shared/` has no runtime dependencies other than zod and no Node- or DOM-specific code.

**Gateway (`gateway/`)**
- Node.js 26 LTS, ES modules, Hono (`@hono/node-server`). Configuration only from environment variables,
  parsed once in `config.ts`.
- SQLite via `better-sqlite3` + Drizzle ORM. Migrations are generated by `drizzle-kit` into
  `gateway/drizzle/`; append-only, never edit a released migration.
- Authentication only through Better Auth (`gateway/src/auth/`). PXDict tables reference Better Auth's
  `user.id`.
- One API error shape: `{"error": {"code": "snake_case", "message": "..."}}` (Better Auth's own
  `/app-api/auth/*` responses keep their format).
- Every admin write action is recorded in `audit_log`.
- File operations stay inside `/data` and go through `storage/safe-path.ts` (`safeJoin`: path
  traversal and symlink safe). Never build paths from user input with `path.join` directly.
- Logging: structured JSON to stdout (`pino` or a small wrapper); never `console.log` in shipped code.
- Tests: Vitest, table-driven where it helps, Hono's `app.request()` for HTTP, SQLite in a temp dir.
  wuDict is faked by `gateway/src/wudict/fake.ts`; contract tests run against the real binary in CI.

**PWA (`pwa/`)**
- UI code **never calls `fetch` directly**, only through `src/api/*.ts` (ESLint enforces this).
- `build.assetsDir = "app-assets"` (avoids wuDict's `/assets/*`) — do not change.
- Service worker caches are **namespaced per user** and **wiped on logout** (shared devices).
- Never cache `/app-api/*` in the service worker.

## 6. Security — things that must not go wrong

- Passwords are hashed by Better Auth (scrypt). Sessions: `HttpOnly`, `Secure` (behind HTTPS),
  `SameSite=Lax` cookie signed with `BETTER_AUTH_SECRET`. Better Auth stores session tokens unhashed, so
  `pxdict.db` and its backups are secrets ([ADR 0004](docs/adr/0004-typescript-gateway-better-auth.md)).
- State-changing requests (`POST/PUT/PATCH/DELETE` on `/app-api`) must pass the **origin check**:
  `Origin` equal to `PUBLIC_URL`'s origin (or, without `Origin`, `Sec-Fetch-Site: same-origin`). Better
  Auth enforces this on its routes via `trustedOrigins`; PXDict routes use the same middleware.
- Rate-limit sign-in, sign-up, password reset and email sending (Better Auth's limiter, stored in the
  database so it survives restarts). Sign-in errors never reveal whether an account exists.
- OAuth/OIDC providers are enabled only by configuration; accounts are linked to an existing user only
  through verified emails. Registration policy (closed / invite / open) applies to **every** sign-in
  method, including the first social or OIDC sign-in.
- **Dictionary content is untrusted**, especially user-proposed dictionaries. Render by default in an
  iframe with `sandbox="allow-scripts"` (opaque origin); only dictionaries an admin marks `trusted_render`
  may render same-origin.
- Proposed files stay in `/data/proposals/` (outside `DICT_DIR`) until approved. Check size, extension,
  file count, zip bombs, file names.
- Deletion always has a **dry-run preview** (paths + bytes) before confirmation. No unconfirmed bulk delete.
- Never log passwords, tokens, cookies, OAuth codes/secrets, or `Authorization` header values.

## 7. Unverified wuDict behaviour

The original design marks several points **[needs verification]**. Phase 0 answers them in
`docs/wudict-notes.md`. **Do not write code that depends on assumed wuDict behaviour** that the notes
have not confirmed. If you must assume, mark it `// ASSUMPTION(wudict): ...` in code and add it to the
"Open questions" section of the notes.

wuDict's API has no version prefix. Generating types from its `openapi.yaml` + `tsc` in CI, plus the
gateway's contract tests against the real binary, are the main guard rails.

## 8. Working with the plan

- Follow the phase order in `docs/PLAN.md`. Keep each PR within one phase.
- When an item is done, tick `[x]` in `docs/PLAN.md` in the same PR.
- Any deviation from this file or the plan → write a short ADR in `docs/adr/` and update this file.
