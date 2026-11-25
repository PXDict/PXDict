import { afterEach, describe, expect, it } from "vitest";
import { loginUrl, navigate, safeNext } from "./router";

describe("safeNext", () => {
  it.each([
    [null, "/"],
    ["/?q=cat", "/?q=cat"],
    ["/account", "/account"],
    ["//evil.example/", "/"],
    ["/\\evil.example", "/"],
    ["https://evil.example/", "/"],
    ["javascript:alert(1)", "/"],
  ])("%s → %s", (raw, want) => {
    expect(safeNext(raw)).toBe(want);
  });
});

describe("loginUrl", () => {
  afterEach(() => {
    history.replaceState(null, "", "/");
  });

  it("keeps the pending page", () => {
    navigate("/?q=cat&mode=prefix");
    expect(loginUrl()).toBe("/login?next=%2F%3Fq%3Dcat%26mode%3Dprefix");
    navigate("/");
    expect(loginUrl()).toBe("/login");
  });
});
