# scripts

| Script | Phase | Purpose |
|---|---|---|
| `dev.sh` | 1 | Run wuDict + gateway (`tsx watch`) + Vite locally (see its header for options) |
| `smoke-test.sh` | 2 | Smoke-test a built image |
| `latest-wudict.sh` | 8 | Print the latest stable wuDict tag |
| `setup-swap.sh` | 9 | Enable swap on the host |
| `server-update.sh` | 9 | Pull the new image and restart (self-hosted) |
| `backup.sh` | 9 | Back up the gateway database and wuDict config |
| `spike/run-wudict.sh` | 0 | Run a wuDict binary with PXDict's `/data` layout and settings |
| `spike/make-test-dicts.py` | 0 | Generate small MDX/MDD test dictionaries (CSS, JS, images, audio) |
| `spike/make-big-dict.py` | 0 | Generate a 1M-headword MDX for RAM measurements |
