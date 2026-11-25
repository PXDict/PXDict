// The ONLY adapter for PXDict's own API (/app-api and /healthz) that UI code imports. Types come from
// @pxdict/shared, the zod schemas the gateway validates with; only types are imported, so zod is not
// bundled. Better Auth's endpoints (/app-api/auth/*) are wrapped in ./auth and re-exported here.
import type {
  AuthMethods,
  ClaimInviteRequest,
  Favorite,
  FavoriteList,
  Health,
  HistoryEntry,
  HistoryPage,
  Me,
  MyDict,
  MyDictList,
  NewDict,
  SaveFavoriteRequest,
  UpdateMyDictsRequest,
  UpdateSettingsRequest,
  UserSettings,
} from "@pxdict/shared";
import { send, toApiError } from "./http";

export { ApiError, isNetworkError, onUnauthorized } from "./http";
export * from "./auth";
export type { AuthMethods, Favorite, Health, HistoryEntry, HistoryPage, Me, MyDict, NewDict, UserSettings };

const opts = (signal?: AbortSignal): RequestInit => (signal ? { signal } : {});

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await send(path, opts(signal));
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as T;
}

/** GET /healthz */
export function getHealth(signal?: AbortSignal): Promise<Health> {
  return getJson<Health>("/healthz", signal);
}

/** GET /app-api/auth/methods: which sign-in methods the login screen offers. Public. */
export function getAuthMethods(signal?: AbortSignal): Promise<AuthMethods> {
  return getJson<AuthMethods>("/app-api/auth/methods", signal);
}

/** GET /app-api/me: the signed-in user; throws ApiError 401 without a session. */
export function getMe(signal?: AbortSignal): Promise<Me> {
  return getJson<Me>("/app-api/me", signal);
}

/** POST /app-api/auth/invite: remembers an invite code (HttpOnly cookie) for the next sign-up. */
export async function claimInvite(code: string): Promise<void> {
  const res = await send("/app-api/auth/invite", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code } satisfies ClaimInviteRequest),
  });
  if (!res.ok) throw await toApiError(res);
}

async function sendJson<T>(method: string, path: string, body: unknown): Promise<T> {
  const res = await send(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as T;
}

async function sendEmpty(method: string, path: string, body?: unknown): Promise<void> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await send(path, init);
  if (!res.ok) throw await toApiError(res);
}

/** PUT /app-api/me/settings: changes some settings; answers all of them. */
export function updateSettings(changes: UpdateSettingsRequest): Promise<UserSettings> {
  return sendJson<UserSettings>("PUT", "/app-api/me/settings", changes);
}

export interface HistoryOptions {
  q?: string;
  cursor?: number;
  limit?: number;
  /** One entry per distinct query. */
  unique?: boolean;
}

/** GET /app-api/me/history: newest first, a page at a time. */
export function getHistory(o: HistoryOptions = {}, signal?: AbortSignal): Promise<HistoryPage> {
  const p = new URLSearchParams();
  if (o.q) p.set("q", o.q);
  if (o.cursor) p.set("cursor", String(o.cursor));
  if (o.limit) p.set("limit", String(o.limit));
  if (o.unique) p.set("unique", "1");
  const qs = p.toString();
  return getJson<HistoryPage>(`/app-api/me/history${qs ? `?${qs}` : ""}`, signal);
}

/** DELETE /app-api/me/history/{id} */
export function deleteHistoryEntry(id: number): Promise<void> {
  return sendEmpty("DELETE", `/app-api/me/history/${String(id)}`);
}

/** DELETE /app-api/me/history: forgets every lookup. */
export function clearHistory(): Promise<void> {
  return sendEmpty("DELETE", "/app-api/me/history");
}

/** Download links for exports (opened by the browser, not fetched). */
export const exportUrl = (what: "history" | "favorites", format: "csv" | "json") =>
  `/app-api/me/${what}/export?format=${format}`;

/** GET /app-api/me/dicts: every dictionary the user may use, in their order. */
export async function getMyDicts(signal?: AbortSignal): Promise<MyDict[]> {
  return (await getJson<MyDictList>("/app-api/me/dicts", signal)).dicts;
}

/** PUT /app-api/me/dicts: saves the order and the enabled flags. */
export async function saveMyDicts(dicts: UpdateMyDictsRequest["dicts"]): Promise<MyDict[]> {
  return (await sendJson<MyDictList>("PUT", "/app-api/me/dicts", { dicts } satisfies UpdateMyDictsRequest)).dicts;
}

/** POST /app-api/me/dicts/seen: stops announcing new dictionaries. */
export function markDictsSeen(): Promise<void> {
  return sendEmpty("POST", "/app-api/me/dicts/seen");
}

/** GET /app-api/me/favorites, newest first. */
export async function getFavorites(signal?: AbortSignal): Promise<Favorite[]> {
  return (await getJson<FavoriteList>("/app-api/me/favorites", signal)).favorites;
}

/** POST /app-api/me/favorites: saves a word (and, when given, its note). */
export function saveFavorite(f: SaveFavoriteRequest): Promise<void> {
  return sendEmpty("POST", "/app-api/me/favorites", f);
}

/** DELETE /app-api/me/favorites */
export function deleteFavorite(headword: string, dictId: string): Promise<void> {
  return sendEmpty("DELETE", `/app-api/me/favorites?${new URLSearchParams({ headword, dict: dictId }).toString()}`);
}
