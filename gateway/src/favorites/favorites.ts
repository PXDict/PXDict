// Saved words (favorites), one per (user, headword, dictionary).
import type { Favorite } from "@pxdict/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { favorites } from "../db/schema";

/** Saved words per user at most. */
export const maxFavoritesPerUser = 10_000;

export class FavoritesStore {
  constructor(private readonly db: Db) {}

  /**
   * Newest first. `visibleTitle` gives the title of a dictionary the user may use, or undefined: the
   * title of any other dictionary is not revealed.
   */
  list(userId: string, visibleTitle: (dictId: string) => string | undefined): Favorite[] {
    return this.db
      .select()
      .from(favorites)
      .where(eq(favorites.userId, userId))
      .orderBy(desc(favorites.createdAt), favorites.headword)
      .all()
      .map((f) => ({
        headword: f.headword,
        dictId: f.dictId,
        dictTitle: visibleTitle(f.dictId) ?? null,
        note: f.note,
        createdAt: f.createdAt.toISOString(),
        updatedAt: f.updatedAt.toISOString(),
      }));
  }

  count(userId: string): number {
    return this.db.select({ n: sql<number>`count(*)` }).from(favorites).where(eq(favorites.userId, userId)).get()?.n ?? 0;
  }

  exists(userId: string, headword: string, dictId: string): boolean {
    return (
      this.db
        .select({ h: favorites.headword })
        .from(favorites)
        .where(and(eq(favorites.userId, userId), eq(favorites.headword, headword), eq(favorites.dictId, dictId)))
        .get() !== undefined
    );
  }

  /** Saves a word; an existing one keeps its date and gets the new note when one is given. */
  save(userId: string, headword: string, dictId: string, note: string | null | undefined): void {
    const now = new Date();
    const clean = note?.trim() ? note.trim() : null;
    this.db
      .insert(favorites)
      .values({ userId, headword, dictId, note: clean, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [favorites.userId, favorites.headword, favorites.dictId],
        set: note === undefined ? { updatedAt: now } : { note: clean, updatedAt: now },
      })
      .run();
  }

  delete(userId: string, headword: string, dictId: string): boolean {
    return (
      this.db
        .delete(favorites)
        .where(and(eq(favorites.userId, userId), eq(favorites.headword, headword), eq(favorites.dictId, dictId)))
        .run().changes > 0
    );
  }
}
