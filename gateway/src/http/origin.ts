// CSRF protection for PXDict's own state-changing /app-api routes (AGENTS.md §6), the same rule Better
// Auth applies to its routes: the Origin header must be PUBLIC_URL's origin, or, without Origin,
// Sec-Fetch-Site must be same-origin. Requests from non-browser clients must send Origin.
import type { MiddlewareHandler } from "hono";
import { jsonError } from "./errors";

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

export function originCheck(publicOrigin: string): MiddlewareHandler {
  return async (c, next) => {
    if (!safeMethods.has(c.req.method)) {
      const origin = c.req.header("origin");
      const ok = origin !== undefined ? origin === publicOrigin : c.req.header("sec-fetch-site") === "same-origin";
      if (!ok) return jsonError(c, 403, "origin_mismatch", "request origin not allowed");
    }
    await next();
  };
}
