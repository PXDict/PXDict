# gateway

`pxdict-gateway` — the Go service in front of wuDict (see [`docs/PLAN.md`](../docs/PLAN.md); layout and
conventions in [`AGENTS.md`](../AGENTS.md) §3 and §5).

```bash
go test ./...
go vet ./... && staticcheck ./...
go run ./cmd/pxdict-gateway          # or scripts/dev.sh for the whole stack
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `LISTEN_ADDR` | `:8080` | Listen address |
| `DATA_DIR` | `/data` | Persistent volume (absolute path) |
| `WUDICT_URL` | `http://127.0.0.1:6888` | Loopback wuDict server |
| `PWA_DIR` | `/srv/pwa` | Built PWA served at `/` |

Phase 2 adds the rest (`AUTH_TOKEN`, `PUBLIC_URL`, `REGISTRATION`, …).

The `/app-api` contract is [`openapi.yaml`](openapi.yaml); after changing it run `npm run gen:api` in `pwa/`.
