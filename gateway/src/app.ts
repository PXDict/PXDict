// Builds the gateway's Hono app. Phase 2 adds the wuDict proxy and the static PWA; Phase 3 mounts
// Better Auth under /app-api/auth.
import type { Health } from "@pxdict/shared";
import { Hono } from "hono";
import { jsonError } from "./http/errors";
import type { Logger } from "./log";

export interface AppOptions {
  /** Reported by /healthz. */
  version: string;
  logger: Logger;
}

export function createApp({ version, logger }: AppOptions): Hono {
  const app = new Hono();

  // Phase 2 adds the wuDict check; until then the gateway reports only itself.
  app.get("/healthz", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ status: "ok", version } satisfies Health);
  });

  app.all("/app-api/*", (c) => jsonError(c, 404, "not_found", "no such endpoint"));

  app.notFound((c) => jsonError(c, 404, "not_found", "not found"));

  app.onError((err, c) => {
    logger.error("unhandled error", { method: c.req.method, path: c.req.path, err });
    return jsonError(c, 500, "internal", "internal server error");
  });

  return app;
}
