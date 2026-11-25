// The gateway's dictionary catalogue (docs/PLAN.md Phase 5, ADR 0007).
//
// wuDict's ids are path hashes that change when files move or originals are deleted, so PXDict keys
// dictionaries on its own id (`dictionaries.id`). Every time wuDict's listing changes, `sync` matches
// each listed dictionary to a row by wuDict id, then library folder, then source path, refreshes the
// row's `wudict_id`, and creates a row for anything new (source 'builtin'). Rows wuDict no longer lists
// keep their data and users' choices but lose their `wudict_id`, so nobody can search them until they
// come back.
//
// Per user, `user_dicts` holds the order and the enabled flags. It is filled in lazily: a dictionary
// the user may use but has no row for is appended, enabled (and flagged new unless this is the user's
// first visit), so newly published global dictionaries reach every user without a bulk insert.
import { and, eq, inArray, or } from "drizzle-orm";
import type { Db } from "../db/client";
import { dictionaries, userDicts } from "../db/schema";
import type { Logger } from "../log";
import type { CatalogSnapshot, DictAccess, UserDictView, UsableDict, WudictCatalog } from "../wudict/catalog";

export type DictionaryRow = typeof dictionaries.$inferSelect;

/** One dictionary as one user sees it, in the user's order. */
export interface UserDict {
  dict: DictionaryRow;
  enabled: boolean;
  position: number;
  isNew: boolean;
}

export interface DictRegistryOptions {
  db: Db;
  catalog: Pick<WudictCatalog, "snapshot">;
  logger: Logger;
  /** Visibility of a dictionary found in DICT_DIR without a proposal. */
  builtinVisibility: "global" | "hidden";
}

/** PXDict ids: lower-case letters, digits and "-" (shared DictId). */
const maxIdLength = 48;

/** A readable id from a title: "Oxford EN–VI" → "oxford-en-vi". */
export function slugify(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxIdLength)
    .replace(/-+$/, "");
  return slug || "dict";
}

export class DictRegistry implements DictAccess {
  readonly #db: Db;
  readonly #catalog: Pick<WudictCatalog, "snapshot">;
  readonly #logger: Logger;
  readonly #builtinVisibility: "global" | "hidden";
  #syncedVersion: number | undefined;

  constructor(opts: DictRegistryOptions) {
    this.#db = opts.db;
    this.#catalog = opts.catalog;
    this.#logger = opts.logger;
    this.#builtinVisibility = opts.builtinVisibility;
  }

  /** Brings the table up to date with wuDict's listing (cheap when nothing changed). Throws when wuDict cannot be asked. */
  async refresh(): Promise<void> {
    const snap = await this.#catalog.snapshot();
    if (snap.version !== this.#syncedVersion) {
      this.sync(snap);
      this.#syncedVersion = snap.version;
    }
  }

  /** Reconciles the `dictionaries` table with one listing. */
  sync(snap: CatalogSnapshot): void {
    const db = this.#db;
    db.transaction((tx) => {
      const rows = tx.select().from(dictionaries).all();
      const claimed = new Set<string>();
      const usedIds = new Set(rows.map((r) => r.id));
      const find = (pred: (r: DictionaryRow) => boolean) => rows.find((r) => !claimed.has(r.id) && pred(r));

      for (const w of snap.rows) {
        const match =
          find((r) => r.wudictId === w.id) ??
          (w.libraryDir ? find((r) => r.libraryDir === w.libraryDir) : undefined) ??
          (w.sourcePath ? find((r) => r.sourcePath === w.sourcePath) : undefined);
        if (match) {
          claimed.add(match.id);
          const changes: Partial<DictionaryRow> = {};
          if (match.wudictId !== w.id) changes.wudictId = w.id;
          if (w.libraryDir && match.libraryDir !== w.libraryDir) changes.libraryDir = w.libraryDir;
          if (w.sourcePath && match.sourcePath !== w.sourcePath) changes.sourcePath = w.sourcePath;
          if (w.format && match.format !== w.format) changes.format = w.format;
          if (Object.keys(changes).length) {
            tx.update(dictionaries)
              .set({ ...changes, updatedAt: new Date() })
              .where(eq(dictionaries.id, match.id))
              .run();
          }
          continue;
        }
        const id = uniqueId(slugify(w.name), usedIds);
        usedIds.add(id);
        claimed.add(id);
        tx.insert(dictionaries)
          .values({
            id,
            wudictId: w.id,
            libraryDir: w.libraryDir ?? null,
            sourcePath: w.sourcePath ?? null,
            title: w.name,
            format: w.format ?? null,
            source: "builtin",
            visibility: this.#builtinVisibility,
          })
          .run();
        this.#logger.info("dictionary found", { dictId: id, wudictId: w.id, visibility: this.#builtinVisibility });
      }

      // No longer listed: unavailable until wuDict lists it again.
      const gone = rows.filter((r) => !claimed.has(r.id) && r.wudictId !== null).map((r) => r.id);
      if (gone.length) {
        tx.update(dictionaries)
          .set({ wudictId: null, updatedAt: new Date() })
          .where(inArray(dictionaries.id, gone))
          .run();
        this.#logger.info("dictionaries no longer listed by wuDict", { dictIds: gone });
      }
    });
  }

