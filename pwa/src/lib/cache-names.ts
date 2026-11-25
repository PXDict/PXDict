// Cache Storage layout shared by the page and the service worker (src/sw.ts). Everything a user looks
// up is cached under names that contain their id, so one person's lookups are never served to
// another on a shared device, and logging out deletes them (AGENTS.md §5).

/** Prefix of every per-user cache. */
export const userCachePrefix = "pxdict-u-";

/** Holds which user the service worker caches for (written by the page after /app-api/me). */
export const metaCache = "pxdict-meta";
export const metaUserKey = "/__pxdict/user";

export type UserCacheKind = "lookups" | "res" | "dicts";

export function userCacheName(userId: string, kind: UserCacheKind): string {
  return `${userCachePrefix}${userId}-${kind}`;
}

/** True for a cache that belongs to some user (any user). */
export function isUserCache(name: string): boolean {
  return name.startsWith(userCachePrefix);
}

/** True for one of `userId`'s caches. */
export function isCacheOf(name: string, userId: string): boolean {
  return name.startsWith(`${userCachePrefix}${userId}-`);
}

/** Message the page posts to the service worker when the signed-in user changes or logs out. */
export const userChangedMessage = "pxdict:user-changed";

/**
 * The cache key for a dictionary resource: `/r/<token>/<dict>/<path>` and `/res/<dict>/<path>` are the
 * same file, and tokens change every hour, so both are stored as `/res/<dict>/<path>`.
 */
export function resourceCacheKey(url: URL): string {
  const m = /^\/r\/[^/]+\/([^/]+\/.+)$/.exec(url.pathname);
  return m ? `${url.origin}/res/${m[1] ?? ""}` : `${url.origin}${url.pathname}`;
}
