# wuDict behaviour — verified notes (Phase 0)

> Verified: 2026-11-24, against **wuDict v3.7.11** (`wuweidict/wudict`, commit `ae9ae07`), both the
> official `wudict-linux-amd64-cgo` release asset and a `-tags purego` build of the same tag.
> Every answer below comes from running the binary unless it says "(source)", meaning it was read in
> the wuDict source at that tag. Re-check this file whenever the pinned wuDict tag changes.

## How the spike was run

```bash
# 1. Test dictionaries (needs `pip install mdict-utils`)
python scripts/spike/make-test-dicts.py ./spike/dicts      # PXTest (MDX+MDD+CSS/JS), PXTest2, PXTest3
python scripts/spike/make-big-dict.py   ./spike/big        # PXBig: 1,000,000 headwords, 36 MB MDX
# 2. wuDict with the /data layout PXDict uses (AUTH=on, SERVER_IP=127.0.0.1, token "spike-token")
scripts/spike/run-wudict.sh ./wudict-linux-amd64-cgo ./spike/data
# 3. Probe with curl; e.g.
curl -sN 'http://127.0.0.1:6888/api/search?q=cat&mode=exact' | jq -c .
```

Spike dictionaries: `PXTest` has an `.mdd` with PNG images and MP3 audio plus `pxtest.css` /
`pxtest.js` beside the `.mdx`; its entries use relative (`img/cat.png`), root-absolute
(`/img/abs.png`), `sound://` and `entry://` references and one `@@@LINK=` redirect. `PXTest2` is a
plain MDX with overlapping headwords; `PXTest3` keeps its stylesheet inside the `.mdd`.

## Summary for the design

| # | Question | Answer | Design impact |
|---|---|---|---|
| 0 | Can we download `wudict-linux-<arch>-purego`? | **No.** Releases ship only `*-cgo` assets (glibc-linked); purego is built on manual dispatch and never published. `v3.7.12` exists only as `-alpha.1`/`-beta.1` | Build wuDict from source at the tag with `CGO_ENABLED=0 -tags purego` ([ADR 0002](adr/0002-build-wudict-from-source.md)); pin **v3.7.11** |
| 1 | Status without a token | **401** (JSON, or HTML if `Accept: text/html`); wrong token also 401 | Gateway maps it to its own error; smoke test expects exactly 401 |
| 2 | Is `Authorization: Bearer` accepted everywhere? | Yes, on every gated route (cookie, Bearer and `?k=` are equivalent) | Gateway injects Bearer; must strip client `?k=`, `Cookie: wudict_session`, and upstream `Set-Cookie` |
| 3 | Auth-free routes | `GET /api/dicts`, `GET /api/search`, `GET /res/…`, their `OPTIONS`, `/api/openapi.yaml`, the HTML pages and `/assets/*` | wuDict must stay on loopback; the gateway is the only gate for search |
| 4 | DNS-rebinding guard with `Host: 127.0.0.1:6888` | Accepted. Any IP literal and `localhost` pass; other names get **421** | Gateway sets `Host: 127.0.0.1:6888`; `TRUSTED_HOSTS` not needed |
| 5 | Restrict search/suggest to dictionaries | **Yes:** `dict=all \| <id> \| <id>,<id>,…` on `/api/search` **and** `/api/suggest` | Gateway always sends an explicit list (never `all`) |
| 6 | Dictionary ID stability | `sha256(absolute path of the main file)[:12]`; changes if the file moves, is renamed, or **its originals are deleted** | PXDict keys dictionaries on the library `uuid`, not the wuDict id |
| 7 | How entry HTML references resources | wuDict rewrites every bundled reference to **absolute `/res/{id}/{path}`**, including `sound://` and root-absolute paths; `entry://` is kept. CSS files served from `/res/` are **not** rewritten | Gateway rewrites one prefix for signed URLs; relative `url()` in CSS works under a path-prefixed token |
| 8 | `/style`, `/files`, `/assets` needed to render? | **No.** Search bodies never reference them; they belong to wuDict's own UI | Do not proxy them |
| 9 | Originals needed after indexing? | Articles live in `text.db` (zstd). **Originals can be deleted** for MDX/MDD once media is packed (`media.db`) and `USE_CACHED=1` | "Delete originals" is possible for MDX; other formats hidden until verified |
| 10 | Adding a dictionary at runtime | **Not** auto-detected. `GET /api/rescan` lists it; indexing on first search or via `GET /api/ingest` (SSE) | Approval = move files → rescan → ingest (with `media=1`) |
| 11 | Deleting a dictionary | `DELETE /api/library?dict=<id>[&prepared=0\|&source=0]`; removes the library folder and the main+companion files only | Gateway removes leftovers (sidecar CSS/JS, empty folder) itself |
| 12 | `wudict ingest` syntax; copied `db/` | `wudict ingest [-full] [-fulltext] [<dictfile\|folder…>]`; refuses while a server uses the library. A copied `db/<name>` is reused **only if the original's absolute path is identical** | Off-box indexing must use the same `/data/dictionaries/...` path (same image + same mount) |
| 13 | RAM indexing ~1M headwords | Explicit ingest: **~250–290 MB** peak RSS, 7 s. Search before indexing: **~730 MB** peak | Always ingest explicitly after approval; budget ~300 MB + swap |
| 14 | Licensing | Gateway ↔ wuDict over HTTP = separate programs (aggregation) | PXDict is **GPL-3.0-or-later**; image keeps the wuDict source pointer |

