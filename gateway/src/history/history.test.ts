import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/client";
import { searchHistory, user, userSettings } from "../db/schema";
import { migrationsDir } from "../test/harness";
import { HistoryStore, mergeWindowMs } from "./history";

const day = 24 * 60 * 60 * 1000;

function setup() {
  const db = openDatabase({ file: ":memory:", migrationsDir });
  let now = Date.UTC(2026, 10, 1);
  const store = new HistoryStore(db, () => now);
  for (const id of ["u1", "u2"]) {
    db.insert(user).values({ id, name: id, email: `${id}@example.com`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() }).run();
  }
  return { db, store, advance: (ms: number) => (now += ms) };
}

const lookup = (query: string, mode = "exact", dictIds: string[] | null = null) => ({ query, mode, dictIds });

describe("HistoryStore", () => {
  it("merges identical consecutive lookups within a minute", () => {
    const { store, advance } = setup();
    store.record("u1", lookup("cat"));
    advance(mergeWindowMs - 1);
    store.record("u1", lookup("cat"));
    expect(store.all("u1")).toHaveLength(1);
    advance(mergeWindowMs - 1); // within a minute of the merged (moved) entry
    store.record("u1", lookup("cat"));
    expect(store.all("u1")).toHaveLength(1);
    advance(mergeWindowMs);
    store.record("u1", lookup("cat"));
    expect(store.all("u1")).toHaveLength(2);
  });

  it("does not merge different modes, dictionaries or interleaved lookups", () => {
    const { store } = setup();
    store.record("u1", lookup("cat"));
    store.record("u1", lookup("cat", "prefix"));
    store.record("u1", lookup("cat", "prefix", ["alpha"]));
    store.record("u1", lookup("dog", "prefix", ["alpha"]));
    store.record("u1", lookup("cat", "prefix", ["alpha"]));
    expect(store.all("u1").map((e) => [e.query, e.mode, e.dictIds])).toEqual([
      ["cat", "prefix", ["alpha"]],
      ["dog", "prefix", ["alpha"]],
      ["cat", "prefix", ["alpha"]],
      ["cat", "prefix", null],
      ["cat", "exact", null],
    ]);
  });

  it("pages newest first, filters by text (wildcards literal) and lists distinct queries", () => {
    const { store, advance } = setup();
    for (const q of ["cat", "car", "100%", "cat", "dog"]) {
      store.record("u1", lookup(q));
      advance(mergeWindowMs);
    }
    store.record("u2", lookup("cat"));
    const p1 = store.list("u1", { limit: 2 });
    expect(p1.entries.map((e) => e.query)).toEqual(["dog", "cat"]);
    const p2 = store.list("u1", { limit: 2, cursor: p1.nextCursor ?? 0 });
    expect(p2.entries.map((e) => e.query)).toEqual(["100%", "car"]);
    const p3 = store.list("u1", { limit: 2, cursor: p2.nextCursor ?? 0 });
    expect(p3).toMatchObject({ entries: [{ query: "cat" }], nextCursor: null });

    expect(store.list("u1", { limit: 10, q: "CA" }).entries.map((e) => e.query)).toEqual(["cat", "car", "cat"]);
    expect(store.list("u1", { limit: 10, q: "0%" }).entries.map((e) => e.query)).toEqual(["100%"]);
    expect(store.list("u1", { limit: 10, q: "_" }).entries).toEqual([]);
    expect(store.list("u1", { limit: 10, unique: true }).entries.map((e) => e.query)).toEqual(["dog", "cat", "100%", "car"]);
    expect(store.list("u1", { limit: 2, unique: true }).nextCursor).not.toBeNull();
  });

  it("deletes only the user's own entries", () => {
    const { store } = setup();
    store.record("u1", lookup("cat"));
    store.record("u2", lookup("dog"));
    const theirs = store.all("u2")[0]?.id ?? 0;
    expect(store.delete("u1", theirs)).toBe(false);
    expect(store.clear("u1")).toBe(1);
    expect(store.all("u2")).toHaveLength(1);
  });

  it("cleans up by each user's retention (0 keeps forever), defaulting for users without settings", () => {
    const { db, store, advance } = setup();
    db.insert(userSettings).values({ userId: "u2", historyRetentionDays: 0 }).run();
    store.record("u1", lookup("old"));
    store.record("u2", lookup("old"));
    advance(8 * day);
    store.record("u1", lookup("new"));
    expect(store.cleanup(7)).toBe(1);
    expect(store.all("u1").map((e) => e.query)).toEqual(["new"]);
    expect(store.all("u2").map((e) => e.query)).toEqual(["old"]);
  });

  it("keeps at most 10 000 entries per user", () => {
    const { db, store } = setup();
    const rows = Array.from({ length: 10_005 }, (_, i) => ({ userId: "u1", query: `w${String(i)}`, mode: "exact", createdAt: new Date() }));
    for (let i = 0; i < rows.length; i += 500) db.insert(searchHistory).values(rows.slice(i, i + 500)).run();
    expect(store.cleanup(0)).toBe(5);
    expect(store.list("u1", { limit: 1 }).entries[0]?.query).toBe("w10004");
  });
});
