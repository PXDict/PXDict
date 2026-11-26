import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { migrationsDir } from "../test/harness";
import Database from "better-sqlite3";
import { backupDatabase, cacheStatements, databaseFile, openDatabase, pingDatabase } from "./client";
import { auditLog, dictionaries } from "./schema";

describe("openDatabase", () => {
  it("creates the file with WAL and foreign keys, and migrates idempotently", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pxdict-db-"));
    try {
      const file = databaseFile(dir);
      expect(file).toBe(path.join(dir, "gateway", "pxdict.db"));
      const db = openDatabase({ file, migrationsDir });
      expect(db.$client.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(pingDatabase(db)).toBe(true);
      db.$client.close();
      // A second start applies nothing new.
      const again = openDatabase({ file, migrationsDir });
      const tables = again.$client
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .pluck()
        .all();
      expect(tables).toEqual(expect.arrayContaining(["audit_log", "dictionaries"]));
      again.$client.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enforces the dictionaries constraints and fills timestamps", () => {
    const db = openDatabase({ file: ":memory:", migrationsDir });
    db.insert(dictionaries).values({ id: "oxford", title: "Oxford", source: "builtin" }).run();
    const row = db.select().from(dictionaries).get();
    expect(row).toMatchObject({ visibility: "hidden", trustedRender: false, mediaPacked: false });
    expect(row?.createdAt).toBeInstanceOf(Date);
    expect(Math.abs((row?.createdAt.getTime() ?? 0) - Date.now())).toBeLessThan(5000);

    expect(() =>
      db.insert(dictionaries).values({ id: "p", title: "P", source: "builtin", visibility: "private" }).run(),
    ).toThrow(/CHECK constraint/);
    expect(() =>
      db.$client.prepare("INSERT INTO dictionaries (id, title, source) VALUES ('x', 'X', 'upload')").run(),
    ).toThrow(/CHECK constraint/);

    db.insert(auditLog).values({ action: "dict.rescan", detailsJson: { added: 1 } }).run();
    expect(db.select().from(auditLog).get()).toMatchObject({ action: "dict.rescan", detailsJson: { added: 1 } });
  });
});

describe("backupDatabase", () => {
  it("writes a consistent copy that opens on its own, and never overwrites", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pxdict-backup-"));
    try {
      const db = openDatabase({ file: databaseFile(dir), migrationsDir });
      db.insert(dictionaries).values({ id: "oxford", title: "Oxford", source: "builtin" }).run();
      const file = path.join(dir, "out", "pxdict.db");
      backupDatabase(db, file);
      expect(() => {
        backupDatabase(db, file);
      }).toThrow(/already exists/);
      expect(() => {
        backupDatabase(db, "relative.db");
      }).toThrow(/absolute/);
      db.$client.close();

      const copy = openDatabase({ file, migrationsDir });
      expect(copy.select().from(dictionaries).all().map((d) => d.id)).toEqual(["oxford"]);
      copy.$client.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cacheStatements", () => {
  const open = (max?: number) => {
    const sqlite = new Database(":memory:");
    cacheStatements(sqlite, max);
    sqlite.exec("CREATE TABLE t (a INTEGER, b TEXT); INSERT INTO t VALUES (1, 'x'), (2, 'y')");
    return sqlite;
  };

  it("reuses a statement for the same SQL and resets its result mode", () => {
    const sqlite = open();
    const first = sqlite.prepare("SELECT a, b FROM t ORDER BY a");
    expect(first.raw().all()).toEqual([[1, "x"], [2, "y"]]);
    const again = sqlite.prepare("SELECT a, b FROM t ORDER BY a");
    expect(again).toBe(first);
    expect(again.all()).toEqual([{ a: 1, b: "x" }, { a: 2, b: "y" }]);
    expect(sqlite.prepare("SELECT a, b FROM t ORDER BY a").pluck().all()).toEqual([1, 2]);
    expect(sqlite.prepare("SELECT a, b FROM t ORDER BY a").get()).toEqual({ a: 1, b: "x" });
    // Statements that return no data have no result mode to reset.
    const insert = sqlite.prepare("INSERT INTO t VALUES (?, ?)");
    insert.run(3, "z");
    expect(sqlite.prepare("INSERT INTO t VALUES (?, ?)")).toBe(insert);
    sqlite.close();
  });

  it("hands out a fresh statement while the cached one is busy", () => {
    const sqlite = open();
    const sql = "SELECT a FROM t ORDER BY a";
    const outer = sqlite.prepare(sql);
    const seen: number[] = [];
    for (const row of outer.iterate() as IterableIterator<{ a: number }>) {
      const inner = sqlite.prepare(sql);
      expect(inner).not.toBe(outer);
      seen.push(row.a, (inner.all() as { a: number }[]).length);
    }
    expect(seen).toEqual([1, 2, 2, 2]);
    expect(sqlite.prepare(sql)).toBe(outer);
    sqlite.close();
  });

  it("keeps at most `max` statements, dropping the least recently used", () => {
    const sqlite = open(2);
    const a = sqlite.prepare("SELECT 1");
    const b = sqlite.prepare("SELECT 2");
    expect(sqlite.prepare("SELECT 1")).toBe(a);
    sqlite.prepare("SELECT 3");
    expect(sqlite.prepare("SELECT 1")).toBe(a);
    expect(sqlite.prepare("SELECT 2")).not.toBe(b);
    sqlite.close();
  });
});
