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
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: migrationsDir });
    return db;
  } catch (err) {
    sqlite.close();
    throw err;
  }
}

/** Cheap liveness check for /healthz. */
export function pingDatabase(db: Db): boolean {
  try {
    return db.$client.prepare("SELECT 1 AS ok").get() !== undefined;
  } catch {
    return false;
  }
}
