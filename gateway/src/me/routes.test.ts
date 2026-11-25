import { ErrorBody, FavoriteList, HistoryPage, Me, MyDictList, UserSettings } from "@pxdict/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { dictionaries } from "../db/schema";
import { harness, ndjsonLines, type TestClient } from "../test/harness";
import { csvField } from "./routes";

const json = async <T>(res: Response, schema: { parse: (v: unknown) => T }): Promise<T> => schema.parse(await res.json());

const put = (c: TestClient, path: string, body: unknown) =>
  c.request(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function twoUsers() {
  const h = harness();
  const a = await h.signedIn({ email: "a@example.com" });
  const b = await h.signedIn({ email: "b@example.com" });
  // Lets the gateway learn wuDict's dictionaries.
  await a.client.request("/app-api/me/dicts");
  return { ...h, a, b };
}

const searchDicts = (h: ReturnType<typeof harness>) => h.upstream("/api/search").at(-1)?.url.searchParams.get("dict");

describe("/app-api/me", () => {
  it("includes the user's settings and new dictionaries", async () => {
    const { a } = await twoUsers();
    const me = await json(await a.client.request("/app-api/me"), Me);
    expect(me.settings).toEqual({
      historyEnabled: true,
      historyRetentionDays: 90,
      defaultMode: "exact",
      uiLang: null,
      theme: "system",
      fontSize: "medium",
    });
    expect(me.newDicts).toEqual([]);
  });

  it("needs a session and, for writes, the origin", async () => {
    const { client, a } = await twoUsers();
    expect((await client().request("/app-api/me/settings")).status).toBe(401);
    expect((await client().request("/app-api/me/unknown")).status).toBe(401);
    const res = await a.client.request("/app-api/me/history", { method: "DELETE", headers: { Origin: "https://evil.example" } });
    expect(res.status).toBe(403);
    expect((await a.client.request("/app-api/me/settings")).headers.get("cache-control")).toBe("no-store");
  });
});

describe("/app-api/me/settings", () => {
  it("changes only the given fields and validates them", async () => {
    const { a } = await twoUsers();
    const res = await put(a.client, "/app-api/me/settings", { defaultMode: "prefix", fontSize: "large", uiLang: "vi" });
    expect(await json(res, UserSettings)).toMatchObject({ defaultMode: "prefix", fontSize: "large", uiLang: "vi", theme: "system" });
    await put(a.client, "/app-api/me/settings", { theme: "dark" });
    expect(await json(await a.client.request("/app-api/me/settings"), UserSettings)).toMatchObject({ defaultMode: "prefix", theme: "dark" });
    for (const bad of [{ theme: "neon" }, { historyRetentionDays: -1 }, { uiLang: "<script>" }, "nope"]) {
      expect((await put(a.client, "/app-api/me/settings", bad)).status).toBe(400);
    }
  });
});

describe("search history", () => {
  it("records searches (not suggestions), merges repeats, and honours the setting", async () => {
    const { a } = await twoUsers();
    await a.client.request("/api/search?q=cat&mode=exact");
    await a.client.request("/api/search?q=cat&mode=exact");
    await a.client.request("/api/suggest?q=ca");
    await a.client.request("/api/search?q=zebra&mode=prefix&dict=bbbbbbbbbbbb");
    await a.client.request("/api/search?q=%20%20"); // invalid: not recorded
    const page = await json(await a.client.request("/app-api/me/history"), HistoryPage);
    expect(page.entries.map((e) => [e.query, e.mode, e.dictIds])).toEqual([
      ["zebra", "prefix", ["beta"]],
      ["cat", "exact", null],
    ]);

    await put(a.client, "/app-api/me/settings", { historyEnabled: false });
    await a.client.request("/api/search?q=dog");
    expect((await json(await a.client.request("/app-api/me/history"), HistoryPage)).entries).toHaveLength(2);
  });

  it("filters, deletes one and deletes all", async () => {
    const { a } = await twoUsers();
    for (const q of ["cat", "car", "dog"]) await a.client.request(`/api/search?q=${q}`);
    const filtered = await json(await a.client.request("/app-api/me/history?q=ca&unique=1"), HistoryPage);
    expect(filtered.entries.map((e) => e.query)).toEqual(["car", "cat"]);
    expect((await a.client.request("/app-api/me/history?limit=999")).status).toBe(400);

    const id = filtered.entries[0]?.id ?? 0;
    expect((await a.client.request(`/app-api/me/history/${String(id)}`, { method: "DELETE" })).status).toBe(204);
    expect((await a.client.request(`/app-api/me/history/${String(id)}`, { method: "DELETE" })).status).toBe(404);
    expect((await a.client.request("/app-api/me/history", { method: "DELETE" })).status).toBe(204);
    expect((await json(await a.client.request("/app-api/me/history"), HistoryPage)).entries).toEqual([]);
  });

  it("exports as JSON and CSV", async () => {
    const { a } = await twoUsers();
    await a.client.request("/api/search?q=%3D1%2B1&mode=exact");
    const j = await a.client.request("/app-api/me/history/export?format=json");
    expect(j.headers.get("content-disposition")).toMatch(/^attachment; filename="pxdict-history-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(((await j.json()) as { history: { query: string }[] }).history[0]?.query).toBe("=1+1");
    const c = await a.client.request("/app-api/me/history/export?format=csv");
    expect(c.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    const lines = (await c.text()).trim().split("\r\n");
    expect(lines[0]).toBe('"time","query","mode","dictionaries"');
    expect(lines[1]).toMatch(/^"[^"]+","'=1\+1","exact",""$/);
    expect((await a.client.request("/app-api/me/history/export?format=xml")).status).toBe(400);
  });
});

describe("csvField", () => {
  it.each([
    ["plain", '"plain"'],
    ['say "hi"', '"say ""hi"""'],
    ["=HYPERLINK()", `"'=HYPERLINK()"`],
    ["-1", `"'-1"`],
    [null, '""'],
  ])("%j → %s", (v, out) => {
    expect(csvField(v)).toBe(out);
  });
});

describe("/app-api/me/dicts", () => {
  it("lists every global dictionary for a new user, enabled, without filesystem data", async () => {
    const { a } = await twoUsers();
    const res = await a.client.request("/app-api/me/dicts");
    const { dicts } = await json(res, MyDictList);
    expect(dicts).toEqual([
      { id: "alpha", title: "Alpha", format: "mdx", visibility: "global", enabled: true, position: 0, isNew: false, available: true, wudictId: "aaaaaaaaaaaa" },
      { id: "beta", title: "Beta", format: "mdx", visibility: "global", enabled: true, position: 1, isNew: false, available: true, wudictId: "bbbbbbbbbbbb" },
    ]);
  });

  it("decides the default search set and its order, per user", async () => {
    const h = await twoUsers();
    const { a, b } = h;
    const res = await put(a.client, "/app-api/me/dicts", { dicts: [{ id: "beta", enabled: true }, { id: "alpha", enabled: true }] });
    expect((await json(res, MyDictList)).dicts.map((d) => d.id)).toEqual(["beta", "alpha"]);
    await a.client.request("/api/search?q=cat");
    expect(searchDicts(h)).toBe("bbbbbbbbbbbb,aaaaaaaaaaaa");
    await b.client.request("/api/search?q=cat");
    expect(searchDicts(h)).toBe("aaaaaaaaaaaa,bbbbbbbbbbbb");

    await put(a.client, "/app-api/me/dicts", { dicts: [{ id: "beta", enabled: false }] });
    await a.client.request("/api/search?q=cat");
    expect(searchDicts(h)).toBe("aaaaaaaaaaaa");
    await a.client.request("/api/suggest?q=c");
    expect(h.upstream("/api/suggest").at(-1)?.url.searchParams.get("dict")).toBe("aaaaaaaaaaaa");
    // A disabled dictionary can still be searched on purpose, and its resources still load.
    await a.client.request("/api/search?q=cat&dict=bbbbbbbbbbbb");
    expect(searchDicts(h)).toBe("bbbbbbbbbbbb");

    const dicts = await ndjsonLines(await a.client.request("/api/dicts"));
    expect(dicts.filter((l) => l.t === "dict").map((l) => l.dict)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "bbbbbbbbbbbb", dictId: "beta", enabled: false }),
        expect.objectContaining({ id: "aaaaaaaaaaaa", dictId: "alpha", enabled: true }),
      ]),
    );
  });

  it("refuses unknown ids and malformed lists", async () => {
    const { a } = await twoUsers();
    expect((await put(a.client, "/app-api/me/dicts", { dicts: [{ id: "nope", enabled: true }] })).status).toBe(404);
    expect((await put(a.client, "/app-api/me/dicts", { dicts: [{ id: "alpha", enabled: true }, { id: "alpha", enabled: false }] })).status).toBe(400);
  });

  it("names dictionaries with PXDict's titles in search results", async () => {
    const { db, a } = await twoUsers();
    db.update(dictionaries).set({ title: "Alpha EN–VI" }).where(eq(dictionaries.id, "alpha")).run();
    const lines = await ndjsonLines(await a.client.request("/api/search?q=cat"));
    expect(lines[0]).toEqual({ t: "begin", slots: [{ dict: "aaaaaaaaaaaa", name: "Alpha EN–VI" }, { dict: "bbbbbbbbbbbb", name: "Beta" }] });
    expect(lines.find((l) => l.dict === "aaaaaaaaaaaa")?.name).toBe("Alpha EN–VI");
  });

  it("announces a dictionary published later until the user acknowledges it", async () => {
    const { fake, a, b } = await twoUsers();
    await b.client.request("/app-api/me/dicts");
    fake.dicts = [...fake.dicts, { id: "cccccccccccc", name: "Gamma", entries: { cat: "a gamma cat" } }];
    expect((await json(await a.client.request("/app-api/me"), Me)).newDicts).toEqual([{ id: "gamma", title: "Gamma" }]);
    const { dicts } = await json(await a.client.request("/app-api/me/dicts"), MyDictList);
    expect(dicts.at(-1)).toMatchObject({ id: "gamma", enabled: true, isNew: true, position: 2 });
    expect((await a.client.request("/app-api/me/dicts/seen", { method: "POST" })).status).toBe(204);
    expect((await json(await a.client.request("/app-api/me"), Me)).newDicts).toEqual([]);
    expect((await json(await b.client.request("/app-api/me"), Me)).newDicts).toHaveLength(1);
  });

  it("drops hidden and vanished dictionaries for everyone without errors", async () => {
    const h = await twoUsers();
    const { db, fake, a, b } = h;
    db.update(dictionaries).set({ visibility: "hidden" }).where(eq(dictionaries.id, "alpha")).run();
    for (const c of [a.client, b.client]) {
      expect((await json(await c.request("/app-api/me/dicts"), MyDictList)).dicts.map((d) => d.id)).toEqual(["beta"]);
      const res = await c.request("/api/search?q=cat&dict=aaaaaaaaaaaa");
      expect(res.status).toBe(200);
      expect(await ndjsonLines(res)).toEqual([{ t: "begin", slots: [] }, { t: "end" }]);
      expect((await c.request("/res/aaaaaaaaaaaa/img/cat.png")).status).toBe(404);
    }

    fake.dicts = [];
    const { dicts } = await json(await a.client.request("/app-api/me/dicts"), MyDictList);
    expect(dicts).toEqual([expect.objectContaining({ id: "beta", available: false, wudictId: null })]);
    const res = await a.client.request("/api/search?q=cat");
    expect(await ndjsonLines(res)).toEqual([{ t: "begin", slots: [] }, { t: "end" }]);
    // Nothing left to search: answered by the gateway alone.
    expect(h.upstream("/api/search")).toEqual([]);
  });
});

