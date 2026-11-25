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

describe("WudictCatalog", () => {
  it("lists every dictionary except the builtin howto, sorted", async () => {
    const { catalog } = setup();
    expect(await catalog.allowedIds()).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
  });

  it("reuses the list within the TTL and revalidates with the etag after it", async () => {
    const { fake, catalog, advance } = setup();
    await catalog.allowedIds();
    await catalog.allowedIds();
    expect(fake.requests).toHaveLength(1);

    advance(1500);
    expect(await catalog.allowedIds()).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
    expect(fake.requests).toHaveLength(2);
    expect(fake.lastRequest()?.headers.get("if-none-match")).toBe('"aaaaaaaaaaaa-bbbbbbbbbbbb"');

    fake.dicts = fake.dicts.slice(1);
    advance(1500);
    expect(await catalog.allowedIds()).toEqual(["bbbbbbbbbbbb"]);
  });

  it("shares one refresh between concurrent callers", async () => {
    const { fake, catalog } = setup();
    await Promise.all([catalog.allowedIds(), catalog.allowedIds(), catalog.allowedIds()]);
    expect(fake.requests).toHaveLength(1);
  });

  it("fails with the upstream status", async () => {
    const { fake, catalog } = setup();
    fake.forceStatus = 500;
    await expect(catalog.allowedIds()).rejects.toBeInstanceOf(WudictCatalogError);
  });
});
