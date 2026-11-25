import { ErrorBody } from "@pxdict/shared";
import { describe, expect, it } from "vitest";
import { harness, ndjsonLines } from "../test/harness";

const browserHeaders = {
  Cookie: "pxdict.session=user-secret; wudict_session=stolen",
  Authorization: "Bearer from-the-browser",
  "Sec-Fetch-Site": "cross-site",
  "X-Forwarded-For": "1.2.3.4",
};

describe("GET /api/dicts", () => {
  it("drops the howto and every filesystem or global field", async () => {
    const { app } = harness();
    const res = await app.request("/api/dicts");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    expect(res.headers.get("set-cookie")).toBeNull();
    const lines = await ndjsonLines(res);
    expect(lines[0]).toEqual({ t: "begin" });
    expect(lines.at(-1)).toEqual({ t: "end" });
    const dicts = lines.filter((l) => l.t === "dict").map((l) => l.dict as Record<string, unknown>);
    expect(dicts.map((d) => d.id)).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
    for (const d of dicts) {
      expect(Object.keys(d).sort()).toEqual(["caps", "entries", "format", "id", "name"]);
    }
    expect(JSON.stringify(lines)).not.toContain("/data/");
  });
});

describe("GET /api/search", () => {
  it("always sends an explicit dictionary list, the token, and nothing from the browser", async () => {
    const { app, upstream } = harness();
    const res = await app.request("/api/search?q=cat&mode=exact&k=stolen-token&dict=all&evil=1", {
      headers: browserHeaders,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();

    const [req] = upstream("/api/search");
    expect(req).toBeDefined();
    expect(Object.fromEntries(req?.url.searchParams ?? [])).toEqual({
      q: "cat",
      mode: "exact",
      dict: "aaaaaaaaaaaa,bbbbbbbbbbbb",
    });
  });

  it("streams hits from the allowed dictionaries", async () => {
    const { app, upstream } = harness();
    const res = await app.request("/api/search?q=cat", { headers: browserHeaders });
    const lines = await ndjsonLines(res);
    expect(lines[0]).toMatchObject({ t: "begin", slots: [{ dict: "aaaaaaaaaaaa" }, { dict: "bbbbbbbbbbbb" }] });
    expect(lines.filter((l) => l.t === "hit")).toHaveLength(2);
    expect(lines.at(-1)).toEqual({ t: "end" });

    const [req] = upstream("/api/search");
    expect(req?.url.searchParams.get("dict")).toBe("aaaaaaaaaaaa,bbbbbbbbbbbb");
    expect(req?.url.searchParams.has("k")).toBe(false);
    expect(req?.headers.get("authorization")).toMatch(/^Bearer test-token-/);
    expect(req?.headers.get("cookie")).toBeNull();
    expect(req?.headers.get("sec-fetch-site")).toBeNull();
    expect(req?.headers.get("x-forwarded-for")).toBeNull();
  });

  it("keeps only allowed dictionaries from the requested list, in request order", async () => {
    const { app, upstream } = harness();
    await app.request("/api/search?q=cat&dict=bbbbbbbbbbbb,nothere00000,aaaaaaaaaaaa,bbbbbbbbbbbb");
    expect(upstream("/api/search")[0]?.url.searchParams.get("dict")).toBe("bbbbbbbbbbbb,aaaaaaaaaaaa");
  });

  it.each(["dict=nothere00000", "dict=wudict-howto"])(
    "answers an empty result for %s without asking wuDict",
    async (param) => {
      const { app, upstream } = harness();
      const res = await app.request(`/api/search?q=cat&${param}`);
      expect(res.status).toBe(200);
      expect(await ndjsonLines(res)).toEqual([{ t: "begin", slots: [] }, { t: "end" }]);
      expect(upstream("/api/search")).toEqual([]);
    },
  );

  it.each([
    "",
    "q=",
    "q=%20%20",
    "q=cat&mode=contains",
    "q=cat&format=clean",
    "q=cat&n=0",
    "q=cat&n=1000",
    "q=cat&dict=../etc",
    `q=${"x".repeat(501)}`,
  ])("rejects ?%s with 400", async (qs) => {
    const { app, upstream } = harness();
    const res = await app.request(`/api/search?${qs}`);
    expect(res.status).toBe(400);
    expect(ErrorBody.parse(await res.json()).error.code).toBe("bad_request");
    expect(upstream("/api/search")).toEqual([]);
  });

  it("does not forward wuDict's error messages", async () => {
    const { app, fake } = harness({ catalogTtlMs: 60_000 });
    await app.request("/api/dicts"); // the catalogue now lists both dictionaries
    fake.dicts = []; // …but wuDict no longer knows them and answers 404 with a path in the message
    const res = await app.request("/api/search?q=cat");
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("/data/");
  });
});

describe("GET /api/suggest", () => {
  it("returns the words from the allowed dictionaries", async () => {
    const { app, upstream } = harness();
    const res = await app.request("/api/suggest?q=ca&k=x", { headers: browserHeaders });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ words: ["car", "cat"] });
    const [req] = upstream("/api/suggest");
    expect(Object.fromEntries(req?.url.searchParams ?? [])).toEqual({
      q: "ca",
      dict: "aaaaaaaaaaaa,bbbbbbbbbbbb",
    });
  });

  it("rejects modes wuDict does not support", async () => {
    const { app } = harness();
    expect((await app.request("/api/suggest?q=ca&mode=exact")).status).toBe(400);
  });
});

