import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryEntry, Me, MyDict } from "../api/app";
import { App } from "../App";
import { setDefaultMode } from "../lib/search-prefs";
import { me, methods, ndjson, stubBackend, type FakeBackend } from "../test/backend";
import { move } from "./Dictionaries";
import { groupByDay } from "./History";
import { queryFrom, searchPath } from "./SearchView";

let root: HTMLElement | undefined;
let backend: FakeBackend;

function mount(path: string): HTMLElement {
  history.replaceState(null, "", path);
  const el = document.createElement("div");
  document.body.append(el);
  render(<App />, el);
  root = el;
  return el;
}

const text = () => root?.textContent ?? "";
const tick = () => new Promise((r) => setTimeout(r, 0));

const dict = (id: string, title: string, more: Partial<MyDict> = {}): MyDict => ({
  id,
  title,
  format: "mdx",
  visibility: "global",
  enabled: true,
  position: 0,
  isNew: false,
  available: true,
  wudictId: `${id}-w`,
  ...more,
});

const entry = (id: number, query: string, createdAt: string): HistoryEntry => ({ id, query, mode: "exact", dictIds: null, createdAt });

function withMe(patch: Partial<Me> = {}): void {
  backend.on("GET", "/app-api/me", () => Response.json({ ...me, ...patch }));
}

beforeEach(() => {
  backend = stubBackend();
  backend.on("GET", "/app-api/auth/methods", () => Response.json(methods));
  backend.on("GET", "/api/dicts", () =>
    ndjson([{ t: "begin" }, { t: "dict", dict: { id: "d1", dictId: "one", enabled: true, name: "Dict One", format: "mdx", entries: 1, caps: {}, trustedRender: false } }, { t: "end" }]),
  );
  backend.on("GET", "/app-api/me/favorites", () => Response.json({ favorites: [] }));
  backend.on("GET", "/app-api/me/history", () => Response.json({ entries: [], nextCursor: null }));
});

afterEach(() => {
  if (root) render(null, root);
  root = undefined;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  localStorage.clear();
  setDefaultMode("exact");
  delete document.documentElement.dataset.font;
  delete document.documentElement.dataset.theme;
});