## Details

### Q0. Release assets and the wuDict repository

- `gh api repos/wuweidict/wudict/releases/tags/v3.7.11 --jq '.assets[].name'` lists
  `wudict-{linux,darwin}-{amd64,arm64}-cgo`, a Windows `.exe`, an Android APK and a macOS zip.
  **No `-purego` asset** in v3.7.10 or v3.7.11 either. `.github/workflows/build-purego.yml` builds purego
  only on `workflow_dispatch` and uploads workflow artifacts (source).
- `file wudict-linux-amd64-cgo` → dynamically linked against glibc. On `alpine:3.22` it fails with
  `exec …: no such file or directory` (no glibc loader).
- `CGO_ENABLED=0 go build -buildvcs=false -trimpath -tags purego -ldflags "-s -w -X
  github.com/wuweidict/wudict/internal/cli.Version=v3.7.11"` in `golang:1.26` (`go.mod` requires
  Go 1.26.5) produces a static binary that runs on Alpine and behaved identically in every check below.
- The latest stable tag is **v3.7.11** (2026-11-20). `v3.7.12` exists only as `v3.7.12-alpha.1` and
  `v3.7.12-beta.1` (the beta has no Linux purego asset either). The changelog on `master` already
  mentions 3.7.12, which is where the original design's "v3.7.12" came from.
- `PXDict/wudict` is a fork of `wuweidict/wudict` with identical `master` but **no tags and no
  releases**, so builds must fetch tags from `wuweidict/wudict` (or the fork must mirror tags).
- **Impact:** see [ADR 0002](adr/0002-build-wudict-from-source.md). `scripts/latest-wudict.sh` (Phase 8)
  checks for a **stable tag** (not a release asset) and ignores pre-releases.

### Q1–Q3. Authentication

Commands (no token / `Bearer spike-token` / `Bearer wrong`):

| Route | none | Bearer | wrong |
|---|---|---|---|
| `GET /api/dicts`, `GET /api/search`, `GET /api/openapi.yaml`, `/`, `/setup`, `/assets/frame.js` | 200 | 200 | 200 |
| `GET /res/{id}/…` (existing) | 200 | 200 | 200 |
| `GET /api/suggest`, `/api/prefs`, `/api/words`, `/api/library`, `/api/config`, `/api/rescan` | **401** | 200 | 401 |
| `GET /style/x.css`, `/files/x` | 401 | 404 | 401 |

- 401 body: `{"error":"access key required: …","auth":"required"}`; with `Accept: text/html` an HTML page.
- The token is accepted from the `wudict_session` cookie, `Authorization: Bearer`, or `?k=` (source:
  `internal/server/auth.go`). A valid `?k=` sets `wudict_session=<token>; HttpOnly; SameSite=Strict`
  and, for HTML navigations, 302-redirects to the clean URL.
