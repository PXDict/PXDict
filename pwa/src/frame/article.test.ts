import { describe, expect, it } from "vitest";
import { articleDocument, linkAction, maxFrameHeight, parseFrameMessage, sandboxFor } from "./article";

const origin = "https://dict.example.com";

describe("linkAction", () => {
  it.each([
    ["entry://dog", { kind: "lookup", word: "dog" }],
    ["bword://ice%20cream", { kind: "lookup", word: "ice cream" }],
    ["entry://cat#sense2", { kind: "lookup", word: "cat" }],
    ["entry://", { kind: "none" }],
    ["/r/tok.sig/abc123/audio/cat.mp3", { kind: "audio", url: `${origin}/r/tok.sig/abc123/audio/cat.mp3` }],
    ["/res/abc123/a/b.OGG", { kind: "audio", url: `${origin}/res/abc123/a/b.OGG` }],
    ["/res/abc123/img/cat.png", { kind: "none" }],
    ["/api/config", { kind: "none" }],
    ["https://en.wikipedia.org/wiki/Cat", { kind: "external", url: "https://en.wikipedia.org/wiki/Cat" }],
    ["javascript:alert(1)", { kind: "none" }],
    ["data:text/html,hi", { kind: "none" }],
    [`${origin}/app-api/me`, { kind: "none" }],
    ["https://evil.example/x.mp3", { kind: "external", url: "https://evil.example/x.mp3" }],
  ])("%s", (href, want) => {
    expect(linkAction(href, origin)).toEqual(want);
  });
});

describe("parseFrameMessage", () => {
  it("accepts the three message types and clamps heights", () => {
    expect(parseFrameMessage({ type: "pxdict:ready" })).toEqual({ type: "ready" });
    expect(parseFrameMessage({ type: "pxdict:height", height: 123.4 })).toEqual({ type: "height", height: 123 });
    expect(parseFrameMessage({ type: "pxdict:height", height: 1e9 })).toEqual({ type: "height", height: maxFrameHeight });
    expect(parseFrameMessage({ type: "pxdict:height", height: -5 })).toEqual({ type: "height", height: 0 });
    expect(parseFrameMessage({ type: "pxdict:link", href: "entry://x" })).toEqual({ type: "link", href: "entry://x" });
  });

  it.each([null, "x", 1, {}, { type: "pxdict:height", height: "1" }, { type: "pxdict:height", height: NaN }, { type: "pxdict:link", href: 1 }, { type: "other" }])(
    "rejects %j",
    (data) => {
      expect(parseFrameMessage(data)).toBeUndefined();
    },
  );
});

describe("articleDocument", () => {
  it("puts the runtime in <head>, before the untrusted article", () => {
    const doc = articleDocument({ body: "<textarea><b>cat", theme: "dark", lang: "vi" });
    expect(doc.indexOf("<script>")).toBeLessThan(doc.indexOf("<body>"));
    expect(doc).toContain('<html lang="vi">');
    expect(doc).toContain("color-scheme:dark");
    expect(doc).toContain("<body><textarea><b>cat</body>");
  });
});

describe("sandboxFor", () => {
  it("isolates untrusted dictionaries in an opaque origin", () => {
    expect(sandboxFor(false)).toBe("allow-scripts");
    expect(sandboxFor(true)).toContain("allow-same-origin");
  });
});
