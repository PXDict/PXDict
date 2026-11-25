// The service worker (vite-plugin-pwa, injectManifest). It precaches the app shell and caches what a
// user looks up so earlier lookups work offline:
//   /api/search            network first, falling back to the cache (4 s timeout)
//   /api/dicts             stale-while-revalidate
//   /res/* and /r/*        cache first, keyed without the signing token (resourceCacheKey)
// Every runtime cache name contains the signed-in user's id (read from the meta cache the page
// writes), so a shared device never serves one user's lookups to another; with no known user nothing
// is cached. /app-api/* is never cached. Logout deletes the caches (src/lib/offline.ts).
//
// Sandboxed (opaque-origin) article frames are not controlled by a service worker; their resources go
// through the browser's HTTP cache instead (ADR 0006).
import { CacheableResponsePlugin } from "workbox-cacheable-response";
import { ExpirationPlugin } from "workbox-expiration";
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
  type PrecacheEntry,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { CacheFirst, NetworkFirst, StaleWhileRevalidate, type Strategy } from "workbox-strategies";
import {
  metaCache,
  metaUserKey,
  resourceCacheKey,
  userCacheName,
  userChangedMessage,
  type UserCacheKind,
} from "../lib/cache-names";
import { reservedPathPattern } from "../lib/paths";

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: (string | PrecacheEntry)[] };

precacheAndRoute(self.__WB_MANIFEST, { ignoreURLParametersMatching: [/^v$/, /^utm_/] });
cleanupOutdatedCaches();

// Client-side routes get the app shell; gateway and wuDict paths never do.
registerRoute(new NavigationRoute(createHandlerBoundToURL("/index.html"), { denylist: [reservedPathPattern, /^\/frame\.html/] }));

let userId: Promise<string | undefined> | undefined;

/** The signed-in user's id as last recorded by the page; undefined when nobody is signed in. */
function currentUser(): Promise<string | undefined> {
  userId ??= caches
    .open(metaCache)
    .then((c) => c.match(metaUserKey))
    .then((r) => r?.text())
    .then((id) => (id && /^[\w-]{1,128}$/.test(id) ? id : undefined))
    .catch(() => undefined);
  return userId;
}

self.addEventListener("message", (e) => {
  const data: unknown = e.data;
  if (typeof data === "object" && data !== null && (data as { type?: unknown }).type === userChangedMessage) {
    userId = undefined;
    strategies.clear();
  }
});

const day = 24 * 60 * 60;
const strategies = new Map<string, Strategy>();

function strategyFor(user: string, kind: UserCacheKind): Strategy {
  const key = `${user}:${kind}`;
  let s = strategies.get(key);
  if (s) return s;
  const cacheName = userCacheName(user, kind);
  const ok = new CacheableResponsePlugin({ statuses: [200] });
  switch (kind) {
    case "lookups":
      s = new NetworkFirst({
        cacheName,
        networkTimeoutSeconds: 4,
        plugins: [ok, new ExpirationPlugin({ maxEntries: 500, maxAgeSeconds: 30 * day, purgeOnQuotaError: true })],
      });
      break;
    case "res":
      s = new CacheFirst({
        cacheName,
        plugins: [
          ok,
          new ExpirationPlugin({ maxEntries: 2000, maxAgeSeconds: 30 * day, purgeOnQuotaError: true }),
          { cacheKeyWillBeUsed: ({ request }) => Promise.resolve(resourceCacheKey(new URL(request.url))) },
        ],
      });
      break;
    case "dicts":
      s = new StaleWhileRevalidate({ cacheName, plugins: [ok] });
      break;
  }
  strategies.set(key, s);
  return s;
}

/** Routes one kind of request through the user's cache, or straight to the network without a user. */
function perUser(kind: UserCacheKind) {
  return async ({ request, event }: { request: Request; event: ExtendableEvent }) => {
    const user = await currentUser();
    if (!user) return fetch(request);
    return strategyFor(user, kind).handle({ request, event });
  };
}

const sameOrigin = (url: URL) => url.origin === self.location.origin;

registerRoute(({ url }) => sameOrigin(url) && url.pathname === "/api/search", perUser("lookups"));
registerRoute(({ url }) => sameOrigin(url) && url.pathname === "/api/dicts", perUser("dicts"));
registerRoute(({ url }) => sameOrigin(url) && /^\/(?:res|r)\//.test(url.pathname), perUser("res"));
