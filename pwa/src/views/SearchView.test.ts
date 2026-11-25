import { describe, expect, it } from "vitest";
import { queryFrom, searchPath } from "./SearchView";

describe("queryFrom", () => {
  it.each([
    ["q=cat", { q: "cat", mode: "exact" }],
    ["q=+cat+&mode=prefix", { q: "cat", mode: "prefix" }],
    ["q=cat&mode=bogus", { q: "cat", mode: "exact" }],
    ["title=shared+text", { q: "shared text", mode: "exact" }],
    ["q=cat&dict=abc", { q: "cat", mode: "exact", only: "abc" }],
    ["", { q: "", mode: "exact" }],
  ])("%s", (query, want) => {
    expect(queryFrom(new URLSearchParams(query))).toEqual(want);
  });
});

describe("searchPath", () => {
  it("omits defaults", () => {
    expect(searchPath("cat", "exact")).toBe("/?q=cat");
    expect(searchPath("a b", "fts", "d1")).toBe("/?q=a+b&mode=fts&dict=d1");
    expect(searchPath("", "exact")).toBe("/");
  });
});
