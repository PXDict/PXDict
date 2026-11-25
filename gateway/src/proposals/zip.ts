// Unpacks a proposed .zip with zip-bomb limits (docs/PLAN.md Phase 6). The central directory is read
// first and checked as a whole (entry count, total size, compression ratio, names, symlinks,
// encryption, nested archives) before a single byte is written; then entries are streamed to disk
// through storage/safe-path.ts, hashed on the way, and their real sizes are checked again (yauzl's
// validateEntrySizes), so a lying header cannot write more than it declared.
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { relPathProblem, safeJoin } from "../storage/safe-path";
import { classify, isJunkEntry } from "./formats";

export interface ZipLimits {
  /** Most entries in the central directory (folders and skipped junk included). */
  maxEntries: number;
  /** Largest total uncompressed size of the files kept. */
  maxTotalBytes: number;
  /** Largest uncompressed/compressed ratio of a single entry larger than `ratioFloorBytes`. */
  maxRatio: number;
  ratioFloorBytes: number;
  /** Deepest folder nesting of a kept file. */
  maxDepth: number;
}

export const defaultZipLimits = (maxUploadBytes: number): ZipLimits => ({
  maxEntries: 2000,
  // Dictionary files compress well, but a proposal unpacked to more than four times the upload limit
  // is not a dictionary anyone needs to share this way.
  maxTotalBytes: maxUploadBytes * 4,
  maxRatio: 100,
  ratioFloorBytes: 1 << 20,
  maxDepth: 4,
});

/** The archive is refused; the message is safe to show to the proposer. */
export class ZipRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipRejectedError";
  }
}

export interface UnpackedFile {
  relPath: string;
  bytes: number;
  sha256: string;
}

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/** A file entry's mode, for archives made on Unix (the upper 16 bits of the external attributes). */
const isSymlink = (e: yauzl.Entry) => ((e.externalFileAttributes >>> 16) & S_IFMT) === S_IFLNK;

/** Drops one folder that every kept entry shares ("Oxford/oxford.mdx" → "oxford.mdx"). */
export function stripCommonFolder(paths: readonly string[]): string[] {
  const first = paths[0]?.split("/")[0];
  if (!first || paths.some((p) => !p.includes("/") || p.split("/")[0] !== first)) return [...paths];
  return paths.map((p) => p.slice(first.length + 1));
}

/**
 * Unpacks `zipFile` into `destDir` (created if missing) and answers the files written. Throws
 * ZipRejectedError when a limit or rule is broken; files written before the error stay in `destDir`
 * for the caller to remove with the rest of the proposal.
 */
export async function unpackZip(zipFile: string, destDir: string, limits: ZipLimits): Promise<UnpackedFile[]> {
  let zip: yauzl.ZipFile;
  try {
    zip = await yauzl.openPromise(zipFile, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true });
  } catch (err) {
    throw new ZipRejectedError(`not a readable zip archive: ${(err as Error).message}`);
  }
  try {
    if (zip.entryCount > limits.maxEntries) {
      throw new ZipRejectedError(`the archive has more than ${String(limits.maxEntries)} entries`);
    }
    const kept: yauzl.Entry[] = [];
    let total = 0;
    try {
      for await (const entry of zip.eachEntry()) {
        const name = entry.fileName;
        if (name.endsWith("/") || isJunkEntry(name)) continue;
        if (isSymlink(entry)) throw new ZipRejectedError(`${name}: symbolic links are not allowed`);
        if (entry.isEncrypted()) throw new ZipRejectedError(`${name}: encrypted entries are not allowed`);
        if (!entry.canDecodeFileData()) throw new ZipRejectedError(`${name}: unsupported compression method`);
        const size = entry.uncompressedSize;
        if (size > limits.ratioFloorBytes && size / Math.max(entry.compressedSize, 1) > limits.maxRatio) {
          throw new ZipRejectedError(`${name}: compression ratio is too high`);
        }
        total += size;
        if (total > limits.maxTotalBytes) {
          throw new ZipRejectedError(`the unpacked files would exceed ${String(limits.maxTotalBytes)} bytes`);
        }
        kept.push(entry);
      }
    } catch (err) {
      if (err instanceof ZipRejectedError) throw err;
      // yauzl refuses absolute paths, "..", backslashes and malformed headers.
      throw new ZipRejectedError(`invalid archive: ${(err as Error).message}`);
    }
    if (!kept.length) throw new ZipRejectedError("the archive contains no files");

    const relPaths = stripCommonFolder(kept.map((e) => e.fileName));
    const seen = new Set<string>();
    relPaths.forEach((rel) => {
      const problem = relPathProblem(rel);
      if (problem) throw new ZipRejectedError(`${rel}: invalid name (${problem})`);
      if (rel.split("/").length - 1 > limits.maxDepth) throw new ZipRejectedError(`${rel}: folders nested too deeply`);
      const kind = classify(path.posix.basename(rel))?.kind;
      if (!kind) throw new ZipRejectedError(`${rel}: this file type is not accepted`);
      if (kind === "zip") throw new ZipRejectedError(`${rel}: archives inside the archive are not accepted`);
      const key = rel.toLowerCase();
      if (seen.has(key)) throw new ZipRejectedError(`${rel}: duplicate name`);
      seen.add(key);
    });

    await fsp.mkdir(destDir, { recursive: true });
    const out: UnpackedFile[] = [];
    for (const [i, entry] of kept.entries()) {
      const rel = relPaths[i] ?? "";
      const target = await safeJoin(destDir, rel);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const hash = createHash("sha256");
      let bytes = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          bytes += chunk.length;
          hash.update(chunk);
          cb(null, chunk);
        },
      });
      try {
        const src = await zip.openReadStreamPromise(entry);
        await pipeline(src, meter, fs.createWriteStream(target, { flags: "wx" }));
      } catch (err) {
        throw new ZipRejectedError(`${rel}: cannot unpack (${(err as Error).message})`);
      }
      out.push({ relPath: rel, bytes, sha256: hash.digest("hex") });
    }
    return out;
  } finally {
    zip.close();
  }
}
