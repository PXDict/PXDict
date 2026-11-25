// HTTP routes for dictionary proposals (shared/src/api/proposals.ts) and the admin dictionary catalogue
// (shared/src/api/admin-dicts.ts).
//
// Guards: /app-api/proposals/* gets requireUser + the origin check here. /app-api/me/* is guarded by
// me/routes.ts and /app-api/admin/* by auth/routes.ts (requireAdmin + origin check); Hono applies a
// sub-app's middleware to every route mounted after it under the same pattern, and
// proposals/routes.test.ts checks those boundaries.
import {
  AdminProposalQuery,
  ApproveProposalRequest,
  CreateProposalRequest,
  RejectProposalRequest,
  UpdateAdminDictRequest,
  type AdminDict,
  type AdminDictList,
  type AdminProposalList,
  type ChunkResponse,
  type ProposalList,
  type UploadLimits,
} from "@pxdict/shared";
import { inArray } from "drizzle-orm";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { every } from "hono/combine";
import { recordAudit } from "../audit/audit";
import type { AuthEnv, Guards } from "../auth/guards";
import type { Db } from "../db/client";
import { user } from "../db/schema";
import type { DictPublisher } from "../dicts/publisher";
import type { DictionaryRow, DictRegistry } from "../dicts/registry";
import { readJson, readQuery } from "../http/body";
import { jsonError } from "../http/errors";
import { originCheck } from "../http/origin";
import type { Logger } from "../log";
import { ProposalError, type ProposalService } from "./service";

export interface ProposalRoutesOptions {
  db: Db;
  guards: Guards;
  publicOrigin: string;
  logger: Logger;
  proposals: ProposalService;
  registry: DictRegistry;
  publisher: DictPublisher;
}

const idPattern = "{[0-9a-f]{24}}";