  /** Dictionaries `userId` may use (global + their own private ones), in their order. Fills in missing rows. */
  list(userId: string): UserDict[] {
    const db = this.#db;
    return db.transaction((tx) => {
      const visible = tx
        .select()
        .from(dictionaries)
        .where(
          or(
            eq(dictionaries.visibility, "global"),
            and(eq(dictionaries.visibility, "private"), eq(dictionaries.ownerUserId, userId)),
          ),
        )
        .all();
      const chosen = tx.select().from(userDicts).where(eq(userDicts.userId, userId)).all();
      const byDict = new Map(chosen.map((c) => [c.dictId, c]));

      const missing = visible
        .filter((d) => !byDict.has(d.id))
        .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
      if (missing.length) {
        const firstVisit = chosen.length === 0;
        let next = chosen.reduce((max, c) => Math.max(max, c.position), -1) + 1;
        for (const d of missing) {
          const row = { userId, dictId: d.id, enabled: true, position: next++, isNew: !firstVisit, createdAt: new Date() };
          tx.insert(userDicts).values(row).onConflictDoNothing().run();
          byDict.set(d.id, row);
        }
      }

      return visible
        .map((dict) => {
          const c = byDict.get(dict.id);
          return { dict, enabled: c?.enabled ?? true, position: c?.position ?? 0, isNew: c?.isNew ?? false };
        })
        .sort((a, b) => a.position - b.position || a.dict.id.localeCompare(b.dict.id))
        .map((u, i) => ({ ...u, position: i }));
    });
  }

  /** The same list, keyed for the proxy; only dictionaries wuDict lists now. */
  async forUser(userId: string): Promise<UserDictView> {
    await this.refresh();
    const usable = new Map<string, UsableDict>();
    const enabled: string[] = [];
    for (const u of this.list(userId)) {
      const w = u.dict.wudictId;
      if (!w || usable.has(w)) continue;
      usable.set(w, { dictId: u.dict.id, title: u.dict.title, enabled: u.enabled, trusted: u.dict.trustedRender });
      if (u.enabled) enabled.push(w);
    }
    return { usable, enabled };
  }

  /**
   * Saves a new order and enabled flags: `order` first, then the remaining dictionaries in their old
   * order. Answers false (and changes nothing) when an id is not one the user may use.
   */
  update(userId: string, order: readonly { id: string; enabled: boolean }[]): boolean {
    const current = this.list(userId);
    const known = new Set(current.map((u) => u.dict.id));
    if (order.some((o) => !known.has(o.id))) return false;
    const listed = new Set(order.map((o) => o.id));
    const final = [
      ...order,
      ...current.filter((u) => !listed.has(u.dict.id)).map((u) => ({ id: u.dict.id, enabled: u.enabled })),
    ];
    this.#db.transaction((tx) => {
      final.forEach((o, position) => {
        tx.update(userDicts)
          .set({ enabled: o.enabled, position, isNew: false })
          .where(and(eq(userDicts.userId, userId), eq(userDicts.dictId, o.id)))
          .run();
      });
    });
    return true;
  }

  /** Acknowledges every new dictionary of `userId`. */
  markSeen(userId: string): void {
    this.#db
      .update(userDicts)
      .set({ isNew: false })
      .where(and(eq(userDicts.userId, userId), eq(userDicts.isNew, true)))
      .run();
  }

  /** A dictionary `userId` may use, by PXDict id. */
  visible(userId: string, dictId: string): DictionaryRow | undefined {
    return this.#db
      .select()
      .from(dictionaries)
      .where(
        and(
          eq(dictionaries.id, dictId),
          or(
            eq(dictionaries.visibility, "global"),
            and(eq(dictionaries.visibility, "private"), eq(dictionaries.ownerUserId, userId)),
          ),
        ),
      )
      .get();
  }
}

function uniqueId(base: string, used: ReadonlySet<string>): string {
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${String(n)}`;
    const id = base.slice(0, maxIdLength - suffix.length).replace(/-+$/, "") + suffix;
    if (!used.has(id)) return id;
  }
}
