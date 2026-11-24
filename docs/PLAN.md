# PXDict — Phased implementation plan

> Written: 2026-11-24. Reference wuDict version: **v3.7.11** (latest stable tag; v3.7.12 is only a
> pre-release — see [wudict-notes.md](wudict-notes.md)). wuDict behaviour this plan relies on is verified in
> [`wudict-notes.md`](wudict-notes.md).
> Baseline: the [original design](design/wudict-pwa.md) (single user). This plan keeps the packaging,
> CI and deployment parts of that design and adds **user management, login, per-user data, dictionary
> proposals with admin review, and storage administration**.
> Working rules: see [`AGENTS.md`](../AGENTS.md).

---

## 0. Changes from the original design

| Topic | Original design | PXDict | Why |
|---|---|---|---|
| Process in front of wuDict | Caddy | **pxdict-gateway (Go)** | Needs logic: sessions, roles, per-user data, uploads. The gateway also serves static files, so Caddy is dropped |
| Login | Cloudflare Access + `/?k=<AUTH_TOKEN>` | **PXDict accounts** (username + password, session cookie). Cloudflare Access becomes an **optional** outer layer | Multiple users; users must not know wuDict's token |
| wuDict token | Browser cookie | **Held only by the gateway**, injected when proxying | Prevents users from calling wuDict admin APIs |
| `TRUSTED_HOSTS` | Required | Not needed | Gateway sends `Host: 127.0.0.1:6888` |
| Favorites, groups, settings | wuDict `/api/words`, `/api/groups`, `/api/prefs` | **Per-user tables in the gateway** | wuDict APIs are global |
| Entry rendering | Style A (same-origin iframe) first | **Style B (sandbox) by default**, A only for `trusted` dictionaries | User-proposed dictionaries + admin sessions on the same origin |
| Image name | `wudict-pwa` | `pxdict` (`IMAGE_NAME` in CI) | Repository name |

Also changed after Phase 0: the wuDict binary is **built from source** (purego) at a pinned stable tag,
because releases publish only glibc-linked `-cgo` binaries ([ADR 0002](adr/0002-build-wudict-from-source.md)).

Unchanged: one multi-arch image on GHCR, one port 8080, one volume `/data`,
cloudflared tunnel, swap + memory limits, CI auto-detecting new wuDict releases, systemd auto-update timer.

---

## 1. Data model (gateway SQLite at `/data/gateway/pxdict.db`)

```sql
users(id, username UNIQUE, display_name, password_hash, role CHECK(role IN ('user','admin')),
      status CHECK(status IN ('active','disabled')), created_at, last_login_at)
sessions(id_hash PRIMARY KEY, user_id, csrf_token, created_at, expires_at, last_seen_at, user_agent, ip)
invites(code_hash, created_by, role, expires_at, used_by, used_at)          -- REGISTRATION=invite

user_settings(user_id PRIMARY KEY, history_enabled, history_retention_days, default_mode, ui_lang, theme)
search_history(id, user_id, query, mode, dict_ids_json, created_at)          -- index (user_id, created_at)
favorites(user_id, headword, dict_id, note, created_at, PRIMARY KEY(user_id, headword, dict_id))

dictionaries(id PRIMARY KEY,           -- PXDict's own stable id (also the folder name under DICT_DIR)
             wudict_id,                -- wuDict's id = sha256(path)[:12]; changes when originals are
                                       -- deleted or files move, so refreshed on every rescan
             wudict_uuid,              -- `uuid` from db/<name>/info.txt: stable, used to re-match
             library_dir,              -- db/<name>/ (wuDict appends " (fmt)" on name clashes)
             title, format, source CHECK(source IN ('builtin','proposal')),
             visibility CHECK(visibility IN ('global','private','hidden')),
             owner_user_id NULL,       -- for visibility='private'
             trusted_render BOOLEAN,   -- allows style-A rendering
             source_path, source_bytes, index_bytes, media_packed BOOLEAN, source_deleted_at,
             proposal_id NULL, created_at, updated_at)
user_dicts(user_id, dict_id, enabled, position, PRIMARY KEY(user_id, dict_id))

proposals(id, user_id, title, description, source_url, license_note,
          status CHECK(status IN ('uploading','pending','approved','rejected','withdrawn')),
          total_bytes, file_count, review_note, reviewed_by, reviewed_at,
          approved_scope CHECK(approved_scope IN ('global','private')), created_at)
proposal_files(proposal_id, rel_path, bytes, sha256, kind)                  -- kind: mdx|mdd|css|js|zim|other

audit_log(id, actor_user_id, action, target_type, target_id, details_json, bytes_freed, created_at)
```