describe("/app-api/me/favorites", () => {
  it("saves, re-notes, lists, exports and deletes", async () => {
    const { a } = await twoUsers();
    const save = (body: unknown) => a.client.post("/app-api/me/favorites", body);
    expect((await save({ headword: " cat ", dictId: "alpha" })).status).toBe(204);
    expect((await save({ headword: "cat", dictId: "alpha", note: "=cmd" })).status).toBe(204);
    expect((await save({ headword: "zebra", dictId: "beta", note: "  " })).status).toBe(204);
    for (const bad of [{ headword: "", dictId: "alpha" }, { headword: "x", dictId: "../etc" }, { headword: "x".repeat(501), dictId: "alpha" }]) {
      expect((await save(bad)).status).toBe(400);
    }
    expect((await save({ headword: "x", dictId: "nope" })).status).toBe(404);

    const { favorites } = await json(await a.client.request("/app-api/me/favorites"), FavoriteList);
    expect(favorites.map((f) => [f.headword, f.dictId, f.dictTitle, f.note])).toEqual(
      expect.arrayContaining([
        ["cat", "alpha", "Alpha", "=cmd"],
        ["zebra", "beta", "Beta", null],
      ]),
    );
    expect(favorites).toHaveLength(2);

    const csv = await (await a.client.request("/app-api/me/favorites/export?format=csv")).text();
    expect(csv).toContain(`"cat","Alpha","'=cmd"`);

    expect((await a.client.request("/app-api/me/favorites?headword=cat&dict=alpha", { method: "DELETE" })).status).toBe(204);
    expect((await a.client.request("/app-api/me/favorites?headword=cat&dict=alpha", { method: "DELETE" })).status).toBe(404);
    expect((await json(await a.client.request("/app-api/me/favorites"), FavoriteList)).favorites).toHaveLength(1);
  });
});

