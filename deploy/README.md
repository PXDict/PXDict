# deploy

Self-hosting files; the runbook is [`docs/operations.md`](../docs/operations.md).

| File | Purpose |
|---|---|
| `compose.yaml` | The app (one container, one volume) and an optional `cloudflared` tunnel (profile `cloudflared`) |
| `.env.example` | Settings for `compose.yaml` and PXDict (copy to `/opt/pxdict/.env`) |
| `backup.env.example` | Settings for the backup and update units (copy to `/opt/pxdict/backup.env`) |
| `systemd/pxdict-update.{service,timer}` | Daily `scripts/server-update.sh` |
| `systemd/pxdict-backup.{service,timer}` | Daily `scripts/backup.sh` |

Login is handled by PXDict accounts only; the tunnel or reverse proxy only provides TLS and a public
hostname.
