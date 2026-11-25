// Brings a dictionary whose files were just moved into DICT_DIR into service (docs/PLAN.md Phase 6,
// docs/wudict-notes.md Q10): `GET /api/rescan` (new files are not detected on their own), sync the
// catalogue so the gateway's row gets wuDict's id, then `GET /api/ingest?dict=<id>&media=1` and follow
// its Server-Sent Events. Users can see the dictionary only after indexing finished: searching an
// unindexed dictionary costs ~2.5× the RAM (Q13). Progress is kept in memory for the admin UI.
import { eq } from "drizzle-orm";
import type { IndexStatus } from "@pxdict/shared";
import type { Db } from "../db/client";
import { dictionaries } from "../db/schema";
import type { Logger } from "../log";
import { diskUsage, safeJoin } from "../storage/safe-path";
import type { WudictCatalog } from "../wudict/catalog";
import type { WudictClient } from "../wudict/client";
import type { DictRegistry } from "./registry";

/** Visibility given to the dictionary once indexing succeeded; omitted to leave it as it is. */
export interface PublishTarget {
  visibility: "global" | "private" | "hidden";
  ownerUserId: string | null;
}

export interface DictPublisherOptions {
  db: Db;
  client: WudictClient;
  catalog: Pick<WudictCatalog, "invalidate">;
  registry: DictRegistry;
  /** DB_DIR: wuDict's library (index sizes). */
  dbDir: string;
  logger: Logger;
  /** Time allowed until wuDict answers a rescan or starts an ingest stream. */
  headersTimeoutMs?: number;
}

/** One Server-Sent Event. */
export interface SseEvent {
  event: string;
  data: string;
}

/** Splits a text/event-stream body into events as they arrive. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffered = "";
  const parse = (block: string): SseEvent | undefined => {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    return data.length ? { event, data: data.join("\n") } : undefined;
  };
  for await (const chunk of body) {
    buffered += decoder.decode(chunk, { stream: true });
    let sep: RegExpExecArray | null;
    while ((sep = /\r?\n\r?\n/.exec(buffered))) {
      const ev = parse(buffered.slice(0, sep.index));
      buffered = buffered.slice(sep.index + sep[0].length);
      if (ev) yield ev;
    }
  }
  const last = parse(buffered + decoder.decode());
  if (last) yield last;
}

const idle: IndexStatus = { state: "idle", done: 0, total: 0, error: null };

export class DictPublisher {
  readonly #opts: DictPublisherOptions;
  readonly #status = new Map<string, IndexStatus>();
  readonly #running = new Map<string, Promise<void>>();

  constructor(opts: DictPublisherOptions) {
    this.#opts = opts;
  }

  /** Indexing status of a dictionary (idle when nothing ran since the gateway started). */
  status(dictId: string): IndexStatus {
    return this.#status.get(dictId) ?? idle;
  }

  /** Asks wuDict to read DICT_DIR again, then syncs the catalogue. */
  async rescan(): Promise<void> {
    const { client, catalog, registry } = this.#opts;
    const res = await client.request({ path: "/api/rescan", headersTimeoutMs: this.#opts.headersTimeoutMs ?? 120_000 });
    // The answer is the /api/dicts stream; the catalogue reads it again itself.
    await res.body?.cancel();
    if (res.status !== 200) throw new Error(`wuDict /api/rescan answered ${String(res.status)}`);
    catalog.invalidate();
    await registry.refresh();
  }

  /**
   * Starts (or joins) rescan + ingest for `dictId` in the background; `target` is applied once it
   * succeeded. The returned promise settles when the job ends and never rejects.
   */
  publish(dictId: string, target?: PublishTarget): Promise<void> {
    const running = this.#running.get(dictId);
    if (running) return running;
    this.#status.set(dictId, { state: "running", done: 0, total: 0, error: null });
    const job = this.#run(dictId, target)
      .then(() => {
        this.#status.set(dictId, { ...this.status(dictId), state: "done", error: null });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.#opts.logger.error("dictionary indexing failed", { dictId, err });
        this.#status.set(dictId, { ...this.status(dictId), state: "error", error: message });
      })
      .finally(() => {
        this.#running.delete(dictId);
      });
    this.#running.set(dictId, job);
    return job;
  }

  async #run(dictId: string, target: PublishTarget | undefined): Promise<void> {
    const { db, client, catalog, registry, logger } = this.#opts;
    await this.rescan();
    const row = db.select().from(dictionaries).where(eq(dictionaries.id, dictId)).get();
    if (!row) throw new Error("the dictionary was deleted");
    if (!row.wudictId) throw new Error("the dictionary server did not list the new files after a rescan");

    const res = await client.request({
      path: "/api/ingest",
      query: new URLSearchParams({ dict: row.wudictId, media: "1" }),
      headers: new Headers({ Accept: "text/event-stream" }),
      headersTimeoutMs: this.#opts.headersTimeoutMs ?? 120_000,
    });
    if (res.status !== 200 || !res.body) {
      await res.body?.cancel();
      throw new Error(`the dictionary server refused to index it (HTTP ${String(res.status)})`);
    }
    let finished = false;
    for await (const ev of readSse(res.body)) {
      if (ev.event === "progress") {
        const p = JSON.parse(ev.data) as { done?: unknown; total?: unknown };
        const done = typeof p.done === "number" ? p.done : 0;
        const total = typeof p.total === "number" ? p.total : 0;
        this.#status.set(dictId, { state: "running", done, total, error: null });
      } else if (ev.event === "error") {
        const e = JSON.parse(ev.data) as { error?: unknown };
        throw new Error(typeof e.error === "string" ? `indexing failed: ${e.error}` : "indexing failed");
      } else if (ev.event === "done") {
        finished = true;
      }
    }
    if (!finished) throw new Error("the indexing stream ended without a result");

    catalog.invalidate();
    await registry.refresh();
    const after = db.select().from(dictionaries).where(eq(dictionaries.id, dictId)).get();
    if (!after) throw new Error("the dictionary was deleted");
    const indexBytes = after.libraryDir ? await diskUsage(await safeJoin(this.#opts.dbDir, after.libraryDir)) : null;
    db.update(dictionaries)
      .set({
        mediaPacked: true,
        indexBytes,
        ...(target ? { visibility: target.visibility, ownerUserId: target.ownerUserId } : {}),
        updatedAt: new Date(),
      })
      .where(eq(dictionaries.id, dictId))
      .run();
    logger.info("dictionary indexed", { dictId, wudictId: after.wudictId, visibility: target?.visibility ?? after.visibility });
  }
}