- **Gateway rules that follow:** strip the `k` query parameter and all client cookies before proxying,
  drop `Set-Cookie` from wuDict responses, never forward `Authorization` from the client.
- The auth-free list is an allowlist in wuDict's source (`authFree`); `/api/dicts`, `/api/search` and
  `/res/` are open **by design** for browser extensions. `/api/dicts` also leaks absolute filesystem
  paths (`path`, `dbPath`, `source`, `mediaSrc`, `textDB`, `folder`). wuDict must never be reachable
  except through the gateway, and the gateway must strip those fields.

### Q4. Host guard and fetch metadata

- `Host: 127.0.0.1:6888`, `localhost:6888`, `[::1]:6888`, `10.0.0.5` → 200; `Host: dict.example.com`
  → **421** `request Host … is not a name this server answers to`.
- `X-Forwarded-Host` / `X-Forwarded-For` are ignored (200).
- wuDict also refuses `Sec-Fetch-Site: cross-site` with **403** on every route except the three
  extension routes (`/api/dicts`, `/api/search`, `/res/`). Same-origin requests through the gateway pass.
- Deleting dictionaries is allowed only from loopback unless `ALLOW_REMOTE_DELETE=1` (source:
  `remove.go`); the gateway connects from 127.0.0.1, so it is allowed. The gateway's own admin check is
  the real control.

### Q5. Search, suggest and their responses

- `/api/dicts` and `/api/search` are **NDJSON streams** (`application/x-ndjson`), one object per line,
  discriminated by `t`:
  - dicts: `{"t":"begin","total":N}`, `{"t":"dict","dict":{id,name,format,entries,caps,…}}`,
    `{"t":"end","etag":"\"…\""}`; an `If-None-Match` with that etag returns 304.
  - search: `{"t":"begin","slots":[{dict,name}…]}`, one `{"t":"hit","i":slot,"dict":id,"name":…,
    "results":[{"Headword":…,"Body":…}]}` per dictionary **in completion order**, optional `morph`
    lines, then `{"t":"end"}`. A dictionary with no result has a `hit` line without `results`.
- `dict=` restricts both endpoints: `dict=b56882bd1042` returned only that dictionary; on `/api/suggest`
  `q=z&dict=<PXTest>` → `{"words":[]}`, `q=z&dict=<PXTest2>` → `{"words":["zebra"]}`.
  A list where **no** id resolves is **404**; unknown ids inside a resolving list are skipped silently.
- `/api/suggest` returns `{"words":[…]}` (max 20), **requires the token**, modes `prefix|wildcard`.
- `/api/search` modes: `exact|prefix|fts|wildcard` (`fuzzy` = legacy `prefix`); default `prefix`;
  `n` = max results per dictionary (default 20). `@@@LINK=` redirects are resolved server-side
  (`kitty` → the `cat` article).
- wuDict always ships a built-in dictionary `wudict-howto` (`"builtin": true`, stored under
  `XDG_DATA_HOME`). It cannot be disabled; the gateway hides it.
- **Impact:** the gateway parses the NDJSON stream line by line, filters `dict` rows, strips path fields,
  and forwards search lines as they arrive (flush per line). It always passes an explicit `dict=` list.

### Q6. Dictionary IDs

- Source (`registry.go`): `pathID(path) = hex(sha256(path))[:12]` of the dictionary's main file;
  verified: `sha256("…/dictionaries/pxtest/PXTest.mdx")[:12] = b56882bd1042`.
- After deleting the originals (Q9) the same dictionary is listed with id
  `sha256("…/db/PXTest/text.db")[:12] = 1c735a60381e`. Renaming/moving the file or changing the mount
  path changes the id too. The builtin is `wudict-howto`.
- The library folder is named after the file stem (`db/PXTest/`); on a name clash wuDict appends the
  format (`db/PXTest3 (mdx)/`).
