// Builds the gateway's Hono app: security headers, /healthz, Better Auth under /app-api/auth, PXDict's
// /app-api, the allowlisted wuDict proxy (behind a session check) and the static PWA.
import { createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";
import type { Health } from "@pxdict/shared";
import { count, sql } from "drizzle-orm";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { authBasePath, clientIpHeader, type Auth } from "./auth/auth";
import { createGuards, type AuthEnv } from "./auth/guards";
import { createAuthRoutes } from "./auth/routes";
import type { Config } from "./config";
import { pingDatabase, type Db } from "./db/client";
import * as schema from "./db/schema";
import { clientIp } from "./http/client-ip";
import { jsonError } from "./http/errors";
import { Metrics, metricsContentType, routeGroup } from "./http/metrics";
import { originCheck } from "./http/origin";
import { securityHeaders } from "./http/security";
import type { Logger } from "./log";
import { mountPwa } from "./static/pwa";
import { DictPublisher } from "./dicts/publisher";
import { DictRegistry } from "./dicts/registry";
import { FavoritesStore } from "./favorites/favorites";
import { HistoryStore } from "./history/history";
import { createMeRoutes } from "./me/routes";
import { createProposalRoutes } from "./proposals/routes";
import { ProposalService } from "./proposals/service";
import { SettingsStore } from "./settings/settings";
import { StorageService } from "./storage/admin";
import { createStorageRoutes } from "./storage/routes";
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
  catalog: Pick<WudictCatalog, "snapshot" | "invalidate">;
  /** Free bytes on the data volume; replaced in tests. */
  freeBytes?: (dir: string) => Promise<number>;
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

/**
 * Largest request body on /app-api (JSON, and Better Auth's forms), so nobody, signed in or not, can make
 * the gateway buffer an arbitrary body. Big enough for the largest shared schema (a 500-item storage
 * plan). Proposal file chunks are streamed to disk with their own limits instead.
 */
export const maxJsonBodyBytes = 1024 * 1024;
const uploadChunkPattern = /^\/app-api\/proposals\/[0-9a-f]{24}\/files\/[0-9]{1,3}$/;

/** Time allowed for wuDict to answer the health check. */
const healthTimeoutMs = 3_000;

/** Long-lived services that background jobs (jobs.ts) share with the routes. */
export interface AppServices {
  proposals: ProposalService;
  publisher: DictPublisher;
  registry: DictRegistry;
  storage: StorageService;
  /** Requests in flight and the time the last one started (jobs.ts runs VACUUM only when idle). */
  activity: { inFlight: number; lastRequestAt: number };
  /** Set when METRICS is on. */
  metrics: Metrics | undefined;
}

/** Constant-time comparison of a bearer token (hashed first so lengths always match). */
function tokenMatches(given: string, expected: string): boolean {
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(given), h(expected));
}

export function createApp(opts: AppOptions): Hono<AuthEnv> & { services: AppServices } {
  const { version, config, logger, db, wudict, auth } = opts;
  const app = new Hono<AuthEnv>();
  const guards = createGuards(auth, { requireAdmin2fa: config.auth.requireAdmin2fa });

  const metrics = config.metrics.enabled ? new Metrics() : undefined;
  if (metrics) app.use("*", metrics.middleware());

  // Access log at debug level: the route group, never the path or query (they hold lookups).
  app.use("*", async (c, next) => {
    const start = performance.now();
    await next();
    logger.debug("request", {
      method: c.req.method,
      route: routeGroup(c.req.path),
      status: c.res.status,
      ms: Math.round(performance.now() - start),
    });
  });

  const activity = { inFlight: 0, lastRequestAt: Date.now() };
  app.use("*", async (_c, next) => {
    activity.inFlight++;
    activity.lastRequestAt = Date.now();
    try {
      await next();
    } finally {
      activity.inFlight--;
    }
  });
  app.use("*", securityHeaders({ hsts: config.publicUrl.protocol === "https:" }));

  const jsonBodyLimit: MiddlewareHandler = bodyLimit({
    maxSize: maxJsonBodyBytes,
    onError: (c) => jsonError(c, 413, "payload_too_large", "request body is too large"),
  });
  const limitBodies: MiddlewareHandler = (c, next) =>
    c.req.method === "PUT" && uploadChunkPattern.test(c.req.path) ? next() : jsonBodyLimit(c, next);
  app.use("/app-api/*", limitBodies);

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

  if (metrics) {
    const token = config.metrics.token;
    // A scraper presents METRICS_TOKEN; a person signs in as an admin.
    const metricsAccess: MiddlewareHandler<AuthEnv> = (c, next) => {
      const given = /^Bearer (.+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
      if (token && given !== undefined && tokenMatches(given, token)) return next();
      return guards.requireAdmin(c, next);
    };
    const total = (rows: { n: number }[]) => rows[0]?.n ?? 0;
    metrics.addGauge({
      name: "pxdict_users",
      help: "User accounts.",
      read: () => [{ labels: {}, value: total(db.select({ n: count() }).from(schema.user).all()) }],
    });
    metrics.addGauge({
      name: "pxdict_dictionaries",
      help: "Dictionaries in the gateway's catalogue.",
      read: () => [{ labels: {}, value: total(db.select({ n: count() }).from(schema.dictionaries).all()) }],
    });
    metrics.addGauge({
      name: "pxdict_proposals",
      help: "Dictionary proposals, by status.",
      read: () =>
        db
          .select({ status: schema.proposals.status, n: sql<number>`count(*)` })
          .from(schema.proposals)
          .groupBy(schema.proposals.status)
          .all()
          .map((r) => ({ labels: { status: r.status }, value: r.n })),
    });
    app.get("/metrics", metricsAccess, (c: Context) => {
      c.header("Cache-Control", "no-store");
      return c.body(metrics.render(), 200, { "Content-Type": metricsContentType });
    });
  }

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

  const registry = new DictRegistry({
    db,
    catalog: opts.catalog,
    logger,
    builtinVisibility: config.builtinDictVisibility,
    dbDir: path.join(config.dataDir, "db"),
  });
  const publisher = new DictPublisher({ db, client: wudict, catalog: opts.catalog, registry, dbDir: path.join(config.dataDir, "db"), logger });
  const proposals = new ProposalService({
    db,
    dataDir: config.dataDir,
    limits: {
      maxUploadBytes: config.maxUploadBytes,
      maxPendingProposalsPerUser: config.maxPendingProposalsPerUser,
      maxPendingBytes: config.maxPendingBytes,
      minFreeBytes: config.minFreeBytes,
    },
    logger,
    publisher,
    ...(opts.freeBytes ? { freeBytes: opts.freeBytes } : {}),
  });
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
      proposals,
    }),
  );
  app.route(
    "/",
    createProposalRoutes({ db, guards, publicOrigin: config.publicUrl.origin, logger, proposals, registry, publisher }),
  );

  const storage = new StorageService({
    db,
    dataDir: config.dataDir,
    client: wudict,
    catalog: opts.catalog,
    registry,
    publisher,
    proposals,
    logger,
  });
  app.route("/", createStorageRoutes({ db, storage }));

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

  return Object.assign(app, { services: { proposals, publisher, registry, storage, activity, metrics } });
}