describe("isolation between users", () => {
  it("never shows one user's history, favorites or private dictionaries to another", async () => {
    const h = await twoUsers();
    const { db, a, b } = h;
    db.update(dictionaries)
      .set({ visibility: "private", ownerUserId: a.user.id })
      .where(eq(dictionaries.id, "beta"))
      .run();

    await a.client.request("/api/search?q=zebra&dict=bbbbbbbbbbbb");
    await a.client.post("/app-api/me/favorites", { headword: "zebra", dictId: "beta" });
    const aHistory = await json(await a.client.request("/app-api/me/history"), HistoryPage);
    expect(aHistory.entries).toHaveLength(1);

    // History and favorites
    expect((await json(await b.client.request("/app-api/me/history"), HistoryPage)).entries).toEqual([]);
    expect((await json(await b.client.request("/app-api/me/favorites"), FavoriteList)).favorites).toEqual([]);
    const id = String(aHistory.entries[0]?.id ?? 0);
    expect((await b.client.request(`/app-api/me/history/${id}`, { method: "DELETE" })).status).toBe(404);
    await b.client.request("/app-api/me/history", { method: "DELETE" });
    expect((await json(await a.client.request("/app-api/me/history"), HistoryPage)).entries).toHaveLength(1);
    expect((await b.client.request("/app-api/me/favorites?headword=zebra&dict=beta", { method: "DELETE" })).status).toBe(404);
    expect(await (await b.client.request("/app-api/me/history/export?format=csv")).text()).not.toContain("zebra");

    // The private dictionary: listed, searchable and loadable only for its owner.
    const bDicts = (await json(await b.client.request("/app-api/me/dicts"), MyDictList)).dicts.map((d) => d.id);
    expect(bDicts).toEqual(["alpha"]);
    const aDicts = (await json(await a.client.request("/app-api/me/dicts"), MyDictList)).dicts;
    expect(aDicts.find((d) => d.id === "beta")).toMatchObject({ visibility: "private" });
    const listed = await ndjsonLines(await b.client.request("/api/dicts"));
    expect(JSON.stringify(listed)).not.toContain("bbbbbbbbbbbb");
    await b.client.request("/api/search?q=zebra");
    expect(searchDicts(h)).toBe("aaaaaaaaaaaa");
    const direct = await b.client.request("/api/search?q=zebra&dict=bbbbbbbbbbbb");
    expect(await ndjsonLines(direct)).toEqual([{ t: "begin", slots: [] }, { t: "end" }]);
    expect((await b.client.post("/app-api/me/favorites", { headword: "zebra", dictId: "beta" })).status).toBe(404);
    expect((await put(b.client, "/app-api/me/dicts", { dicts: [{ id: "beta", enabled: true }] })).status).toBe(404);

    // Owner's view is unaffected; another user's favorite in a dictionary no longer visible hides the title.
    expect((await json(await a.client.request("/app-api/me/favorites"), FavoriteList)).favorites[0]).toMatchObject({ dictTitle: "Beta" });
    db.update(dictionaries).set({ visibility: "hidden" }).where(eq(dictionaries.id, "beta")).run();
    expect((await json(await a.client.request("/app-api/me/favorites"), FavoriteList)).favorites[0]).toMatchObject({ dictTitle: null });
  });

  it("errors use the shared shape", async () => {
    const { a } = await twoUsers();
    const res = await a.client.post("/app-api/me/favorites", { headword: "x", dictId: "nope" });
    expect(ErrorBody.parse(await res.json()).error.code).toBe("unknown_dict");
  });
});
