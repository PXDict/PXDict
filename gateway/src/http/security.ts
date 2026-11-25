// Default security headers for every gateway response. A route that needs a different value (e.g. the
// sandbox CSP and cross-origin CORP on /res/*) sets the header itself; defaults never overwrite it.
import type { MiddlewareHandler } from "hono";

/**
 * CSP for the PWA. Phase 4 adds what sandboxed dictionary iframes need (frame-src, blob: for audio)
 * once they exist; until then the policy stays as strict as the empty PWA allows.
 */
export const pwaCsp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join("; ");

export const permissionsPolicy = [
  "accelerometer=()",
  "bluetooth=()",
  "browsing-topics=()",
  "camera=()",
  "display-capture=()",
  "geolocation=()",
  "gyroscope=()",
  "hid=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "serial=()",
  "usb=()",
].join(", ");

export interface SecurityHeadersOptions {
  /** Send Strict-Transport-Security (only when PUBLIC_URL is https). */
  hsts: boolean;
}

export function securityHeaders({ hsts }: SecurityHeadersOptions): MiddlewareHandler {
  const defaults: [string, string][] = [
    ["Content-Security-Policy", pwaCsp],
    ["X-Content-Type-Options", "nosniff"],
    ["Referrer-Policy", "same-origin"],
    ["Permissions-Policy", permissionsPolicy],
    ["X-Frame-Options", "SAMEORIGIN"],
    ["Cross-Origin-Opener-Policy", "same-origin"],
    ["Cross-Origin-Resource-Policy", "same-origin"],
  ];
  if (hsts) defaults.push(["Strict-Transport-Security", "max-age=31536000"]);

  return async (c, next) => {
    await next();
    const headers = c.res.headers;
    // Some responses (e.g. a fetched upstream Response) have immutable headers; copy once if needed.
    try {
      for (const [k, v] of defaults) if (!headers.has(k)) headers.set(k, v);
    } catch {
      const res = new Response(c.res.body, c.res);
      for (const [k, v] of defaults) if (!res.headers.has(k)) res.headers.set(k, v);
      c.res = res;
    }
  };
}
