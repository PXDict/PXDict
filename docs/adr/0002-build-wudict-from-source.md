# 0002. Build the wuDict binary from source (purego) instead of downloading a release asset

- Status: accepted
- Date: 2026-11-24

## Context

[AGENTS.md](../../AGENTS.md) and the original design assume the image downloads the official
`wudict-linux-<arch>-purego` release asset for a pinned tag. Phase 0 found
([wudict-notes.md, Q0](../wudict-notes.md#q0-release-assets-and-the-wudict-repository)):

- wuDict releases publish only `wudict-linux-{amd64,arm64}-cgo` for Linux. The purego workflow runs
  on manual dispatch and does not attach its binaries to releases.
- The `-cgo` binaries are linked against glibc and do not start on Alpine.
- `v3.7.12` is only a pre-release (`-alpha.1`, `-beta.1`); the latest stable tag is `v3.7.11`.
- The `PXDict/wudict` fork has no tags or releases; tags exist only in `wuweidict/wudict`.

## Decision

- The Dockerfile gets a `wudict` build stage: `golang:1.26` (matching wuDict's `go.mod`), clone
  `https://github.com/${WUDICT_REPO}` at `${WUDICT_VERSION}`, then
  `CGO_ENABLED=0 go build -buildvcs=false -trimpath -tags purego -ldflags "-s -w -X github.com/wuweidict/wudict/internal/cli.Version=${WUDICT_VERSION}"`.
  This is the same command as wuDict's own `build-purego.yml`. The result is a static binary for an
  Alpine runtime, built for each `TARGETARCH` by cross-compiling (no QEMU needed for Go).
- `WUDICT_REPO` defaults to `wuweidict/wudict` (where the tags are). `PXDict/wudict` can be used once it
  mirrors tags.
- The source is not modified. Only a **stable** tag is used; pre-releases are ignored.
- The reference version becomes **v3.7.11** until a stable v3.7.12 exists.
- `scripts/latest-wudict.sh` (Phase 8) checks for the newest stable **tag** that builds, not for
  release assets.

Rejected alternative: a Debian-slim runtime with the `-cgo` release asset. It avoids the build step but
makes the image larger, needs a glibc base, and still has no published asset for 32-bit ARM.

## Consequences

- Image builds take about 1–2 minutes longer (Go module download + compile); cache the Go module and
  build caches in CI.
- The GPL "corresponding source" is exactly the upstream tag that was built; the image labels record
  repository and tag.
- A wuDict tag whose purego build fails (or whose `go.mod` needs a newer Go) blocks the update in CI
  instead of shipping; the contract tests run against this same binary.
- AGENTS.md §1 and the plan are updated to say "built from source at a pinned tag".