describe("helpers", () => {
  it("move() reorders", () => {
    expect(move(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(move(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(move(["a", "b"], 1, 9)).toEqual(["a", "b"]);
  });

  it("groupByDay() splits by local day", () => {
    const now = new Date(2026, 10, 25, 12);
    const groups = groupByDay(
      [
        entry(3, "c", new Date(2026, 10, 25, 9).toISOString()),
        entry(2, "b", new Date(2026, 10, 24, 23).toISOString()),
        entry(1, "a", new Date(2026, 10, 20, 8).toISOString()),
      ],
      now,
    );
    expect(groups.map((g) => [g.day, g.entries.map((e) => e.query)])).toEqual([
      ["Today", ["c"]],
      ["Yesterday", ["b"]],
      [expect.stringContaining("2026"), ["a"]],
    ]);
  });

  it("search URLs leave out the user's default mode", () => {
    setDefaultMode("prefix");
    expect(searchPath("cat", "prefix")).toBe("/?q=cat");
    expect(searchPath("cat", "exact")).toBe("/?q=cat&mode=exact");
    expect(queryFrom(new URLSearchParams("q=cat")).mode).toBe("prefix");
  });
});

describe("per-user features", () => {
  it("applies the user's settings on sign-in and uses the default mode", async () => {
    withMe({ settings: { ...me.settings, theme: "dark", fontSize: "large", defaultMode: "prefix", uiLang: "vi" } });
    backend.on("GET", "/api/search", () => ndjson([{ t: "begin", slots: [] }, { t: "end" }]));
    mount("/?q=cat");
    await vi.waitFor(() => {
      expect(backend.requests.some((r) => new URL(r.url).pathname === "/api/search")).toBe(true);
    });
    const search = backend.requests.find((r) => new URL(r.url).pathname === "/api/search");
    expect(new URL(search?.url ?? "http://x").searchParams.get("mode")).toBe("prefix");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.font).toBe("large");
    expect(document.documentElement.lang).toBe("vi");
  });

  it("announces new dictionaries and acknowledges them", async () => {
    withMe({ newDicts: [{ id: "gamma", title: "Gamma" }] });
    let seen = false;
    backend.on("POST", "/app-api/me/dicts/seen", () => {
      seen = true;
      return new Response(null, { status: 204 });
    });
    const root = mount("/");
    await vi.waitFor(() => {
      expect(text()).toContain("New dictionaries are available: Gamma.");
    });
    const ok = [...root.querySelectorAll<HTMLButtonElement>(".banner button")].find((b) => b.textContent === "OK");
    ok?.click();
    await vi.waitFor(() => {
      expect(seen).toBe(true);
    });
    await tick();
    expect(text()).not.toContain("Gamma");
  });

  it("saves a word from the results with the PXDict dictionary id", async () => {
    withMe();
    backend.on("GET", "/api/search", () =>
      ndjson([
        { t: "begin", slots: [{ dict: "d1", name: "Dict One" }] },
        { t: "hit", i: 0, dict: "d1", name: "Dict One", results: [{ Headword: "cat", Body: "a cat" }] },
        { t: "end" },
      ]),
    );
    let body: unknown;
    backend.on("POST", "/app-api/me/favorites", async (req) => {
      body = await req.json();
      return new Response(null, { status: 204 });
    });
    const root = mount("/?q=cat");
    await vi.waitFor(() => {
      expect(root.querySelector("button.star")).not.toBeNull();
    });
    root.querySelector<HTMLButtonElement>("button.star")?.click();
    await vi.waitFor(() => {
      expect(body).toEqual({ headword: "cat", dictId: "one" });
    });
    await vi.waitFor(() => {
      expect(root.querySelector("button.star")?.getAttribute("aria-pressed")).toBe("true");
    });
  });

  it("offers recent searches when the search box is empty", async () => {
    withMe();
    backend.on("GET", "/app-api/me/history", (req) => {
      expect(new URL(req.url).searchParams.get("unique")).toBe("1");
      return Response.json({ entries: [entry(1, "zebra", new Date().toISOString())], nextCursor: null });
    });
    const root = mount("/");
    await vi.waitFor(() => {
      expect(root.querySelector('input[name="q"]')).not.toBeNull();
    });
    await tick();
    root.querySelector<HTMLInputElement>('input[name="q"]')?.dispatchEvent(new FocusEvent("focus"));
    await vi.waitFor(() => {
      expect(root.querySelector("#suggestions")?.textContent).toBe("zebra");
    });
  });

  it("reorders and toggles dictionaries, saving each change", async () => {
    withMe();
    let list = [dict("alpha", "Alpha", { position: 0 }), dict("beta", "Beta", { position: 1, isNew: true })];
    const saved: unknown[] = [];
    backend.on("GET", "/app-api/me/dicts", () => Response.json({ dicts: list }));
    backend.on("POST", "/app-api/me/dicts/seen", () => new Response(null, { status: 204 }));
    backend.on("PUT", "/app-api/me/dicts", async (req) => {
      const b = (await req.json()) as { dicts: { id: string; enabled: boolean }[] };
      saved.push(b.dicts);
      list = b.dicts.map((d, i) => dict(d.id, d.id === "alpha" ? "Alpha" : "Beta", { enabled: d.enabled, position: i }));
      return Response.json({ dicts: list });
    });
    const root = mount("/dictionaries");
    await vi.waitFor(() => {
      expect(root.querySelectorAll(".dict-list li")).toHaveLength(2);
    });
    expect(backend.requests.some((r) => new URL(r.url).pathname === "/app-api/me/dicts/seen")).toBe(true);
    root.querySelector<HTMLButtonElement>('button[aria-label="Move Beta up"]')?.click();
    await vi.waitFor(() => {
      expect(saved).toEqual([[{ id: "beta", enabled: true }, { id: "alpha", enabled: true }]]);
    });
    await vi.waitFor(() => {
      expect(root.querySelector(".dict-list li")?.textContent).toContain("Beta");
    });
    const box = root.querySelector<HTMLInputElement>('.dict-list li input[type="checkbox"]');
    if (box) {
      box.checked = false;
      box.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await vi.waitFor(() => {
      expect(saved[1]).toEqual([{ id: "beta", enabled: false }, { id: "alpha", enabled: true }]);
    });
  });

  it("lists history by day, deletes an entry, and links to the lookup", async () => {
    withMe();
    let entries = [entry(2, "dog", new Date().toISOString()), entry(1, "cat", new Date().toISOString())];
    backend.on("GET", "/app-api/me/history", () => Response.json({ entries, nextCursor: null }));
    backend.on("DELETE", "/app-api/me/history/2", () => {
      entries = entries.filter((e) => e.id !== 2);
      return new Response(null, { status: 204 });
    });
    const root = mount("/history");
    await vi.waitFor(() => {
      expect(text()).toContain("Today");
    });
    expect([...root.querySelectorAll(".day li a")].map((a) => a.getAttribute("href"))).toEqual(["/?q=dog", "/?q=cat"]);
    expect(root.querySelector('a[href="/app-api/me/history/export?format=csv"]')).not.toBeNull();
    root.querySelector<HTMLButtonElement>('button[aria-label="Delete “dog” from history"]')?.click();
    await vi.waitFor(() => {
      expect(root.querySelectorAll(".day li")).toHaveLength(1);
    });
  });

  it("lists saved words and edits a note", async () => {
    withMe();
    backend.on("GET", "/app-api/me/dicts", () => Response.json({ dicts: [dict("alpha", "Alpha")] }));
    backend.on("GET", "/app-api/me/favorites", () =>
      Response.json({
        favorites: [{ headword: "cat", dictId: "alpha", dictTitle: "Alpha", note: null, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" }],
      }),
    );
    let body: unknown;
    backend.on("POST", "/app-api/me/favorites", async (req) => {
      body = await req.json();
      return new Response(null, { status: 204 });
    });
    const root = mount("/favorites");
    await vi.waitFor(() => {
      expect(root.querySelector(".favorite a")?.getAttribute("href")).toBe("/?q=cat&dict=alpha-w");
    });
    [...root.querySelectorAll<HTMLButtonElement>(".favorite button")].find((b) => b.textContent === "Add a note")?.click();
    await tick();
    const area = root.querySelector("textarea");
    if (area) {
      area.value = "a small pet";
      area.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await tick();
    root.querySelector(".favorite form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => {
      expect(body).toEqual({ headword: "cat", dictId: "alpha", note: "a small pet" });
    });
    await vi.waitFor(() => {
      expect(root.querySelector(".note")?.textContent).toBe("a small pet");
    });
  });
});
