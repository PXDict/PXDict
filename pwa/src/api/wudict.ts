// The ONLY adapter for wuDict's routes (/api/*, /res/*, /r/*), always reached through the gateway.
// Types come from @pxdict/shared/wudict, generated from wuDict's openapi.yaml at the pinned tag.
import type {
  DictsLine,
  GatewayDict,
  SearchLine,
  SearchMode,
  SearchResult,
  SuggestResponse,
} from "@pxdict/shared/wudict";
import { readNdjson, send, toApiError } from "./http";

export type { GatewayDict, SearchLine, SearchMode, SearchResult };

export const searchModes: readonly SearchMode[] = ["exact", "prefix", "fts", "wildcard"];

const ndjson = "application/x-ndjson";

/** GET /api/dicts: the dictionaries this user may search, in their order. */
export async function listDicts(signal?: AbortSignal): Promise<GatewayDict[]> {
  const res = await send("/api/dicts", { headers: { Accept: ndjson }, ...(signal ? { signal } : {}) });
  if (!res.ok || !res.body) throw await toApiError(res);
  const dicts: GatewayDict[] = [];
  for await (const line of readNdjson<DictsLine>(res.body)) if (line.t === "dict") dicts.push(line.dict);
  return dicts;
}

export interface SearchParams {
  q: string;
  mode: SearchMode;
  /** Limit to these dictionaries; all the user's dictionaries when omitted. */
  dicts?: readonly string[];
}

/** The URL of a search, also used as the service worker's cache key for offline lookups. */
export function searchUrl({ q, mode, dicts }: SearchParams): string {
  const query = new URLSearchParams({ q, mode });
  if (dicts?.length) query.set("dict", dicts.join(","));
  return `/api/search?${query.toString()}`;
}

/** GET /api/search: yields NDJSON lines as wuDict answers, dictionary by dictionary. */
export async function* search(params: SearchParams, signal?: AbortSignal): AsyncGenerator<SearchLine> {
  const res = await send(searchUrl(params), { headers: { Accept: ndjson }, ...(signal ? { signal } : {}) });
  if (!res.ok || !res.body) throw await toApiError(res);
  yield* readNdjson<SearchLine>(res.body);
}

/** GET /api/suggest: up to 20 headwords for the search box. */
export async function suggest(q: string, signal?: AbortSignal): Promise<string[]> {
  const mode = /[*?]/.test(q) ? "wildcard" : "prefix";
  const res = await send(`/api/suggest?${new URLSearchParams({ q, mode }).toString()}`, signal ? { signal } : {});
  if (!res.ok) throw await toApiError(res);
  return ((await res.json()) as SuggestResponse).words;
}

/** Audio file extensions: links to these play in the page instead of navigating (`sound://`). */
const audioExtensions = /\.(?:mp3|wav|ogg|oga|opus|m4a|aac|spx|flac|webm)$/i;

/**
 * A dictionary resource URL (/res/<dict>/… or a signed /r/<token>/<dict>/…) on this origin, or
 * undefined for anything else. Used to decide which links from an article the page may follow.
 */
export function resourceUrl(href: string, base: string = location.origin): URL | undefined {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return undefined;
  }
  if (url.origin !== new URL(base).origin) return undefined;
  return /^\/(?:res\/[^/]+|r\/[^/]+\/[^/]+)\/./.test(url.pathname) ? url : undefined;
}

/** True when a resource URL names an audio file. */
export function isAudio(url: URL): boolean {
  return audioExtensions.test(url.pathname);
}
