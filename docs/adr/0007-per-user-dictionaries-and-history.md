# 0007. Per-user dictionaries, history and settings

- Status: accepted
- Date: 2026-11-25

## Context

Phase 5 makes searches per user: each user has their own dictionary set and order, search history,
favorites and settings. Up to Phase 4 the proxy let every user search every dictionary wuDict listed,
keyed on wuDict's ids. Those ids are path hashes. They change when a file moves or its originals are
deleted (`docs/wudict-notes.md` Q6), so per-user data cannot be keyed on them.

The plan keeps catalogue sync and the admin dictionary screens in Phase 6, where a dictionary copied
into `DICT_DIR` by hand starts `hidden` until an admin publishes it. Phase 5 cannot hide those
dictionaries: there is no admin screen yet, and existing installs would lose every dictionary on
upgrade.

## Decision

- **Catalogue sync starts in Phase 5** (`gateway/src/dicts/registry.ts`). Whenever wuDict's
  `/api/dicts` listing changes (it is cached for 5 s and revalidated with its etag), the gateway
  reconciles it with the `dictionaries` table. Each listed dictionary is matched to a row by wuDict id,
  then by library folder (`db/<name>/`, which keeps its name when originals are deleted), then by source
  path. The row's `wudict_id` is refreshed. A dictionary that matches no row gets a new row with
  `source = 'builtin'` and a readable id (a slug of its name, `-2`, `-3`, … on clashes). A row wuDict no
  longer lists keeps its data and users' choices, but `wudict_id` becomes null, so it is not searched
  until it comes back. Titles are never overwritten (admins edit them in Phase 6). Reading `uuid` from
  `info.txt` stays in Phase 6, together with the other filesystem work.
- **`BUILTIN_DICT_VISIBILITY`** (`global` by default, or `hidden`) is the visibility of a dictionary found
  this way. The default keeps today's behaviour: dictionaries the operator copies in are for everyone.
  An operator who wants Phase 6's review-first behaviour sets `hidden`.
- **`user_dicts` is filled in lazily.** When a user's list is read, every `global` dictionary and every
  `private` one the user owns that has no row is appended, enabled, sorted by title. On the user's first
  visit they are not flagged; later additions get `is_new`. `/app-api/me` lists the new ones until
  `POST /app-api/me/dicts/seen`. Publishing a dictionary therefore needs no write per user. Hidden,
  foreign-private and unavailable dictionaries are filtered out on every request, and their
  `user_dicts` rows stay in place so a dictionary that comes back keeps the user's choice.
- **The proxy decides per user.** Without `dict=`, `/api/search` and `/api/suggest` use the user's
  enabled dictionaries in the user's order. An explicit `dict=` may name any dictionary the user may use,
  including disabled ones (e.g. "search only this dictionary" from a saved word). `/api/dicts` and
  search lines carry PXDict's title, and dictionary rows carry `dictId` and `enabled`. `/res/` and `/r/`
  are allowed for any dictionary the user may use.
- **History is written by the proxy** once wuDict accepts a `/api/search` request (never for
  `suggest`), if the user has history on. A lookup identical to the user's previous entry (query, mode,
  dictionaries) within one minute moves that entry's time instead of adding one. An hourly job deletes
  entries past each user's retention (`HISTORY_DEFAULT_RETENTION_DAYS` for users who never changed it;
  0 = forever) and keeps at most 10 000 entries per user. Lookups answered by the service worker's cache
  while offline are not recorded.
- **Settings are per user** (`user_settings`: history, retention, default search mode, UI language,
  theme, text size). `/app-api/me` returns them and the PWA applies them on sign-in. The PWA still
  caches theme, language and text size in `localStorage`, so the login screen and offline starts look
  the same.
- **Favorites** are keyed on PXDict's dictionary id (`favorites` rows are deleted with the dictionary).
  A favorite in a dictionary the user can no longer use is still listed, without the dictionary's
  title.

## Consequences

- PXDict ids survive wuDict id changes, and Phase 6/7 build on the same table (proposals insert rows
  with `source = 'proposal'`; admins change `visibility`, `title`, `trusted_render`).
- Every proxied request reads the user's list from SQLite (a few indexed queries). That is cheap at
  PXDict's scale and keeps access decisions current without cache invalidation.
- Matching by folder or source path is a heuristic: two dictionaries that swap paths in one rescan
  could swap PXDict ids. `wudict_uuid` (Phase 6) makes matching exact once dictionaries are indexed.
- Phase 6's "manually copied dictionaries start hidden" becomes a configuration choice
  (`BUILTIN_DICT_VISIBILITY=hidden`) rather than the only behaviour.
- CSV exports quote every field and prefix a leading `=`, `+`, `-`, `@`, tab or CR with `'`, so
  spreadsheets do not run lookups or notes as formulas.
