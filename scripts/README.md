# scripts

| Script | Phase | Purpose |
|---|---|---|
| `dev.sh` | 1 | Run wuDict + gateway (`tsx watch`) + Vite locally (see its header for options) |
| `smoke-test.sh` | 2 | Smoke-test a built image: PWA, `/healthz`, 404 for non-allowlisted wuDict routes, loopback-only wuDict, a lookup through the gateway |
| `latest-wudict.sh` | 8 | Print the newest stable wuDict tag (`vX.Y.Z`, pre-releases ignored; used by `build-image.yml`) |
| `setup-swap.sh` | 9 | Enable a swap file and swap-friendly sysctls on the host (root) |
| `server-update.sh` | 9 | Pull the image, back up if asked, recreate and wait until healthy (self-hosted, systemd timer) |
| `backup.sh` | 9 | Encrypted archive of the gateway database, secret, wuDict config, `compose.yaml` and `.env` |
| `load-test.mjs` | 10 | N virtual users look words up; throughput and p50/p95/p99 of `/api/search` through the gateway or directly against wuDict ([operations.md](../docs/operations.md#load-testing)) |
| `restore.sh` | 9 | Restore a `backup.sh` archive (moves the replaced files aside) |
| `spike/run-wudict.sh` | 0 | Run a wuDict binary with PXDict's `/data` layout and settings |
| `spike/make-test-dicts.py` | 0 | Generate small MDX/MDD test dictionaries (CSS, JS, images, audio) |
| `spike/make-big-dict.py` | 0 | Generate a 1M-headword MDX for RAM measurements |
