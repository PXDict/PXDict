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

Phase 2 adds `AUTH_TOKEN`, `PUBLIC_URL`, `REGISTRATION`, …; Phase 3 adds `BETTER_AUTH_SECRET` and the
sign-in method settings.

Request and response bodies of `/app-api` are zod schemas in [`../shared/src/api/`](../shared/src/api/).
