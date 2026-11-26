// Opens the gateway's SQLite database and brings its schema up to date.
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

export interface OpenDatabaseOptions {
  /** Database file, or ":memory:" in tests. */
  file: string;
  /** Folder with drizzle-kit's migrations (gateway/drizzle, or dist/drizzle in the bundle). */
  migrationsDir: string;
}

/** The database file inside DATA_DIR. */
export function databaseFile(dataDir: string): string {
  return path.join(dataDir, "gateway", "pxdict.db");
}

/** Prepared statements kept per connection (statementCache). */
export const statementCacheSize = 256;

/**
 * Makes `sqlite.prepare` reuse compiled statements by SQL text. Drizzle prepares every query again on
 * each call, and compiling the SQL was the largest single cost of a lookup in the Phase 10 load test
 * (session check, dictionary view and search history are a handful of small queries each).
 *
 * Safe because every query runs synchronously right after it is prepared: a statement still busy
 * (an unfinished iterate()) is never handed out again, and result modes (Drizzle's raw() for
 * column-mapped selects, pluck(), expand()) are switched off again before reuse.
 */
export function cacheStatements(sqlite: Database.Database, max = statementCacheSize): void {
  const cache = new Map<string, Database.Statement>();
  const prepare = sqlite.prepare.bind(sqlite);
  const cached = (source: string): Database.Statement => {
    let stmt = cache.get(source);
    if (stmt && !stmt.busy) {
      // Most recently used last.
      cache.delete(source);
      cache.set(source, stmt);
      // Modes set by the previous user stay on a statement (Drizzle uses raw(), scripts pluck()).
      if (stmt.reader) stmt.raw(false).pluck(false).expand(false);
      return stmt;
    }
    stmt = prepare(source);
    if (!cache.has(source)) {
      cache.set(source, stmt);
      if (cache.size > max) cache.delete(cache.keys().next().value ?? "");
    }
    return stmt;
  };
  // Database.prepare is generic over its parameter and result types; the cache does not change them.
  sqlite.prepare = cached as typeof sqlite.prepare;
}

/**
 * Opens the database with the settings every connection needs (WAL, busy timeout, foreign keys) and
 * applies pending migrations. Throws if the file cannot be opened or a migration fails.
 */
export function openDatabase({ file, migrationsDir }: OpenDatabaseOptions): Db {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  try {
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("synchronous = NORMAL");
    sqlite.pragma("busy_timeout = 5000");
    sqlite.pragma("foreign_keys = ON");
    cacheStatements(sqlite);
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: migrationsDir });
    return db;
  } catch (err) {
    sqlite.close();
    throw err;
  }
}

/**
 * Writes a consistent, compacted copy of the database to `file` with `VACUUM INTO` (safe while the
 * server is running: it reads one snapshot). The file must not exist yet. Used by
 * `pxdict-gateway db backup` and scripts/backup.sh.
 */
export function backupDatabase(db: Db, file: string): void {
  if (!path.isAbsolute(file)) throw new Error("the backup file must be an absolute path");
  if (fs.existsSync(file)) throw new Error("the backup file already exists");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db.$client.prepare("VACUUM INTO ?").run(file);
}

/** Cheap liveness check for /healthz. */
export function pingDatabase(db: Db): boolean {
  try {
    return db.$client.prepare("SELECT 1 AS ok").get() !== undefined;
  } catch {
    return false;
  }
}
