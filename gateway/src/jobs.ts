// Background jobs of the gateway process: search-history retention (Phase 5), abandoned proposal
// uploads (Phase 6), stale files in tmp/ and a weekly SQLite VACUUM while nobody uses the gateway
// (Phase 7). Timers are unref'd so they never keep the process alive.
import { desc, eq } from "drizzle-orm";
import { recordAudit } from "./audit/audit";
import type { Db } from "./db/client";
import { auditLog } from "./db/schema";
import { HistoryStore } from "./history/history";
import type { Logger } from "./log";
import type { ProposalService } from "./proposals/service";
import type { StorageService } from "./storage/admin";

/** VACUUM runs at most this often… */
export const vacuumIntervalMs = 7 * 24 * 60 * 60 * 1000;
/** …and only when no request arrived for this long (it blocks the event loop while it runs). */
export const vacuumIdleMs = 10 * 60 * 1000;

export interface JobsOptions {
  db: Db;
  logger: Logger;
  historyDefaultRetentionDays: number;
  proposals?: Pick<ProposalService, "cleanup">;
  storage?: Pick<StorageService, "cleanTmp">;
  /** Request activity (app.services.activity); without it VACUUM never runs. */
  activity?: { readonly inFlight: number; readonly lastRequestAt: number };
  /** Time between runs; default one hour. */
  intervalMs?: number;
  now?: () => number;
}

/**
 * VACUUMs the database when the last one (recorded in audit_log as "system.vacuum") is a week old and
 * the gateway is idle. Answers whether it ran.
 */
export function maybeVacuum(
  db: Db,
  logger: Logger,
  activity: { readonly inFlight: number; readonly lastRequestAt: number },
  now: number,
): boolean {
  if (activity.inFlight > 0 || now - activity.lastRequestAt < vacuumIdleMs) return false;
  const last = db
    .select({ createdAt: auditLog.createdAt })
    .from(auditLog)
    .where(eq(auditLog.action, "system.vacuum"))
    .orderBy(desc(auditLog.id))
    .limit(1)
    .get();
  if (last && now - last.createdAt.getTime() < vacuumIntervalMs) return false;
  const size = () => {
    const pages = db.$client.pragma("page_count", { simple: true }) as number;
    const pageSize = db.$client.pragma("page_size", { simple: true }) as number;
    return pages * pageSize;
  };
  const before = size();
  db.$client.exec("VACUUM");
  const freed = Math.max(0, before - size());
  recordAudit(db, { actorUserId: null, action: "system.vacuum", bytesFreed: freed });
  logger.info("database vacuumed", { bytesFreed: freed });
  return true;
}

/** Runs the jobs once shortly after start, then every `intervalMs`. Returns a function that stops them. */
export function startJobs(opts: JobsOptions): () => void {
  const { db, logger, historyDefaultRetentionDays, proposals, storage, activity, intervalMs = 60 * 60 * 1000 } = opts;
  const now = opts.now ?? Date.now;
  const history = new HistoryStore(db);
  const run = async () => {
    try {
      const deleted = history.cleanup(historyDefaultRetentionDays);
      if (deleted) logger.info("search history cleaned up", { deleted });
    } catch (err) {
      logger.error("search history cleanup failed", { err });
    }
    try {
      const r = await proposals?.cleanup();
      if (r && (r.withdrawn || r.orphans)) logger.info("abandoned proposal uploads removed", r);
    } catch (err) {
      logger.error("proposal upload cleanup failed", { err });
    }
    try {
      const freed = await storage?.cleanTmp();
      if (freed) logger.info("stale temporary files removed", { bytesFreed: freed });
    } catch (err) {
      logger.error("temporary file cleanup failed", { err });
    }
    try {
      if (activity) maybeVacuum(db, logger, activity, now());
    } catch (err) {
      logger.error("database vacuum failed", { err });
    }
  };
  const tick = () => void run();
  const first = setTimeout(tick, 30_000);
  const timer = setInterval(tick, intervalMs);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
