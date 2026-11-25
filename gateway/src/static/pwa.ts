// Serves the built PWA from PWA_DIR: files as they are (with precompressed .br/.gz variants when the
// build made them), index.html for client-side routes, and 404 for wuDict/gateway paths.
import { serveStatic } from "@hono/node-server/serve-static";
import type { Env, Hono, MiddlewareHandler } from "hono";
import { frameCsp } from "../http/security";
import { isReservedPath } from "../wudict/routes";

/** Files that must be revalidated on every load so a new deployment is picked up. */
const revalidate = "no-cache";
/** Vite's hashed build output (build.assetsDir = "app-assets"). */
const immutable = "public, max-age=31536000, immutable";

const compressible = /\.(?:html|js|mjs|css|svg|json|webmanifest|txt|xml|wasm)$/;

/** The page dictionary articles render in (pwa/public/frame.html); it gets its own CSP. */
export const framePath = "/frame.html";

export interface MountPwaOptions {
  /** PUBLIC_URL's origin, for the frame page's CSP. */
  publicOrigin: string;
}

/** Registers the static routes; call after every API route so those take precedence. */
export function mountPwa<E extends Env>(app: Hono<E>, pwaDir: string, { publicOrigin }: MountPwaOptions): void {
  const articleCsp = frameCsp(publicOrigin);
  const files = serveStatic({ root: pwaDir, precompressed: true });
  const index = serveStatic({ root: pwaDir, path: "index.html", precompressed: true });

  const nothing = () => Promise.resolve();
  const handler: MiddlewareHandler = async (c, next) => {
    // Reserved paths never resolve to a PWA file or to the SPA fallback.
    if (isReservedPath(c.req.path)) return next();

    const method = c.req.method;
    const last = c.req.path.split("/").pop() ?? "";
    let res = await files(c, nothing);
    let name = last;
    // SPA fallback: client-side routes (no file extension in the last segment) get index.html.
    if (!res && (method === "GET" || method === "HEAD") && !last.includes(".")) {
      res = await index(c, nothing);
      name = "index.html";
    }
    if (!res) return next();

    res.headers.set("Cache-Control", c.req.path.startsWith("/app-assets/") ? immutable : revalidate);
    if (c.req.path === framePath) {
      res.headers.set("Content-Security-Policy", articleCsp);
      // The PWA links it as /frame.html?v=<content hash>; sandboxed iframes bypass the service worker,
      // so a versioned URL cached for long is what keeps articles viewable offline (ADR 0006).
      if (c.req.query("v")) res.headers.set("Cache-Control", immutable);
    }
    if (compressible.test(name) || name === "") res.headers.set("Vary", "Accept-Encoding");
    return res;
  };
  app.use("*", handler);
}
