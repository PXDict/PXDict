// Builds the gateway's Hono app: security headers, /healthz, PXDict's /app-api, the allowlisted wuDict
// proxy and the static PWA. Phase 3 mounts Better Auth under /app-api/auth and puts the proxy behind
// a session check.
import type { Health } from "@pxdict/shared";
import { Hono } from "hono";
import { pingDatabase, type Db } from "./db/client";
import { jsonError } from "./http/errors";
import { securityHeaders } from "./http/security";
import type { Logger } from "./log";
import { mountPwa } from "./static/pwa";
import type { DictAccess } from "./wudict/catalog";
import type { WudictClient } from "./wudict/client";
import { createWudictRoutes } from "./wudict/proxy";

export interface AppOptions {
  /** Reported by /healthz. */
  version: string;
  logger: Logger;
  db: Db;
  wudict: WudictClient;
  /** Which wuDict dictionaries requests may use. */
  access: DictAccess;
  /** Built PWA; omitted in tests that do not need it. */
  pwaDir?: string;
  /** Send HSTS (PUBLIC_URL is https). */
  hsts?: boolean;
}

/** Time allowed for wuDict to answer the health check. */
const healthTimeoutMs = 3_000;

export function createApp(opts: AppOptions): Hono {
  const { version, logger, db, wudict } = opts;
  const app = new Hono();

  app.use("*", securityHeaders({ hsts: opts.hsts ?? false }));

  app.get("/healthz", async (c) => {
    c.header("Cache-Control", "no-store");
    const wudictOk = await wudict
      .request({ path: "/api/config", headersTimeoutMs: healthTimeoutMs, signal: AbortSignal.timeout(healthTimeoutMs) })
      .then(async (res) => {
        await res.body?.cancel();
        return res.status === 200;
      })
      .catch(() => false);
    const checks: Health["checks"] = {
      wudict: wudictOk ? "ok" : "down",
      database: pingDatabase(db) ? "ok" : "down",
    };
    const ok = checks.wudict === "ok" && checks.database === "ok";
    if (!ok) logger.warn("health check failed", { checks });
    return c.json({ status: ok ? "ok" : "unavailable", version, checks } satisfies Health, ok ? 200 : 503);
  });

  app.all("/app-api/*", (c) => jsonError(c, 404, "not_found", "no such endpoint"));

  app.route("/", createWudictRoutes({ client: wudict, access: opts.access, logger }));

  if (opts.pwaDir) mountPwa(app, opts.pwaDir);

  // Missing PWA files and every wuDict path that is not allowlisted (/setup, /api/library, …) end here.
  app.notFound((c) => jsonError(c, 404, "not_found", "not found"));

  app.onError((err, c) => {
    logger.error("unhandled error", { method: c.req.method, path: c.req.path, err });
    return jsonError(c, 500, "internal", "internal server error");
  });

  return app;
}
