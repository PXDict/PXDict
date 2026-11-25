// Builds the gateway's Hono app: security headers, /healthz, Better Auth under /app-api/auth, PXDict's
// /app-api, the allowlisted wuDict proxy (behind a session check) and the static PWA.
import type { Health } from "@pxdict/shared";
import { Hono, type MiddlewareHandler } from "hono";
import { authBasePath, clientIpHeader, type Auth } from "./auth/auth";
import { createGuards, type AuthEnv } from "./auth/guards";
import { createAuthRoutes } from "./auth/routes";
import type { Config } from "./config";
import { pingDatabase, type Db } from "./db/client";
import { clientIp } from "./http/client-ip";
import { jsonError } from "./http/errors";
import { originCheck } from "./http/origin";
import { securityHeaders } from "./http/security";
import type { Logger } from "./log";
import { mountPwa } from "./static/pwa";
import { DictRegistry } from "./dicts/registry";
import { FavoritesStore } from "./favorites/favorites";
import { HistoryStore } from "./history/history";
import { createMeRoutes } from "./me/routes";
import { SettingsStore } from "./settings/settings";
import type { WudictCatalog } from "./wudict/catalog";
import type { WudictClient } from "./wudict/client";
import { createWudictRoutes } from "./wudict/proxy";
import { ResourceSigner } from "./wudict/signed-url";

export interface AppOptions {
  /** Reported by /healthz. */
  version: string;
  config: Config;
  logger: Logger;
  db: Db;
  auth: Auth;
  /** Email-based sign-in methods are offered (a mailer is configured). */
  emailEnabled: boolean;
  wudict: WudictClient;
  /** wuDict's dictionary list, reconciled with the gateway's catalogue (dicts/registry.ts). */
  catalog: Pick<WudictCatalog, "snapshot">;
  /** Built PWA; omitted in tests that do not need it. */
  pwaDir?: string;
}

/**
 * OAuth/OIDC callbacks: providers may POST them cross-site (Apple, response_mode=form_post); they are
 * protected by the state parameter and its cookie instead of the origin check.
 */
const oauthCallbackPattern = new RegExp(`^${authBasePath}/callback/[^/]+$`);

/** Better Auth admin endpoints that a non-admin may call: ending an impersonation. */
const authAdminExceptions = new Set([`${authBasePath}/admin/stop-impersonating`]);

/** Time allowed for wuDict to answer the health check. */
const healthTimeoutMs = 3_000;

export function createApp(opts: AppOptions): Hono<AuthEnv> {
  const { version, config, logger, db, wudict, auth } = opts;
  const app = new Hono<AuthEnv>();
  const guards = createGuards(auth, { requireAdmin2fa: config.auth.requireAdmin2fa });

  app.use("*", securityHeaders({ hsts: config.publicUrl.protocol === "https:" }));

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

  app.route("/", createAuthRoutes({ config, db, guards, emailEnabled: opts.emailEnabled }));

  // Better Auth checks Origin only on requests that carry cookies; PXDict checks every state-changing
  // request (AGENTS.md §6), which also stops login CSRF.
  const sameOrigin = originCheck(config.publicUrl.origin);
  const authOriginCheck: MiddlewareHandler<AuthEnv> = (c, next) =>
    oauthCallbackPattern.test(c.req.path) ? next() : sameOrigin(c, next);
  app.use(`${authBasePath}/*`, authOriginCheck);
  // Better Auth's admin endpoints get the same admin check as PXDict's (fresh session, 2FA policy).
  const authAdminCheck: MiddlewareHandler<AuthEnv> = (c, next) =>
    authAdminExceptions.has(c.req.path) ? next() : guards.requireAdmin(c, next);
  app.use(`${authBasePath}/admin/*`, authAdminCheck);
  app.on(["GET", "POST"], `${authBasePath}/*`, (c) => {
    // Better Auth reads the client address from this header only; never trust an incoming copy.
    const headers = new Headers(c.req.raw.headers);
    headers.delete(clientIpHeader);
    const ip = clientIp(c, config.auth.clientIpHeader);
    if (ip) headers.set(clientIpHeader, ip);
    return auth.handler(new Request(c.req.raw, { headers }));
  });

  const registry = new DictRegistry({ db, catalog: opts.catalog, logger, builtinVisibility: config.builtinDictVisibility });
  const settings = new SettingsStore(db, config.historyDefaultRetentionDays);
  const history = new HistoryStore(db);
  app.route(
    "/",
    createMeRoutes({
      guards,
      publicOrigin: config.publicUrl.origin,
      logger,
      registry,
      settings,
      history,
      favorites: new FavoritesStore(db),
    }),
  );

  app.all("/app-api/*", (c) => jsonError(c, 404, "not_found", "no such endpoint"));

  const signer = new ResourceSigner(config.auth.secret);
  app.route(
    "/",
    createWudictRoutes({
      client: wudict,
      access: registry,
      logger,
      guard: guards.requireUser,
      signer,
      onSearch: (userId, lookup) => {
        if (settings.get(userId).historyEnabled) history.record(userId, lookup);
      },
    }),
  );

  if (opts.pwaDir) mountPwa(app, opts.pwaDir, { publicOrigin: config.publicUrl.origin });

  // Missing PWA files and every wuDict path that is not allowlisted (/setup, /api/library, …) end here.
  app.notFound((c) => jsonError(c, 404, "not_found", "not found"));

  app.onError((err, c) => {
    logger.error("unhandled error", { method: c.req.method, path: c.req.path, err });
    return jsonError(c, 500, "internal", "internal server error");
  });

  return app;
}
