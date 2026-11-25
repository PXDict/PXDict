// Page-side management of the per-user offline caches (see cache-names.ts and src/sw.ts).
import { readLocal, writeLocal } from "./storage";
import { isCacheOf, isUserCache, metaCache, metaUserKey, userChangedMessage } from "./cache-names";

/** What the app remembers about the signed-in user to start offline. Cleared on logout. */
export interface LastUser {
  id: string;
  name: string;
  role: "user" | "admin";
}

const lastUserKey = "pxdict.user";

export function readLastUser(): LastUser | undefined {
  const raw = readLocal(lastUserKey);
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as Partial<LastUser>;
    if (typeof v.id === "string" && typeof v.name === "string" && (v.role === "user" || v.role === "admin")) {
      return { id: v.id, name: v.name, role: v.role };
    }
  } catch {
    // Corrupt entry: ignore.
  }
  return undefined;
}

const hasCaches = () => typeof caches !== "undefined";

function tellServiceWorker(): void {
  // navigator.serviceWorker is missing in insecure contexts and some embedded browsers.
  if ("serviceWorker" in navigator) navigator.serviceWorker.controller?.postMessage({ type: userChangedMessage });
}

/**
 * Records the signed-in user for offline start and for the service worker's cache names, and deletes
 * any other user's caches (left behind when a session expired without logging out).
 */
export async function setActiveUser(user: LastUser): Promise<void> {
  writeLocal(lastUserKey, JSON.stringify(user));
  if (!hasCaches()) return;
  try {
    for (const name of await caches.keys()) {
      if (isUserCache(name) && !isCacheOf(name, user.id)) await caches.delete(name);
    }
    const meta = await caches.open(metaCache);
    await meta.put(metaUserKey, new Response(user.id, { headers: { "Content-Type": "text/plain" } }));
    tellServiceWorker();
  } catch {
    // Cache Storage unavailable (private mode): nothing is cached either.
  }
}

/** Logout: deletes every user's cached lookups and resources, IndexedDB, and the remembered user. */
export async function wipeUserData(): Promise<void> {
  writeLocal(lastUserKey, null);
  try {
    if (hasCaches()) {
      for (const name of await caches.keys()) if (isUserCache(name) || name === metaCache) await caches.delete(name);
    }
    if (typeof indexedDB !== "undefined" && "databases" in indexedDB) {
      for (const db of await indexedDB.databases()) if (db.name) indexedDB.deleteDatabase(db.name);
    }
  } catch {
    // Best effort; the service worker also refuses to cache once the user is unknown.
  }
  tellServiceWorker();
}
