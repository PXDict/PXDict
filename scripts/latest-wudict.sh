#!/usr/bin/env bash
# Print the newest stable wuDict tag (vX.Y.Z, no -alpha/-beta/-rc suffix).
#
#   scripts/latest-wudict.sh            → e.g. v3.7.11
#
# Tags are read with `git ls-remote`, so no GitHub API token or rate limit is involved and no release
# assets are required: the image builds wuDict from source (docs/adr/0002-build-wudict-from-source.md).
# Environment: WUDICT_REPO (default wuweidict/wudict).
# Exits non-zero (and prints nothing on stdout) when no stable tag is found, so CI keeps the old image.
set -euo pipefail
shopt -s inherit_errexit

repo="${WUDICT_REPO:-wuweidict/wudict}"

tags="$(GIT_TERMINAL_PROMPT=0 git ls-remote --tags --refs "https://github.com/${repo}.git")" || {
  echo "latest-wudict: cannot list tags of ${repo}" >&2
  exit 1
}
tag="$(awk '{ sub("^refs/tags/", "", $2); print $2 }' <<<"$tags" |
  grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1 || true)"

if [[ -z "$tag" ]]; then
  echo "latest-wudict: ${repo} has no stable vX.Y.Z tag" >&2
  exit 1
fi
printf '%s\n' "$tag"
