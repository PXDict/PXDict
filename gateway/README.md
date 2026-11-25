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
| `PUBLIC_URL` | `http://localhost:8080` | Origin users open (no path); used for cookies and origin checks from Phase 3 |
| `COOKIE_SECURE` | `true` if `PUBLIC_URL` is https | `Secure` flag of the session cookie (Phase 3) |
| `REGISTRATION` | `closed` | `closed`, `invite` or `open` (Phase 3) |
| `MAX_UPLOAD_BYTES` | `500MB` | Largest dictionary proposal; sizes accept `B`, `kB`/`MB`/`GB`/`TB`, `KiB`/`MiB`/`GiB`/`TiB` (Phase 6) |
| `MAX_PENDING_PROPOSALS_PER_USER` | `3` | Pending proposals per user (Phase 6) |
| `MAX_PENDING_BYTES` | `5GB` | Total size of all pending proposals (Phase 6) |
| `MIN_FREE_BYTES` | `1GB` | Uploads are refused below this much free disk (Phase 6) |
| `HISTORY_DEFAULT_RETENTION_DAYS` | `90` | Default search-history retention, `0` = forever (Phase 5) |

Every invalid variable is reported at once on startup. Phase 3 adds `BETTER_AUTH_SECRET` and the
sign-in method settings.

## Layout

| Path | What |
|---|---|
| `src/config.ts` | Environment parsing |
| `src/app.ts` | The Hono app: security headers, `/healthz`, `/app-api`, wuDict proxy, static PWA |
| `src/db/` | SQLite (`better-sqlite3`, WAL) + Drizzle schema; migrations in `drizzle/` |
| `src/wudict/routes.ts` | **The allowlist** of proxied wuDict routes and their query parameters |
| `src/wudict/proxy.ts` | The proxy: Bearer token, header allowlists, NDJSON filtering, error mapping |
| `src/wudict/catalog.ts` | Which wuDict dictionaries a request may use (all but the howto until Phase 5) |
| `src/wudict/fake.ts` | Fake wuDict for unit tests; `contract.test.ts` runs against the real binary |
| `src/static/pwa.ts` | Static PWA: precompressed files, cache headers, SPA fallback |

## Database migrations

Edit `src/db/schema.ts`, then `npm run db:generate -w @pxdict/gateway` writes a new SQL migration into
`drizzle/` (commit it; never edit a released one). Migrations run on startup. CI fails when the schema
and the migrations disagree.

## Contract tests

```bash
# a wuDict binary at the pinned tag, e.g. extracted from the local image:
c=$(docker create pxdict:dev) && docker cp $c:/usr/local/bin/wudict .cache/wudict-contract && docker rm $c
WUDICT_BIN=$PWD/.cache/wudict-contract npm test -w @pxdict/gateway -- contract
```

Request and response bodies of `/app-api` are zod schemas in [`../shared/src/api/`](../shared/src/api/).
