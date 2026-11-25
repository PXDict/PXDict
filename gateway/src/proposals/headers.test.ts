import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { makeMdx } from "../test/zip";
import { decodeText, parseMdxHeaderXml, readHeader } from "./headers";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pxdict-headers-"));
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
const write = (name: string, data: Buffer | string) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, data);
  return file;
};

describe("MDX", () => {
  it("parses header attributes with entities", () => {
    const a = parseMdxHeaderXml('<Dictionary Title="A &amp; B" Encoding="UTF-8"/>');
    expect(a.get("Title")).toBe("A & B");
    expect(a.get("Encoding")).toBe("UTF-8");
  });

  it("reads version, title, encoding, description and the headword count", async () => {
    const file = write(
      "a.mdx",
      makeMdx(
        { GeneratedByEngineVersion: "2.0", Encrypted: "2", Encoding: "UTF-8", Title: "PX Test", Description: "&lt;b&gt;bold&lt;/b&gt; text" },
        42,
      ),
    );
    const { metadata, warnings } = await readHeader(file, "a.mdx", "mdx");
    expect(warnings).toEqual([]);
    expect(metadata).toMatchObject({ format: "mdx", version: "2.0", title: "PX Test", encoding: "UTF-8", entries: 42, description: "bold text" });
  });

  it("warns about an encrypted keyword index and garbage", async () => {
    const enc = await readHeader(write("e.mdx", makeMdx({ GeneratedByEngineVersion: "2.0", Encrypted: "1" })), "e.mdx", "mdx");
    expect(enc.warnings.map((w) => w.code)).toEqual(["encrypted"]);
    expect(enc.metadata.entries).toBeNull();
    const bad = await readHeader(write("bad.mdx", "nope"), "bad.mdx", "mdx");
    expect(bad.warnings.map((w) => w.code)).toEqual(["unreadable_header"]);
  });
});

describe("DSL and StarDict", () => {
  const dsl = '#NAME "Test DSL"\n#INDEX_LANGUAGE "English"\n#CONTENTS_LANGUAGE "Vietnamese"\n\nhello\n\t[m1]xin chào[/m]\n';

  it("reads UTF-16LE (BOM), UTF-8 and dictzip DSL headers", async () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(dsl, "utf16le")]);
    for (const [name, data] of [
      ["a.dsl", utf16],
      ["b.dsl", dsl],
      ["c.dsl.dz", zlib.gzipSync(Buffer.from(dsl))],
    ] as const) {
      const { metadata, warnings } = await readHeader(write(name, data), name, "dsl");
      expect(warnings).toEqual([]);
      expect(metadata).toMatchObject({ title: "Test DSL", languages: "English → Vietnamese" });
    }
  });

  it("reads a StarDict .ifo", async () => {
    const ifo = "StarDict's dict ifo file\nversion=3.0.0\nbookname=Star\nwordcount=1234\ndescription=hi\n";
    const { metadata } = await readHeader(write("s.ifo", ifo), "s.ifo", "stardict");
    expect(metadata).toMatchObject({ title: "Star", entries: 1234, version: "3.0.0", description: "hi" });
  });

  it("decodes UTF-16 without a BOM", () => {
    expect(decodeText(Buffer.from("#NAME x", "utf16le"))).toBe("#NAME x");
  });
});
