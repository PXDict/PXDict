// A fake wuDict for tests: the handful of routes the gateway proxies, with wuDict's response shapes
// (docs/wudict-notes.md). Real behaviour is checked by contract.test.ts against the actual binary.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";

export interface FakeDict {
  id: string;
  name: string;
  /** headword → article HTML */
  entries: Record<string, string>;
  /** resource path → body */
  resources?: Record<string, string>;
  /** Absolute path of the main file; default /data/dictionaries/<name>/<name>.mdx. */
  sourcePath?: string;
  /** False until /api/ingest ran (no dbPath/folder in /api/dicts); default true. */
  indexed?: boolean;
  /** The originals were deleted (DELETE /api/library?prepared=0): listed from its index only. */
  sourceDeleted?: boolean;
}

export interface FakeWudictOptions {
  token: string;
  dicts?: FakeDict[];
  /** DICT_DIR scanned by /api/rescan (main files .mdx/.dsl at any depth); omitted: rescan adds nothing. */
  dictDir?: string;
  /** DB_DIR where /api/ingest writes <name>/info.txt with a uuid. */
  dbDir?: string;
}

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Headers;
}

export const fakeDicts: FakeDict[] = [
  {
    id: "aaaaaaaaaaaa",
    name: "Alpha",
    entries: { cat: '<img src="/res/aaaaaaaaaaaa/img/cat.png">a cat', car: "a car" },
    resources: { "img/cat.png": "PNG-cat", "style.css": "b{color:red}" },
  },
  { id: "bbbbbbbbbbbb", name: "Beta", entries: { cat: "another cat", zebra: "a zebra" } },
];

export class FakeWudict {
  readonly requests: RecordedRequest[] = [];
  dicts: FakeDict[];
  /** When set, every request answers this status (e.g. 401 to simulate a wrong token). */
  forceStatus: number | undefined;
  /** When set, every request fails as if wuDict were down. */
  down = false;
  /** When set, /api/ingest streams this error instead of finishing. */
  ingestError: string | undefined;
  readonly #app = new Hono();
  readonly #token: string;
  readonly #dictDir: string | undefined;
  readonly #dbDir: string | undefined;

  constructor({ token, dicts = fakeDicts, dictDir, dbDir }: FakeWudictOptions) {
    this.#token = token;
    // A copy: rescans add to it, and the default list is shared by every test.
    this.dicts = [...dicts];
    this.#dictDir = dictDir;
    this.#dbDir = dbDir;
    this.#routes();
  }

