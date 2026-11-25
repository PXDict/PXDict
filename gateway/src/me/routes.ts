// The signed-in user's own data: /app-api/me (account summary) and /app-api/me/* (settings, search
// history, dictionary selection, favorites). Every query is scoped to the session's user id; nothing
// here takes a user id from the request.
import {
  DeleteFavoriteQuery,
  ExportQuery,
  HistoryQuery,
  SaveFavoriteRequest,
  UpdateMyDictsRequest,
  UpdateSettingsRequest,
  type FavoriteList,
  type HistoryEntry,
  type Me,
  type MyDict,
  type MyDictList,
  type UserSettings,
} from "@pxdict/shared";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { every } from "hono/combine";
import { hasAdminRole } from "../auth/auth";
import type { AuthEnv, Guards } from "../auth/guards";
import type { DictRegistry, UserDict } from "../dicts/registry";
import { maxFavoritesPerUser, type FavoritesStore } from "../favorites/favorites";
import type { HistoryStore } from "../history/history";
import { readJson, readQuery } from "../http/body";
import { jsonError } from "../http/errors";
import { originCheck } from "../http/origin";
import type { Logger } from "../log";
import type { ProposalService } from "../proposals/service";
import type { SettingsStore } from "../settings/settings";

export interface MeRoutesOptions {
  guards: Guards;
  publicOrigin: string;
  logger: Logger;
  registry: DictRegistry;
  settings: SettingsStore;
  history: HistoryStore;
  favorites: FavoritesStore;
  proposals: Pick<ProposalService, "unseenDecisions">;
}

const myDict = (u: UserDict): MyDict => ({
  id: u.dict.id,
  title: u.dict.title,
  format: u.dict.format,
  visibility: u.dict.visibility === "private" ? "private" : "global",
  enabled: u.enabled,
  position: u.position,
  isNew: u.isNew,
  available: u.dict.wudictId !== null,
  wudictId: u.dict.wudictId,
});

/**
 * One CSV field, always quoted. A leading =, +, -, @, tab or CR is prefixed with ' so spreadsheets do
 * not run it as a formula (lookups and notes are user input).
 */
