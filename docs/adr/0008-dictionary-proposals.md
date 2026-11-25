# 0008. Dictionary proposals: chunked uploads, checks, approval and preview

- Status: accepted
- Date: 2026-11-25

## Context

Phase 6 lets users upload dictionary files that an admin reviews before anyone can use them. The plan
lists `POST /proposals` as one size-limited multipart request, and asks for chunked, resumable uploads
for large files, because Cloudflare's Free plan caps request bodies at 100 MB and proposals may be up
to `MAX_UPLOAD_BYTES` (500 MB by default). For the preview before approval, it suggests a temporary
wuDict instance indexing a staging copy, or, if that is not practical, approving the dictionary as
`hidden` so the admin can try it first.

Several things are fixed by wuDict (`docs/wudict-notes.md`): new files in `DICT_DIR` need
`GET /api/rescan`; searching an unindexed dictionary costs about 2.5× the RAM of an explicit
`GET /api/ingest` (Q13); an index built at one path is not reused at another (Q12), so an index built
in a staging directory would be thrown away after the move.

## Decision

- **One upload protocol, always chunked** (`gateway/src/proposals/`, `shared/src/api/proposals.ts`).
  `POST /app-api/proposals` takes the metadata and the file list (names and sizes) and checks names,
  extensions, the composition (one main dictionary file, or a single `.zip`), `MAX_UPLOAD_BYTES`, the
  per-user and system-wide quotas and the free disk space before any byte is sent. Each file is then sent
  with `PUT /app-api/proposals/{id}/files/{index}` in chunks of at most 32 MiB, with an `Upload-Offset`
  header that must equal the bytes already stored (409 otherwise). A cut-off chunk keeps what arrived,
  so the client resumes from `received` (shown by `GET /app-api/proposals/{id}`), also from another tab
  after a reload. This replaces the multipart endpoint: small proposals use the same path in one chunk.
  The protocol is tus-like but much smaller; a tus server library would add a dependency for less than
  a hundred lines of code.
- **Files move by same-filesystem renames only:** `tmp/proposals/<id>/upload/` while uploading,
  `tmp/proposals/<id>/files/` while checking, `proposals/<id>/` (quarantine, outside `DICT_DIR`) once
  pending, `dictionaries/<dictId>/` once approved. Every path built from a name goes through
  `storage/safe-path.ts`.
- **Checks on submit:** a zip is unpacked with limits checked on the whole central directory first
  (entries, total size, per-entry compression ratio, names, symlinks, encryption, nested archives), then
  streamed to disk with real sizes checked again. SHA-256 is computed while writing (recomputed when the
  in-memory state was lost). The main file's header is read (MDX version, title, encoding, encryption,
  headword count; DSL name and languages; StarDict `.ifo`). Warnings, never errors: JavaScript files,
  encrypted MDX, unreadable headers, and duplicates (same SHA-256 as a pending or approved proposal, or
  as an operator-copied dictionary of the same size). A submit that fails a rule deletes the proposal
  and its files and answers 422 with the reason: there is nothing for an admin to review.
- **Accepted formats:** the main file is `.mdx`, `.dsl`/`.dsl.dz`, `.ifo`, `.slob`, `.bgl` or `.zim`
  (the formats wuDict's `openapi.yaml` lists), with companions (`.mdd`, StarDict `.idx`/`.dict`/`.syn`,
  DSL `.ann`) and resources (styles, scripts, images, fonts, audio, `.txt`). Only MDX and DSL are verified
  end to end; the others are an open question in the notes.
- **Approval:** the gateway creates the `dictionaries` row (`hidden`, `source = 'proposal'`, its future
  source path) *before* moving the files into `DICT_DIR`, so the catalogue sync claims them by path and
  never creates a `builtin` row users could see early. Then, in the background (`dicts/publisher.ts`):
  rescan, sync, `GET /api/ingest?dict=<id>&media=1` (progress kept in memory for
  `GET /app-api/admin/dicts/{id}/index-status`), sync again (library folder, `uuid` from `info.txt`,
  index size), and only then the chosen visibility (`global`, `private` for the proposer, or `hidden`).
  An indexing error leaves the dictionary hidden; `POST /app-api/admin/dicts/{id}/index` retries and
  still publishes it with the approved scope.
- **Preview = approve as `hidden`.** A staging wuDict instance would index twice (the staging index is
  not reused after the move) and double the RAM peak on small servers. Instead an admin approves as
  `hidden` and tries the dictionary through the normal search: **admins may name any listed dictionary
  in `dict=`** (hidden ones and other users' private ones), although those never join their default
  search set. The dictionary is then published with `PATCH /app-api/admin/dicts/{id}`.
- **Rejecting or withdrawing deletes the files at once** and keeps the row with the reason. The
  proposer sees approvals and rejections in `GET /app-api/me` (`proposalUpdates`) until they open their
  proposals or dismiss the notice (`POST /app-api/me/proposals/seen`).
- **Deleted proposers:** `proposals.user_id` is `ON DELETE SET NULL`, so the admin keeps the history. An
  open proposal whose proposer is gone is withdrawn (files deleted) by the hourly job, which also drops
  uploads unfinished for 24 hours and upload folders without a proposal. A private dictionary whose
  owner is gone is visible to nobody until an admin changes it.

## Consequences

- Large proposals work behind Cloudflare and survive flaky mobile connections; the PWA retries failed
  chunks with backoff and resumes from the server's offset.
- One extra runtime dependency, `yauzl` (streaming zip reader with size validation), instead of
  hand-written zip parsing.
- Indexing status is in memory: after a gateway restart during indexing it shows `idle`, and the admin
  sees the dictionary as hidden and not indexed, with a retry button.
- Admins' `/api/dicts` lists every dictionary wuDict knows (not only theirs), so the PWA can show the
  names of hidden ones they try.
- Phase 7's storage administration can reuse `safe-path.ts`, the recorded `index_bytes`, and the
  proposal folders' known layout.
