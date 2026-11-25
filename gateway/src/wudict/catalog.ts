// wuDict's dictionary list as the gateway sees it, cached and refreshed cheaply with the etag of the
// stream's end line. dicts/registry.ts reconciles it with the gateway's `dictionaries` table, and the
// proxy decides per user from that table (DictAccess).
import path from "node:path";
import type { WudictClient } from "./client";
import { isBuiltinDict, type DictLabel } from "./sanitize";

/** What one user may use, keyed by wuDict's current ids. */
export interface UserDictView {
  /** Every dictionary the user may use (wuDict id → PXDict data), in the user's order. */
  usable: ReadonlyMap<string, UsableDict>;
  /** wuDict ids of the user's enabled dictionaries, in the user's order: the default search set. */
  enabled: readonly string[];
}

/** PXDict's stable id and title, the user's enabled flag, and `trusted_render` (style A allowed). */
export type UsableDict = DictLabel;

export interface DictAccess {
  /** The dictionaries `userId` may use. Throws WudictCatalogError etc. when wuDict cannot be asked. */
  forUser(userId: string, signal?: AbortSignal): Promise<UserDictView>;
}

/** One /api/dicts row, reduced to what the gateway needs (paths stay inside the gateway). */
export interface WudictDictRow {
  id: string;
  name: string;
  format: string | undefined;
  /** Folder name under DB_DIR (`db/<name>/`), once indexed. */
  libraryDir: string | undefined;
  /** Absolute path of the original file, while it exists. */
  sourcePath: string | undefined;
}

export interface CatalogSnapshot {
  rows: readonly WudictDictRow[];
  /** Changes whenever the listing changes; equal versions have equal rows. */
  version: number;
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

interface Snapshot extends CatalogSnapshot {
  etag: string | undefined;
  fetchedAt: number;
}

/** Caches wuDict's dictionary list; refreshes cheaply through the `etag` of the stream's end line. */
export class WudictCatalog {
  readonly #client: WudictClient;
  readonly #ttlMs: number;
  readonly #maxBytes: number;
  readonly #now: () => number;
  #snapshot: Snapshot | undefined;
  #refreshing: Promise<Snapshot> | undefined;
  #version = 0;

  constructor(opts: WudictCatalogOptions) {
    this.#client = opts.client;
    this.#ttlMs = opts.ttlMs ?? 5_000;
    this.#maxBytes = opts.maxBytes ?? 8 * 2 ** 20;
    this.#now = opts.now ?? Date.now;
  }

  /** The current listing (from the cache while it is fresh). */
  async snapshot(): Promise<CatalogSnapshot> {
    const snap = this.#snapshot;
    if (snap && this.#now() - snap.fetchedAt < this.#ttlMs) return snap;
    // One refresh at a time; concurrent callers share it. It is not tied to any caller's signal.
    this.#refreshing ??= this.#refresh(snap).finally(() => {
      this.#refreshing = undefined;
    });
    return await this.#refreshing;
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
    const rows: WudictDictRow[] = [];
    let etag: string | undefined;
    for (const raw of text.split("\n")) {
      if (!raw.trim()) continue;
      const line = JSON.parse(raw) as { t?: unknown; dict?: Record<string, unknown>; etag?: unknown };
      if (line.t === "dict" && line.dict && !isBuiltinDict(line.dict)) {
        const row = toRow(line.dict);
        if (row) rows.push(row);
      } else if (line.t === "end" && typeof line.etag === "string") {
        etag = line.etag;
      }
    }
    // wuDict streams rows in completion order; keep a stable order.
    rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const same = previous && JSON.stringify(previous.rows) === JSON.stringify(rows);
    const version = same ? previous.version : ++this.#version;
    return (this.#snapshot = { rows, version, etag, fetchedAt: this.#now() });
  }
}

const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);

/** Reads the fields the gateway needs from one DictInfo (docs/wudict-notes.md Q6). */
function toRow(d: Record<string, unknown>): WudictDictRow | undefined {
  const id = str(d.id);
  if (!id) return undefined;
  // `folder` is db/<name>; `dbPath` is db/<name>/text.db; both are absent until indexed.
  const folder = str(d.folder) ?? (str(d.dbPath) ? path.posix.dirname(str(d.dbPath) ?? "") : undefined);
  // `source` is the original file while it exists; `path` is the source, or text.db once originals are gone.
  const sourcePath = str(d.source) ?? (str(d.dbPath) ? undefined : str(d.path));
  return {
    id,
    name: str(d.name) ?? id,
    format: str(d.format),
    libraryDir: folder ? path.posix.basename(folder) : undefined,
    sourcePath,
  };
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
