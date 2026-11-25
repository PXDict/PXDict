// Which wuDict dictionaries a request may use. The proxy always sends wuDict an explicit `dict=` list
// built from this (never `all`), and filters /api/dicts with it.
//
// Until Phase 5 every signed-in user may use every dictionary wuDict lists except its builtin howto, and
// no dictionary is trusted. Phase 5 replaces WudictCatalog with the gateway's `dictionaries` +
// `user_dicts` tables.
import type { WudictClient } from "./client";
import { isBuiltinDict } from "./sanitize";

export interface DictAccess {
  /** wuDict ids `userId` may use, in the order results should be shown. */
  allowedIds(userId: string, signal?: AbortSignal): Promise<string[]>;
  /**
   * wuDict ids an admin marked `trusted_render`: the PWA may render them same-origin (style A) instead
   * of in an opaque-origin sandbox.
   */
  trustedIds(signal?: AbortSignal): Promise<ReadonlySet<string>>;
}

/** wuDict answered /api/dicts with something other than 200/304. */
export class WudictCatalogError extends Error {
  constructor(readonly status: number) {
    super(`wuDict /api/dicts answered ${String(status)}`);
    this.name = "WudictCatalogError";
  }
}

export interface WudictCatalogOptions {
  client: WudictClient;
  /** How long a listing is reused before asking wuDict again (with If-None-Match). */
  ttlMs?: number;
  /** Largest /api/dicts body read (bytes). */
  maxBytes?: number;
  now?: () => number;
}

interface Snapshot {
  ids: string[];
  etag: string | undefined;
  fetchedAt: number;
}

/** Caches wuDict's dictionary list; refreshes cheaply through the `etag` of the stream's end line. */
export class WudictCatalog implements DictAccess {
  readonly #client: WudictClient;
  readonly #ttlMs: number;
  readonly #maxBytes: number;
  readonly #now: () => number;
  #snapshot: Snapshot | undefined;
  #refreshing: Promise<Snapshot> | undefined;

  constructor(opts: WudictCatalogOptions) {
    this.#client = opts.client;
    this.#ttlMs = opts.ttlMs ?? 5_000;
    this.#maxBytes = opts.maxBytes ?? 8 * 2 ** 20;
    this.#now = opts.now ?? Date.now;
  }

  trustedIds(): Promise<ReadonlySet<string>> {
    return Promise.resolve(new Set());
  }

  async allowedIds(): Promise<string[]> {
    const snap = this.#snapshot;
    if (snap && this.#now() - snap.fetchedAt < this.#ttlMs) return snap.ids;
    // One refresh at a time; concurrent callers share it. It is not tied to any caller's signal.
    this.#refreshing ??= this.#refresh(snap).finally(() => {
      this.#refreshing = undefined;
    });
    return (await this.#refreshing).ids;
  }

  /** Forgets the cached list (after a rescan, an approval, …). */
  invalidate(): void {
    this.#snapshot = undefined;
  }

  async #refresh(previous: Snapshot | undefined): Promise<Snapshot> {
    const headers = new Headers({ Accept: "application/x-ndjson" });
    if (previous?.etag) headers.set("If-None-Match", previous.etag);
    const res = await this.#client.request({
      path: "/api/dicts",
      headers,
      signal: AbortSignal.timeout(60_000),
    });

    if (res.status === 304 && previous) {
      await res.body?.cancel();
      return (this.#snapshot = { ...previous, fetchedAt: this.#now() });
    }
    if (res.status !== 200) {
      await res.body?.cancel();
      throw new WudictCatalogError(res.status);
    }

    const text = await readLimited(res, this.#maxBytes);
    const ids: string[] = [];
    let etag: string | undefined;
    for (const raw of text.split("\n")) {
      if (!raw.trim()) continue;
      const line = JSON.parse(raw) as { t?: unknown; dict?: { id?: unknown }; etag?: unknown };
      if (line.t === "dict" && line.dict && typeof line.dict.id === "string" && !isBuiltinDict(line.dict)) {
        ids.push(line.dict.id);
      } else if (line.t === "end" && typeof line.etag === "string") {
        etag = line.etag;
      }
    }
    // wuDict streams rows in completion order; keep a stable order for search results.
    ids.sort();
    return (this.#snapshot = { ids, etag, fetchedAt: this.#now() });
  }
}

async function readLimited(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader: ReadableStreamDefaultReader<Uint8Array> = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error(`wuDict /api/dicts is larger than ${String(maxBytes)} bytes`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
