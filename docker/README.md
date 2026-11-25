# docker

Container runtime files. The image itself is built by the [`Dockerfile`](../Dockerfile) at the root.

`entrypoint.sh` (run by `tini`):

1. checks that `/data` is writable by UID 1000 and creates its folders;
2. uses `AUTH_TOKEN` or generates a random one for this start (only wuDict and the gateway know it);
3. starts wuDict with a clean environment: `AUTH=on`, `SERVER_IP=127.0.0.1`, `SERVER_PORT=6888`,
   `USE_CACHED=1` and the `/data` folders are forced; only tuning variables (`INDEX_WORKERS`,
   `PREVIEW_MEMORY`, `SEARCH_MEMORY`, `MORPH_CACHE`, `MEMORY_LIMIT`, `COMPRESSION`, `AUTO_INDEX`,
   `GOGC`, `GOMEMLIMIT`, `TZ`) pass through. wuDict's startup banner prints its access key; the
   entrypoint redacts the token from wuDict's output;
4. starts the gateway (`node --max-old-space-size=$GATEWAY_MAX_OLD_SPACE_MB`, default 128);
5. waits: when either process exits on its own, the other is stopped and the container exits non-zero
   (so `restart: on-failure` applies); `docker stop` exits 0.

The `HEALTHCHECK` calls the gateway's `/healthz`, which also checks wuDict and the database.
