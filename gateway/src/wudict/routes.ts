// The allowlist of wuDict routes the gateway proxies (AGENTS.md §2, docs/PLAN.md §2). Anything not
// listed here never reaches wuDict from a browser. Each route also has a query allowlist: unknown
// parameters (including wuDict's `?k=` token) are dropped, known ones are validated.
import { z } from "zod";

/** The proxied routes. `/res/{dict}/{path…}` is matched as a prefix. */
export const proxiedRoutes = [
  { method: "GET", path: "/api/dicts" },
  { method: "GET", path: "/api/search" },
  { method: "GET", path: "/api/suggest" },
  { method: "GET", path: "/res/:dict/*" },
] as const;

/**
 * Paths owned by wuDict or the gateway. Unproxied ones answer 404 instead of falling back to the PWA's
 * index.html, so a wuDict page or API never looks like it exists. Includes wuDict's own UI pages
 * (`/setup`, `/lemmas`, `/groups`, `/browse`) and its UI assets (`/assets`, `/style`, `/files`).
 */
const reservedRoots = new Set([
  "api",
  "res",
  "r",
  "app-api",
  "assets",
  "style",
  "files",
  "setup",
  "lemmas",
  "groups",
  "browse",
  "healthz",
  "wudict-admin",
]);

export function isReservedPath(pathname: string): boolean {
  const root = pathname.split("/")[1] ?? "";
  return reservedRoots.has(root);
}

/** One wuDict dictionary id as it appears in URLs and `dict=` lists. */
export const dictIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

const dictList = z
  .string()
  .max(8192)
  .transform((raw) =>
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string().regex(dictIdPattern, "invalid dictionary id")).max(500));

const query = z
  .string()
  .max(500, "query is too long")
  .refine((q) => q.trim() !== "", "query must not be blank");

const flag = z.enum(["1", "0", "true", "false"]);

/** GET /api/search. `format=clean` is not offered: wuDict would rewrite links to its loopback URL. */
export const searchQuery = z.object({
  q: query,
  mode: z.enum(["exact", "prefix", "fts", "wildcard", "fuzzy"]).optional(),
  hl: flag.optional(),
  mark: z.string().max(200).optional(),
  format: z.enum(["raw", "text"]).optional(),
  dict: dictList.optional(),
  n: z
    .string()
    .regex(/^\d{1,3}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(200))
    .optional(),
});

/** GET /api/suggest. */
export const suggestQuery = z.object({
  q: query,
  mode: z.enum(["prefix", "wildcard"]).optional(),
  dict: dictList.optional(),
});

/** Picks the allowlisted parameters (first value of each) from a request URL. */
export function pickQuery(url: URL, keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const v = url.searchParams.get(key);
    if (v !== null) out[key] = v;
  }
  return out;
}

/**
 * Validates the `{path}` part of /res/{dict}/{path}: percent-encoded segments with no empty, "." or
 * ".." segment, no backslash and no NUL once decoded. Returns the path to forward (still encoded) or
 * undefined.
 */
export function checkResourcePath(encoded: string): string | undefined {
  if (!encoded || encoded.length > 2048) return undefined;
  for (const seg of encoded.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      return undefined;
    }
    if (decoded === "" || decoded === "." || decoded === ".." || /[\\/\0]/.test(decoded)) return undefined;
  }
  return encoded;
}