  /** Adds main files found under DICT_DIR that are not listed yet (wuDict's rescan). */
  #rescan(): void {
    const root = this.#dictDir;
    if (!root || !fs.existsSync(root)) return;
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) return walk(full);
        return /\.(mdx|dsl)$/i.test(e.name) ? [full] : [];
      });
    for (const file of walk(root)) {
      if (this.dicts.some((d) => d.sourcePath === file)) continue;
      const id = createHash("sha256").update(file).digest("hex").slice(0, 12);
      const name = path.basename(file).replace(/\.[^.]+$/, "");
      this.dicts.push({ id, name, entries: { hello: `hello from ${name}` }, sourcePath: file, indexed: false });
    }
  }

  /** A fetch implementation to pass to WudictClient. */
  readonly fetch: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    this.requests.push({ method: req.method, url: new URL(req.url), headers: req.headers });
    if (this.down) throw new TypeError("fetch failed: connect ECONNREFUSED");
    if (this.forceStatus) return new Response("forced", { status: this.forceStatus });
    return this.#app.fetch(req);
  };

  lastRequest(): RecordedRequest | undefined {
    return this.requests.at(-1);
  }

  #resolve(dictParam: string | null): FakeDict[] | undefined {
    if (!dictParam || dictParam === "all") return this.dicts;
    const ids = dictParam.split(",");
    const found = ids.map((id) => this.dicts.find((d) => d.id === id)).filter((d) => d !== undefined);
    return found.length ? found : undefined;
  }

  #routes(): void {
    const app = this.#app;
    const ndjson = (lines: unknown[]) =>
      new Response(lines.map((l) => JSON.stringify(l) + "\n").join(""), {
        headers: { "Content-Type": "application/x-ndjson", "Set-Cookie": "wudict_session=leak" },
      });
    const authorized = (h: string | undefined) => h === `Bearer ${this.#token}`;

    app.get("/api/rescan", (c) => {
      if (!authorized(c.req.header("Authorization"))) return c.json({ error: "access key required" }, 401);
      this.#rescan();
      return ndjson([{ t: "begin", total: this.dicts.length }, { t: "end", etag: '"rescan"' }]);
    });

    app.get("/api/ingest", (c) => {
      if (!authorized(c.req.header("Authorization"))) return c.json({ error: "access key required" }, 401);
      const d = this.dicts.find((x) => x.id === c.req.query("dict"));
      if (!d) return c.json({ error: "unknown dictionary id" }, 404);
      const events = ["event: progress\ndata: {\"done\":1,\"total\":2}\n\n"];
      if (this.ingestError) {
        events.push(`event: error\ndata: ${JSON.stringify({ error: this.ingestError })}\n\n`);
      } else {
        d.indexed = true;
        if (this.#dbDir) {
          fs.mkdirSync(path.join(this.#dbDir, d.name), { recursive: true });
          fs.writeFileSync(path.join(this.#dbDir, d.name, "info.txt"), `name = ${d.name}\nuuid = ${randomUUID()}\nmedia = packed\n`);
          fs.writeFileSync(path.join(this.#dbDir, d.name, "text.db"), "x".repeat(100));
        }
        events.push("event: progress\ndata: {\"done\":2,\"total\":2}\n\n", `event: done\ndata: {"id":"${d.id}"}\n\n`);
      }
      return c.body(events.join(""), 200, { "Content-Type": "text/event-stream" });
    });

    // DELETE /api/library?dict=<id>[&prepared=0] (docs/wudict-notes.md Q9, Q11): removes the library
    // folder and the main + .mdd files; with prepared=0 only those files, and the id changes.
    app.delete("/api/library", (c) => {
      if (!authorized(c.req.header("Authorization"))) return c.json({ error: "access key required" }, 401);
      const d = this.dicts.find((x) => x.id === c.req.query("dict"));
      if (!d) return c.json({ error: "unknown dictionary" }, 404);
      const keepIndex = c.req.query("prepared") === "0";
      if (keepIndex && d.indexed === false) return c.json({ error: `pack media for ${d.name} first` }, 409);
      const sources: string[] = [];
      if (d.sourcePath && !d.sourceDeleted) {
        const dir = path.dirname(d.sourcePath);
        const stem = path.basename(d.sourcePath).replace(/\.[^.]+$/, "");
        sources.push(d.sourcePath);
        if (fs.existsSync(dir)) {
          for (const n of fs.readdirSync(dir)) if (n.startsWith(`${stem}.`) && n.toLowerCase().endsWith(".mdd")) sources.push(path.join(dir, n));
        }
        for (const f of sources) fs.rmSync(f, { force: true });
      }
      if (keepIndex) {
        d.sourceDeleted = true;
        d.id = createHash("sha256").update(`/data/db/${d.name}/text.db`).digest("hex").slice(0, 12);
      } else {
        this.dicts = this.dicts.filter((x) => x !== d);
        if (this.#dbDir) fs.rmSync(path.join(this.#dbDir, d.name), { recursive: true, force: true });
      }
      return c.json({ name: d.name, sources, freed: 1, gone: true });
    });

    app.get("/api/dicts", (c) => {
      const etag = `"${this.dicts.map((d) => `${d.id}${d.indexed === false ? "u" : ""}${d.sourceDeleted ? "s" : ""}`).join("-")}"`;
      if (c.req.header("If-None-Match") === etag) return c.body(null, 304);
      return ndjson([
        { t: "begin", total: this.dicts.length + 1, groupsProblems: 0 },
        ...this.dicts.map((d) => ({
          t: "dict",
          dict: {
            id: d.id,
            name: d.name,
            format: "mdx",
            ...(d.sourceDeleted
              ? { path: `/data/db/${d.name}/text.db` }
              : {
                  path: d.sourcePath ?? `/data/dictionaries/${d.name}/${d.name}.mdx`,
                  source: d.sourcePath ?? `/data/dictionaries/${d.name}/${d.name}.mdx`,
                }),
            ...(d.indexed === false ? {} : { dbPath: `/data/db/${d.name}/text.db`, folder: `/data/db/${d.name}` }),
            entries: Object.keys(d.entries).length,
            caps: { Exact: true, Prefix: true },
            groups: [{ id: "g", name: "global group" }],
          },
        })),
        {
          t: "dict",
          dict: { id: "wudict-howto", name: "howto", format: "wudict", path: "/x", entries: 1, caps: {}, builtin: true },
        },
        { t: "end", etag },
      ]);
    });

    app.get("/api/search", (c) => {
      const q = c.req.query("q") ?? "";
      if (!q.trim()) return c.json({ error: "blank query" }, 400);
      const dicts = this.#resolve(c.req.query("dict") ?? null);
      if (!dicts) return c.json({ error: "unknown dictionary /data/secret" }, 404);
      const lines: unknown[] = [{ t: "begin", slots: dicts.map((d) => ({ dict: d.id, name: d.name })) }];
      dicts.forEach((d, i) => {
        const body = d.entries[q];
        lines.push({
          t: "hit",
          i,
          dict: d.id,
          name: d.name,
          ...(body === undefined ? {} : { results: [{ Headword: q, Body: body }] }),
        });
      });
      lines.push({ t: "end" });
      return ndjson(lines);
    });

    // Used by /healthz: a token-gated route.
    app.get("/api/config", (c) => {
      if (!authorized(c.req.header("Authorization"))) return c.json({ error: "access key required" }, 401);
      return c.json({ dictDir: "/data/dictionaries" });
    });

    app.get("/api/suggest", (c) => {
      if (!authorized(c.req.header("Authorization"))) return c.json({ error: "access key required" }, 401);
      const q = c.req.query("q") ?? "";
      const dicts = this.#resolve(c.req.query("dict") ?? null);
      if (!dicts) return c.json({ error: "unknown dictionary" }, 404);
      const words = [...new Set(dicts.flatMap((d) => Object.keys(d.entries)))].filter((w) => w.startsWith(q)).sort();
      return c.json({ words });
    });

    app.get("/res/:dict/*", (c) => {
      const d = this.dicts.find((x) => x.id === c.req.param("dict"));
      const rest = new URL(c.req.url).pathname.slice(`/res/${c.req.param("dict")}/`.length);
      const body = d?.resources?.[decodeURIComponent(rest)];
      if (body === undefined) return c.body(null, 404);
      return c.body(body, 200, {
        "Content-Type": rest.endsWith(".css") ? "text/css" : "image/png",
        "Cache-Control": "public, max-age=86400",
        "Set-Cookie": "wudict_session=leak",
        "X-Wudict-Internal": "/data/dictionaries",
      });
    });

    // Admin routes exist upstream; the gateway must never reach them.
    app.all("*", (c) => c.json({ error: "fake: unexpected route" }, 418));
  }
}
