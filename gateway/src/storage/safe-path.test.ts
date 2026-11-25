import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diskUsage, relPathProblem, safeJoin, safeJoinSync, safeRemove, UnsafePathError } from "./safe-path";

describe("relPathProblem", () => {
  it.each(["a.mdx", "img/cat.png", "Oxford 2024/oxford.mdx", "ü/tệp.css"])("accepts %j", (rel) => {
    expect(relPathProblem(rel)).toBeUndefined();
  });

  it.each([
    ["", "empty"],
    ["/etc/passwd", "absolute"],
    ["../x", "dot segment"],
    ["a/../../x", "dot segment"],
    ["a/./b", "dot segment"],
    ["a//b", "empty segment"],
    ["a\\b", "backslash, colon or control character"],
    ["C:x", "backslash, colon or control character"],
    ["a\0b", "backslash, colon or control character"],
    [".hidden", "hidden name"],
    [" lead", "leading or trailing space"],
    ["x".repeat(256), "name too long"],
  ])("refuses %j (%s)", (rel, problem) => {
    expect(relPathProblem(rel)).toBe(problem);
  });
});

describe("safeJoin", () => {
  let root: string;
  let outside: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pxdict-safe-"));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), "pxdict-outside-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("joins plain paths, existing or not", async () => {
    fs.mkdirSync(path.join(root, "a"));
    expect(await safeJoin(root, "a/b/c.txt")).toBe(path.join(root, "a", "b", "c.txt"));
    expect(safeJoinSync(root, "x")).toBe(path.join(root, "x"));
  });

  it("refuses traversal", async () => {
    await expect(safeJoin(root, "../x")).rejects.toBeInstanceOf(UnsafePathError);
  });

  it("refuses a symlink anywhere below the root", async () => {
    fs.symlinkSync(outside, path.join(root, "link"));
    await expect(safeJoin(root, "link/file")).rejects.toThrow(/symlink/);
    expect(() => safeJoinSync(root, "link")).toThrow(/symlink/);
  });

  it("removes a folder without following links inside it, and counts the bytes", async () => {
    fs.mkdirSync(path.join(root, "p/sub"), { recursive: true });
    fs.writeFileSync(path.join(root, "p/a"), "12345");
    fs.writeFileSync(path.join(root, "p/sub/b"), "123");
    fs.writeFileSync(path.join(outside, "keep"), "important");
    fs.symlinkSync(outside, path.join(root, "p/sub/out"));
    expect(await diskUsage(path.join(root, "p"))).toBe(8);
    expect(await safeRemove(root, "p")).toBe(8);
    expect(fs.existsSync(path.join(root, "p"))).toBe(false);
    expect(fs.readFileSync(path.join(outside, "keep"), "utf8")).toBe("important");
    expect(await safeRemove(root, "missing")).toBe(0);
  });
});
