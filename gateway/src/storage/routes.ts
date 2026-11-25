// Admin routes for storage administration (shared/src/api/admin-storage.ts) and the audit log.
// /app-api/admin/* is guarded by auth/routes.ts (requireAdmin + origin check).
import {
  AuditQuery,
  StorageExecuteRequest,
  StoragePlanRequest,
  type AuditEntry,
  type AuditPage,
  type StorageExecuteResult,
  type StorageOverview,
  type StoragePlan,
} from "@pxdict/shared";
import { and, desc, eq, inArray, lt, sql, type SQL } from "drizzle-orm";
import { Hono, type Context } from "hono";
import type { AuthEnv } from "../auth/guards";
import type { Db } from "../db/client";
import { auditLog, user } from "../db/schema";
import { readJson, readQuery } from "../http/body";
import { jsonError } from "../http/errors";
import { StorageError, type StorageService } from "./admin";

export interface StorageRoutesOptions {
  db: Db;
  storage: StorageService;
}

export function createStorageRoutes({ db, storage }: StorageRoutesOptions): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  const noStore = (c: Context) => {
    c.header("Cache-Control", "no-store");
  };
  const uid = (c: Context<AuthEnv>) => c.get("session").user.id;

  app.get("/app-api/admin/storage", async (c) => {
    noStore(c);
    return c.json((await storage.overview()) satisfies StorageOverview);
  });

  app.post("/app-api/admin/storage/plan", async (c) => {
    noStore(c);
    const body = await readJson(c, StoragePlanRequest);
    if (!body) return jsonError(c, 400, "bad_request", "list the items to delete");
    return c.json((await storage.plan(uid(c), body.items)) satisfies StoragePlan);
  });

  app.post("/app-api/admin/storage/execute", async (c) => {
    noStore(c);
    const body = await readJson(c, StorageExecuteRequest);
    if (!body) return jsonError(c, 400, "bad_request", "give the plan id");
    try {
      return c.json((await storage.execute(uid(c), body.planId)) satisfies StorageExecuteResult);
    } catch (err) {
      if (err instanceof StorageError) return jsonError(c, err.status, err.code, err.message);
      throw err;
    }
  });

  app.get("/app-api/admin/audit", (c) => {
    noStore(c);
    const q = readQuery(c, AuditQuery);
    if (!q) return jsonError(c, 400, "bad_request", "invalid query");
    const conds: SQL[] = [];
    if (q.cursor) conds.push(lt(auditLog.id, q.cursor));
    if (q.action) {
      // A prefix ending in "." matches by substring, so LIKE wildcards in it mean nothing.
      conds.push(
        q.action.endsWith(".")
          ? sql`substr(${auditLog.action}, 1, ${q.action.length}) = ${q.action}`
          : eq(auditLog.action, q.action),
      );
    }
    const rows = db
      .select()
      .from(auditLog)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(auditLog.id))
      .limit(q.limit + 1)
      .all();
    const page = rows.slice(0, q.limit);
    const actors = [...new Set(page.map((r) => r.actorUserId).filter((a) => a !== null))];
    const names = new Map(
      actors.length ? db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, actors)).all().map((u) => [u.id, u.name]) : [],
    );
    const entries = page.map(
      (r): AuditEntry => ({
        id: r.id,
        actor: r.actorUserId ? { id: r.actorUserId, name: names.get(r.actorUserId) ?? null } : null,
        action: r.action,
        targetType: r.targetType,
        targetId: r.targetId,
        details: r.detailsJson ?? null,
        bytesFreed: r.bytesFreed,
        createdAt: r.createdAt.toISOString(),
      }),
    );
    const last = page.at(-1);
    return c.json({ entries, nextCursor: rows.length > q.limit && last ? last.id : null } satisfies AuditPage);
  });

  return app;
}
