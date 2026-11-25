// The controlled proxy to wuDict: only the routes in routes.ts, with validated query parameters, an
// explicit `dict=` list from DictAccess, and allowlisted headers both ways. The browser's Cookie and
// Authorization headers and wuDict's Set-Cookie never cross, because headers are copied by allowlist.
// Streams (NDJSON) are forwarded line by line as wuDict produces them.
//
// Resources are served twice: /res/<dict>/<path> for the signed-in PWA itself (session cookie), and
// /r/<token>/<dict>/<path> for sandboxed dictionary iframes, which send no cookie (signed-url.ts).
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { z } from "zod";
import type { AuthEnv } from "../auth/guards";
import { jsonError } from "../http/errors";
import type { Logger } from "../log";
import type { DictAccess } from "./catalog";
import { WudictCatalogError } from "./catalog";
import { WudictTimeoutError, WudictUnavailableError, type WudictClient } from "./client";
import { ndjsonBody, ndjsonContentType, ndjsonTransform } from "./ndjson";
import { checkResourcePath, dictIdPattern, pickQuery, searchQuery, suggestQuery } from "./routes";
import { mapDictsLine, mapSearchLine } from "./sanitize";
import { signArticle, type ResourceSigner } from "./signed-url";

export interface WudictRoutesOptions {
  client: WudictClient;
  access: DictAccess;
  logger: Logger;
  /** Runs before every session-protected route; routes that are not allowlisted stay 404. */
  guard: MiddlewareHandler<AuthEnv>;
  /** Signs the resource URLs in search results for sandboxed iframes. */
  signer: ResourceSigner;
}

/** Response headers copied from wuDict for resources. Everything else (Set-Cookie, …) is dropped. */
const resourceResponseHeaders = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
] as const;

/** Request headers forwarded to wuDict for resources (conditional and range requests). */
const resourceRequestHeaders = ["range", "if-range", "if-none-match", "if-modified-since"] as const;

/**
 * A resource opened as a top-level document (e.g. HTML inside an .mdd) would run with the gateway's
 * origin. `sandbox` gives it an opaque origin; CSP does not affect it when loaded as a subresource.
 */
const resourceCsp = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'self' 'unsafe-inline'";

/** wuDict refuses the gateway itself: 401 wrong token, 403 fetch-metadata guard, 421 unknown Host. */
const refusedStatuses = new Set([401, 403, 421]);

