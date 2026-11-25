// Builds a gateway app for tests: in-memory database, fake wuDict, optional PWA folder.
import { fileURLToPath } from "node:url";
import { createApp } from "../app";
import { openDatabase } from "../db/client";
import { createLogger } from "../log";
import { WudictCatalog } from "../wudict/catalog";
import { WudictClient } from "../wudict/client";
import { FakeWudict } from "../wudict/fake";

export const testToken = "test-token-".padEnd(40, "x");
export const migrationsDir = fileURLToPath(new URL("../../drizzle/", import.meta.url));

export interface HarnessOptions {
  pwaDir?: string;
  headersTimeoutMs?: number;
  /** Catalogue cache lifetime; 0 (default) asks wuDict on every request. */
  catalogTtlMs?: number;
  /** Replaces the fake wuDict's fetch (e.g. to simulate a hanging server). */
  fetch?: typeof fetch;
}

export function harness(opts: HarnessOptions = {}) {
  const lines: string[] = [];
  const logger = createLogger("debug", (l) => lines.push(l));
  const fake = new FakeWudict({ token: testToken });
  const db = openDatabase({ file: ":memory:", migrationsDir });
  const wudict = new WudictClient({
    baseUrl: new URL("http://127.0.0.1:6888"),
    token: testToken,
    fetch: opts.fetch ?? fake.fetch,
    ...(opts.headersTimeoutMs ? { headersTimeoutMs: opts.headersTimeoutMs } : {}),
  });
  const catalog = new WudictCatalog({ client: wudict, ttlMs: opts.catalogTtlMs ?? 0 });
  const app = createApp({
    version: "1.2.3",
    logger,
    db,
    wudict,
    access: catalog,
    ...(opts.pwaDir ? { pwaDir: opts.pwaDir } : {}),
  });
  /** Requests the fake wuDict received for one path. */
  const upstream = (pathname: string) => fake.requests.filter((r) => r.url.pathname === pathname);
  return { app, fake, db, lines, catalog, upstream };
}

/** Reads an NDJSON response body into parsed lines. */
export async function ndjsonLines(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}
