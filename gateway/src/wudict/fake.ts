// A fake wuDict for tests: the handful of routes the gateway proxies, with wuDict's response shapes
// (docs/wudict-notes.md). Real behaviour is checked by contract.test.ts against the actual binary.
import { Hono } from "hono";

export interface FakeDict {
  id: string;
  name: string;
  /** headword → article HTML */
  entries: Record<string, string>;
  /** resource path → body */
  resources?: Record<string, string>;
}

export interface FakeWudictOptions {
  token: string;
  dicts?: FakeDict[];
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
  readonly #app = new Hono();
  readonly #token: string;

  constructor({ token, dicts = fakeDicts }: FakeWudictOptions) {
    this.#token = token;
    this.dicts = dicts;
    this.#routes();
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

    app.get("/api/dicts", (c) => {
      const etag = `"${this.dicts.map((d) => d.id).join("-")}"`;
      if (c.req.header("If-None-Match") === etag) return c.body(null, 304);
      return ndjson([
        { t: "begin", total: this.dicts.length + 1, groupsProblems: 0 },
        ...this.dicts.map((d) => ({
          t: "dict",
          dict: {
            id: d.id,
            name: d.name,
            format: "mdx",
            path: `/data/dictionaries/${d.name}/${d.name}.mdx`,
            source: `/data/dictionaries/${d.name}/${d.name}.mdx`,
            dbPath: `/data/db/${d.name}/text.db`,
            folder: `/data/db/${d.name}`,
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
