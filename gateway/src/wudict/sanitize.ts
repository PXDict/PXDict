// What users may see of wuDict's NDJSON lines. wuDict is single-user: /api/dicts exposes absolute
// filesystem paths and its global groups, and error strings can name files (docs/wudict-notes.md
// Q1–Q3). Fields are allowlisted so a new upstream field is hidden until someone decides otherwise.

/** wuDict's built-in help dictionary; it cannot be disabled upstream, so the gateway hides it. */
export const howtoDictId = "wudict-howto";

const dictFields = new Set([
  "id",
  "name",
  "format",
  "entries",
  "caps",
  "job",
  "error",
  "tooLarge",
  "outdated",
  "ftsSize",
  "ownText",
  "dbSize",
  "mediaSize",
  "hasMedia",
  "articleLang",
]);

const genericError = "dictionary unavailable";

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** True for a /api/dicts row that is wuDict's own (the howto). */
export function isBuiltinDict(dict: Json): boolean {
  return dict.builtin === true || dict.id === howtoDictId;
}

/** Copies the allowlisted fields of one DictInfo; `error` becomes a generic message. */
export function sanitizeDict(dict: Json): Json {
  const out: Json = {};
  for (const [k, v] of Object.entries(dict)) if (dictFields.has(k)) out[k] = v;
  if (typeof out.error === "string" && out.error) out.error = genericError;
  return out;
}

/**
 * Maps one /api/dicts line: rows outside `allowed` and builtins are dropped, rows are sanitised,
 * `begin.total` and `end.etag` are removed (both describe wuDict's whole library, not this user's
 * view). Unknown line types are dropped.
 */
export function mapDictsLine(line: unknown, allowed: ReadonlySet<string>): unknown {
  if (!isObject(line)) return undefined;
  switch (line.t) {
    case "begin":
      return { t: "begin" };
    case "end":
      return { t: "end" };
    case "dict": {
      const dict = line.dict;
      if (!isObject(dict) || isBuiltinDict(dict) || typeof dict.id !== "string" || !allowed.has(dict.id)) {
        return undefined;
      }
      return { t: "dict", dict: sanitizeDict(dict) };
    }
    case "busy": {
      const busy = Array.isArray(line.busy) ? line.busy : [];
      const kept = busy
        .filter((b): b is Json => isObject(b) && typeof b.id === "string" && allowed.has(b.id))
        .map((b) => ({ id: b.id, name: b.name, phase: b.phase, done: b.done, total: b.total }));
      return kept.length ? { t: "busy", busy: kept } : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Maps one /api/search line: error strings become generic. The gateway always sends an explicit `dict=`
 * list, so wuDict only answers for allowed dictionaries; a hit for any other one is dropped anyway.
 * `begin.slots` is passed unchanged because hits refer to slots by index.
 */
export function mapSearchLine(line: unknown, allowed: ReadonlySet<string>): unknown {
  if (!isObject(line)) return undefined;
  if (line.t === "hit") {
    if (typeof line.dict !== "string" || !allowed.has(line.dict)) return undefined;
    return typeof line.error === "string" && line.error ? { ...line, error: genericError } : line;
  }
  return line;
}