export function createWudictRoutes({ client, access, logger, guard, signer }: WudictRoutesOptions): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  // Only for the methods that have a route, so anything else stays a plain 404. /r/* carries its own
  // credential (the signed token) instead.
  const guardReads: MiddlewareHandler<AuthEnv> = (c, next) =>
    c.req.method === "GET" || c.req.method === "HEAD" ? guard(c, next) : next();
  for (const path of ["/api/dicts", "/api/search", "/api/suggest", "/res/:dict/*"]) app.use(path, guardReads);

  const userId = (c: Context<AuthEnv>) => c.get("session").user.id;

  /** The gateway's token or Host is wrong: a deployment problem, never the user's. */
  const logRefused = (path: string, status: number) => {
    logger.error("wuDict refused the gateway's request; check AUTH_TOKEN and WUDICT_URL", { path, status });
  };

  /** Turns upstream failures into the gateway's error shape. */
  const fail = (c: Context, err: unknown) => {
    // The browser went away; nobody reads this answer.
    if (c.req.raw.signal.aborted) return new Response(null, { status: 499 });
    if (err instanceof WudictTimeoutError) {
      logger.warn("wuDict timed out", { path: c.req.path, timeoutMs: err.timeoutMs });
      return jsonError(c, 504, "wudict_timeout", "the dictionary server did not answer in time");
    }
    if (err instanceof WudictCatalogError && refusedStatuses.has(err.status)) {
      logRefused(c.req.path, err.status);
      return jsonError(c, 502, "wudict_unavailable", "the dictionary server is unavailable");
    }
    if (err instanceof WudictUnavailableError || err instanceof WudictCatalogError) {
      logger.error("wuDict unavailable", { path: c.req.path, err });
      return jsonError(c, 502, "wudict_unavailable", "the dictionary server is unavailable");
    }
    throw err;
  };

  /** Maps a non-success upstream status; wuDict's own messages are not forwarded (they may name files). */
  const upstreamError = async (c: Context, res: Response) => {
    await res.body?.cancel();
    switch (res.status) {
      case 400:
        return jsonError(c, 400, "bad_request", "the dictionary server rejected the request");
      case 404:
        return jsonError(c, 404, "not_found", "not found");
      default:
        if (refusedStatuses.has(res.status)) {
          logRefused(c.req.path, res.status);
          return jsonError(c, 502, "wudict_unavailable", "the dictionary server is unavailable");
        }
        logger.warn("wuDict error", { path: c.req.path, status: res.status });
        return jsonError(c, 502, "wudict_error", "the dictionary server failed");
    }
  };

  const parse = <S extends z.ZodType>(c: Context, schema: S, keys: readonly string[]) => {
    const result = schema.safeParse(pickQuery(new URL(c.req.url), keys));
    return result.success ? { ok: true as const, data: result.data } : { ok: false as const };
  };

  /** The requested ids (in request order) that are allowed; every allowed id for none or `all`. */
  const resolveDicts = (requested: string[] | undefined, allowed: string[]): string[] => {
    if (!requested?.length || requested.includes("all")) return allowed;
    const set = new Set(allowed);
    return [...new Set(requested)].filter((id) => set.has(id));
  };

  const streamNdjson = (c: Context, res: Response, map: (line: unknown) => unknown) => {
    const body = res.body?.pipeThrough(
      ndjsonTransform(map, (err) => {
        logger.warn("dropped an invalid NDJSON line from wuDict", { path: c.req.path, err });
      }),
    );
    return new Response(body ?? null, {
      status: 200,
      headers: { "Content-Type": ndjsonContentType, "Cache-Control": "no-store" },
    });
  };

  app.get("/api/dicts", async (c) => {
    try {
      const [allowedList, trusted] = await Promise.all([
        access.allowedIds(userId(c), c.req.raw.signal),
        access.trustedIds(c.req.raw.signal),
      ]);
      const allowed = new Set(allowedList);
      const res = await client.request({
        path: "/api/dicts",
        headers: new Headers({ Accept: ndjsonContentType }),
        signal: c.req.raw.signal,
      });
      if (res.status !== 200) return await upstreamError(c, res);
      return streamNdjson(c, res, (line) => mapDictsLine(line, allowed, trusted));
    } catch (err) {
      return fail(c, err);
    }
  });

  app.get("/api/search", async (c) => {
    const q = parse(c, searchQuery, Object.keys(searchQuery.shape));
    if (!q.ok) return jsonError(c, 400, "bad_request", "invalid search parameters");
    try {
      const user = userId(c);
      const dicts = resolveDicts(q.data.dict, await access.allowedIds(user, c.req.raw.signal));
      if (!dicts.length) {
        // wuDict answers 404 for a list where no id resolves; nothing to search is an empty result.
        c.header("Cache-Control", "no-store");
        return c.body(ndjsonBody([{ t: "begin", slots: [] }, { t: "end" }]), 200, {
          "Content-Type": ndjsonContentType,
        });
      }
      const query = new URLSearchParams({ q: q.data.q, dict: dicts.join(",") });
      if (q.data.mode) query.set("mode", q.data.mode);
      if (q.data.hl) query.set("hl", q.data.hl);
      if (q.data.mark) query.set("mark", q.data.mark);
      if (q.data.format) query.set("format", q.data.format);
      if (q.data.n) query.set("n", String(q.data.n));
      const res = await client.request({
        path: "/api/search",
        query,
        headers: new Headers({ Accept: ndjsonContentType }),
        signal: c.req.raw.signal,
      });
      if (res.status !== 200) return await upstreamError(c, res);
      const allowed = new Set(dicts);
      const prefixes = new Map<string, string>();
      const sign = (body: string, dict: string) => {
        let prefix = prefixes.get(dict);
        if (prefix === undefined) prefixes.set(dict, (prefix = signer.prefix(user, dict)));
        return signArticle(body, dict, prefix);
      };
      return streamNdjson(c, res, (line) => mapSearchLine(line, allowed, sign));
    } catch (err) {
      return fail(c, err);
    }
  });

  app.get("/api/suggest", async (c) => {
    const q = parse(c, suggestQuery, Object.keys(suggestQuery.shape));
    if (!q.ok) return jsonError(c, 400, "bad_request", "invalid suggest parameters");
    c.header("Cache-Control", "no-store");
    try {
      const dicts = resolveDicts(q.data.dict, await access.allowedIds(userId(c), c.req.raw.signal));
      if (!dicts.length) return c.json({ words: [] });
      const query = new URLSearchParams({ q: q.data.q, dict: dicts.join(",") });
      if (q.data.mode) query.set("mode", q.data.mode);
      const res = await client.request({
        path: "/api/suggest",
        query,
        headers: new Headers({ Accept: "application/json" }),
        signal: c.req.raw.signal,
      });
      if (res.status !== 200) return await upstreamError(c, res);
      const body = (await res.json()) as { words?: unknown };
      const words = Array.isArray(body.words) ? body.words.filter((w) => typeof w === "string") : [];
      return c.json({ words });
    } catch (err) {
      return fail(c, err);
    }
  });

  /**
   * Forwards one resource request for `user`. `prefix` is the path before `<rest>` (e.g. `/res/<dict>/`);
   * `crossOrigin` is set for /r/*, whose callers are opaque-origin iframes (fonts need CORS there).
   */
  const serveResource = async (c: Context, user: string, dict: string, prefix: string, crossOrigin: boolean) => {
    // The raw (still percent-encoded) remainder after the prefix.
    const rawPath = new URL(c.req.url).pathname;
    const rest = rawPath.startsWith(prefix) ? checkResourcePath(rawPath.slice(prefix.length)) : undefined;
    if (!dictIdPattern.test(dict) || rest === undefined) return jsonError(c, 404, "not_found", "not found");
    try {
      if (!(await access.allowedIds(user, c.req.raw.signal)).includes(dict)) {
        return jsonError(c, 404, "not_found", "not found");
      }
      const headers = new Headers();
      for (const h of resourceRequestHeaders) {
        const v = c.req.header(h);
        if (v !== undefined) headers.set(h, v);
      }
      const res = await client.request({
        method: c.req.method === "HEAD" ? "HEAD" : "GET",
        path: `/res/${dict}/${rest}`,
        headers,
        signal: c.req.raw.signal,
      });
      if (![200, 206, 304, 416].includes(res.status)) return await upstreamError(c, res);

      const out = new Headers();
      for (const h of resourceResponseHeaders) {
        const v = res.headers.get(h);
        if (v !== null) out.set(h, v);
      }
      // Access is per user: never let a shared cache (e.g. a CDN) keep it. Signed URLs are cached for
      // long: sandboxed iframes bypass the service worker, so the browser's HTTP cache is what shows
      // earlier lookups offline (ADR 0006). A dictionary's content changes only with its wuDict id.
      out.set("Cache-Control", crossOrigin ? "private, max-age=2592000" : "private, max-age=86400");
      out.set("Content-Security-Policy", resourceCsp);
      // Sandboxed iframes have an opaque origin; same-origin CORP would block their subresources.
      out.set("Cross-Origin-Resource-Policy", "cross-origin");
      // The token in the URL is the credential, never a cookie, so a wildcard reveals nothing more.
      if (crossOrigin) out.set("Access-Control-Allow-Origin", "*");
      return new Response(res.body, { status: res.status, headers: out });
    } catch (err) {
      return fail(c, err);
    }
  };

  app.get("/res/:dict/*", (c) => {
    const dict = c.req.param("dict");
    return serveResource(c, userId(c), dict, `/res/${dict}/`, false);
  });

  app.get("/r/:token/:dict/*", (c) => {
    const { token, dict } = c.req.param();
    const verified = signer.verify(token, dict);
    // Same answer as an unknown resource: a wrong or expired token reveals nothing.
    if (!verified) return jsonError(c, 404, "not_found", "not found");
    return serveResource(c, verified.userId, dict, `/r/${token}/${dict}/`, true);
  });

  return app;
}
