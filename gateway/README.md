# gateway

`pxdict-gateway`: the single entry point in front of wuDict, written in TypeScript (Node.js 26 + Hono,
[ADR 0004](../docs/adr/0004-typescript-gateway-better-auth.md)). It serves the PWA, PXDict's own
`/app-api` (accounts via Better Auth from Phase 3), and an allowlisted proxy to the loopback wuDict
server. Plan: [`docs/PLAN.md`](../docs/PLAN.md); conventions: [`AGENTS.md`](../AGENTS.md) §3 and §5.

```bash
npm test -w @pxdict/gateway          # Vitest
npm run dev -w @pxdict/gateway       # tsx watch (or scripts/dev.sh for the whole stack)
npm run build -w @pxdict/gateway     # dist/pxdict-gateway.mjs (esbuild bundle), run with node
```

Typecheck and lint run from the repository root (`npm run typecheck`, `npm run lint`).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `LISTEN_ADDR` | `:8080` | Listen address (`host:port`, `[v6]:port` or `:port`) |
| `DATA_DIR` | `/data` | Persistent volume (absolute path) |
| `WUDICT_URL` | `http://127.0.0.1:6888` | Loopback wuDict server |
| `PWA_DIR` | `/srv/pwa` | Built PWA served at `/` |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` (JSON lines on stdout) |
| `AUTH_TOKEN` | — (required) | wuDict's access token, ≥ 32 printable characters; never logged. The image's entrypoint generates one per start when unset |
| `PUBLIC_URL` | `http://localhost:8080` | Origin users open (no path): Better Auth's base URL, the only trusted origin, the passkey relying party |
| `COOKIE_SECURE` | `true` if `PUBLIC_URL` is https | `Secure` flag (and `__Secure-` prefix) of the session cookies |
| `REGISTRATION` | `closed` | Who may create an account, for every sign-in method: `closed` (admins create users), `invite` (single-use codes from `/app-api/admin/invites`) or `open` |
| `BETTER_AUTH_SECRET` | — (required) | ≥ 32 characters; signs cookies and encrypts OAuth tokens. Changing it signs everyone out. The image generates one in `/data/gateway/better-auth-secret` when unset |
| `ADMIN_EMAIL`, `ADMIN_USERNAME`, `ADMIN_PASSWORD` | — | The first admin, created at startup when no admin exists. Without `ADMIN_PASSWORD` a one-time password is logged; without any of them the user is `admin` |
| `AUTH_PASSKEY` | `true` | Passkey (WebAuthn) sign-in; credentials are bound to `PUBLIC_URL`'s host |
| `AUTH_HIBP` | `false` | Refuse passwords listed by Have I Been Pwned (k-anonymity range API) |
| `AUTH_REQUIRE_2FA_ADMIN` | `false` | Admin endpoints answer 403 `two_factor_required` until the admin enables TOTP |
| `SMTP_URL`, `MAIL_FROM` | — | `smtp://user:pass@host:587` or `smtps://…:465`. Enables email verification, password reset by email, magic links and email codes; without it admins reset passwords |
| `AUTH_<PROVIDER>_CLIENT_ID`, `AUTH_<PROVIDER>_CLIENT_SECRET` | — | Social sign-in for `GOOGLE`, `GITHUB`, `MICROSOFT` (+ `AUTH_MICROSOFT_TENANT_ID`), `APPLE`, `DISCORD`, `FACEBOOK`, `GITLAB` (+ `AUTH_GITLAB_ISSUER`). Redirect URI: `${PUBLIC_URL}/app-api/auth/callback/<provider>` |
| `AUTH_OIDC_<NAME>_ISSUER`, `_CLIENT_ID`, `_CLIENT_SECRET`, `_LABEL` | — | Any OpenID Connect provider (discovery from the issuer). `<NAME>`: upper-case letters/digits; redirect URI `${PUBLIC_URL}/app-api/auth/callback/<name>` |
| `CLIENT_IP_HEADER` | — (TCP peer) | Header with the client address set by a trusted proxy, e.g. `cf-connecting-ip` or `x-forwarded-for` (last entry). Rate limits use it |
| `MAX_UPLOAD_BYTES` | `500MB` | Largest dictionary proposal; sizes accept `B`, `kB`/`MB`/`GB`/`TB`, `KiB`/`MiB`/`GiB`/`TiB` (Phase 6) |
| `MAX_PENDING_PROPOSALS_PER_USER` | `3` | Pending proposals per user (Phase 6) |
| `MAX_PENDING_BYTES` | `5GB` | Total size of all pending proposals (Phase 6) |
| `MIN_FREE_BYTES` | `1GB` | Uploads are refused below this much free disk (Phase 6) |
| `HISTORY_DEFAULT_RETENTION_DAYS` | `90` | Default search-history retention, `0` = forever (Phase 5) |

