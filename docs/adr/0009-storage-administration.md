# 0009. Storage administration: attributing files, dry-run plans, and background clean-up

- Status: accepted
- Date: 2026-11-25

## Context

Phase 7 lets admins see where the data volume's space goes and delete what is not needed: original
files of indexed dictionaries, whole dictionaries, leftovers of proposals, stale uploads, orphaned
indexes and junk files. The plan asks for a dry run (`plan_id` valid for ten minutes) before every
deletion, and for the execution to re-check every file.

wuDict reports only a dictionary's main file (`source`), not the other files that belong to it, and
`DELETE /api/library` has no dry run: it removes the library folder and the main + companion files and
leaves everything else (docs/wudict-notes.md Q9, Q11). Deleting originals is verified only for MDX/MDD
with media packed and `USE_CACHED=1`; afterwards the wuDict id changes.

## Decision

- **The gateway attributes files itself** (`gateway/src/storage/admin.ts`). A dictionary approved from
  a proposal owns `DICT_DIR/<id>/`. Any other dictionary owns the folder of its main file when no other
  dictionary's main file lies in or below it; otherwise (e.g. files directly in `DICT_DIR`) it owns only
  the files beside the main file whose names start with its stem.
- **"Original files" are the main file, its `<stem>*.mdd` files and the CSS/JS beside it**: what
  wuDict packs into `media.db`. Deleting them calls `DELETE /api/library?dict=<id>&prepared=0`, then
  the gateway removes the CSS/JS, records `source_deleted_at`, and rescans (the row follows wuDict's new
  id through its library folder). Offered only when the dictionary is available, indexed, MDX, media
  packed (`dictionaries.media_packed`, or `info.txt` not saying "not packed") and `DICT_DIR` is
  writable. Other files in a dictionary folder (unknown types, archives, `.mdd` files of another stem)
  and files no dictionary claims are listed as **auxiliary files**: never pre-selected, picked one by one.
- **Deleting a whole dictionary** calls `DELETE /api/library?dict=<id>` (when wuDict lists it), removes
  the remaining attributed files and the index folder, deletes the `dictionaries` row (its `user_dicts`
  and `favorites` rows cascade) and rescans so the listing cannot re-create the row.
- **Plans live in memory**: an item list with every file's size, mtime and type, bound to the admin who
  previewed it, single use, ten minutes. Execution skips an item when any listed file changed, or a
  planned folder gained files; each deleted item is one `storage.delete` row in `audit_log` with
  `bytes_freed` counted from the planned files that are gone. One execution runs at a time. A restart
  forgets plans, which only means previewing again.
- **Read-only `DICT_DIR`** (`access(W_OK)` fails) blocks deleting originals, whole dictionaries with
  files and auxiliary files, with the reason shown.
- **Orphaned indexes** are folders in `DB_DIR` holding `info.txt` or `text.db` that neither the
  catalogue nor wuDict's current listing uses; they are not listed when wuDict cannot be asked.
- **Background jobs** (`gateway/src/jobs.ts`, hourly): history retention and proposal upload clean-up
  as before, plus removal of `tmp/` entries untouched for 24 hours, and a **weekly `VACUUM`** that runs
  only when no request is in flight and none arrived for ten minutes (it blocks the event loop). The
  last run is the newest `system.vacuum` row in `audit_log`, so no new table is needed.
- **Admin UI** (`/admin/*` in the PWA): Users (Better Auth's admin plugin: role, suspend, sign out
  everywhere, delete; plus invite codes), Proposals, Dictionaries, Storage, Audit log
  (`GET /app-api/admin/audit`, newest first, filter by action or action prefix).

## Consequences

- Attribution is a heuristic: a dictionary copied in by the operator next to unrelated files may own
  fewer or more files than expected. The dry run shows every path before anything is deleted.
- Formats other than MDX keep "delete originals" hidden until wuDict's behaviour is verified for them.
- Without originals a dictionary cannot be indexed again after a wuDict reader upgrade; the preview says
  so.