export function createProposalRoutes(opts: ProposalRoutesOptions): Hono<AuthEnv> {
  const { db, guards, logger, proposals, registry, publisher } = opts;
  const app = new Hono<AuthEnv>();
  const noStore: MiddlewareHandler = async (c, next) => {
    await next();
    if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
  };
  const protect = every(guards.requireUser, originCheck(opts.publicOrigin), noStore);
  app.use("/app-api/proposals", protect);
  app.use("/app-api/proposals/*", protect);
  app.use("/app-api/admin/proposals/*", noStore);
  app.use("/app-api/admin/dicts/*", noStore);

  const uid = (c: Context<AuthEnv>) => c.get("session").user.id;

  /** Runs `fn`, mapping ProposalError to the error shape. */
  const handle = async (c: Context<AuthEnv>, fn: () => Promise<Response> | Response): Promise<Response> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ProposalError) return jsonError(c, err.status, err.code, err.message);
      throw err;
    }
  };

  // The proposer

  app.get("/app-api/proposals/limits", (c) => c.json(proposals.uploadLimits() satisfies UploadLimits));

  app.post("/app-api/proposals", (c) =>
    handle(c, async () => {
      const body = await readJson(c, CreateProposalRequest);
      if (!body) return jsonError(c, 400, "bad_request", "invalid proposal");
      return c.json(await proposals.create(uid(c), body), 201);
    }),
  );

  app.put(`/app-api/proposals/:id${idPattern}/files/:index{[0-9]{1,3}}`, (c) =>
    handle(c, async () => {
      const raw = c.req.header("Upload-Offset");
      if (!raw || !/^\d{1,15}$/.test(raw)) {
        await c.req.raw.body?.cancel();
        return jsonError(c, 400, "bad_request", "send the Upload-Offset header");
      }
      const result = await proposals.writeChunk(uid(c), c.req.param("id"), Number(c.req.param("index")), Number(raw), c.req.raw.body);
      return c.json(result satisfies ChunkResponse);
    }),
  );

  app.post(`/app-api/proposals/:id${idPattern}/submit`, (c) =>
    handle(c, async () => c.json(await proposals.submit(uid(c), c.req.param("id")))),
  );

  app.get(`/app-api/proposals/:id${idPattern}`, (c) => handle(c, () => c.json(proposals.getForUser(uid(c), c.req.param("id")))));

  app.delete(`/app-api/proposals/:id${idPattern}`, (c) =>
    handle(c, async () => {
      await proposals.withdraw(uid(c), c.req.param("id"));
      return c.body(null, 204);
    }),
  );

  app.get("/app-api/me/proposals", (c) => c.json({ proposals: proposals.listForUser(uid(c)) } satisfies ProposalList));

  app.post("/app-api/me/proposals/seen", (c) => {
    proposals.markDecisionsSeen(uid(c));
    return c.body(null, 204);
  });

  // Admins: proposals

  app.get("/app-api/admin/proposals", (c) => {
    const q = readQuery(c, AdminProposalQuery);
    if (!q) return jsonError(c, 400, "bad_request", "invalid status");
    c.header("Cache-Control", "no-store");
    return c.json({ proposals: proposals.listAdmin(q.status) } satisfies AdminProposalList);
  });

  app.get(`/app-api/admin/proposals/:id${idPattern}`, (c) => handle(c, () => c.json(proposals.getAdmin(c.req.param("id")))));

  app.post(`/app-api/admin/proposals/:id${idPattern}/approve`, (c) =>
    handle(c, async () => {
      const body = await readJson(c, ApproveProposalRequest);
      if (!body) return jsonError(c, 400, "bad_request", "invalid approval");
      const result = await proposals.approve(uid(c), c.req.param("id"), body);
      return c.json(result, 202);
    }),
  );

  app.post(`/app-api/admin/proposals/:id${idPattern}/reject`, (c) =>
    handle(c, async () => {
      const body = await readJson(c, RejectProposalRequest);
      if (!body) return jsonError(c, 400, "bad_request", "give a reason");
      return c.json(await proposals.reject(uid(c), c.req.param("id"), body.note));
    }),
  );

  // Admins: dictionaries

  const adminDicts = (rows: DictionaryRow[]): AdminDict[] => {
    const owners = [...new Set(rows.map((r) => r.ownerUserId).filter((o) => o !== null))];
    const names = new Map(
      owners.length ? db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, owners)).all().map((u) => [u.id, u.name]) : [],
    );
    return rows.map((d) => ({
      id: d.id,
      title: d.title,
      format: d.format,
      source: d.source,
      visibility: d.visibility,
      owner: d.ownerUserId ? { id: d.ownerUserId, name: names.get(d.ownerUserId) ?? null } : null,
      trustedRender: d.trustedRender,
      available: d.wudictId !== null,
      wudictId: d.wudictId,
      indexed: d.libraryDir !== null,
      proposalId: d.proposalId,
      index: publisher.status(d.id),
      createdAt: d.createdAt.toISOString(),
    }));
  };

  const refresh = async () => {
    try {
      await registry.refresh();
    } catch (err) {
      logger.warn("dictionary list not refreshed", { err });
    }
  };

  app.get("/app-api/admin/dicts", async (c) => {
    await refresh();
    c.header("Cache-Control", "no-store");
    return c.json({ dicts: adminDicts(registry.all()) } satisfies AdminDictList);
  });

  app.post("/app-api/admin/dicts/rescan", async (c) => {
    try {
      await publisher.rescan();
    } catch (err) {
      logger.error("rescan failed", { err });
      return jsonError(c, 502, "wudict_unavailable", "the dictionary server could not rescan");
    }
    recordAudit(db, { actorUserId: uid(c), action: "dict.rescan" });
    c.header("Cache-Control", "no-store");
    return c.json({ dicts: adminDicts(registry.all()) } satisfies AdminDictList);
  });

  app.patch("/app-api/admin/dicts/:id", async (c) => {
    const body = await readJson(c, UpdateAdminDictRequest);
    if (!body) return jsonError(c, 400, "bad_request", "invalid change");
    if (body.ownerUserId && !db.select({ id: user.id }).from(user).where(inArray(user.id, [body.ownerUserId])).get()) {
      return jsonError(c, 404, "unknown_user", "no such user");
    }
    const id = c.req.param("id");
    const before = registry.get(id);
    const row = registry.updateDict(id, body);
    if (row === undefined) return jsonError(c, 404, "not_found", "no such dictionary");
    if (row === "owner_required") return jsonError(c, 400, "owner_required", "a private dictionary needs an owner");
    recordAudit(db, {
      actorUserId: uid(c),
      action: "dict.update",
      targetType: "dictionary",
      targetId: id,
      details: { before: before && { title: before.title, visibility: before.visibility, trustedRender: before.trustedRender }, change: body },
    });
    const [dto] = adminDicts([row]);
    return c.json(dto);
  });

  app.get("/app-api/admin/dicts/:id/index-status", (c) => {
    const id = c.req.param("id");
    if (!registry.get(id)) return jsonError(c, 404, "not_found", "no such dictionary");
    return c.json(publisher.status(id));
  });

  /** Runs indexing again (e.g. after an error); a dictionary still hidden since its approval is published afterwards. */
  app.post("/app-api/admin/dicts/:id/index", (c) => {
    const id = c.req.param("id");
    const row = registry.get(id);
    if (!row) return jsonError(c, 404, "not_found", "no such dictionary");
    const target = row.visibility === "hidden" && row.libraryDir === null ? proposals.publishTargetOf(id) : undefined;
    void publisher.publish(id, target);
    recordAudit(db, { actorUserId: uid(c), action: "dict.index", targetType: "dictionary", targetId: id });
    return c.json(publisher.status(id), 202);
  });

  return app;
}