Every invalid variable is reported at once on startup; secrets are never echoed.

## Accounts

Better Auth serves `/app-api/auth/*` ([ADR 0004](../docs/adr/0004-typescript-gateway-better-auth.md),
[ADR 0005](../docs/adr/0005-authentication-details.md)); its endpoint shapes are its own. PXDict adds
`GET /app-api/auth/methods` (what the login screen offers), `POST /app-api/auth/invite {code}`,
`GET /app-api/me` and `/app-api/admin/invites`. Every proxied wuDict route needs a session, and every
`/app-api/admin/*` path and Better Auth admin endpoint needs an admin. Writes need `Origin: PUBLIC_URL`.

Rescue (e.g. a forgotten admin password), from the container or with `DATA_DIR` set:

```bash
docker exec -it pxdict node /app/pxdict-gateway.mjs user reset-password <email|username>
```

It prints a new random password and signs that user out everywhere.

## Layout

| Path | What |
|---|---|
| `src/config.ts` | Environment parsing |
| `src/app.ts` | The Hono app: security headers, `/healthz`, Better Auth, `/app-api`, wuDict proxy, static PWA |
| `src/auth/auth.ts` | The Better Auth instance: methods, sessions, rate limits, registration policy, last-admin rule, audit hooks |
| `src/auth/plugins.ts` | Better Auth plugins enabled by configuration (also read by the schema generator) |
| `src/auth/guards.ts` | `requireUser` / `requireAdmin` |
| `src/auth/routes.ts` | `/app-api/auth/methods`, `/app-api/auth/invite`, `/app-api/me`, `/app-api/admin/invites` |
| `src/auth/invites.ts`, `bootstrap.ts` | Invite codes; first admin and the rescue CLI |
| `src/http/origin.ts`, `client-ip.ts` | Origin check for writes; the client address handed to Better Auth |
| `src/audit/audit.ts` | `audit_log` writer |
| `src/db/` | SQLite (`better-sqlite3`, WAL) + Drizzle schema (`schema.ts`; `auth-schema.ts` is generated); migrations in `drizzle/` |
| `src/wudict/routes.ts` | **The allowlist** of proxied wuDict routes and their query parameters |
| `src/wudict/proxy.ts` | The proxy: Bearer token, header allowlists, NDJSON filtering, error mapping |
| `src/wudict/catalog.ts` | Which wuDict dictionaries a request may use (all but the howto until Phase 5) |
| `src/wudict/fake.ts` | Fake wuDict for unit tests; `contract.test.ts` runs against the real binary |
| `src/static/pwa.ts` | Static PWA: precompressed files, cache headers, SPA fallback |

## Database migrations

Edit `src/db/schema.ts`, then `npm run db:generate -w @pxdict/gateway` writes a new SQL migration into
`drizzle/` (commit it; never edit a released one). Migrations run on startup. CI fails when the schema
and the migrations disagree.

Better Auth's tables live in the generated `src/db/auth-schema.ts`. After upgrading Better Auth or
changing the plugin list, run `npm run auth:schema -w @pxdict/gateway` (Better Auth CLI at the
installed version), then `db:generate`. `node scripts/gen-auth-schema.mjs --check` fails on drift.

## Contract tests

```bash
# a wuDict binary at the pinned tag, e.g. extracted from the local image:
c=$(docker create pxdict:dev) && docker cp $c:/usr/local/bin/wudict .cache/wudict-contract && docker rm $c
WUDICT_BIN=$PWD/.cache/wudict-contract npm test -w @pxdict/gateway -- contract
```

Request and response bodies of `/app-api` are zod schemas in [`../shared/src/api/`](../shared/src/api/).
