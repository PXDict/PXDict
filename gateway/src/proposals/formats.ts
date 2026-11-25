// Which files a proposal may contain (docs/PLAN.md Phase 6): one main dictionary file in a format
// wuDict reads, its companion files, and resources (styles, scripts, images, fonts, audio). A single
// .zip may stand in for all of them; it is unpacked and checked on submit.
//
// ASSUMPTION(wudict): MDX/MDD and DSL are verified (docs/wudict-notes.md Q5–Q9, Phase 2 additions); the
// other formats are the ones wuDict's openapi.yaml lists (`DictInfo.format`), with their usual file
// names, and are not verified with real files yet (notes, "Open questions").

export type FileKind = "main" | "companion" | "resource" | "zip";

/** Main file extensions → wuDict format name. Longest suffix first. */
const mainFormats: readonly (readonly [string, string])[] = [
  [".dsl.dz", "dsl"],
  [".mdx", "mdx"],
  [".dsl", "dsl"],
  [".ifo", "stardict"],
  [".slob", "slob"],
  [".bgl", "bgl"],
  [".zim", "zim"],
];

/** Files that belong to a main file (MDX media, StarDict index and data, DSL annotations). */
const companionExtensions = [".mdd", ".idx", ".idx.gz", ".dict", ".dict.dz", ".syn", ".ann"];

/** Files an article may reference. */
const resourceExtensions = [
  ".css",
  ".js",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".bmp",
  ".ico",
  ".ttf",
  ".otf",
  ".woff",
  ".woff2",
  ".mp3",
  ".wav",
  ".ogg",
  ".oga",
  ".opus",
  ".spx",
  ".m4a",
  ".txt",
];

/** Every accepted extension, for the upload form. */
export const acceptedExtensions: readonly string[] = [
  ...mainFormats.map(([ext]) => ext),
  ...companionExtensions,
  ...resourceExtensions,
  ".zip",
];

export interface Classified {
  kind: FileKind;
  /** wuDict format, for a main file. */
  format?: string;
}

/** Classifies a file by its name (case-insensitive); undefined when the extension is not accepted. */
export function classify(name: string): Classified | undefined {
  const lower = name.toLowerCase();
  for (const [ext, format] of mainFormats) if (lower.endsWith(ext) && lower.length > ext.length) return { kind: "main", format };
  const has = (exts: readonly string[]) => exts.some((ext) => lower.endsWith(ext) && lower.length > ext.length);
  if (has(companionExtensions)) return { kind: "companion" };
  if (has(resourceExtensions)) return { kind: "resource" };
  if (lower.endsWith(".zip") && lower.length > 4) return { kind: "zip" };
  return undefined;
}

/** Names that archivers add and nobody needs; silently skipped inside a zip. */
export function isJunkEntry(entryPath: string): boolean {
  const parts = entryPath.split("/");
  const last = parts.at(-1) ?? "";
  return parts.includes("__MACOSX") || last === ".DS_Store" || last === "Thumbs.db" || last === "desktop.ini";
}
