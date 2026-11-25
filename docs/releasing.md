# Images and releases

PXDict publishes one multi-arch image (`linux/amd64`, `linux/arm64`) to
`ghcr.io/<owner>/pxdict`, built by [`.github/workflows/build-image.yml`](../.github/workflows/build-image.yml).

## Image tags

| Tag | Built when | wuDict | Use it for |
|---|---|---|---|
| `latest` | push to `main`, daily schedule, manual run on `main` | newest stable tag | self-hosted auto-update (Phase 9) |
| `wudict-<tag>` | same | that tag | pinning a wuDict version |
| `wudict-<tag>-<sha>` | same | that tag | one exact build, for rollbacks |
| `X.Y.Z`, `X.Y` | push of a `vX.Y.Z` git tag | the tag in `WUDICT_VERSION` at that commit | pinning a PXDict release |

`latest` only moves when the image was built with the **newest** stable wuDict tag. A manual run with an
older wuDict tag publishes only the `wudict-*` tags. Release builds never move `latest`.

Every image has the OCI labels `org.opencontainers.image.{source,revision,version,licenses}`
(`GPL-3.0-or-later`) and `io.github.wudict.{version,source}`, which point to the exact wuDict source
that is bundled (GPL §6).

## Automatic wuDict updates

Every day the workflow runs [`scripts/latest-wudict.sh`](../scripts/latest-wudict.sh), which prints the
newest `vX.Y.Z` tag of `wuweidict/wudict` and ignores `-alpha`, `-beta` and `-rc` tags. If
`wudict-<tag>-<sha>` already exists for the current `main` commit, nothing happens. Otherwise the build
job runs these checks in order and stops at the first failure:

1. **API check:** it generates `shared/src/wudict.schema.d.ts` from the new tag's `openapi.yaml`, then
   runs `npm run typecheck`.
2. **Contract tests:** it builds the purego wuDict binary at the new tag
   ([`.github/actions/build-wudict`](../.github/actions/build-wudict/action.yml)) and runs
   `gateway/src/wudict/contract.test.ts` against it.
3. **Smoke test:** it builds the amd64 image and runs [`scripts/smoke-test.sh`](../scripts/smoke-test.sh)
   against it. The script signs in as the bootstrap admin, checks that `/api/search` answers 401
   without a session and 200 with one, that a regular user gets 403 on `/app-api/admin/*`, that
   `/setup` and `/api/prefs` answer 404, and more.
4. **Publish:** only after the checks above pass, it builds both architectures and pushes them.

If any check fails, nothing is pushed, `latest` stays on the previous image, and the failed run shows
in the Actions tab. Then fix PXDict for the new wuDict (usually in `gateway/src/wudict/`), and pin
the new tag: update `WUDICT_VERSION` and the `ARG WUDICT_VERSION=` defaults in the `Dockerfile`
(CI checks that they match), run `npm run gen:api`, and commit everything together.

The scheduled build does **not** change `WUDICT_VERSION`. The pin is what the PR CI, `scripts/dev.sh`
and release builds use. Raise it through a normal PR.

Manual run: **Actions → Build image → Run workflow**. You can choose a wuDict tag (including a
pre-release, which never becomes `latest`) and tick *force* to rebuild an existing image. Runs on
branches other than `main` build and test but never push.

## Releasing PXDict

PXDict uses semantic versioning, separately from wuDict.

1. On a release branch, move the `Unreleased` entries in `CHANGELOG.md` under `## [X.Y.Z] - YYYY-MM-DD`,
   then merge the PR.
2. Tag the merge commit on `main` and push the tag:

   ```bash
   git fetch origin main
   git tag -a vX.Y.Z origin/main -m "PXDict vX.Y.Z"
   git push origin vX.Y.Z
   ```

3. The workflow checks that the `## [X.Y.Z]` section exists, runs the same checks with the pinned
   wuDict, and pushes `:X.Y.Z` and `:X.Y`. `/healthz` reports `X.Y.Z` as the version.

## One-time repository setup

- **GHCR visibility:** after the first push, go to GitHub → *Packages* → `pxdict` → *Package settings*
  → *Change visibility* → **Public**. PikaPods and `docker pull` without `docker login` need a public
  image. In the same page, under *Manage Actions access*, check that this repository has write access.
- **Actions permissions:** *Settings → Actions → General → Workflow permissions* can stay
  "Read repository contents". The workflow requests `packages: write` itself.
- **Dependabot** ([`.github/dependabot.yml`](../.github/dependabot.yml)) opens weekly PRs for npm,
  GitHub Actions and the `Dockerfile` base images. Better Auth (`better-auth`, `@better-auth/*`) always
  gets its own PR. Read its changelog before you merge, because it owns sessions, accounts and OAuth
  tokens. Then run `node gateway/scripts/gen-auth-schema.mjs` and, if the schema changed,
  `npm run db:generate -w @pxdict/gateway`. Node.js major updates are ignored: moving to a new LTS line
  is a deliberate change.
