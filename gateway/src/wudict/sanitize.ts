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

/** PXDict's view of one wuDict dictionary (UsableDict in catalog.ts). */
export interface DictLabel {
  dictId: string;
  title: string;
  enabled: boolean;
  trusted: boolean;
}

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
 * Maps one /api/dicts line: rows outside `allowed` and builtins are dropped, rows are sanitised, named
 * with PXDict's title and get PXDict's `dictId`, `enabled` and `trustedRender`; `begin.total` and
 * `end.etag` are removed (both describe wuDict's whole library, not this user's view). Unknown line
 * types are dropped.
 */
export function mapDictsLine(line: unknown, allowed: ReadonlyMap<string, DictLabel>): unknown {
  if (!isObject(line)) return undefined;
  switch (line.t) {
    case "begin":
      return { t: "begin" };
    case "end":
      return { t: "end" };
    case "dict": {
      const dict = line.dict;
      const label = isObject(dict) && typeof dict.id === "string" ? allowed.get(dict.id) : undefined;
      if (!isObject(dict) || isBuiltinDict(dict) || !label) return undefined;
      return {
        t: "dict",
        dict: { ...sanitizeDict(dict), name: label.title, dictId: label.dictId, enabled: label.enabled, trustedRender: label.trusted },
      };
    }
    case "busy": {
      const busy = Array.isArray(line.busy) ? line.busy : [];
      const kept = busy
        .filter((b): b is Json => isObject(b) && typeof b.id === "string" && allowed.has(b.id))
        .map((b) => ({ id: b.id, name: allowed.get(b.id as string)?.title ?? b.name, phase: b.phase, done: b.done, total: b.total }));
      return kept.length ? { t: "busy", busy: kept } : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Maps one /api/search line: error strings become generic, names become PXDict's titles, and each
 * article's `/res/<dict>/` references go through `rewriteBody` (signed URLs). The gateway always sends
 * an explicit `dict=` list, so wuDict only answers for allowed dictionaries; a hit for any other one is
 * dropped anyway. `begin.slots` keeps its length and order because hits refer to slots by index.
 */
export function mapSearchLine(
  line: unknown,
  allowed: ReadonlyMap<string, Pick<DictLabel, "title">>,
  rewriteBody: (body: string, dict: string) => string = (b) => b,
): unknown {
  if (!isObject(line)) return undefined;
  if (line.t === "begin" && Array.isArray(line.slots)) {
    const slots = line.slots.map((s: unknown) => {
      if (!isObject(s) || typeof s.dict !== "string") return s;
      const title = allowed.get(s.dict)?.title;
      return title === undefined ? s : { ...s, name: title };
    });
    return { ...line, slots };
  }
  if (line.t === "hit") {
    const dict = line.dict;
    const label = typeof dict === "string" ? allowed.get(dict) : undefined;
    if (typeof dict !== "string" || !label) return undefined;
    const out: Json = { ...line, name: label.title };
    if (typeof out.error === "string" && out.error) out.error = genericError;
    if (Array.isArray(line.results)) {
      out.results = line.results.map((r: unknown) =>
        isObject(r) && typeof r.Body === "string" ? { ...r, Body: rewriteBody(r.Body, dict) } : r,
      );
    }
    return out;
  }
  return line;
}
