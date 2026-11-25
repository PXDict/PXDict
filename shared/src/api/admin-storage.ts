// Storage administration (/app-api/admin/storage, docs/PLAN.md Phase 7, ADR 0009) and the audit log
// (/app-api/admin/audit). Deleting is always two steps: a dry-run plan (paths + bytes + warnings), then
// the execution of that plan, which re-checks every file first.
import { z } from "zod";
import { DictId } from "./me";

/** Top-level folders of the data volume. */
export const StorageArea = z.enum(["dictionaries", "db", "proposals", "tmp", "gateway"]);
export type StorageArea = z.infer<typeof StorageArea>;

/** What can be deleted; `target` names the thing inside its kind. */
export const StorageItemKind = z.enum([
  /** Original files of an indexed MDX dictionary (index kept); target = dictionary id. */
  "dict_originals",
  /** A whole dictionary: originals, index and the catalogue entry; target = dictionary id. */
  "dict",
  /** Leftover files of a rejected, withdrawn or unknown proposal; target = folder name under proposals/. */
  "proposal_files",
  /** Something in tmp/ untouched for 24 hours; target = path under tmp/. */
  "stale_upload",
  /** An index folder in db/ that no dictionary uses; target = folder name under db/. */
  "orphan_index",
  /** One file in the dictionary folder that is not a dictionary's main or media file; target = path under dictionaries/. */
  "aux_file",
]);
export type StorageItemKind = z.infer<typeof StorageItemKind>;

/** Why an item cannot be deleted right now. */
export const StorageBlockReason = z.enum([
  /** The dictionary folder is mounted read-only. */
  "read_only",
  /** Deleting originals is verified for MDX/MDD only (docs/wudict-notes.md Q9). */
  "format_unsupported",
  /** The index has no media pack yet: resources still come from the original files. */
  "media_not_packed",
  "not_indexed",
  /** The dictionary server does not list the dictionary right now. */
  "unavailable",
  /** There are no original files left. */
  "no_originals",
  /** Being indexed, or another deletion runs. */
  "busy",
  /** Still in use: a proposal waiting for review, an upload changed in the last 24 hours, an index a dictionary uses. */
  "in_use",
  "not_found",
]);
export type StorageBlockReason = z.infer<typeof StorageBlockReason>;

export const StorageWarning = z.object({
  code: z.enum([
    /** `count` users have the dictionary enabled. */
    "users_enabled",
    /** `count` favorites point at the dictionary and are deleted with it. */
    "favorites_lost",
    /** Without originals the dictionary cannot be indexed again (e.g. after a dictionary server upgrade). */
    "no_reindex",
    /** The file may still be used (e.g. a style sheet, or a dictionary not scanned yet). */
    "may_be_in_use",
    /** An unfinished upload is cancelled. */
    "cancels_upload",
  ]),
  count: z.number().int().optional(),
});
export type StorageWarning = z.infer<typeof StorageWarning>;

/** One dictionary's disk use. */
export const StorageDict = z.object({
  id: DictId,
  title: z.string(),
  format: z.string().nullable(),
  available: z.boolean(),
  /** Bytes of the original files the gateway attributes to the dictionary. */
  sourceBytes: z.number().int(),
  /** Bytes of the index folder (db/<name>/). */
  indexBytes: z.number().int(),
  sourceDeletedAt: z.iso.datetime().nullable(),
  /** Users who have it enabled (users who never opened their list are not counted). */
  enabledUsers: z.number().int(),
  /** Why "delete originals" is not offered; null when it is. */
  originalsBlocked: StorageBlockReason.nullable(),
  /** Why "delete dictionary" is not offered; null when it is. */
  deleteBlocked: StorageBlockReason.nullable(),
});
export type StorageDict = z.infer<typeof StorageDict>;