`/data` layout:

```text
/data/dictionaries/<dict>/   approved dictionaries, scanned by wuDict (DICT_DIR)
/data/db/                    wuDict indexes (DB_DIR): <name>/{text.db,media.db,fulltext.db,info.txt}
/data/.wudict/{config,data,state,home}   wuDict XDG folders (HOME must not be /data, see notes Q12)
/data/gateway/pxdict.db      gateway data
/data/proposals/<id>/        upload quarantine (outside DICT_DIR)
/data/tmp/                   in-progress uploads, cleaned periodically
```

## 2. Gateway API (`/app-api`; full contract in `gateway/openapi.yaml`)

| Group | Endpoints | Access |
|---|---|---|
| Auth | `POST /auth/login`, `POST /auth/logout`, `POST /auth/register` (if enabled), `GET /me`, `PUT /me/password`, `GET/DELETE /me/sessions` | public / user |
| History | `GET /me/history?cursor=`, `DELETE /me/history/{id}`, `DELETE /me/history` | user |
| Settings | `GET/PUT /me/settings` | user |
| My dictionaries | `GET /me/dicts` (allowed list + enabled + order), `PUT /me/dicts` | user |
| Favorites | `GET/POST/DELETE /me/favorites` | user |
| Proposals | `POST /proposals` (multipart, size-limited), `GET /me/proposals`, `DELETE /proposals/{id}` (while pending) | user |
| Admin: users | `GET/POST /admin/users`, `PATCH /admin/users/{id}` (role, status, password reset), `DELETE /admin/users/{id}`, `POST /admin/invites` | admin |
| Admin: proposals | `GET /admin/proposals`, `GET /admin/proposals/{id}`, `POST .../{id}/approve {scope, dict_id, trusted_render}`, `POST .../{id}/reject {note}` | admin |
| Admin: dictionaries | `GET /admin/dicts`, `PATCH /admin/dicts/{id}` (visibility, trusted_render, title), `POST /admin/dicts/rescan`, `GET /admin/dicts/{id}/index-status` | admin |
| Admin: storage | `GET /admin/storage` (overview), `POST /admin/storage/plan` (dry-run → items + bytes + `plan_id`), `POST /admin/storage/execute {plan_id}` | admin |
| Admin: misc | `GET /admin/audit`, `GET /admin/system` (wuDict version, RAM, disk) | admin |
| System | `GET /healthz` (gateway + wuDict) | public |

Proxying to wuDict (after the session check):

