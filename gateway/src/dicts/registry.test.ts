import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/client";
import { dictionaries, user } from "../db/schema";
import { createLogger } from "../log";
import { migrationsDir } from "../test/harness";
import type { CatalogSnapshot, WudictDictRow } from "../wudict/catalog";
import { DictRegistry, slugify } from "./registry";

function setup(builtinVisibility: "global" | "hidden" = "global") {
  const db = openDatabase({ file: ":memory:", migrationsDir });
  let snap: CatalogSnapshot = { rows: [], version: 0 };
  const catalog = { snapshot: () => Promise.resolve(snap) };
  const registry = new DictRegistry({ db, catalog, logger: createLogger("error", () => undefined), builtinVisibility });
  let version = 0;
  const list = (rows: WudictDictRow[]) => {
    snap = { rows, version: ++version };
    return registry.refresh();
  };
  const addUser = (id: string) => {
    db.insert(user).values({ id, name: id, email: `${id}@example.com`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() }).run();
  };
  const rows = () => db.select().from(dictionaries).orderBy(dictionaries.id).all();
  return { db, registry, list, addUser, rows };
}

const row = (id: string, name: string, more: Partial<WudictDictRow> = {}): WudictDictRow => ({
  id,
  name,
  format: "mdx",
  libraryDir: name,
  sourcePath: `/data/dictionaries/${name}/${name}.mdx`,
  ...more,
});

describe("slugify", () => {
  it.each([
    ["Oxford EN–VI", "oxford-en-vi"],
    ["Từ điển Đức–Việt", "tu-dien-duc-viet"],
    ["  ***  ", "dict"],
    ["汉越词典", "dict"],
    ["a".repeat(80), "a".repeat(48)],
  ])("%j → %j", (title, id) => {
    expect(slugify(title)).toBe(id);
  });
});

describe("DictRegistry.sync", () => {
  it("creates a builtin row per new dictionary, with unique readable ids", async () => {
    const { list, rows } = setup();
    await list([row("aaaaaaaaaaaa", "Alpha"), row("bbbbbbbbbbbb", "Alpha", { libraryDir: "Alpha (dsl)", sourcePath: "/x.dsl" })]);
    expect(rows().map((r) => [r.id, r.wudictId, r.source, r.visibility])).toEqual([
      ["alpha", "aaaaaaaaaaaa", "builtin", "global"],
      ["alpha-2", "bbbbbbbbbbbb", "builtin", "global"],
    ]);
  });

  it("uses BUILTIN_DICT_VISIBILITY for found dictionaries", async () => {
    const { list, rows } = setup("hidden");
    await list([row("aaaaaaaaaaaa", "Alpha")]);
    expect(rows()[0]?.visibility).toBe("hidden");
  });

  it("keeps the PXDict id when wuDict's id changes (library folder, then source path)", async () => {
    const { list, rows } = setup();
    await list([row("aaaaaaaaaaaa", "Alpha"), row("bbbbbbbbbbbb", "Beta", { libraryDir: undefined })]);
    // Originals of Alpha deleted: new id, same library folder. Beta moved into the index: same source.
    await list([
      row("111111111111", "Alpha", { sourcePath: undefined }),
      row("222222222222", "Beta", { libraryDir: "Beta" }),
    ]);
    expect(rows().map((r) => [r.id, r.wudictId, r.libraryDir])).toEqual([
      ["alpha", "111111111111", "Alpha"],
      ["beta", "222222222222", "Beta"],
    ]);
  });

  it("marks dictionaries wuDict no longer lists as unavailable and matches them when they return", async () => {
    const { list, rows } = setup();
    await list([row("aaaaaaaaaaaa", "Alpha")]);
    await list([]);
    expect(rows()[0]?.wudictId).toBeNull();
    await list([row("cccccccccccc", "Alpha")]);
    expect(rows().map((r) => [r.id, r.wudictId])).toEqual([["alpha", "cccccccccccc"]]);
  });

  it("does not overwrite a title set in PXDict", async () => {
    const { db, list, rows } = setup();
    await list([row("aaaaaaaaaaaa", "Alpha")]);
    db.update(dictionaries).set({ title: "Alpha (curated)" }).where(eq(dictionaries.id, "alpha")).run();
    await list([row("aaaaaaaaaaaa", "Alpha v2")]);
    expect(rows()[0]?.title).toBe("Alpha (curated)");
  });
});

