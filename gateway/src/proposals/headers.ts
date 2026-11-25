// Reads what a dictionary's main file says about itself, to show the admin (docs/PLAN.md Phase 6): MDX
// header (version, title, encoding, encryption) and headword count, a DSL's #NAME and languages, a
// StarDict .ifo. Only the first bytes are read, so a malformed or huge file costs little; anything
// unreadable becomes a warning, never an error.
import fsp from "node:fs/promises";
import fs from "node:fs";
import zlib from "node:zlib";
import type { DictionaryMetadata, ProposalWarning } from "@pxdict/shared";

/** Largest header read from any file. */
const maxHeaderBytes = 1 << 20;
const textPeekBytes = 64 << 10;

export interface HeaderResult {
  metadata: DictionaryMetadata;
  warnings: ProposalWarning[];
}

const empty = (format: string, mainFile: string): DictionaryMetadata => ({
  format,
  mainFile,
  title: null,
  description: null,
  version: null,
  encoding: null,
  entries: null,
  languages: null,
});

const xmlEntities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Attributes of the MDX header's single XML element. */
export function parseMdxHeaderXml(xml: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const m of xml.matchAll(/([A-Za-z_][\w.-]*)\s*=\s*"([^"]*)"/g)) {
    const [, key = "", raw = ""] = m;
    attrs.set(key, raw.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => xmlEntities[e] ?? ""));
  }
  return attrs;
}

/** A short plain-text version of a description that may contain HTML (shown as text anyway). */
function plain(s: string | undefined, max = 2000): string | null {
  if (!s) return null;
  const text = s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

async function readAt(fh: fsp.FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead);
}

/** Parses an MDX file's header and keyword-section header. */
export async function readMdx(file: string, mainFile: string): Promise<HeaderResult> {
  const meta = empty("mdx", mainFile);
  const warnings: ProposalWarning[] = [];
  const fh = await fsp.open(file, "r");
  try {
    const head = await readAt(fh, 0, 4);
    if (head.length < 4) throw new Error("file too short");
    const size = head.readUInt32BE(0);
    if (size < 2 || size > maxHeaderBytes) throw new Error("implausible header size");
    const raw = await readAt(fh, 4, size);
    if (raw.length < size) throw new Error("truncated header");
    // Engine 1.x/2.x write UTF-16LE; 3.x writes UTF-8.
    const xml = (raw[1] === 0 ? raw.toString("utf16le") : raw.toString("utf8")).replace(/\0+$/, "");
    const attrs = parseMdxHeaderXml(xml);
    const version = attrs.get("GeneratedByEngineVersion") ?? attrs.get("RequiredEngineVersion") ?? null;
    meta.version = version;
    meta.title = plain(attrs.get("Title"), 200);
    meta.description = plain(attrs.get("Description"));
    meta.encoding = attrs.get("Encoding") || null;
    const encrypted = Number(attrs.get("Encrypted") ?? "0");
    const v = Number(version ?? "2");
    if (Number.isFinite(encrypted) && encrypted & 1) {
      warnings.push({ code: "encrypted", message: "the keyword index is encrypted (registered MDX); it may not open", path: mainFile });
    } else if (v < 3) {
      // Header, its 4-byte checksum, then the keyword section header: big-endian counts, 8 bytes each
      // from engine 2.0, 4 bytes before.
      const wide = v >= 2;
      const kh = await readAt(fh, 4 + size + 4, wide ? 16 : 8);
      if (kh.length === (wide ? 16 : 8)) {
        const n = wide ? kh.readBigUInt64BE(8) : BigInt(kh.readUInt32BE(4));
        if (n <= BigInt(Number.MAX_SAFE_INTEGER)) meta.entries = Number(n);
      }
    }
  } catch (err) {
    warnings.push({ code: "unreadable_header", message: `MDX header not readable: ${(err as Error).message}`, path: mainFile });
  } finally {
    await fh.close();
  }
  return { metadata: meta, warnings };
}