| Path | Gateway behaviour |
|---|---|
| `GET /api/dicts` | NDJSON stream. Keep only dictionaries the user may use (`visibility` + `user_dicts.enabled`, ordered by `position`), drop the builtin `wudict-howto`, **strip filesystem fields** (`path`, `dbPath`, `source`, `mediaSrc`, `textDB`, `mediaDB`, `folder`) |
| `GET /api/search`, `GET /api/suggest` | Always pass an explicit `dict=<id>,<id>,…` (never `all`; wuDict supports it on both). Empty allowed set → answer empty without calling wuDict (an all-unknown list is a wuDict 404). Forward NDJSON lines as they arrive. Log `search_history` (`search` only, if enabled) |
| `GET /res/{dict}/…` | Check the user may access `{dict}`; sandboxed iframes use signed URLs (see Phase 4). wuDict already rewrites every resource reference to absolute `/res/{id}/…`, so the gateway rewrites only that prefix |
| `/style/*`, `/files/*`, `/assets/*` | **Not proxied**: Phase 0 found entry HTML never references them (wuDict's own UI only) |
| Everything else (`/setup`, `/api/library…`, `/api/ingest`, `/api/rescan`, …) | **404 for users**; admins only via `/app-api/admin/*` (optional: `/wudict-admin/*` for admins to use the native UI) |

For every proxied request the gateway removes the client's `Cookie`, `Authorization` and any `k` query
parameter (wuDict accepts its token from a cookie, Bearer or `?k=`), and drops `Set-Cookie` from
wuDict responses. wuDict answers 401 without a token, 421 for unknown `Host` names, and 403 for
`Sec-Fetch-Site: cross-site` outside its three extension routes.

---

## Phase 0 — Verify wuDict (spike, no product code)

**Goal:** answer every **[needs verification]** point from the original design, plus the new questions
multi-user features raise, before the design depends on them.

- [x] Run `wudict-linux-amd64-purego` v3.7.12 locally with `AUTH=on` and a few small MDX/MDD dictionaries (with CSS, images, audio, JS). → no purego asset exists and v3.7.12 is pre-release only: ran v3.7.11 (`-cgo` asset and a purego build from source).
- [x] Status code without a token (401/403); is `Authorization: Bearer` accepted on every endpoint?
- [x] Does the DNS-rebinding guard accept `Host: 127.0.0.1:6888` through a proxy?
- [x] `/api/search`, `/api/suggest`: is there a parameter to restrict to dictionaries / groups? Response shape; how stable are dictionary IDs (file name? hash?).
- [x] How entry HTML references resources (absolute `/res/{dict}/…` or relative); which files under `/style`, `/files`, `/assets` are needed to render.
- [x] **Does wuDict still need the original files after indexing?** (MDX/MDD, ZIM, other formats). Is content stored in SQLite (zstd)? → decides whether "delete original, keep index" is possible.
- [x] Adding a dictionary to `DICT_DIR` at runtime: auto-detected, or must an API be called (rescan/ingest)? Which endpoint; SSE progress format.
- [x] Deleting a dictionary: which API, does it remove the index in `db/`, what files remain.
- [x] `wudict ingest` syntax; can a `db/` copied from another machine be used?
- [x] RAM while indexing a ~1M-headword dictionary (`/usr/bin/time -v`, `docker stats`).
- [x] Licensing: the gateway talks to wuDict over HTTP (no linking) → record the conclusion and choose a license for this repo.

**Deliverables:** `docs/wudict-notes.md` (for each question: command run, result, design impact),
section 2 of this plan updated if needed, and the LICENSE file.

**Done when:** no question above is still "unknown", or each has a documented fallback.

**Result:** all answered in [`wudict-notes.md`](wudict-notes.md) (summary table at the top); license
GPL-3.0-or-later; [ADR 0002](adr/0002-build-wudict-from-source.md) for the binary. Remaining open
questions there have fallbacks.

---

## Phase 1 — Repository skeleton & tooling

**Goal:** the repo builds and tests with empty code; CI is green.

- [ ] `gateway/`: `go mod init`, `cmd/pxdict-gateway/main.go` (config loading, `/healthz`), `internal/` layout per AGENTS.md.
- [ ] `pwa/`: Vite + strict TypeScript + a UI framework (suggest **Preact** or **Svelte** for small bundles; record an ADR), ESLint, Vitest, `assetsDir: "app-assets"`, i18n with `en` source + `vi`.
- [ ] `npm run gen:api`: generate `wudict.schema.d.ts` (from the wuDict tag's `openapi.yaml`) and `app.schema.d.ts` (from `gateway/openapi.yaml`).
- [ ] `scripts/dev.sh`: download the wuDict binary into `.cache/`, run wuDict + gateway (`go run`) + Vite dev server (proxy `/api`, `/res`, `/app-api` to the gateway).
- [ ] `.github/workflows/ci.yml`: `go vet`, `staticcheck`, `go test`, `npm ci`, `typecheck`, `lint`, `test` on every PR.

**Done when:** `scripts/dev.sh` serves an empty PWA page; CI is green.

---

## Phase 2 — Gateway foundation & a runnable image

**Goal:** one container running wuDict + gateway; the gateway serves the PWA and proxies wuDict safely.
No users yet (Phase 3 locks everything behind a bootstrap admin).

- [ ] `internal/config`: env vars (`LISTEN_ADDR=:8080`, `DATA_DIR=/data`, `WUDICT_URL=http://127.0.0.1:6888`, `AUTH_TOKEN`, `PUBLIC_URL`, `COOKIE_SECURE`, `REGISTRATION=closed|invite|open`, `MAX_UPLOAD_BYTES`, `MAX_PENDING_PROPOSALS_PER_USER`, `HISTORY_DEFAULT_RETENTION_DAYS`, …) with validation and defaults.
- [ ] `internal/store`: open SQLite (WAL, `busy_timeout`, `foreign_keys=on`), run embedded migrations, `0001_init.sql` per section 1.
- [ ] `internal/wudict`: client with timeouts; reverse proxy (`httputil.ReverseProxy`) injecting Bearer, setting Host, flushing immediately for SSE **and NDJSON**, stripping client cookies/`Authorization`/`?k=` and upstream `Set-Cookie`; route allowlist; NDJSON filter for `/api/dicts`.
- [ ] Serve the static PWA from `/srv/pwa`: SPA fallback, `no-cache` for `sw.js`/`index.html`/`manifest.webmanifest`, `immutable` for `/app-assets/*`, gzip/zstd.
- [ ] Default security headers: CSP, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`.
- [ ] `Dockerfile`, 4 stages: PWA build (node:22-alpine) → gateway build (golang, `CGO_ENABLED=0`) → wuDict **purego build from source** at `WUDICT_VERSION` from `WUDICT_REPO=wuweidict/wudict` ([ADR 0002](adr/0002-build-wudict-from-source.md)) → `alpine` runtime + `tini`, UID 1000.
- [ ] `docker/entrypoint.sh`: check required env, create `/data/*`, start wuDict (`AUTH=on`, `SERVER_IP=127.0.0.1`, `USE_CACHED=1`, `INDEX_WORKERS=1`, `HOME`/`XDG_*` under `/data/.wudict/`) and gateway, `wait -n` → if one dies, stop the container (logic of original §3.2).
- [ ] `HEALTHCHECK` calls the gateway's `/healthz` (which checks wuDict).
- [ ] `scripts/smoke-test.sh`: run the image, wait for healthy, check `/`, `/manifest.webmanifest`, `/healthz`, wuDict only on loopback, non-allowlisted routes return 404.
- [ ] Go contract tests against the real wuDict binary (separate CI job).

**Done when:** `docker run` of a local image serves the empty PWA, `/api/search` through the gateway returns results, `/setup` returns 404.

---

## Phase 3 — Authentication & user management

**Goal:** login/logout, user/admin roles, admin manages users. Every route except the login page,
static assets and `/healthz` requires a session.

- [ ] Admin bootstrap: if `users` is empty, create an admin from `ADMIN_USERNAME` + `ADMIN_PASSWORD` (or print a one-time random password to the log). CLI rescue: `pxdict-gateway user reset-password <username>`.
- [ ] `internal/auth`: argon2id (parameters sized for a 1 GB VPS, e.g. m=64MB, t=2, p=1 — measure), 256-bit session IDs (SHA-256 stored), cookie `pxdict_session`, sliding expiry (default 30 days, suits installed PWAs), per-session CSRF token.
- [ ] Middleware: `RequireUser`, `RequireAdmin`, user in context; update `last_seen_at` at most once a minute.
- [ ] Login rate limiting (in-memory token bucket per IP + username), temporary lockout after N failures.
- [ ] Registration modes: `closed` (admin creates users), `invite` (single-use, expiring codes), `open` (optional, rate-limited).
- [ ] User: change password (revokes other sessions), view/revoke sessions.
- [ ] Admin: list/search users, create, change role, disable/enable (revokes all sessions), reset password, delete (removes history and favorites; proposals reassigned to admin or deleted — ask at delete time).
- [ ] The last admin cannot demote, disable or delete themselves.
- [ ] `audit_log` for every admin action and for bursts of failed logins.
- [ ] (Optional) `TRUST_CF_ACCESS=1`: auto-login from `Cf-Access-Jwt-Assertion` (JWT verified against the team domain), email → user mapping.
- [ ] Tests: login/logout, missing/wrong CSRF, rate limiting, admin authorization, expired sessions, disabled users.

**Done when:** the smoke test confirms `/api/search` returns 401 without a session and 200 after login; a regular user gets 403 on `/app-api/admin/*`.

---

## Phase 4 — PWA MVP: lookups

**Goal:** usable every day on a phone.

- [ ] Login screen (plus register / invite code if enabled); global 401 handling → back to login, keeping the pending query.
- [ ] Search box + debounced suggestions, search `mode`, keyboard shortcuts, Android `share_target` pre-filling `q`.
- [ ] Multi-dictionary results (collapsible per dictionary, ordered by the user's settings).
- [ ] **Style-B rendering**: iframe `sandbox="allow-scripts"` (+ `allow-popups` if needed), `postMessage` height sync, intercept internal links (`entry://`, `bword://`, `sound://`), play audio in the parent frame.
- [ ] Resources in a sandboxed iframe carry no cookie → the gateway issues **signed URLs** for `/res/`: `/r/<token>/<dict>/<path>` where token = HMAC(user_id, dict, short expiry); the gateway rewrites the `/res/<id>/` prefix in entry HTML before returning it (wuDict emits only absolute `/res/<id>/…` references; relative `url()` inside CSS then stays under the signed prefix). Audio is a plain `<a href="/res/…/x.mp3">` (from `sound://`): intercept by extension.
- [ ] Style A (same-origin, modelled on wuDict's `frame.js`) only for dictionaries with `trusted_render = true`.
- [ ] `vite-plugin-pwa`: manifest, icons, `registerType: "prompt"`, `navigateFallbackDenylist` covering `/api`, `/res`, `/r`, `/app-api`; runtime caching as in original §6.2 but **cache names include the user id**; logout wipes the user's caches + IndexedDB.
- [ ] i18n (en source, vi), light/dark theme; test on Android Chrome and iOS Safari (cookies in an installed PWA).

**Done when:** PWA installed on Android + iOS, login works, lookups show images/audio, previously looked-up words are viewable offline.

---

## Phase 5 — Per-user features

**Goal:** search history, dictionary selection, favorites, settings — isolated between users.

**Search history**
- [ ] Gateway logs while proxying `/api/search` (not `suggest`), merging identical consecutive lookups within 1 minute.
- [ ] Settings: enable/disable history, retention (7/30/90/365 days/forever); periodic cleanup job.
- [ ] PWA: history page (grouped by day, searchable, tap to look up again), delete one / delete all; suggestions from history when the search box is empty.
- [ ] Export history (CSV/JSON).

**Dictionary selection**
- [ ] `GET /me/dicts`: all `global` dictionaries + the user's own `private` ones, with `enabled` and `position`. New users: all `global` dictionaries enabled.
- [ ] PWA: toggle, drag-and-drop ordering; (optional) named "dictionary sets" for quick switching (e.g. English–Vietnamese, Chinese–Vietnamese).
- [ ] Newly approved `global` dictionaries are added to every user, enabled, at the end; the PWA shows a "new dictionary" notice.
- [ ] Hidden/deleted dictionaries disappear for every user without errors.

**Favorites & settings**
- [ ] Per-user favorites (add from results, list, notes, export).
- [ ] Settings: default search mode, UI language, theme, font size.

- [ ] Isolation tests at the HTTP layer: user A never sees user B's history, favorites or private dictionaries.

**Done when:** two users on two devices have different histories and dictionary sets, and the same lookup returns results according to each user's choices.

---

## Phase 6 — Dictionary proposals & admin review

**Goal:** users propose new dictionary files; an admin reviews them before they can be used.

**User side**
- [ ] Proposal form: title, description, source URL, license note, files (`.mdx` + `.mdd`, `.css`, `.js`, images; or one `.zip`; other formats per the list confirmed in Phase 0).
- [ ] Stream uploads into `/data/tmp/`, enforce `MAX_UPLOAD_BYTES`, compute SHA-256 while writing, chunked/resumable uploads for large files; move into `/data/proposals/<id>/` only when complete.
- [ ] Quotas: pending proposals per user, total pending bytes system-wide; refuse when free disk is below a threshold.
- [ ] Users see the status of their proposals and can withdraw while `pending` (files deleted immediately).

**Automatic checks on receipt**
- [ ] Safe file names (no `..`, no absolute paths, no symlinks), extension allowlist.
- [ ] Zip: limits on entry count, total uncompressed size, compression ratio (zip-bomb protection).
- [ ] Read format headers (MDX: version, headword count, encoding) to show the admin; warn if JS is present.
- [ ] Duplicate detection: SHA-256 matching an existing dictionary or another proposal.

**Admin side**
- [ ] Proposal list (filter by status) and detail: proposer, files, sizes, hashes, metadata, warnings.
- [ ] **Preview before approval**: `wudict ingest` works on a separate library while the main server runs (different `SERVER_PORT`/`DB_DIR`), so a temporary instance is feasible; but an index built at a staging path is **not** reused after the move (absolute paths must match) — budget a second ingest, or use the `hidden` fallback below. Option A: index into a separate staging directory with a temporary wuDict instance and try lookups in a sandboxed iframe. If not feasible: approve as `hidden`, let the admin try it, then switch to `global`.
- [ ] Approve: choose `dict_id`, scope `global` (all users) or `private` (proposer only), `trusted_render` flag (off by default) → move files into `/data/dictionaries/<dict_id>/` (same-filesystem rename), `GET /api/rescan` (new files are not auto-detected), find the row by path, create the `dictionaries` row, **explicitly** `GET /api/ingest?dict=<id>&media=1` (SSE `progress`/`done`/`error`) before users can search it (search-before-index costs ~2.5× the RAM), record `wudict_uuid` from `info.txt`, surface indexing errors.
- [ ] Reject: record a reason, **delete files immediately** (free disk), keep metadata so the user sees the reason.
- [ ] Notify the user in the PWA when a proposal is approved/rejected.
- [ ] Catalogue sync: a "rescan" action reconciles `/data/dictionaries` + `/api/dicts` with the `dictionaries` table (dictionaries copied in manually → `source='builtin'`, `visibility='hidden'` until an admin enables them).

**Done when:** a user proposes a small MDX → the admin reviews and approves it as `global` → every user sees it and can look words up; a rejected proposal leaves no files on disk.

---

## Phase 7 — Storage administration

**Goal:** admins see where disk space goes and safely delete what is not needed.

- [ ] `GET /admin/storage`: free space on the volume; usage per area (`dictionaries`, `db`, `proposals`, `tmp`, `gateway`); per dictionary: original files, index, number of users with it enabled.
- [ ] Deletable categories:
  - **Original files of an indexed dictionary** — Phase 0 confirmed for **MDX/MDD only**, and only once media is packed (`media.db`) and wuDict runs with `USE_CACHED=1`: `DELETE /api/library?dict=<id>&prepared=0`. Sidecar files (CSS/JS beside the MDX) are left by wuDict → the gateway removes them. The wuDict id **changes** afterwards → rescan and re-match by `wudict_uuid`. Other formats: hidden with an explanation. Warning: without originals, the dictionary cannot be re-indexed when wuDict bumps its reader version.
  - **Whole dictionary (originals + index)** — removed from the system; warns how many users use it.
  - **Rejected / withdrawn proposals** with leftover files.
  - **Stale uploads** in `/data/tmp` older than 24 hours.
  - **Orphaned indexes** in `/data/db` with no matching dictionary.
  - **Unused auxiliary files** (e.g. duplicate `.mdd`, junk in dictionary folders) — listed only; the admin picks files individually.
- [ ] Two-step flow: `POST /admin/storage/plan` (dry-run returning paths, bytes, warnings, `plan_id` valid for 10 minutes) → `POST /admin/storage/execute {plan_id}`; execution re-checks every file (skips anything that changed) and writes `audit_log` with `bytes_freed`.
- [ ] Deleting a dictionary calls `DELETE /api/library?dict=<id>` first (removes `db/<name>/` + main/companion files; no dry run there, so the gateway builds its own), then cleans the remaining files in `/data/dictionaries/<dict_id>/`; updates `dictionaries` and `user_dicts`.
- [ ] Detect a read-only `DICT_DIR` mount → disable original-file deletion and say why.
- [ ] Gateway background jobs: clean `tmp`, expire history, weekly SQLite `VACUUM` (when idle).
- [ ] Admin UI in the PWA (`/admin`, visible to admins only): Users, Proposals, Dictionaries, Storage, Audit log.

**Done when:** an admin deletes a 500 MB dictionary via the UI, free disk increases accordingly, the audit log is correct; a dry-run never deletes anything.

---

## Phase 8 — CI/CD & automatic wuDict updates

**Goal:** as in original §7, plus tests for the multi-user parts.

- [ ] `scripts/latest-wudict.sh`: newest **stable tag** of `wuweidict/wudict` (ignore pre-releases); no release-asset check, since the binary is built from source ([ADR 0002](adr/0002-build-wudict-from-source.md)).
- [ ] `.github/workflows/build-image.yml` (per original §7.2) with these changes:
  - API check: generate types from the new wuDict `openapi.yaml` + `tsc`; run Go contract tests against the new wuDict binary;
  - new smoke test: log in as the bootstrap admin; `/api/search` without a session → 401, with a session → 200; regular user → `/app-api/admin/*` 403; `/setup` → 404; `/api/prefs` not exposed;
  - image tags: `latest`, `wudict-<tag>`, `wudict-<tag>-<sha>`; GPL label and wuDict source label.
- [ ] Separate PXDict releases (semver) when gateway/PWA change: tag `vX.Y.Z` → image `:X.Y.Z`.
- [ ] Dependabot for Go modules, npm, GitHub Actions.
- [ ] GHCR package set to Public.

**Done when:** CI builds automatically on a new wuDict release and **does not** push the image if contract or smoke tests fail.

---

## Phase 9 — Self-hosted deployment

**Goal:** run for real on a 1–2 GB VPS via cloudflared (original §8–10).

- [ ] `deploy/compose.yaml` (app + cloudflared), `.env.example` adding `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `PUBLIC_URL`, `REGISTRATION`, `MAX_UPLOAD_BYTES`.
- [ ] `scripts/setup-swap.sh` and the three memory-limit layers (original §9); budget the gateway's RAM (~30–60 MB) and peaks during upload/zip checks. Phase 0 numbers: wuDict ~50 MB idle, ~260–300 MB peak while ingesting 1M headwords (`INDEX_WORKERS=1`).
- [ ] Cloudflare: tunnel, Public Hostname, Cache Rule bypass for `/api/`, `/res/`, `/r/`, `/app-api/`, `/files/`, `/style/`. **Upload limit:** Cloudflare caps request bodies at 100 MB on the Free plan → larger proposals need chunked uploads (Phase 6) or admin rsync.
- [ ] Cloudflare Access: optional; document both modes (PXDict accounts only / Access + PXDict).
- [ ] `scripts/server-update.sh` + systemd timer (original §10).
- [ ] **Backups**: `scripts/backup.sh` using `sqlite3 .backup` (or `VACUUM INTO`) for `pxdict.db` + wuDict config; restore docs. Original dictionaries are backed up separately (large).
- [ ] Runbook `docs/operations.md`: first login, admin password reset, adding dictionaries via rsync, indexing off-box (same image **and the same `/data/dictionaries/...` path**, or the copied `db/` is ignored), rolling back the image, restoring a backup.

**Done when:** stable for one week on a real VPS, the update timer has run at least once, a test restore succeeded.

---

## Phase 10 — Hardening & polish

- [ ] Full security review: sessions, CSRF, path traversal in upload/delete, SSRF via `source_url` (never auto-fetch URLs), headers, iframe CSP.
- [ ] Light load test: 10–20 concurrent users on a 1 GB VPS; compare p95 of `/api/search` through the gateway vs. direct wuDict.
- [ ] Structured logs (`log/slog`, JSON), optional Prometheus `/metrics` (admin or loopback only).
- [ ] Accessibility (keyboard, screen readers, contrast), PWA performance (Lighthouse ≥ 90).
- [ ] Complete the "verify in production" checklist from original §12.
- [ ] (Out of current scope, recorded as ideas) full offline lookups via OPFS + js-mdict; propose an official image upstream to wuDict / PikaPods.

---

## Ordering & dependencies

```text
P0 ─▶ P1 ─▶ P2 ─▶ P3 ─▶ P4 ─▶ P5 ─▶ P6 ─▶ P7
                    │                         │
                    └────────▶ P8 ───────────┴─▶ P9 ─▶ P10
```

- P8 (image CI) can start right after P3 to get test images early.
- P6 and P7 share `internal/storage` (SafeJoin, usage accounting) — written in P6, extended in P7.
- An MVP usable by a family/small group: everything through **P5** + the basics of **P9**.

## Key risks

| Risk | Impact | Mitigation |
|---|---|---|
| ~~wuDict cannot filter search by dictionary~~ | — | Resolved in Phase 0: `dict=` on `/api/search` and `/api/suggest` |
| wuDict needs originals after indexing | Cannot delete originals to save space | Phase 0: not needed for MDX/MDD after media packing; other formats hidden until verified |
| wuDict ids change when files move or originals are deleted | Broken references in user data | Gateway uses its own ids; re-match via `wudict_uuid` on every rescan |
| wuDict stops building purego / needs a newer Go | Image build fails | CI blocks the update; previous image stays; bump the Go stage |
| Sandboxed iframes break JS-heavy dictionaries | Broken rendering | Per-dictionary `trusted_render` flag set by admins |
| A malicious dictionary gets approved | Scripts attacking users/admins | Sandbox by default, JS warning at review, admin preview first |
| wuDict API changes without notice | Broken proxy / PWA | Contract tests + `tsc` in CI, pinned tags, roll back to the previous image |
| Large uploads through Cloudflare | HTTP 413 | Chunked uploads, or rsync for admins |
| Indexing large dictionaries on a small VPS | OOM | Swap, `INDEX_WORKERS=1`, index off-VPS (original §9.5) |
