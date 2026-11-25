import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeZip, type ZipEntrySpec } from "../test/zip";
import { defaultZipLimits, stripCommonFolder, unpackZip, ZipRejectedError } from "./zip";

describe("stripCommonFolder", () => {
  it.each([
    [["Oxford/a.mdx", "Oxford/img/b.png"], ["a.mdx", "img/b.png"]],
    [["a.mdx", "Oxford/b.png"], ["a.mdx", "Oxford/b.png"]],
    [["A/a.mdx", "B/b.png"], ["A/a.mdx", "B/b.png"]],
  ])("%j → %j", (input, output) => {
    expect(stripCommonFolder(input)).toEqual(output);
  });
});

describe("unpackZip", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pxdict-zip-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const limits = defaultZipLimits(10 << 20);
  const unpack = (entries: ZipEntrySpec[], l = limits) => {
    const file = path.join(dir, "in.zip");
    fs.writeFileSync(file, makeZip(entries));
    return unpackZip(file, path.join(dir, "out"), l);
  };

  it("unpacks files, drops a shared top folder and junk, and hashes each file", async () => {
    const files = await unpack([
      { name: "Oxford/" },
      { name: "Oxford/oxford.mdx", data: "MDX", deflate: true },
      { name: "Oxford/img/cat.png", data: "PNG" },
      { name: "__MACOSX/Oxford/._oxford.mdx", data: "junk" },
      { name: "Oxford/.DS_Store", data: "junk" },
    ]);
    expect(files.map((f) => [f.relPath, f.bytes])).toEqual([
      ["oxford.mdx", 3],
      ["img/cat.png", 3],
    ]);
    expect(files[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readFileSync(path.join(dir, "out/img/cat.png"), "utf8")).toBe("PNG");
  });

  it.each<[string, ZipEntrySpec[], RegExp]>([
    ["path traversal", [{ name: "../evil.mdx", data: "x" }], /invalid archive|invalid name/],
    ["an absolute path", [{ name: "/etc/evil.mdx", data: "x" }], /invalid archive|invalid name/],
    ["a symlink", [{ name: "a.mdx", data: "/etc/passwd", mode: 0o120777 }], /symbolic links/],
    // yauzl may refuse the malformed sizes of an encrypted stored entry first; either way it is refused.
    ["an encrypted entry", [{ name: "a.mdx", data: "x", encrypted: true }], /encrypted|invalid archive/],
    ["a nested archive", [{ name: "a.mdx", data: "x" }, { name: "more.zip", data: "PK" }], /archives inside/],
    ["an unknown file type", [{ name: "a.mdx", data: "x" }, { name: "run.exe", data: "MZ" }], /not accepted/],
    ["a hidden file", [{ name: "a.mdx", data: "x" }, { name: "img/.secret.png", data: "x" }], /hidden name/],
    ["duplicate names", [{ name: "a.mdx", data: "x" }, { name: "A.MDX", data: "y" }], /duplicate/],
    ["an empty archive", [{ name: "folder/" }], /no files/],
  ])("refuses %s", async (_label, entries, message) => {
    await expect(unpack(entries)).rejects.toThrow(message);
  });

  it("refuses a high compression ratio (zip bomb)", async () => {
    const zeros = Buffer.alloc(4 << 20);
    await expect(unpack([{ name: "bomb.mdx", data: zeros, deflate: true }])).rejects.toThrow(/compression ratio/);
  });

  it("refuses more than the total size, before writing anything", async () => {
    const big = Buffer.alloc(3000, 1);
    await expect(unpack([{ name: "a.mdx", data: big }, { name: "b.css", data: big }], { ...limits, maxTotalBytes: 5000 })).rejects.toThrow(
      /exceed/,
    );
    expect(fs.existsSync(path.join(dir, "out"))).toBe(false);
  });

  it("refuses too many entries and deep nesting", async () => {
    await expect(unpack([{ name: "a.mdx" }, { name: "b.css" }], { ...limits, maxEntries: 1 })).rejects.toThrow(/more than 1 entries/);
    await expect(unpack([{ name: "a.mdx", data: "x" }, { name: "1/2/3/4/5/x.css", data: "x" }])).rejects.toThrow(/nested too deeply/);
  });

  it("refuses an entry whose real size differs from its header", async () => {
    await expect(unpack([{ name: "a.mdx", data: "much more than declared", deflate: true, declaredSize: 3 }])).rejects.toBeInstanceOf(
      ZipRejectedError,
    );
  });

  it("refuses a file that is not a zip", async () => {
    const file = path.join(dir, "in.zip");
    fs.writeFileSync(file, "not a zip at all");
    await expect(unpackZip(file, path.join(dir, "out"), limits)).rejects.toThrow(/not a readable zip/);
  });
});
