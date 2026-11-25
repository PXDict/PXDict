// Named types for wuDict's API, from wudict.schema.d.ts (generated from wuDict's openapi.yaml at the
// tag in ../../WUDICT_VERSION by `npm run gen:api`). Both the gateway's proxy and the PWA use them.
import type { components } from "./wudict.schema";

export type { components as WudictComponents, paths as WudictPaths } from "./wudict.schema";

export type DictInfo = components["schemas"]["DictInfo"];

type Schemas = components["schemas"];

/** One article in a search hit. Field names are capitalised on the wire. */
export type SearchResult = Schemas["Result"];

/**
 * A /api/dicts row as the gateway sends it: wuDict's allowlisted fields (no filesystem paths, no
 * groups), `name` replaced by PXDict's title, plus PXDict's `dictId` (its stable dictionary id),
 * `enabled` (in the user's default set) and `trustedRender` (may render same-origin, style A).
 */
export type GatewayDict = Pick<DictInfo, "id" | "name" | "format" | "entries" | "caps"> &
  Partial<
    Pick<
      DictInfo,
      | "job"
      | "error"
      | "tooLarge"
      | "outdated"
      | "ftsSize"
      | "ownText"
      | "dbSize"
      | "mediaSize"
      | "hasMedia"
      | "articleLang"
    >
  > & { dictId: string; enabled: boolean; trustedRender: boolean };

// The generated schema names its discriminators after the schema ("SearchHit"); on the wire `t` is
// "begin" | "dict" | "busy" | "hit" | "morph" | "end". These types use the wire values.
type Wire<T, Tag extends string> = Omit<T, "t"> & { t: Tag };

/** One line of the gateway's /api/dicts NDJSON stream. */
export type DictsLine =
  | { t: "begin" }
  | { t: "dict"; dict: GatewayDict }
  | Wire<Schemas["DictsBusy"], "busy">
  | { t: "end" };

/** One line of the /api/search NDJSON stream (article URLs already signed by the gateway). */
export type SearchLine =
  | Wire<Schemas["SearchBegin"], "begin">
  | Wire<Schemas["SearchHit"], "hit">
  | Wire<Schemas["SearchMorph"], "morph">
  | Wire<Schemas["StreamEnd"], "end">;

/** Search modes the gateway accepts (`fuzzy` is wuDict's legacy alias of `prefix`). */
export type SearchMode = "exact" | "prefix" | "fts" | "wildcard";

/** Body of /api/suggest. */
export interface SuggestResponse {
  words: string[];
}
