import { describe, expect, it } from "vitest";
import { isCacheOf, isUserCache, resourceCacheKey, userCacheName } from "./cache-names";
import { reservedPathPattern } from "./paths";

describe("cache names", () => {
  it("are per user", () => {
    const name = userCacheName("u1", "lookups");
    expect(isUserCache(name)).toBe(true);
    expect(isCacheOf(name, "u1")).toBe(true);
    expect(isCacheOf(name, "u")).toBe(false);
    expect(isUserCache("workbox-precache-v2")).toBe(false);
  });

  it("key signed and plain resource URLs alike", () => {
    const o = "https://d.example";
    expect(resourceCacheKey(new URL(`${o}/r/abc.def/dict1/img/a%20b.png?x=1`))).toBe(`${o}/res/dict1/img/a%20b.png`);
    expect(resourceCacheKey(new URL(`${o}/res/dict1/img/a.png`))).toBe(`${o}/res/dict1/img/a.png`);
  });
});

describe("reservedPathPattern", () => {
  it.each(["/api/search", "/r/x/y/z", "/res/a/b", "/app-api/me", "/healthz", "/setup", "/assets/frame.js"])("reserves %s", (p) => {
    expect(reservedPathPattern.test(p)).toBe(true);
  });
  it.each(["/", "/account", "/login", "/reset-password", "/apis", "/results"])("leaves %s to the app", (p) => {
    expect(reservedPathPattern.test(p)).toBe(false);
  });
});