/** Something found that may be cleaned up (other than a dictionary). */
export const StorageCandidate = z.object({
  kind: z.enum(["proposal_files", "stale_upload", "orphan_index", "aux_file"]),
  target: z.string(),
  bytes: z.number().int(),
  /** Last change of anything inside. */
  modifiedAt: z.iso.datetime(),
  /** Picked by default in the UI; auxiliary files never are. */
  suggested: z.boolean(),
  blocked: StorageBlockReason.nullable(),
});
export type StorageCandidate = z.infer<typeof StorageCandidate>;

/** Body of GET /app-api/admin/storage. */
export const StorageOverview = z.object({
  volume: z.object({ totalBytes: z.number().int(), freeBytes: z.number().int() }),
  areas: z.array(z.object({ area: StorageArea, bytes: z.number().int() })),
  /** False when DICT_DIR is read-only: original files cannot be deleted. */
  dictDirWritable: z.boolean(),
  /** False when the dictionary server could not be asked: orphaned indexes are not listed. */
  catalogChecked: z.boolean(),
  dicts: z.array(StorageDict),
  candidates: z.array(StorageCandidate),
});
export type StorageOverview = z.infer<typeof StorageOverview>;

export const StorageItemRef = z.object({ kind: StorageItemKind, target: z.string().min(1).max(1024) });
export type StorageItemRef = z.infer<typeof StorageItemRef>;

/** Body of POST /app-api/admin/storage/plan. */
export const StoragePlanRequest = z.object({ items: z.array(StorageItemRef).min(1).max(500) });
export type StoragePlanRequest = z.infer<typeof StoragePlanRequest>;

export const StoragePlanItem = StorageItemRef.extend({
  /** Human-readable name (a dictionary title, a folder). */
  label: z.string(),
  bytes: z.number().int(),
  /** Every file that would be deleted, relative to the data volume. */
  paths: z.array(z.object({ path: z.string(), bytes: z.number().int() })),
  warnings: z.array(StorageWarning),
  /** Set when the item cannot be deleted; it is then left out of the execution. */
  blocked: StorageBlockReason.nullable(),
});
export type StoragePlanItem = z.infer<typeof StoragePlanItem>;

/** Response of POST /app-api/admin/storage/plan (a dry run: nothing is deleted). */
export const StoragePlan = z.object({
  planId: z.string(),
  expiresAt: z.iso.datetime(),
  /** Bytes of the items that are not blocked. */
  totalBytes: z.number().int(),
  items: z.array(StoragePlanItem),
});
export type StoragePlan = z.infer<typeof StoragePlan>;

/** Body of POST /app-api/admin/storage/execute. */
export const StorageExecuteRequest = z.object({ planId: z.string().regex(/^[0-9a-f]{32}$/) });
export type StorageExecuteRequest = z.infer<typeof StorageExecuteRequest>;

export const StorageExecuteItem = StorageItemRef.extend({
  /** "skipped": something changed since the plan (or it was blocked), nothing deleted. */
  status: z.enum(["done", "skipped", "failed"]),
  bytesFreed: z.number().int(),
  reason: z.string().nullable(),
});
export type StorageExecuteItem = z.infer<typeof StorageExecuteItem>;

/** Response of POST /app-api/admin/storage/execute. */
export const StorageExecuteResult = z.object({
  bytesFreed: z.number().int(),
  items: z.array(StorageExecuteItem),
});
export type StorageExecuteResult = z.infer<typeof StorageExecuteResult>;

// Audit log

export const AuditEntry = z.object({
  id: z.number().int(),
  actor: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  details: z.record(z.string(), z.unknown()).nullable(),
  bytesFreed: z.number().int().nullable(),
  createdAt: z.iso.datetime(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

/** Query of GET /app-api/admin/audit: newest first; `cursor` is the last id of the previous page. */
export const AuditQuery = z.object({
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Exact action, or a prefix ending in "." (e.g. "storage."). */
  action: z.string().trim().min(1).max(100).optional(),
});
export type AuditQuery = z.infer<typeof AuditQuery>;

export const AuditPage = z.object({ entries: z.array(AuditEntry), nextCursor: z.number().int().nullable() });
export type AuditPage = z.infer<typeof AuditPage>;