describe("DictRegistry per user", () => {
  it("gives a new user every global dictionary, enabled, by title, none of them new", async () => {
    const { registry, list, addUser } = setup();
    addUser("u1");
    await list([row("bbbbbbbbbbbb", "Beta"), row("aaaaaaaaaaaa", "Alpha")]);
    expect(registry.list("u1").map((u) => [u.dict.id, u.enabled, u.position, u.isNew])).toEqual([
      ["alpha", true, 0, false],
      ["beta", true, 1, false],
    ]);
  });

  it("appends a dictionary published later, enabled and flagged new until seen", async () => {
    const { registry, list, addUser } = setup();
    addUser("u1");
    await list([row("aaaaaaaaaaaa", "Alpha")]);
    registry.update("u1", [{ id: "alpha", enabled: false }]);
    await list([row("aaaaaaaaaaaa", "Alpha"), row("bbbbbbbbbbbb", "Zulu")]);
    expect(registry.list("u1").map((u) => [u.dict.id, u.enabled, u.isNew])).toEqual([
      ["alpha", false, false],
      ["zulu", true, true],
    ]);
    registry.markSeen("u1");
    expect(registry.list("u1").some((u) => u.isNew)).toBe(false);
  });

  it("shows private dictionaries only to their owner and hidden ones to nobody", async () => {
    const { db, registry, list, addUser } = setup();
    addUser("u1");
    addUser("u2");
    await list([row("aaaaaaaaaaaa", "Alpha"), row("bbbbbbbbbbbb", "Beta"), row("cccccccccccc", "Gamma")]);
    db.update(dictionaries).set({ visibility: "private", ownerUserId: "u1" }).where(eq(dictionaries.id, "beta")).run();
    db.update(dictionaries).set({ visibility: "hidden" }).where(eq(dictionaries.id, "gamma")).run();
    expect(registry.list("u1").map((u) => u.dict.id)).toEqual(["alpha", "beta"]);
    expect(registry.list("u2").map((u) => u.dict.id)).toEqual(["alpha"]);
    expect(registry.visible("u2", "beta")).toBeUndefined();
    expect(registry.visible("u1", "beta")?.id).toBe("beta");
  });

  it("orders and enables per user; dictionaries left out keep their place after the listed ones", async () => {
    const { registry, list, addUser } = setup();
    addUser("u1");
    addUser("u2");
    await list([row("aaaaaaaaaaaa", "Alpha"), row("bbbbbbbbbbbb", "Beta"), row("cccccccccccc", "Gamma")]);
    expect(registry.update("u1", [{ id: "gamma", enabled: true }, { id: "alpha", enabled: false }])).toBe(true);
    expect(registry.list("u1").map((u) => [u.dict.id, u.enabled])).toEqual([
      ["gamma", true],
      ["alpha", false],
      ["beta", true],
    ]);
    expect(registry.list("u2").map((u) => u.dict.id)).toEqual(["alpha", "beta", "gamma"]);
    expect(registry.update("u1", [{ id: "nope", enabled: true }])).toBe(false);

    const view = await registry.forUser("u1");
    expect(view.enabled).toEqual(["cccccccccccc", "bbbbbbbbbbbb"]);
    expect([...view.usable.keys()]).toEqual(["cccccccccccc", "aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
  });

  it("leaves unavailable dictionaries out of the proxy's view but keeps the user's choice", async () => {
    const { registry, list, addUser } = setup();
    addUser("u1");
    await list([row("aaaaaaaaaaaa", "Alpha"), row("bbbbbbbbbbbb", "Beta")]);
    registry.update("u1", [{ id: "beta", enabled: false }]);
    await list([row("aaaaaaaaaaaa", "Alpha")]);
    expect([...(await registry.forUser("u1")).usable.keys()]).toEqual(["aaaaaaaaaaaa"]);
    await list([row("aaaaaaaaaaaa", "Alpha"), row("bbbbbbbbbbbb", "Beta")]);
    expect(registry.list("u1").find((u) => u.dict.id === "beta")?.enabled).toBe(false);
  });
});
