# Operations runbook

How to run PXDict on your own server: a 1–2 GB VPS behind a Cloudflare tunnel (or your own TLS reverse
proxy), with daily updates and encrypted backups. Every PXDict setting is listed in
[`gateway/README.md`](../gateway/README.md#configuration); image tags and the update pipeline are in
[`releasing.md`](releasing.md).

Paths below assume the install folder `/opt/pxdict`:

```text
/opt/pxdict/
├── compose.yaml        from deploy/compose.yaml
├── .env                from deploy/.env.example (secrets, mode 600)
├── backup.env          from deploy/backup.env.example (optional, mode 600)
├── scripts/            server-update.sh, backup.sh, restore.sh, setup-swap.sh
└── data/               the container's /data, owned by uid 1000
    ├── dictionaries/   approved dictionaries (originals)
    ├── db/             wuDict indexes
    ├── gateway/        pxdict.db, better-auth-secret
    ├── proposals/      uploads waiting for review
    └── .wudict/        wuDict config
```

`data/` must be **one filesystem**: approving a proposal renames its files from `proposals/` into
`dictionaries/`, which fails across mounts. Do not mount `dictionaries/` separately.

## Contents

- [First install](#first-install)
- [Cloudflare tunnel](#cloudflare-tunnel) · [Own reverse proxy](#own-reverse-proxy)
- [Memory](#memory)
- [First login and users](#first-login-and-users)
- [Sign-in methods](#sign-in-methods)
- [Adding dictionaries](#adding-dictionaries) · [Indexing off-box](#indexing-off-box)
- [Updates](#updates) · [Rolling back](#rolling-back)
- [Backups](#backups) · [Restoring a backup](#restoring-a-backup)
- [Health and logs](#health-and-logs) · [Metrics](#metrics)
- [Load testing](#load-testing)
- [Verify in production](#verify-in-production)

## First install

Requirements: a Linux host with Docker Engine and the Compose plugin, amd64 or arm64, ≥ 1 GB RAM, and
disk for your dictionaries (originals + indexes; an index is roughly 1–3× the original's size).

```bash
sudo mkdir -p /opt/pxdict/data /opt/pxdict/scripts
cd /opt/pxdict
# from a checkout of this repository:
sudo cp ~/PXDict/deploy/compose.yaml ~/PXDict/deploy/.env.example .
sudo cp ~/PXDict/scripts/{server-update,backup,restore,setup-swap}.sh scripts/
sudo mv .env.example .env && sudo chmod 600 .env
sudo chown -R 1000:1000 data          # the image runs as uid 1000

sudo scripts/setup-swap.sh 2G         # see "Memory"
sudoedit .env                         # PUBLIC_URL, CLOUDFLARE_TUNNEL_TOKEN, ADMIN_*, REGISTRATION
sudo docker compose up -d
sudo docker compose logs -f app       # wait for "pxdict-gateway listening"
```

`.env` must set at least `PUBLIC_URL` (the exact origin users open, e.g. `https://dict.example.com`).
`BETTER_AUTH_SECRET` may stay empty: the container then generates one in
`data/gateway/better-auth-secret` and keeps it. The wuDict token is generated on every start and never
leaves the container.

Then: [first login](#first-login-and-users), [the update timer](#updates) and
[backups](#backups).

## Cloudflare tunnel

The tunnel gives PXDict TLS and a public hostname without opening a port. Login is PXDict's own; do not
put Cloudflare Access in front of it ([AGENTS.md §2](../AGENTS.md#2-architecture-must-be-followed)).

1. **Zero Trust → Networks → Tunnels → Create a tunnel** (type *Cloudflared*). Copy the tunnel token
   into `CLOUDFLARE_TUNNEL_TOKEN` in `.env`, and keep `COMPOSE_PROFILES=cloudflared`.
2. **Public Hostname:** `dict.example.com` → service type `HTTP`, URL `app:8080` (the compose service
   name; both containers share the `internal` network).
3. **Caching → Cache Rules → Create rule** "PXDict: bypass": *URI Path* *starts with* any of `/api/`,
   `/res/`, `/r/`, `/app-api/`, `/files/`, `/style/` → **Bypass cache**. Cloudflare caches files with
   static extensions (`.png`, `.css`, `.mp3`, …) regardless of cookies; dictionary resources are
   per-user and must never be served from the edge to someone else. The PWA's own files (`/`,
   `/app-assets/*`) may be cached.
4. Keep `CLIENT_IP_HEADER=cf-connecting-ip` in `.env`, so rate limits see the real client address. This
   is safe only because the app publishes no port: every request comes through the tunnel.
5. Recommended zone settings: *SSL/TLS → Always Use HTTPS* on; *Speed → Rocket Loader* off (it rewrites
   the PWA's scripts).

`sudo docker compose up -d` starts `cloudflared` once the app is healthy.

**Uploads:** Cloudflare's Free plan caps a request body at 100 MB. Proposal uploads are sent in chunks of
at most 32 MiB ([ADR 0008](adr/0008-dictionary-proposals.md)), so `MAX_UPLOAD_BYTES` is not limited by
it. For dictionaries larger than you want to send through the browser, see
[Adding dictionaries](#adding-dictionaries).

## Own reverse proxy

Without Cloudflare: set `COMPOSE_PROFILES=` (empty), uncomment `ports: ["127.0.0.1:8080:8080"]` in
`compose.yaml`, and terminate TLS in a proxy on the same host. Set `CLIENT_IP_HEADER=x-forwarded-for`
only if the proxy overwrites (not appends to) a client-supplied value, or appends its peer as the last
entry (the gateway uses the last one). The proxy must:

- allow request bodies of at least 33 MiB (one upload chunk), e.g. nginx `client_max_body_size 40m;`;
- not buffer responses, so indexing progress (server-sent events) streams: nginx `proxy_buffering off;`;
- pass `Host` unchanged and not cache anything under the paths listed in step 3 above.

Caddy: `dict.example.com { reverse_proxy 127.0.0.1:8080 }` is enough (it streams and has no body
limit by default).

## Memory

Three layers keep a large indexing job from taking the host down
([wudict-notes Q13](wudict-notes.md#q13-ram-while-indexing-1m-headwords)):

| Layer | Where | Effect |
|---|---|---|
| `MEMORY_LIMIT` (wuDict), `GATEWAY_MAX_OLD_SPACE_MB` (gateway) | `.env` | Soft: Go collects garbage harder and drops caches; V8's heap is capped |
| `mem_limit` (`PXDICT_MEM_LIMIT`) | `.env` → `compose.yaml` | Hard RAM limit of the container |
| `memswap_limit` (`PXDICT_MEMSWAP_LIMIT`) | `.env` → `compose.yaml` | RAM + swap; what exceeds `mem_limit` goes to swap |

Budget inside the container:

| Process | Idle | Peak |
|---|---|---|
| wuDict | ~50 MB | ~250–300 MB while indexing 1M headwords (`INDEX_WORKERS=1`); ~700 MB if a dictionary is searched *before* it is indexed (approval always indexes first) |
| gateway (Node.js) | ~50–80 MB | heap capped at `GATEWAY_MAX_OLD_SPACE_MB` (128) + buffers; uploads are streamed to disk in chunks and zip checks read entry headers, so uploads add little |

Suggested values:

| VPS RAM | Host swap | `PXDICT_MEM_LIMIT` | `PXDICT_MEMSWAP_LIMIT` | `MEMORY_LIMIT` | `GATEWAY_MAX_OLD_SPACE_MB` |
|---|---|---|---|---|---|
| 1 GB | 2G | `768m` | `2560m` | `400MB` | `128` |
| 2 GB | 2G | `1536m` | `3584m` | `1GB` | `192` |

`scripts/setup-swap.sh 2G` creates `/swapfile`, adds it to `/etc/fstab` and sets `vm.swappiness=10`.
Swap turns "killed by the OOM killer" into "indexing is slower"; indexing runs once per dictionary.
If `docker info` warns `No swap limit support`, `memswap_limit` is ignored (cgroup v1 without swap
accounting); the container can still use the host's swap.

Measure your own dictionaries: `sudo docker stats pxdict-app-1` while an admin indexes one.

## First login and users

- With `ADMIN_EMAIL` + `ADMIN_PASSWORD` in `.env`, that account is created on the first start (only
  while no admin exists). Without `ADMIN_PASSWORD`, or without any `ADMIN_*`, the log shows a one-time
  password once: `sudo docker compose logs app | grep oneTimePassword` (user `admin`, or the
  `ADMIN_EMAIL` address). Sign in and change it under *Account*.
- Remove `ADMIN_PASSWORD` from `.env` after the first start; it is not used again.
- `REGISTRATION`: `closed` (admins create users under *Admin → Users*), `invite` (admins create
  single-use codes) or `open`. It applies to every sign-in method, including a first social sign-in.
- Consider `AUTH_REQUIRE_2FA_ADMIN=true` once the admins have set up an authenticator app.

**Admin password reset (CLI).** If every admin is locked out, from the host:

```bash
cd /opt/pxdict
sudo docker compose exec app node /app/pxdict-gateway.mjs user reset-password <email-or-username>
```

It prints a new random password, signs that user out everywhere and records `user.reset_password_cli`
in the audit log. It works for any user and needs no running server (the container must be up for
`exec`; otherwise use `docker compose run --rm --no-deps --entrypoint node app /app/pxdict-gateway.mjs …`).

## Sign-in methods

Password sign-in is always on. Everything else is turned on by `.env` and appears on the login screen
after `sudo docker compose up -d` (the container is recreated with the new environment). Better Auth
handles every flow ([ADR 0004](adr/0004-typescript-gateway-better-auth.md),
[ADR 0005](adr/0005-authentication-details.md)).

**Passkeys** (`AUTH_PASSKEY`, on by default) are bound to `PUBLIC_URL`'s host name. Choose the final
host before users register passkeys; changing it later makes existing passkeys unusable (users can still
sign in otherwise and register new ones). Set `AUTH_PASSKEY=false` while the host is temporary.

**Email** (`SMTP_URL`, `MAIL_FROM`): turns on email verification, password reset by email, magic links
and email codes. Without SMTP, admins reset passwords under *Admin → Users*. Use a transactional
provider (or your mailbox's SMTP with an app password); check SPF/DKIM for `MAIL_FROM`'s domain.

**Social providers and OIDC.** Register an OAuth application at the provider with:

| Field | Value |
|---|---|
| Redirect / callback URI | `${PUBLIC_URL}/app-api/auth/callback/<id>` |
| Scopes | `openid email profile` (OIDC); the provider defaults otherwise |

`<id>` is the provider's lower-case name: `google`, `github`, `microsoft`, `apple`, `discord`,
`facebook`, `gitlab`, or for a generic OIDC provider the lower-cased `<NAME>` of
`AUTH_OIDC_<NAME>_*` (e.g. `AUTH_OIDC_AUTHENTIK_ISSUER` → `/app-api/auth/callback/authentik`). Then set
`AUTH_<PROVIDER>_CLIENT_ID` and `AUTH_<PROVIDER>_CLIENT_SECRET` (or the `AUTH_OIDC_<NAME>_*` variables)
in `.env`.

| Provider | Where | Notes |
|---|---|---|
| Google | Google Cloud console → APIs & Services → Credentials → OAuth client ID (Web application) | Add the callback under *Authorized redirect URIs*; publish the consent screen |
| GitHub | Settings → Developer settings → OAuth Apps | *Authorization callback URL* |
| Microsoft | Entra ID → App registrations | Platform *Web*; `AUTH_MICROSOFT_TENANT_ID` = `common`, `organizations`, `consumers` or a tenant id |
| Apple | Apple Developer → Identifiers → Services ID | The client secret is a signed JWT that expires (≤ 6 months): renew it. With `REGISTRATION=invite`, invited users cannot sign up with Apple directly ([ADR 0005](adr/0005-authentication-details.md)) |
| GitLab | User or group → Applications | Self-hosted GitLab: `AUTH_GITLAB_ISSUER=https://gitlab.example.com` |
| Any OIDC (Authentik, Keycloak, Zitadel, …) | The provider's application settings | `AUTH_OIDC_<NAME>_ISSUER` is the issuer URL; discovery is read from `<issuer>/.well-known/openid-configuration` |

A social account is linked to an existing PXDict user only when the provider reports the same email as
**verified**; otherwise a new account is created (if `REGISTRATION` allows) or sign-in is refused.

## Adding dictionaries

Three ways, all ending in the same catalogue:

1. **Proposals** (any user): *Propose* in the PWA → an admin reviews under *Admin → Proposals*. Approval
   moves the files into `data/dictionaries/`, indexes them and publishes them.
2. **rsync** (admin, any size): copy a dictionary into its own folder, then let the gateway find it:

   ```bash
   rsync -avP ./Oxford/ vps:/opt/pxdict/data/dictionaries/oxford/   # e.g. Oxford.mdx + Oxford.mdd
   ssh vps sudo chown -R 1000:1000 /opt/pxdict/data/dictionaries/oxford
   ```

   Then *Admin → Dictionaries → Rescan the dictionary folder*, and index the new entry from the same
   screen. New dictionaries found this way are visible to everyone (`BUILTIN_DICT_VISIBILITY=global`)
   or to no one until published (`hidden`).
3. **Off-box indexing** for dictionaries too large to index on the VPS (below).

Keep one dictionary per folder: wuDict names its index folder after the file, and the gateway keys
dictionaries on the index's `uuid` ([wudict-notes Q6](wudict-notes.md#q6-dictionary-ids)).

## Indexing off-box

wuDict reuses a copied index **only if the original's absolute path is identical**
([wudict-notes Q12](wudict-notes.md#q12-wudict-ingest-and-copying-db)), and indexes made by another
wuDict version may be rebuilt. So index on a bigger machine with **the same image tag** and **the same
`/data/dictionaries/<folder>/<file>` path**:

```bash
# on your workstation; IMAGE = the tag the server runs (docker compose images app on the server)
mkdir -p work/data/dictionaries/oxford && cp Oxford.mdx Oxford.mdd work/data/dictionaries/oxford/
sudo chown -R 1000:1000 work/data
docker run --rm -v "$PWD/work/data:/data" \
  -e HOME=/data/.wudict/home -e XDG_CONFIG_HOME=/data/.wudict/config \
  -e XDG_DATA_HOME=/data/.wudict/data -e XDG_STATE_HOME=/data/.wudict/state \
  -e DICT_DIR=/data/dictionaries -e DB_DIR=/data/db -e USE_CACHED=1 \
  -e INDEX_WORKERS=auto -e MEMORY_LIMIT=0 \
  --entrypoint wudict "$IMAGE" ingest -full /data/dictionaries/oxford

# copy the originals and the index folder(s) it created (ls work/data/db/)
rsync -avP work/data/dictionaries/oxford/ vps:/opt/pxdict/data/dictionaries/oxford/
rsync -avP work/data/db/Oxford/            vps:/opt/pxdict/data/db/Oxford/
ssh vps sudo chown -R 1000:1000 /opt/pxdict/data/dictionaries/oxford /opt/pxdict/data/db/Oxford
```

`-full` also builds the media pack (needed before the originals may be deleted under *Admin → Storage*);
add `-fulltext` for full-text search. Copy `db/` **after** the originals, then *Rescan* on the server:
the dictionary appears already indexed. If wuDict indexes it again (a new folder such as
`db/Oxford (mdx)/`), the path or version differed: delete the duplicate under *Admin → Storage*.

## Updates

CI publishes a tested image when wuDict or PXDict changes ([releasing.md](releasing.md)). The server
pulls it daily with a systemd timer:

```bash
sudo cp ~/PXDict/deploy/systemd/pxdict-update.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pxdict-update.timer
systemctl list-timers 'pxdict-*'
sudo systemctl start pxdict-update.service && journalctl -u pxdict-update.service -n 20   # run once now
```

`server-update.sh` pulls the image named by `PXDICT_IMAGE`; when it changed it (optionally) backs up,
recreates the container and waits until `/healthz` is healthy, failing the unit otherwise. With
`PXDICT_BACKUP_BEFORE_UPDATE=1` in `backup.env` every update is preceded by a backup, which is the
rollback point for database migrations.

After a wuDict upgrade that bumps a format's reader version, wuDict re-indexes dictionaries of that
format: CPU, RAM and swap use go up for a while. Pin a tag if you want to choose when that happens.

## Rolling back

Images are tagged `latest`, `wudict-<tag>`, `wudict-<tag>-<sha>` and `X.Y.Z` ([releasing.md](releasing.md)).
To go back, pin the previous tag in `.env` and recreate:

```bash
sudoedit /opt/pxdict/.env                 # PXDICT_IMAGE=ghcr.io/thanhhvnqb/pxdict:wudict-v3.7.11-<sha>
cd /opt/pxdict && sudo docker compose up -d
```

The update timer then keeps that exact tag. Database migrations only move forward: if the newer image
migrated `pxdict.db`, restore the backup taken before the update as well
([restoring](#restoring-a-backup)). Remove the pin to follow `latest` again.

## Backups

`scripts/backup.sh` writes one encrypted archive with:

- a consistent snapshot of `data/gateway/pxdict.db` (made by the gateway with `VACUUM INTO`, safe while
  it runs), `data/gateway/better-auth-secret` and `data/.wudict/`;
- the host's `compose.yaml` and `.env`;
- a `MANIFEST` with the image, PXDict and wuDict versions.

The archive holds session tokens, OAuth tokens, password hashes and `BETTER_AUTH_SECRET`
([ADR 0004](adr/0004-typescript-gateway-better-auth.md)), so it is always encrypted unless you opt out.
Prefer [age](https://age-encryption.org) with a key whose private half is **not** on the server:

```bash
age-keygen -o pxdict-backup.key            # on your workstation; keep it safe (password manager)
grep 'public key' pxdict-backup.key | cut -d' ' -f4 | ssh vps sudo tee /opt/pxdict/backup-recipients.txt
ssh vps sudo apt-get install -y age
```

Then on the server:

```bash
sudo cp ~/PXDict/deploy/backup.env.example /opt/pxdict/backup.env && sudo chmod 600 /opt/pxdict/backup.env
sudo cp ~/PXDict/deploy/systemd/pxdict-backup.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now pxdict-backup.timer
sudo systemctl start pxdict-backup.service && ls -l /var/backups/pxdict
```

Copy `/var/backups/pxdict/` off the server (e.g. `rclone`, `restic`, or `rsync` from another host).
Archives older than the newest `BACKUP_KEEP` (14) are removed.

**Not in the archive** (large): `data/dictionaries/` (originals), `data/db/` (indexes) and
`data/proposals/`. Back the originals up separately, e.g. `restic backup /opt/pxdict/data/dictionaries`.
Indexes can be rebuilt from originals; for dictionaries whose originals were deleted under *Admin →
Storage* the index **is** the only copy, so back up `data/db/` too if you delete originals.

## Restoring a backup

```bash
cd /opt/pxdict
sudo BACKUP_AGE_IDENTITY=/root/pxdict-backup.key scripts/restore.sh /var/backups/pxdict/pxdict-<time>.tar.gz.age
```

`restore.sh` decrypts the archive, shows its `MANIFEST`, asks for confirmation, stops the app, moves the
current database, secret and `.wudict/` to `data/restore-<time>/`, puts the backup's in place, starts the
app and waits until it is healthy. `compose.yaml` and `.env` are restored only if missing; otherwise
they are written as `*.from-backup` to compare. If `.env` sets `BETTER_AUTH_SECRET`, it must equal the
backup's value (in `.env.from-backup`), or everyone is signed out and stored OAuth tokens cannot be
decrypted.

On a new server: [install](#first-install) first (without starting), copy the archive over, restore,
then rsync `data/dictionaries/` (and `data/db/`) back. Use the image tag from the `MANIFEST`, or a newer
one.

**Test the restore** after setting up backups, e.g. on a spare VM or with another `PXDICT_DIR`: the
restore is not proven until you have signed in to the restored copy.

## Health and logs

- `GET /healthz` checks the gateway, its database and wuDict (`503` when one is down); Docker's
  healthcheck uses it, so `docker compose ps` shows `healthy`.
- Logs are JSON lines: `sudo docker compose logs -f app`. Compose keeps 5 × 10 MB per container.
  `LOG_LEVEL=debug` adds one `request` line per request (method, route group, status, milliseconds; never
  the path or query, which contain look-ups).
  Secrets (wuDict's token, passwords, cookies) are never logged; the one exception is the bootstrap
  one-time password, logged once.
- The audit log of admin actions is under *Admin → Audit log*.
- Disk: *Admin → Storage* shows usage per dictionary and can delete originals, indexes, rejected
  proposals and orphaned files, always after a dry-run preview ([ADR 0009](adr/0009-storage-administration.md)).

## Metrics

Off by default. With `METRICS=true` the gateway serves Prometheus metrics at `/metrics` to admins (open
it in the browser while signed in) and to requests that send `Authorization: Bearer <METRICS_TOKEN>`
([ADR 0010](adr/0010-metrics-access.md)). There is no address-based exception: behind a proxy on the
same host every request would look local.

```yaml
# prometheus.yml (Prometheus on the same Docker network as the app)
scrape_configs:
  - job_name: pxdict
    metrics_path: /metrics
    authorization: { credentials: "<METRICS_TOKEN>" }
    static_configs: [{ targets: ["app:8080"] }]
```

| Metric | Meaning |
|---|---|
| `pxdict_http_requests_total{method,route,status}` | Requests per route group (`/api/search`, `/app-api/me`, `/res`, `static`, …) |
| `pxdict_http_request_duration_seconds{route}` | Histogram of the time until response headers (streams continue after) |
| `pxdict_http_requests_in_flight` | Requests being handled |
| `pxdict_process_resident_memory_bytes`, `pxdict_nodejs_heap_used_bytes`, … | Gateway memory (wuDict is a separate process: use `docker stats` for the container) |
| `pxdict_nodejs_eventloop_delay_seconds{quantile}` | Event-loop delay since the previous scrape |
| `pxdict_users`, `pxdict_dictionaries`, `pxdict_proposals{status}` | Totals from the gateway database |

## Load testing

`scripts/load-test.mjs` (no dependencies) signs in once and lets N virtual users look up words seeded
from `/api/suggest`, then prints throughput and latency percentiles of `/api/search` (time until the
whole NDJSON body arrived). Run it once through the gateway and once against wuDict directly, both from
inside the container so the network is the same:

```bash
read -rsp 'password: ' LOAD_PASSWORD
sudo docker compose exec -T -e LOAD_LOGIN=admin -e LOAD_PASSWORD="$LOAD_PASSWORD" app node --input-type=module - \
  --url http://127.0.0.1:8080 --origin "https://dict.example.com" --users 20 --think 1000 < scripts/load-test.mjs
sudo docker compose exec -T app node --input-type=module - \
  --direct http://127.0.0.1:6888 --users 20 --think 1000 < scripts/load-test.mjs
```

`--origin` must be `PUBLIC_URL` (the sign-in request passes the origin check). `--think` is the pause
between one user's look-ups; `0` sends them back to back.

Reference numbers (2026-11-26, image of this repository with wuDict v3.7.11, container limited to
1 CPU and 1 GB, one 100,000-headword DSL dictionary, history recording on, the load generator inside
the same container and CPU budget):

| Load | Target | req/s | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|
| 10 users, 1 look-up/s each | gateway | 9.5 | 17 | 156 | 550 |
| | wuDict direct | 9.8 | 10 | 87 | 99 |
| 20 users, 1 look-up/s each | gateway | 19.0 | 18 | 188 | 372 |
| | wuDict direct | 19.2 | 11 | 178 | 297 |
| 10 users, back to back | gateway | 46 | 198 | 404 | 595 |
| | wuDict direct | 76 | 112 | 277 | 364 |
| 20 users, back to back | gateway | 43 | 396 | 825 | 1682 |
| | wuDict direct | 70 | 284 | 533 | 690 |

At realistic rates the gateway adds a few milliseconds per look-up and no errors; the container used
about 100 MiB of RAM. Saturated, on one CPU shared with wuDict and the load generator, it delivers about
60 % of wuDict's throughput. CPU profiles put most of the gateway's cost in SQLite work per look-up
(the session check through Better Auth, the user's dictionary view, and writing search history);
compiled statements are cached per connection (`cacheStatements` in `gateway/src/db/client.ts`).

## Verify in production

The original design's §12 checklist, updated for PXDict. Tick these on a real deployment:

- [ ] Sign-in through the public hostname sets the `pxdict.session_token` cookie (`Secure`, `HttpOnly`,
      `SameSite=Lax`) and the installed PWA stays signed in after a restart (Android Chrome, iOS Safari).
- [ ] A passkey can be registered and used from the installed PWA (needs the final `PUBLIC_URL` host).
- [ ] Articles of an untrusted dictionary render in the sandboxed frame and load their images, styles and
      audio through `/r/…` via the tunnel; a recent look-up still opens offline.
- [ ] The Cloudflare cache rule works: responses for `/api/`, `/res/`, `/r/` and `/app-api/` show
      `cf-cache-status: BYPASS` (or `DYNAMIC`), never `HIT`.
- [ ] Rate limits see the real client: after 5 wrong passwords from one network, a sixth answers 429,
      while another network can still sign in.
- [ ] `/setup`, `/api/library` and `/metrics` (unless enabled) answer 404 from outside.
- [ ] RAM while indexing your largest dictionary (`docker stats`) stays under `PXDICT_MEM_LIMIT`.
- [ ] The update timer ran once and a backup was restored on a test machine (Phase 9).
- [ ] [Load test](#load-testing) on the VPS itself: at 20 users × 1 look-up/s, no errors and a gateway p95
      close to wuDict's.

Already verified earlier and not repeated here: wuDict answers 401 without its token (Phase 0,
[`wudict-notes.md`](wudict-notes.md)); `wudict ingest` and copying `db/` from another machine
(Phase 9, [Indexing off-box](#indexing-off-box)).
