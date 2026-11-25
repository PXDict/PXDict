import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { migrationsDir } from "../test/harness";
import { databaseFile, openDatabase, pingDatabase } from "./client";
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
