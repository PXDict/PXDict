// Background jobs of the gateway process. Phase 5: search-history retention. Each run is synchronous
// and short (SQLite); timers are unref'd so they never keep the process alive.
import type { Db } from "./db/client";
import { HistoryStore } from "./history/history";
import type { Logger } from "./log";

export interface JobsOptions {
  db: Db;
  logger: Logger;
  historyDefaultRetentionDays: number;
  /** Time between runs; default one hour. */
  intervalMs?: number;
}

/** Runs the jobs once shortly after start, then every `intervalMs`. Returns a function that stops them. */
export function startJobs({ db, logger, historyDefaultRetentionDays, intervalMs = 60 * 60 * 1000 }: JobsOptions): () => void {
  const history = new HistoryStore(db);
  const run = () => {
    try {
      const deleted = history.cleanup(historyDefaultRetentionDays);
      if (deleted) logger.info("search history cleaned up", { deleted });
    } catch (err) {
      logger.error("search history cleanup failed", { err });
    }
  };
  const first = setTimeout(run, 30_000);
  const timer = setInterval(run, intervalMs);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
