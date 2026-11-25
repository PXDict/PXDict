# deploy

Self-hosting files (Phase 9): `compose.yaml` (app + cloudflared), `.env.example`, and
`systemd/` units for the daily auto-update timer. Login is handled by PXDict accounts only; the tunnel
only provides TLS and a public hostname.