/** Decodes the first bytes of a text file whose encoding is given by a BOM (or guessed). */
export function decodeText(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1)));
    return swapped.swap16().toString("utf16le");
  }
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString("utf8");
  // No BOM: UTF-16LE text has a zero in most odd positions.
  let zeros = 0;
  const probe = Math.min(buf.length, 512);
  for (let i = 1; i < probe; i += 2) if (buf[i] === 0) zeros++;
  return zeros > probe / 4 ? buf.toString("utf16le") : buf.toString("utf8");
}

async function peek(file: string, gz: boolean): Promise<Buffer> {
  if (!gz) {
    const fh = await fsp.open(file, "r");
    try {
      return await readAt(fh, 0, textPeekBytes);
    } finally {
      await fh.close();
    }
  }
  // Dictzip is gzip-compatible: inflate only the beginning.
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const src = fs.createReadStream(file);
    const gunzip = zlib.createGunzip();
    const done = () => {
      src.destroy();
      gunzip.destroy();
      resolve(Buffer.concat(chunks).subarray(0, textPeekBytes));
    };
    gunzip.on("data", (c: Buffer) => {
      chunks.push(c);
      size += c.length;
      if (size >= textPeekBytes) done();
    });
    gunzip.on("end", done);
    gunzip.on("error", reject);
    src.on("error", reject);
    src.pipe(gunzip);
  });
}

/** Reads a DSL file's #NAME and language directives. */
export async function readDsl(file: string, mainFile: string): Promise<HeaderResult> {
  const meta = empty("dsl", mainFile);
  const warnings: ProposalWarning[] = [];
  try {
    const text = decodeText(await peek(file, mainFile.toLowerCase().endsWith(".dz")));
    const directives = new Map<string, string>();
    for (const line of text.split(/\r?\n/)) {
      const m = /^#([A-Z_]+)\s+"?(.*?)"?\s*$/.exec(line);
      if (m?.[1]) directives.set(m[1], m[2] ?? "");
      else if (line.trim() && !line.startsWith("#")) break;
    }
    if (!directives.size) throw new Error("no #NAME directive");
    meta.title = plain(directives.get("NAME"), 200);
    const langs = [directives.get("INDEX_LANGUAGE"), directives.get("CONTENTS_LANGUAGE")].filter(Boolean);
    meta.languages = langs.length ? langs.join(" → ") : null;
  } catch (err) {
    warnings.push({ code: "unreadable_header", message: `DSL header not readable: ${(err as Error).message}`, path: mainFile });
  }
  return { metadata: meta, warnings };
}

/** Reads a StarDict .ifo (key=value lines). */
export async function readIfo(file: string, mainFile: string): Promise<HeaderResult> {
  const meta = empty("stardict", mainFile);
  const warnings: ProposalWarning[] = [];
  try {
    const text = decodeText(await peek(file, false));
    if (!text.startsWith("StarDict's dict ifo file")) throw new Error("missing the .ifo signature");
    const kv = new Map<string, string>();
    for (const line of text.split(/\r?\n/)) {
      const eq = line.indexOf("=");
      if (eq > 0) kv.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
    }
    meta.title = plain(kv.get("bookname"), 200);
    meta.description = plain(kv.get("description"));
    meta.version = kv.get("version") ?? null;
    const n = Number(kv.get("wordcount"));
    meta.entries = Number.isSafeInteger(n) && n >= 0 ? n : null;
  } catch (err) {
    warnings.push({ code: "unreadable_header", message: `.ifo not readable: ${(err as Error).message}`, path: mainFile });
  }
  return { metadata: meta, warnings };
}

/** Reads the header of `file` (the main file, at `mainFile` inside the proposal) in format `format`. */
export async function readHeader(file: string, mainFile: string, format: string): Promise<HeaderResult> {
  switch (format) {
    case "mdx":
      return readMdx(file, mainFile);
    case "dsl":
      return readDsl(file, mainFile);
    case "stardict":
      return readIfo(file, mainFile);
    default:
      return { metadata: empty(format, mainFile), warnings: [] };
  }
}
