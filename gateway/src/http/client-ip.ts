// The client's IP address, for Better Auth's rate limits and session records. Better Auth only reads
// headers, so the gateway computes the address itself and hands it over in one header it controls
// (an incoming copy of that header is always replaced).
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

/**
 * The TCP peer address, or, when `trustedHeader` is configured, the address a reverse proxy put in
 * that header (for X-Forwarded-For: the last entry, the one the proxy in front of the gateway added).
 */
export function clientIp(c: Context, trustedHeader: string | undefined): string | undefined {
  if (trustedHeader) {
    const raw = c.req.header(trustedHeader);
    const value = raw?.split(",").at(-1)?.trim();
    return value || undefined;
  }
  try {
    return getConnInfo(c).remote.address;
  } catch {
    // Not served by @hono/node-server (tests with app.request()).
    return undefined;
  }
}
