// Background jobs of the gateway process: search-history retention (Phase 5) and abandoned proposal
// uploads (Phase 6). Timers are unref'd so they never keep the process alive.
import type { Db } from "./db/client";
import { HistoryStore } from "./history/history";
import type { Logger } from "./log";
import type { ProposalService } from "./proposals/service";

export interface JobsOptions {
  db: Db;
  logger: Logger;
  historyDefaultRetentionDays: number;
  proposals?: Pick<ProposalService, "cleanup">;
  /** Time between runs; default one hour. */
  intervalMs?: number;
}

/** Runs the jobs once shortly after start, then every `intervalMs`. Returns a function that stops them. */
export function startJobs({ db, logger, historyDefaultRetentionDays, proposals, intervalMs = 60 * 60 * 1000 }: JobsOptions): () => void {
  const history = new HistoryStore(db);
  const run = () => {
    try {
      const deleted = history.cleanup(historyDefaultRetentionDays);
      if (deleted) logger.info("search history cleaned up", { deleted });
    } catch (err) {
      logger.error("search history cleanup failed", { err });
    }
    proposals?.cleanup().then(
      (r) => {
        if (r.withdrawn || r.orphans) logger.info("abandoned proposal uploads removed", r);
      },
      (err: unknown) => {
        logger.error("proposal upload cleanup failed", { err });
      },
    );
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
