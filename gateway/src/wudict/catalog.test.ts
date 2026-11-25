import { describe, expect, it } from "vitest";
import { testToken } from "../test/harness";
import { WudictCatalog, WudictCatalogError } from "./catalog";
import { WudictClient } from "./client";
import { FakeWudict } from "./fake";

function setup() {
  const fake = new FakeWudict({ token: testToken });
  const client = new WudictClient({ baseUrl: new URL("http://127.0.0.1:6888"), token: testToken, fetch: fake.fetch });
  let now = 0;
  const catalog = new WudictCatalog({ client, ttlMs: 1000, now: () => now });
  return { fake, catalog, advance: (ms: number) => (now += ms) };
}

const ids = async (catalog: WudictCatalog) => (await catalog.snapshot()).rows.map((r) => r.id);

describe("WudictCatalog", () => {
  it("lists every dictionary except the builtin howto, sorted", async () => {
    const { catalog } = setup();
    expect(await ids(catalog)).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
  });

  it("keeps the fields the registry matches on, and no other paths", async () => {
    const { catalog } = setup();
    expect((await catalog.snapshot()).rows[0]).toEqual({
      id: "aaaaaaaaaaaa",
      name: "Alpha",
      format: "mdx",
      libraryDir: "Alpha",
      sourcePath: "/data/dictionaries/Alpha/Alpha.mdx",
    });
  });

  it("reuses the list within the TTL and revalidates with the etag after it", async () => {
    const { fake, catalog, advance } = setup();
    const first = await catalog.snapshot();
    await catalog.snapshot();
    expect(fake.requests).toHaveLength(1);

    advance(1500);
    const second = await catalog.snapshot();
    expect(second.rows.map((r) => r.id)).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
    // 304: same listing, same version.
    expect(second.version).toBe(first.version);
    expect(fake.requests).toHaveLength(2);
    expect(fake.lastRequest()?.headers.get("if-none-match")).toBe('"aaaaaaaaaaaa-bbbbbbbbbbbb"');

    fake.dicts = fake.dicts.slice(1);
    advance(1500);
    const third = await catalog.snapshot();
    expect(third.rows.map((r) => r.id)).toEqual(["bbbbbbbbbbbb"]);
    expect(third.version).not.toBe(first.version);
  });

  it("shares one refresh between concurrent callers", async () => {
    const { fake, catalog } = setup();
    await Promise.all([catalog.snapshot(), catalog.snapshot(), catalog.snapshot()]);
    expect(fake.requests).toHaveLength(1);
  });

  it("fails with the upstream status", async () => {
    const { fake, catalog } = setup();
    fake.forceStatus = 500;
    await expect(catalog.snapshot()).rejects.toBeInstanceOf(WudictCatalogError);
  });
});