- Stable identifier: `uuid` in `db/<name>/info.txt` (also `dict_uuid` in `text.db`'s `meta` table). It
  survived deleting the originals. It exists only once a dictionary is indexed.
- **Impact:** `dictionaries.id` in the gateway is PXDict's own id; the table stores `wudict_id`
  (refreshed on every rescan), `library_dir` and `wudict_uuid`. The gateway maps `dbPath` →
  `info.txt` → `uuid`.

### Q7–Q8. Resource references and rendering

`PXTest`'s `cat` entry, as stored and as returned by `/api/search`:

```html
<!-- stored -->
<link rel="stylesheet" href="pxtest.css"><script src="pxtest.js"></script> … <img src="img/cat.png">
<a href="sound://audio/cat.mp3">play</a> <a href="entry://dog">see dog</a> <img src="/img/abs.png">
<!-- returned -->
<link rel="stylesheet" href="/res/b56882bd1042/pxtest.css"><script src="/res/b56882bd1042/pxtest.js"></script> …
<img src="/res/b56882bd1042/img/cat.png"> <a href="/res/b56882bd1042/audio/cat.mp3">play</a>
<a href="entry://dog">see dog</a> <img src="/res/b56882bd1042/img/abs.png">
```

- Every bundled reference (`src`, `href` on `<link>`, `url()` in inline styles, `srcset`, `sound://`,
  `file://`, and `href` on `<a>` when it names a file) becomes `/res/{id}/{path}` (source:
  `rewrite.go`). Cross-references stay as `entry://…` (`bword:` is canonicalised to `entry://`).
- Resources come from the MDD, from files beside the MDX (`pxtest.css`), or from `media.db`.
  Responses: correct `Content-Type` (`text/css`, `text/javascript`, `image/png`, `audio/mpeg`),
  `Cache-Control: public, max-age=86400`. The `.mdx` itself is not served (404). `..` in the path is
  normalised by Go's mux (307 redirect) and never escapes the dictionary.
- A CSS file served from `/res/` is passed through **unmodified**: `url(img/x.png)` resolves relative to
  `/res/{id}/` (fine), but a root-absolute `url(/img/abs.png)` in a CSS file breaks — in wuDict too.
- No entry referenced `/style/*`, `/files/*` or `/assets/*`. Those serve wuDict's own page
  (`/assets/frame.js`, user CSS in `<config>/style/`, the user file store).
- **Impact:** signed URLs as `/r/<token>/<id>/<path>` work: the gateway rewrites the single prefix
  `/res/<id>/` in returned HTML, and relative URLs inside CSS stay under the signed prefix.
  `/style/*`, `/files/*`, `/assets/*` are **not** proxied. Audio links are plain `<a href>` to `/res/…`
  — the PWA intercepts clicks on links whose path ends in an audio extension.
- Not verified here (needs a real browser, Phase 4): cookie behaviour inside a sandboxed iframe. The
  plan already avoids depending on it (signed URLs).

### Q9. Do originals stay necessary after indexing?

- Indexing writes `db/<name>/text.db` with the articles (`meta.body_encoding = zstd-1`, per-dictionary
  compression dictionary) and the headword index; `info.txt` says
  `media = not packed - resources come from the original files` until media is packed.
- `GET /api/ingest?dict=<id>&media=1` packed the MDD and the sidecar CSS/JS into `media.db`.
- `DELETE /api/library?dict=<id>&prepared=0` (delete originals, keep index):
  - with `USE_CACHED` off → **409** `turn on prepared dictionaries first, …`;
  - with media not packed → refused `pack media for … first` (source: `remove.go`; same rule in
    `wudict rm -keep-index`);
  - with `USE_CACHED=1` and media packed → 200 `{"name","sources":[mdx,mdd],"freed":2472,"gone":true}`.
    Search and every resource (PNG, MP3, CSS, JS) kept working from `text.db` + `media.db`, under the
    **new id** (Q6), and after a restart. `info.txt` gains `keep = standalone`.
- Sidecar files beside the MDX (`pxtest.css`, `pxtest.js`) are **not** deleted by wuDict.
- With `USE_CACHED` off, a dictionary without originals disappears from `/api/dicts`.
- Not verified: ZIM, StarDict, DSL, BGL, slob. The changelog says ZIM full-text uses the archive's own
  index, so ZIM likely still needs the file. **Fallback:** "delete originals" is offered for MDX/MDD only;
  other formats keep the action hidden until verified.
- **Impact:** wuDict runs with `USE_CACHED=1`. Approval ingests with `media=1` (costs disk: media.db ≈
  the MDD size), so originals can be deleted later. After deleting originals the gateway rescans and
  updates `wudict_id` through the `uuid`.

### Q10. Adding a dictionary at runtime

- Copying `pxtest3/` into `DICT_DIR` while running: `/api/dicts` and `/api/search` did **not** list it
  (also after 3 s).
- `GET /api/rescan` (token required; state change on a GET) → the dictionary appears, `dbPath: null`
  (not indexed). Response is the `/api/dicts` stream.
- Indexing then happens on its first search (`AUTO_INDEX=on`, default) or explicitly:

  ```text
  GET /api/ingest?dict=<id>[&fts=1][&media=1]      (text/event-stream)
  event: progress
  data: {"done":5,"total":5}

  event: done
  data: {…a /api/dicts row…}
  ```

  Errors: `event: error` / `data: {"error":"…"}`; unknown id → 404 `unknown dictionary id`. The job
  continues if the client disconnects; while it runs the `/api/dicts` row carries `job`.
- **Impact:** proposal approval = rename into `/data/dictionaries/<dict_id>/` → `GET /api/rescan` →
  find the new row by path → `GET /api/ingest?dict=<id>&media=1` with SSE progress forwarded to the admin.

### Q11. Deleting a dictionary

- `DELETE /api/library?dict=<id>` (token) → `{"name","folder":"…/db/PXTest3","sources":[…mdx,…mdd],
  "freed":64014,"gone":true}`. Removed: the library folder and the main + companion files.
  Left behind: any other file in the folder (`readme.txt` in the test; sidecar CSS/JS) and the folder.
- Flags: `prepared=0` keeps the index (Q9), `source=0` keeps the originals (index rebuilt on next search
  if the files stay in `DICT_DIR`). **No dry run** in the API; `wudict rm` (CLI) prints a dry run but
  refuses to delete while a server is running.
- **Impact:** the gateway computes the dry-run itself (it knows the files), calls `DELETE /api/library`,
  then removes the remaining files of `/data/dictionaries/<dict_id>/` via the gateway's `safeJoin` (`gateway/src/storage/safe-path.ts`).

### Q12. `wudict ingest` and copying `db/`

- Syntax: `wudict ingest [-full] [-fulltext] [<dictfile|folder…>]`; no path = `DICT_DIR`; `-full` adds
  the media pack; `-fulltext` the full-text index (`fulltext.db`). Indexed dictionaries are skipped.
- `ingest` refuses with `a wudict server is using this library at http://127.0.0.1:6888/` if a server
  answers on the configured address. Running it with a different `SERVER_PORT` (another library) works.
- Copying `db/PXTest3` built from a **different absolute path**: wuDict ignored it and indexed again
  into `db/PXTest3 (mdx)`; with `USE_CACHED=1` the copied folder was also listed as a second, standalone
  dictionary (duplicate results).
- Copying `db/PXTest3` built from the **same absolute path** (`/data/dictionaries/pxtest3/PXTest3.mdx`):
  reused as is — no re-indexing, `text.db` mtime unchanged.
- `HOME` must not contain `.wudict` (e.g. `HOME=/data` with config in `/data/.wudict`): wuDict tries to
  migrate `~/.wudict` to XDG folders and warns. Use `HOME=/data/.wudict/home` and
  `XDG_{CONFIG,DATA,STATE}_HOME=/data/.wudict/{config,data,state}`.
- **Impact:** off-box indexing (original §9.5) must run the same image with the dictionaries mounted at
  the same `/data/dictionaries/...` path. The runbook (Phase 9) documents this.

### Q13. RAM while indexing ~1M headwords

`PXBig.mdx`: 1,000,000 headwords, 36 MB. amd64, purego build, `INDEX_WORKERS=1`.

| Scenario | Peak RSS | Time | Result size |
|---|---|---|---|
| `wudict ingest` (`/usr/bin/time -v`), `MEMORY_LIMIT` unset | 274 MB | 7.4 s | `text.db` 101 MB |
| `wudict ingest`, `MEMORY_LIMIT=400MB` | 244 MB | 7.3 s | same |
| `wudict ingest -fulltext` | 304 MB | 25 s | + `fulltext.db` 86 MB |
| server, explicit `GET /api/ingest` (`VmHWM`) | 257–283 MB | 7.0 s | same |
| server, **first search before indexing** (`VmHWM`) | **717 MB** | 1.9 s (search) | same |
| server idle after indexing (`VmRSS`) | ~50 MB | — | — |

- The search-first peak comes from opening the unindexed dictionary in memory (~350 B per headword,
  `PREVIEW_MEMORY`) while the background index is built.
- The synthetic entries are short; real dictionaries with long articles need more time and disk, but
  the RSS is dominated by the headword count.
- `docker stats` was not used: peak RSS from the kernel (`VmHWM`, `/usr/bin/time`) is the number the
  container limit has to cover.
- **Impact:** after approval, always run `/api/ingest` before the dictionary is enabled for users.
  Budget: wuDict ~50 MB idle, ~300 MB during an ingest (1M headwords), plus the gateway. A 1 GB VPS with
  2 GB swap is fine with `INDEX_WORKERS=1`; set `MEMORY_LIMIT` to ~400MB there.

### Q14. Licensing

- wuDict is GPL-3.0-or-later. PXDict does not link to or modify wuDict: the gateway is a separate
  process that talks HTTP, and the image ships the unmodified binary built from the upstream tag. Per the
  GPL FAQ ("mere aggregation"), this lets PXDict choose its own license.
- Decision: **PXDict is GPL-3.0-or-later** (`LICENSE`), the same license as wuDict, keeping upstreaming
  simple.
- Obligations for the image (Phase 2/8): keep the OCI labels with the wuDict repository and tag
  (`io.github.wudict.version`), keep the README pointer to the corresponding source, and keep
  `wudict licenses` working (third-party notices are inside the binary).

## Phase 2 additions

Found while building the image and the contract tests (same tag, purego build):

- `wudict serve` prints a banner on stdout that includes its **access key** as
  `http://127.0.0.1:6888/?k=<AUTH_TOKEN>`. The entrypoint redacts the token from wuDict's output so it
  never reaches container logs.
- `/api/search?format=clean` rewrites root-absolute links such as `/res/…` into absolute URLs
  (openapi.yaml), which would point at wuDict's loopback address. The gateway does not offer `clean`.
- A UTF-8 DSL file (`#NAME`, tab-indented `[m1]…[/m]` bodies) is enough for a test dictionary:
  after `GET /api/rescan` it is listed (`format: "dsl"`) and searchable. The smoke and contract tests
  use one, so they need no Python tooling.
- `GET /api/config` with the token answers 200 and without it 401: `/healthz` uses it to check both
  that wuDict is up and that the gateway's token is right.

## Open questions

Nothing blocks Phase 1. These have a fallback and are re-checked later:

- [ ] Delete-originals for formats other than MDX/MDD (ZIM, StarDict, DSL, BGL, slob). Fallback: hidden.
- [x] Cookies/`Sec-Fetch-*` for `/r/` requests from a sandboxed iframe (Phase 4): no longer depended on.
  `/r/` URLs carry their own signed token and the gateway accepts them without cookies or fetch
  metadata checks ([ADR 0006](adr/0006-article-rendering-and-offline.md)). The contract test checks a DSL
  `[s]` image through `/r/` against the real binary.
- [ ] arm64 purego build and its RAM numbers (Phase 8 builds multi-arch; the amd64 numbers are the budget).
- [ ] Indexing RAM with a real large dictionary (Phase 9, on the target VPS).
