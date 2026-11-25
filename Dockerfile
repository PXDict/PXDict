# syntax=docker/dockerfile:1.7
#
# PXDict: one image, one port (:8080), one volume (/data). Two processes under tini:
#   wuDict (unmodified upstream, built from source, loopback only) and pxdict-gateway (Node.js).
#
#   docker build -t pxdict:dev .                                   # wuDict tag from the default below
#   docker build --build-arg WUDICT_VERSION=v3.7.11 -t pxdict:dev .
#
# Stages: app (PWA + gateway bundle) → wudict (purego build, ADR 0002) → runtime.
# Base images are written out in each FROM (no ARG) so Dependabot can update them; keep both
# node:26-alpine lines on the same tag.

############################################################
# 1) PWA + gateway bundle (platform independent)
############################################################
FROM --platform=$BUILDPLATFORM node:26-alpine AS app
WORKDIR /src
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY gateway/package.json gateway/
COPY pwa/package.json pwa/
# No install scripts: better-sqlite3 ships N-API prebuilds (incl. musl) and needs no compiler.
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.base.json ./
COPY shared/ shared/
COPY gateway/ gateway/
COPY pwa/ pwa/
ARG PXDICT_VERSION=dev
RUN PXDICT_VERSION="${PXDICT_VERSION}" npm run build -w @pxdict/pwa -w @pxdict/gateway

# The bundle's only runtime package is better-sqlite3 (native, kept external by esbuild; it uses
# Node built-ins only). Keep just the prebuild for the target architecture.
ARG TARGETARCH
RUN set -eu; \
    case "${TARGETARCH}" in amd64) arch=x64 ;; arm64) arch=arm64 ;; *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; esac; \
    mkdir -p /out/node_modules; \
    cp -r node_modules/better-sqlite3 /out/node_modules/; \
    cd /out/node_modules/better-sqlite3; \
    rm -rf deps src binding.gyp; \
    find prebuilds -type f ! -name "linuxmusl-${arch}.node" -delete; \
    test -f "prebuilds/linuxmusl-${arch}.node"; \
    cp -r /src/gateway/dist/. /out/; \
    mkdir -p /out/pwa; cp -r /src/pwa/dist/. /out/pwa/

############################################################
# 2) wuDict, built from the upstream tag (docs/adr/0002-build-wudict-from-source.md)
############################################################
FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS wudict
RUN apk add --no-cache git
# Keep the default equal to ./WUDICT_VERSION (CI checks it).
ARG WUDICT_VERSION=v3.7.11
ARG WUDICT_REPO=wuweidict/wudict
RUN git -c advice.detachedHead=false clone --quiet --depth 1 --branch "${WUDICT_VERSION}" \
      "https://github.com/${WUDICT_REPO}.git" /src
WORKDIR /src
ARG TARGETOS TARGETARCH
# Same command as wuDict's own build-purego.yml; static binary, cross-compiled without QEMU.
RUN --mount=type=cache,target=/root/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS="${TARGETOS}" GOARCH="${TARGETARCH}" \
    go build -buildvcs=false -trimpath -tags purego \
      -ldflags "-s -w -X github.com/wuweidict/wudict/internal/cli.Version=${WUDICT_VERSION}" \
      -o /out/wudict .

############################################################
# 3) Runtime
############################################################
FROM node:26-alpine
ARG WUDICT_VERSION=v3.7.11
ARG WUDICT_REPO=wuweidict/wudict
ARG PXDICT_VERSION=dev

# The node image already has user/group "node" with UID/GID 1000.
RUN apk add --no-cache tini bash ca-certificates tzdata \
 && mkdir -p /data && chown node:node /data

COPY --from=wudict /out/wudict /usr/local/bin/wudict
COPY --from=app /out/pwa /srv/pwa
COPY --from=app /out/node_modules /app/node_modules
COPY --from=app /out/pxdict-gateway.mjs /out/pxdict-gateway.mjs.map /app/
COPY --from=app /out/drizzle /app/drizzle
COPY --chmod=0755 docker/entrypoint.sh /entrypoint.sh

# wuDict tuning for small VPSes (original design §4); override at run time if needed. The settings
# that must never change (AUTH, SERVER_IP, USE_CACHED, folders) are forced by the entrypoint.
ENV DATA_DIR=/data \
    PWA_DIR=/srv/pwa \
    LISTEN_ADDR=:8080 \
    GATEWAY_MAX_OLD_SPACE_MB=128 \
    INDEX_WORKERS=1 \
    PREVIEW_MEMORY=128MB \
    SEARCH_MEMORY=128MB \
    MORPH_CACHE=1 \
    MEMORY_LIMIT=400MB \
    NODE_ENV=production \
    WUDICT_VERSION=${WUDICT_VERSION}

LABEL org.opencontainers.image.title="PXDict" \
      org.opencontainers.image.description="Multi-user dictionary PWA on top of wuDict" \
      org.opencontainers.image.licenses="GPL-3.0-or-later" \
      org.opencontainers.image.source="https://github.com/thanhhvnqb/PXDict" \
      org.opencontainers.image.version="${PXDICT_VERSION}" \
      io.github.wudict.version="${WUDICT_VERSION}" \
      io.github.wudict.source="https://github.com/${WUDICT_REPO}/tree/${WUDICT_VERSION}"

USER node
WORKDIR /app
VOLUME ["/data"]
EXPOSE 8080
# /healthz checks the gateway, its database and wuDict (503 when one is down).
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --start-interval=2s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/sbin/tini", "-g", "--", "/entrypoint.sh"]