export function csvField(v: string | number | null): string {
  let s = v === null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

const csv = (rows: (string | number | null)[][]) => rows.map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";

export function createMeRoutes(opts: MeRoutesOptions): Hono<AuthEnv> {
  const { guards, logger, registry, settings, history, favorites } = opts;
  const app = new Hono<AuthEnv>();
  // Every /app-api/me/* path, including unknown ones, needs a session. Hono's "/me/*" also matches
  // "/me" itself, which guards only its GET route (other methods stay a plain 404).
  const noStore: MiddlewareHandler = async (c, next) => {
    await next();
    if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
  };
  const protect: MiddlewareHandler<AuthEnv> = every(guards.requireUser, originCheck(opts.publicOrigin), noStore);
  const guardMe: MiddlewareHandler<AuthEnv> = (c, next) => (c.req.path === "/app-api/me" ? next() : protect(c, next));
  app.use("/app-api/me/*", guardMe);

  const uid = (c: Context<AuthEnv>) => c.get("session").user.id;

  /** Syncs the catalogue with wuDict when possible; the table's last state is used when wuDict is down. */
  const refresh = async () => {
    try {
      await registry.refresh();
    } catch (err) {
      logger.warn("dictionary list not refreshed", { err });
    }
  };

  const attachment = (c: Context, name: string, type: string, body: string) =>
    c.body(body, 200, {
      "Content-Type": type,
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    });

  const stamp = () => new Date().toISOString().slice(0, 10);

  app.get("/app-api/me", guards.requireUser, async (c) => {
    const { user, session } = c.get("session");
    await refresh();
    c.header("Cache-Control", "no-store");
    return c.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        emailVerified: user.emailVerified,
        username: user.username ?? null,
        displayUsername: user.displayUsername ?? null,
        image: user.image ?? null,
        role: hasAdminRole(user.role) ? "admin" : "user",
        twoFactorEnabled: user.twoFactorEnabled ?? false,
        createdAt: new Date(user.createdAt).toISOString(),
      },
      session: {
        id: session.id,
        expiresAt: new Date(session.expiresAt).toISOString(),
        impersonatedBy: session.impersonatedBy ?? null,
      },
      settings: settings.get(user.id),
      newDicts: registry
        .list(user.id)
        .filter((u) => u.isNew && u.dict.wudictId !== null)
        .map((u) => ({ id: u.dict.id, title: u.dict.title })),
      proposalUpdates: opts.proposals.unseenDecisions(user.id),
    } satisfies Me);
  });

  // Settings

  app.get("/app-api/me/settings", (c) => c.json(settings.get(uid(c)) satisfies UserSettings));

  app.put("/app-api/me/settings", async (c) => {
    const body = await readJson(c, UpdateSettingsRequest);
    if (!body) return jsonError(c, 400, "bad_request", "invalid settings");
    return c.json(settings.update(uid(c), body) satisfies UserSettings);
  });

  // Search history

  app.get("/app-api/me/history", (c) => {
    const q = readQuery(c, HistoryQuery);
    if (!q) return jsonError(c, 400, "bad_request", "invalid history query");
    return c.json(history.list(uid(c), { q: q.q, cursor: q.cursor, limit: q.limit, unique: q.unique === "1" }));
  });

  app.get("/app-api/me/history/export", (c) => {
    const q = readQuery(c, ExportQuery);
    if (!q) return jsonError(c, 400, "bad_request", "invalid export format");
    const entries: HistoryEntry[] = history.all(uid(c));
    if (q.format === "json") {
      return attachment(c, `pxdict-history-${stamp()}.json`, "application/json", JSON.stringify({ history: entries }, null, 2));
    }
    const rows = entries.map((e) => [e.createdAt, e.query, e.mode, e.dictIds?.join(" ") ?? null]);
    return attachment(c, `pxdict-history-${stamp()}.csv`, "text/csv; charset=utf-8", csv([["time", "query", "mode", "dictionaries"], ...rows]));
  });

  app.delete("/app-api/me/history/:id{[0-9]{1,15}}", (c) => {
    if (!history.delete(uid(c), Number(c.req.param("id")))) return jsonError(c, 404, "not_found", "no such history entry");
    return c.body(null, 204);
  });

  app.delete("/app-api/me/history", (c) => {
    history.clear(uid(c));
    return c.body(null, 204);
  });

  // Dictionary selection

  app.get("/app-api/me/dicts", async (c) => {
    await refresh();
    return c.json({ dicts: registry.list(uid(c)).map(myDict) } satisfies MyDictList);
  });

  app.put("/app-api/me/dicts", async (c) => {
    const body = await readJson(c, UpdateMyDictsRequest);
    if (!body) return jsonError(c, 400, "bad_request", "invalid dictionary list");
    if (!registry.update(uid(c), body.dicts)) return jsonError(c, 404, "unknown_dict", "a listed dictionary is not available to you");
    return c.json({ dicts: registry.list(uid(c)).map(myDict) } satisfies MyDictList);
  });

  app.post("/app-api/me/dicts/seen", (c) => {
    registry.markSeen(uid(c));
    return c.body(null, 204);
  });

  // Favorites

  const listFavorites = (user: string) => {
    const titles = new Map(registry.list(user).map((u) => [u.dict.id, u.dict.title]));
    return favorites.list(user, (id) => titles.get(id));
  };

  app.get("/app-api/me/favorites", (c) => c.json({ favorites: listFavorites(uid(c)) } satisfies FavoriteList));

  app.get("/app-api/me/favorites/export", (c) => {
    const q = readQuery(c, ExportQuery);
    if (!q) return jsonError(c, 400, "bad_request", "invalid export format");
    const list = listFavorites(uid(c));
    if (q.format === "json") {
      return attachment(c, `pxdict-favorites-${stamp()}.json`, "application/json", JSON.stringify({ favorites: list }, null, 2));
    }
    const rows = list.map((f) => [f.createdAt, f.headword, f.dictTitle ?? f.dictId, f.note]);
    return attachment(c, `pxdict-favorites-${stamp()}.csv`, "text/csv; charset=utf-8", csv([["saved", "headword", "dictionary", "note"], ...rows]));
  });

  app.post("/app-api/me/favorites", async (c) => {
    const body = await readJson(c, SaveFavoriteRequest);
    if (!body) return jsonError(c, 400, "bad_request", "invalid favorite");
    const user = uid(c);
    // Same answer for a dictionary that does not exist and one the user may not use.
    if (!registry.visible(user, body.dictId)) return jsonError(c, 404, "unknown_dict", "no such dictionary");
    const headword = body.headword.trim();
    if (!favorites.exists(user, headword, body.dictId) && favorites.count(user) >= maxFavoritesPerUser) {
      return jsonError(c, 409, "too_many_favorites", `at most ${String(maxFavoritesPerUser)} saved words`);
    }
    favorites.save(user, headword, body.dictId, body.note);
    return c.body(null, 204);
  });

  app.delete("/app-api/me/favorites", (c) => {
    const q = readQuery(c, DeleteFavoriteQuery);
    if (!q) return jsonError(c, 400, "bad_request", "invalid favorite");
    if (!favorites.delete(uid(c), q.headword.trim(), q.dict)) return jsonError(c, 404, "not_found", "no such favorite");
    return c.body(null, 204);
  });

  return app;
}