describe("GET /res/{dict}/{path}", () => {
  it("serves resources of allowed dictionaries with safe headers", async () => {
    const { app, upstream } = harness();
    const res = await app.request("/res/aaaaaaaaaaaa/img/cat.png", {
      headers: { ...browserHeaders, Range: "bytes=0-2" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("PNG-cat");
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("private, max-age=86400");
    expect(res.headers.get("content-security-policy")).toMatch(/^sandbox;/);
    expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("x-wudict-internal")).toBeNull();

    const [req] = upstream("/res/aaaaaaaaaaaa/img/cat.png");
    expect(req?.headers.get("range")).toBe("bytes=0-2");
    expect(req?.headers.get("cookie")).toBeNull();
  });

  it.each([
    "/res/wudict-howto/x.png",
    "/res/nothere00000/img/cat.png",
    "/res/aaaaaaaaaaaa/missing.png",
    "/res/aaaaaaaaaaaa/",
    "/res/aaaaaaaaaaaa",
    "/res/aaaaaaaaaaaa/img/%2e%2e/%2e%2e/api/config",
    "/res/aaaaaaaaaaaa/img%2f..%2fcat.png",
    "/res/aaaaaaaaaaaa/img//cat.png",
    "/res/aaaaaaaaaaaa/img/%00.png",
  ])("answers 404 for %s", async (url) => {
    const { app, fake } = harness();
    const res = await app.request(url);
    expect(res.status).toBe(404);
    const reached = fake.requests.map((r) => r.url.pathname).filter((p) => p !== "/api/dicts");
    expect(reached.filter((p) => p !== "/res/aaaaaaaaaaaa/missing.png")).toEqual([]);
  });
});

describe("upstream failures", () => {
  it("maps a refused token to 502 and logs it", async () => {
    const { app, fake, lines } = harness();
    await app.request("/api/dicts");
    fake.forceStatus = 401;
    const res = await app.request("/api/suggest?q=ca");
    expect(res.status).toBe(502);
    expect(ErrorBody.parse(await res.json()).error.code).toBe("wudict_unavailable");
    expect(lines.some((l) => l.includes("check AUTH_TOKEN"))).toBe(true);
  });

  it("maps a down wuDict to 502", async () => {
    const { app, fake } = harness();
    fake.down = true;
    const res = await app.request("/api/search?q=cat");
    expect(res.status).toBe(502);
    expect(ErrorBody.parse(await res.json()).error.code).toBe("wudict_unavailable");
  });

  it("maps a slow wuDict to 504", async () => {
    // Every request hangs until it is aborted.
    const hang: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    const { app } = harness({ fetch: hang, headersTimeoutMs: 20 });
    const res = await app.request("/api/search?q=cat");
    expect(res.status).toBe(504);
    expect(ErrorBody.parse(await res.json()).error.code).toBe("wudict_timeout");
  });
});
