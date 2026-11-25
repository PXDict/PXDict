// Search history (search_history): written by the /api/search proxy, read and deleted by the user,
// trimmed by a periodic job (retention per user, and a cap per user).
import type { HistoryEntry, HistoryPage } from "@pxdict/shared";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { searchHistory } from "../db/schema";

/** Identical consecutive lookups within this window are one entry (the time moves forward). */
export const mergeWindowMs = 60_000;

/** Entries kept per user at most, whatever the retention. */
export const maxEntriesPerUser = 10_000;

const day = 24 * 60 * 60 * 1000;

export interface Lookup {
  query: string;
  mode: string;
  /** PXDict ids the lookup was restricted to; null for the user's enabled set. */
  dictIds: string[] | null;
}

export interface ListOptions {
  q?: string | undefined;
  cursor?: number | undefined;
  limit: number;
  unique?: boolean | undefined;
}

type Row = typeof searchHistory.$inferSelect;

const toEntry = (r: Row): HistoryEntry => ({
  id: r.id,
  query: r.query,
  mode: r.mode,
  dictIds: r.dictIdsJson ?? null,
  createdAt: r.createdAt.toISOString(),
});

/** LIKE pattern for "contains", with the user's %, _ and \ taken literally. */
const containsPattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export class HistoryStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a lookup, merging it into the previous entry when it repeats within a minute. */
  record(userId: string, lookup: Lookup): void {
    const now = new Date(this.now());
    const dicts = lookup.dictIds?.length ? lookup.dictIds : null;
    this.db.transaction((tx) => {
      const last = tx
        .select()
        .from(searchHistory)
        .where(eq(searchHistory.userId, userId))
        .orderBy(desc(searchHistory.createdAt), desc(searchHistory.id))
        .limit(1)
        .get();
      const same =
        last &&
        last.query === lookup.query &&
        last.mode === lookup.mode &&
        JSON.stringify(last.dictIdsJson ?? null) === JSON.stringify(dicts) &&
        now.getTime() - last.createdAt.getTime() < mergeWindowMs;
      if (same) {
        tx.update(searchHistory).set({ createdAt: now }).where(eq(searchHistory.id, last.id)).run();
      } else {
        tx.insert(searchHistory)
          .values({ userId, query: lookup.query, mode: lookup.mode, dictIdsJson: dicts, createdAt: now })
          .run();
      }
    });
  }

  /** Newest first. The cursor is the id of the last entry of the previous page. */
  list(userId: string, opts: ListOptions): HistoryPage {
    const filters = [eq(searchHistory.userId, userId)];
    if (opts.q?.trim()) filters.push(sql`${searchHistory.query} LIKE ${containsPattern(opts.q.trim())} ESCAPE '\\'`);
    if (opts.unique) {
      // One entry per query: its newest lookup.
      const newest = this.db
        .select({ id: sql<number>`max(${searchHistory.id})` })
        .from(searchHistory)
        .where(and(...filters))
        .groupBy(searchHistory.query);
      filters.push(inArray(searchHistory.id, newest));
    }
    if (opts.cursor) filters.push(lt(searchHistory.id, opts.cursor));
    const rows = this.db
      .select()
      .from(searchHistory)
      .where(and(...filters))
      .orderBy(desc(searchHistory.id))
      .limit(opts.limit + 1)
      .all();
    return this.#page(rows, opts.limit);
  }

  #page(rows: Row[], limit: number): HistoryPage {
    const more = rows.length > limit;
    const entries = rows.slice(0, limit).map(toEntry);
    return { entries, nextCursor: more ? (entries.at(-1)?.id ?? null) : null };
  }

  /** Every entry, newest first (export). */
  all(userId: string): HistoryEntry[] {
    return this.db
      .select()
      .from(searchHistory)
      .where(eq(searchHistory.userId, userId))
      .orderBy(desc(searchHistory.id))
      .all()
      .map(toEntry);
  }

  /** Deletes one entry of `userId`; false when there is none. */
  delete(userId: string, id: number): boolean {
    const res = this.db
      .delete(searchHistory)
      .where(and(eq(searchHistory.userId, userId), eq(searchHistory.id, id)))
      .run();
    return res.changes > 0;
  }

  /** Deletes every entry of `userId`; returns how many. */
  clear(userId: string): number {
    return this.db.delete(searchHistory).where(eq(searchHistory.userId, userId)).run().changes;
  }

  /**
   * Deletes entries past each user's retention (`defaultRetentionDays` for users without settings;
   * 0 = forever) and beyond the newest `maxEntriesPerUser` of each user. Returns how many.
   */
  cleanup(defaultRetentionDays: number): number {
    const now = this.now();
    const client = this.db.$client;
    const expired = client
      .prepare(
        `DELETE FROM search_history WHERE id IN (
           SELECT h.id FROM search_history h LEFT JOIN user_settings s ON s.user_id = h.user_id
           WHERE COALESCE(s.history_retention_days, @def) > 0
             AND h.created_at < @now - COALESCE(s.history_retention_days, @def) * @day)`,
      )
      .run({ def: defaultRetentionDays, now, day }).changes;
    const capped = client
      .prepare(
        `DELETE FROM search_history WHERE id IN (
           SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY id DESC) AS n FROM search_history)
           WHERE n > @max)`,
      )
      .run({ max: maxEntriesPerUser }).changes;
    return expired + capped;
  }
}
