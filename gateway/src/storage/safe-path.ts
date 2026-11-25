// Every file path the gateway builds from data it did not choose itself (uploaded file names, zip entry
// names, dictionary ids, wuDict's folder names) goes through safeJoin (AGENTS.md §5): the relative part
// must be a plain path below the root, and no existing component below the root may be a symlink, so a
// planted link cannot redirect a write or a delete outside the root.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export class UnsafePathError extends Error {
  constructor(readonly relPath: string, reason: string) {
    super(`unsafe path ${JSON.stringify(relPath)}: ${reason}`);
    this.name = "UnsafePathError";
  }
}

const maxSegmentBytes = 255;
const maxPathLength = 1024;

/**
 * Why `rel` is not a safe relative path, or undefined when it is: "/"-separated segments, none empty,
 * "." or "..", none starting with "." (hidden files), no backslash, colon or control character.
 */
export function relPathProblem(rel: string): string | undefined {
  if (rel === "") return "empty";
  if (rel.length > maxPathLength) return "too long";
  if (rel.startsWith("/")) return "absolute";
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  if (/[\\:\0-\x1f\x7f]/.test(rel)) return "backslash, colon or control character";
  for (const seg of rel.split("/")) {
    if (seg === "") return "empty segment";
    if (seg === "." || seg === "..") return "dot segment";
    if (seg.startsWith(".")) return "hidden name";
    if (seg.trim() !== seg) return "leading or trailing space";
    if (Buffer.byteLength(seg) > maxSegmentBytes) return "name too long";
  }
  return undefined;
}

export function isSafeRelPath(rel: string): boolean {
  return relPathProblem(rel) === undefined;
}

function resolveInside(root: string, rel: string): { full: string; segments: string[] } {
  const problem = relPathProblem(rel);
  if (problem) throw new UnsafePathError(rel, problem);
  const base = path.resolve(root);
  const full = path.resolve(base, ...rel.split("/"));
  if (!full.startsWith(base + path.sep)) throw new UnsafePathError(rel, "outside the root");
  return { full, segments: rel.split("/") };
}

const isMissing = (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT";

/**
 * Joins `root` and the relative path `rel`; throws UnsafePathError if `rel` is not a plain relative
 * path or an existing component below `root` is a symlink. Missing components are fine (to be created).
 */
export async function safeJoin(root: string, rel: string): Promise<string> {
  const { full, segments } = resolveInside(root, rel);
  let current = path.resolve(root);
  for (const seg of segments) {
    current = path.join(current, seg);
    let st: fs.Stats;
    try {
      st = await fsp.lstat(current);
    } catch (err) {
      if (isMissing(err)) break;
      throw err;
    }
    if (st.isSymbolicLink()) throw new UnsafePathError(rel, "symlink");
  }
  return full;
}

/** Synchronous safeJoin, for short checks inside a database transaction. */
export function safeJoinSync(root: string, rel: string): string {
  const { full, segments } = resolveInside(root, rel);
  let current = path.resolve(root);
  for (const seg of segments) {
    current = path.join(current, seg);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(current);
    } catch (err) {
      if (isMissing(err)) break;
      throw err;
    }
    if (st.isSymbolicLink()) throw new UnsafePathError(rel, "symlink");
  }
  return full;
}

/**
 * Removes `rel` under `root` (a file or a whole folder) and answers the bytes freed. Symlinks inside are
 * removed as links, never followed. Missing paths free 0 bytes.
 */
export async function safeRemove(root: string, rel: string): Promise<number> {
  const full = await safeJoin(root, rel);
  const bytes = await diskUsage(full);
  await fsp.rm(full, { recursive: true, force: true });
  return bytes;
}

/** Bytes used by a file or a folder tree (symlinks count as 0 and are not followed). */
export async function diskUsage(full: string): Promise<number> {
  let st: fs.Stats;
  try {
    st = await fsp.lstat(full);
  } catch (err) {
    if (isMissing(err)) return 0;
    throw err;
  }
  if (st.isFile()) return st.size;
  if (!st.isDirectory()) return 0;
  let total = 0;
  for (const name of await fsp.readdir(full)) total += await diskUsage(path.join(full, name));
  return total;
}

/** Free bytes on the file system holding `dir` (for the MIN_FREE_BYTES check). */
export async function freeBytes(dir: string): Promise<number> {
  const st = await fsp.statfs(dir);
  return st.bavail * st.bsize;
}
