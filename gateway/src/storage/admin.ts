// Storage administration (docs/PLAN.md Phase 7, ADR 0009): where the data volume's space goes, and a
// two-step deletion. `plan` is a dry run: it lists every file an item would delete, with sizes and
// warnings, and remembers that list for ten minutes. `execute` takes the plan, checks every listed
// file again (an item whose files changed is skipped), deletes, and records each item in audit_log.
//
// Which files belong to a dictionary: wuDict reports only the main file. A dictionary approved from a
// proposal owns DICT_DIR/<id>/. Any other dictionary owns the folder of its main file when no other
// dictionary lives in or below it; otherwise ("stem" mode, e.g. files directly in DICT_DIR) only the
// files beside the main file whose names start with its stem ("oxford.mdd", "oxford.css").
//
// "Original files" of an MDX dictionary are the main file, its .mdd files and the style sheets and
// scripts beside it: wuDict packs exactly those into media.db (docs/wudict-notes.md Q9). Anything else
// in a dictionary folder is listed as an auxiliary file the admin may pick, never deleted on its own.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type {
  StorageArea,
  StorageBlockReason,
  StorageCandidate,
  StorageDict,
  StorageExecuteItem,
  StorageExecuteResult,
  StorageItemRef,
  StorageOverview,
  StoragePlan,
  StoragePlanItem,
  StorageWarning,
} from "@pxdict/shared";
import { and, eq, sql } from "drizzle-orm";
import { recordAudit } from "../audit/audit";
import type { Db } from "../db/client";
import { dictionaries, favorites, proposals, userDicts } from "../db/schema";
import type { DictPublisher } from "../dicts/publisher";
import type { DictionaryRow, DictRegistry } from "../dicts/registry";
import type { Logger } from "../log";
import { classify } from "../proposals/formats";
import type { ProposalService } from "../proposals/service";
import type { WudictCatalog } from "../wudict/catalog";
import type { WudictClient } from "../wudict/client";
import { relPathProblem, safeJoin, safeRemove } from "./safe-path";

/** A plan can be executed for this long. */
export const planTtlMs = 10 * 60 * 1000;
/** Things in tmp/ untouched for this long are stale. */
export const staleTmpMs = 24 * 60 * 60 * 1000;
const maxPlans = 20;
const areas: readonly StorageArea[] = ["dictionaries", "db", "proposals", "tmp", "gateway"];

/** Files wuDict packs into media.db beside an MDX (docs/wudict-notes.md Q9). */
const packedSidecar = /\.(css|js)$/i;

/** A file seen on disk, relative to DATA_DIR ("/"-separated). */
interface SeenFile {
  rel: string;
  bytes: number;
  mtimeMs: number;
  /** A symlink (removed as a link, never followed). */
  link: boolean;
}

/** The files the gateway attributes to one dictionary. */
interface DictFiles {
  /** Folder under DICT_DIR the dictionary owns, or undefined in stem mode. */
  folder: string | undefined;
  /** Every attributed file. */
  files: SeenFile[];
  /** The main file, its .mdd files and the CSS/JS beside it. */
  originals: SeenFile[];
}

interface PlannedItem {
  ref: StorageItemRef;
  label: string;
  /** Files to delete, as seen when planning. */
  files: SeenFile[];
  /** Folders (relative to DATA_DIR) removed as a whole; their listing must not change. */
  folders: string[];
  blocked: StorageBlockReason | null;
  warnings: StorageWarning[];
}

interface StoredPlan {
  adminId: string;
  expiresAt: number;
  items: PlannedItem[];
}

export class StorageError extends Error {
  constructor(
    readonly status: 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "StorageError";
  }
}

export interface StorageServiceOptions {
  db: Db;
  dataDir: string;
  client: WudictClient;
  catalog: Pick<WudictCatalog, "snapshot" | "invalidate">;
  registry: DictRegistry;
  publisher: Pick<DictPublisher, "status" | "rescan">;
  proposals: Pick<ProposalService, "discardUpload">;
  logger: Logger;
  now?: () => number;
}

const toPosix = (p: string) => p.split(path.sep).join("/");
const iso = (ms: number) => new Date(ms).toISOString();
const sum = (files: readonly SeenFile[]) => files.reduce((n, f) => n + f.bytes, 0);
const isMissing = (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT";

/**
 * `media = …` in db/<name>/info.txt: "not packed - resources come from the original files" until media
 * is packed (docs/wudict-notes.md Q9).
 * ASSUMPTION(wudict): any other value means packed (only the "not packed" wording was seen).
 */
export function parseInfoMediaPacked(text: string): boolean {
  const m = /^\s*media\s*[=:]\s*(.+?)\s*$/m.exec(text);
  return !!m?.[1] && !/^not\b/i.test(m[1]);
}

export class StorageService {
  readonly #o: StorageServiceOptions;
  readonly #now: () => number;
  readonly #dictDir: string;
  readonly #dbDir: string;
  readonly #plans = new Map<string, StoredPlan>();
  #executing = false;

  constructor(opts: StorageServiceOptions) {
    this.#o = opts;
    this.#now = opts.now ?? Date.now;
    this.#dictDir = path.join(opts.dataDir, "dictionaries");
    this.#dbDir = path.join(opts.dataDir, "db");
  }

  // Looking at the disk

  /** Every file (and symlink) below `rel` (relative to DATA_DIR); a missing path has none. */
  async #walk(rel: string): Promise<SeenFile[]> {
    const out: SeenFile[] = [];
    const visit = async (r: string) => {
      let st: fs.Stats;
      try {
        st = await fsp.lstat(path.join(this.#o.dataDir, r));
      } catch (err) {
        if (isMissing(err)) return;
        throw err;
      }
      if (st.isDirectory()) {
        for (const name of (await fsp.readdir(path.join(this.#o.dataDir, r))).sort()) await visit(`${r}/${name}`);
      } else if (st.isFile() || st.isSymbolicLink()) {
        out.push({ rel: r, bytes: st.isFile() ? st.size : 0, mtimeMs: st.mtimeMs, link: st.isSymbolicLink() });
      }
    };
    await visit(rel);
    return out;
  }

  /** Direct children of a folder under DATA_DIR; none when it is missing. */
  async #children(rel: string): Promise<fs.Dirent[]> {
    try {
      return await fsp.readdir(path.join(this.#o.dataDir, rel), { withFileTypes: true });
    } catch (err) {
      if (isMissing(err)) return [];
      throw err;
    }
  }

  async #dictDirWritable(): Promise<boolean> {
    try {
      await fsp.access(this.#dictDir, fs.constants.W_OK);
      return true;
    } catch (err) {
      // A volume without dictionaries yet has nothing to protect.
      return isMissing(err);
    }
  }

  /** The main file's path under DICT_DIR, when it is there. */
  #mainRel(row: DictionaryRow): string | undefined {
    if (!row.sourcePath || row.sourceDeletedAt) return undefined;
    const rel = path.relative(this.#dictDir, row.sourcePath);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
    const posix = toPosix(rel);
    return relPathProblem(posix) ? undefined : posix;
  }

  /** Attributes files under DICT_DIR to every dictionary (see the header comment). */
  async #attribute(rows: readonly DictionaryRow[]): Promise<Map<string, DictFiles>> {
    const mains = new Map<string, string>();
    for (const r of rows) {
      const m = this.#mainRel(r);
      if (m) mains.set(r.id, m);
    }
    const result = new Map<string, DictFiles>();
    for (const r of rows) {
      const main = mains.get(r.id);
      if (!main) {
        result.set(r.id, { folder: undefined, files: [], originals: [] });
        continue;
      }
      const mainDir = path.posix.dirname(main);
      const mainName = path.posix.basename(main);
      const stem = mainName.replace(/\.[^.]+$/, "");
      let folder: string | undefined = r.source === "proposal" && main.startsWith(`${r.id}/`) ? r.id : mainDir;
      if (folder === "." || [...mains].some(([id, m]) => id !== r.id && m.startsWith(`${folder ?? ""}/`))) folder = undefined;

      let files: SeenFile[];
      if (folder) {
        files = await this.#walk(`dictionaries/${folder}`);
      } else {
        const dirRel = mainDir === "." ? "dictionaries" : `dictionaries/${mainDir}`;
        files = [];
        for (const e of await this.#children(dirRel)) {
          if (e.name === mainName || e.name.startsWith(`${stem}.`)) files.push(...(await this.#walk(`${dirRel}/${e.name}`)));
        }
        files = files.filter((f) => path.posix.dirname(f.rel) === dirRel);
      }
      const mainFull = `dictionaries/${main}`;
      const besideMain = (f: SeenFile) => path.posix.dirname(f.rel) === path.posix.dirname(mainFull);
      const originals = files.filter((f) => {
        if (f.link || !besideMain(f)) return false;
        const name = path.posix.basename(f.rel);
        return f.rel === mainFull || (name.startsWith(`${stem}.`) && name.toLowerCase().endsWith(".mdd")) || packedSidecar.test(name);
      });
      result.set(r.id, { folder, files, originals });
    }
    return result;
  }

  /** Files under DICT_DIR that are no dictionary's original files: junk in dictionary folders, loose files. */
  async #auxFiles(rows: readonly DictionaryRow[], attributed: Map<string, DictFiles>): Promise<Map<string, SeenFile & { inUse: boolean }>> {
    const owned = new Set<string>();
    const aux = new Map<string, SeenFile & { inUse: boolean }>();
    for (const r of rows) {
      const a = attributed.get(r.id);
      if (!a) continue;
      const main = this.#mainRel(r);
      const stem = main ? path.posix.basename(main).replace(/\.[^.]+$/, "") : "";
      const originals = new Set(a.originals.map((f) => f.rel));
      for (const f of a.files) {
        owned.add(f.rel);
        if (originals.has(f.rel) || f.link) continue;
        const name = path.posix.basename(f.rel);
        const c = classify(name);
        // Unknown types, archives, and .mdd files of another name (a stray or duplicate media file).
        const stray = c?.kind === "companion" && name.toLowerCase().endsWith(".mdd") && !name.startsWith(`${stem}.`);
        if (!c || c.kind === "zip" || stray) aux.set(f.rel, { ...f, inUse: false });
      }
    }
    // Files no dictionary claims (possibly a dictionary wuDict has not scanned yet).
    for (const f of await this.#walk("dictionaries")) {
      if (owned.has(f.rel) || f.link) continue;
      const c = classify(path.posix.basename(f.rel));
      aux.set(f.rel, { ...f, inUse: !!c && c.kind !== "zip" });
    }
    for (const rel of aux.keys()) if (relPathProblem(rel)) aux.delete(rel);
    return aux;
  }

  async #mediaPacked(row: DictionaryRow): Promise<boolean> {
    if (row.mediaPacked) return true;
    if (!row.libraryDir) return false;
    try {
      return parseInfoMediaPacked(await fsp.readFile(await safeJoin(this.#dbDir, `${row.libraryDir}/info.txt`), "utf8"));
    } catch {
      return false;
    }
  }

  #busy(row: DictionaryRow): boolean {
    return this.#executing || this.#o.publisher.status(row.id).state === "running";
  }

  async #originalsBlocked(row: DictionaryRow, a: DictFiles | undefined, writable: boolean): Promise<StorageBlockReason | null> {
    if (this.#busy(row)) return "busy";
    if (!writable) return "read_only";
    if (!row.wudictId) return "unavailable";
    if (!row.libraryDir) return "not_indexed";
    if (row.format?.toLowerCase() !== "mdx") return "format_unsupported";
    if (!a?.originals.length) return "no_originals";
    if (!(await this.#mediaPacked(row))) return "media_not_packed";
    return null;
  }

  #deleteBlocked(row: DictionaryRow, a: DictFiles | undefined, writable: boolean): StorageBlockReason | null {
    if (this.#busy(row)) return "busy";
    if (!writable && a?.files.length) return "read_only";
    return null;
  }

  async #indexFiles(row: DictionaryRow): Promise<SeenFile[]> {
    if (!row.libraryDir || relPathProblem(row.libraryDir) || row.libraryDir.includes("/")) return [];
    return this.#walk(`db/${row.libraryDir}`);
  }

  /** Library folders some dictionary uses, or undefined when wuDict cannot be asked. */
  async #usedLibraryDirs(): Promise<Set<string> | undefined> {
    try {
      await this.#o.registry.refresh();
      const snap = await this.#o.catalog.snapshot();
      const used = new Set(snap.rows.map((r) => r.libraryDir).filter((d) => d !== undefined));
      for (const r of this.#o.registry.all()) if (r.libraryDir) used.add(r.libraryDir);
      return used;
    } catch (err) {
      this.#o.logger.warn("dictionary list unavailable; orphaned indexes not checked", { err });
      return undefined;
    }
  }

  /**
   * Index folders in db/ that no dictionary uses.
   * ASSUMPTION(wudict): a dictionary's index folder holds info.txt or text.db; other entries of DB_DIR
   * are wuDict's own and never offered.
   */
  async #orphanIndexes(used: Set<string>): Promise<string[]> {
    const out: string[] = [];
    for (const e of await this.#children("db")) {
      if (!e.isDirectory() || used.has(e.name) || relPathProblem(e.name)) continue;
      const names = (await this.#children(`db/${e.name}`)).map((x) => x.name);
      if (names.includes("info.txt") || names.includes("text.db")) out.push(e.name);
    }
    return out;
  }

  /** Proposal folders (in proposals/ or tmp/proposals/) whose proposal is closed or unknown. */
  #proposalLeftover(id: string): StorageBlockReason | null {
    const row = this.#o.db.select({ status: proposals.status }).from(proposals).where(eq(proposals.id, id)).get();
    return row && (row.status === "pending" || row.status === "uploading") ? "in_use" : null;
  }

  #uploadingProposal(tmpRel: string): string | undefined {
    const m = /^proposals\/([^/]+)$/.exec(tmpRel);
    if (!m?.[1]) return undefined;
    const row = this.#o.db.select({ status: proposals.status }).from(proposals).where(eq(proposals.id, m[1])).get();
    return row?.status === "uploading" ? m[1] : undefined;
  }

  /** Entries of tmp/ that are candidates: top-level ones, and one per proposal upload folder. */
  async #tmpEntries(): Promise<string[]> {
    const out: string[] = [];
    for (const e of await this.#children("tmp")) {
      if (relPathProblem(e.name)) continue;
      if (e.name === "proposals" && e.isDirectory()) {
        for (const p of await this.#children("tmp/proposals")) {
          // Folders of closed proposals are cleaned with their proposal (proposal_files).
          if (!relPathProblem(p.name) && this.#proposalLeftover(p.name) === "in_use") out.push(`proposals/${p.name}`);
        }
      } else {
        out.push(e.name);
      }
    }
    return out;
  }

  /** Newest change below `rel` (the folder's own mtime included). */
  async #newest(rel: string, files: readonly SeenFile[]): Promise<number> {
    let newest = files.reduce((m, f) => Math.max(m, f.mtimeMs), 0);
    try {
      newest = Math.max(newest, (await fsp.lstat(path.join(this.#o.dataDir, rel))).mtimeMs);
    } catch {
      // Gone meanwhile.
    }
    return newest;
  }

  // Overview

  async overview(): Promise<StorageOverview> {
    const { db, dataDir } = this.#o;
    const used = await this.#usedLibraryDirs();
    const rows = this.#o.registry.all();
    const writable = await this.#dictDirWritable();
    const attributed = await this.#attribute(rows);

    let volume = { totalBytes: 0, freeBytes: 0 };
    try {
      const st = await fsp.statfs(dataDir);
      volume = { totalBytes: st.blocks * st.bsize, freeBytes: st.bavail * st.bsize };
    } catch (err) {
      this.#o.logger.warn("cannot read the volume's size", { err });
    }
    const areaBytes = await Promise.all(areas.map(async (area) => ({ area, bytes: sum(await this.#walk(area)) })));

    const enabled = new Map(
      db
        .select({ dictId: userDicts.dictId, n: sql<number>`count(*)` })
        .from(userDicts)
        .where(eq(userDicts.enabled, true))
        .groupBy(userDicts.dictId)
        .all()
        .map((r) => [r.dictId, r.n]),
    );
    const dicts: StorageDict[] = [];
    for (const r of rows) {
      const a = attributed.get(r.id);
      dicts.push({
        id: r.id,
        title: r.title,
        format: r.format,
        available: r.wudictId !== null,
        sourceBytes: a ? sum(a.files) : 0,
        indexBytes: sum(await this.#indexFiles(r)),
        sourceDeletedAt: r.sourceDeletedAt?.toISOString() ?? null,
        enabledUsers: enabled.get(r.id) ?? 0,
        originalsBlocked: await this.#originalsBlocked(r, a, writable),
        deleteBlocked: this.#deleteBlocked(r, a, writable),
      });
    }

    const candidates: StorageCandidate[] = [];
    const add = async (kind: StorageCandidate["kind"], target: string, rels: string[], blocked: StorageBlockReason | null, suggested: boolean) => {
      const files = (await Promise.all(rels.map((r) => this.#walk(r)))).flat();
      const newest = Math.max(...(await Promise.all(rels.map((r) => this.#newest(r, files)))));
      candidates.push({ kind, target, bytes: sum(files), modifiedAt: iso(newest || this.#now()), suggested: suggested && !blocked, blocked });
    };
    const proposalIds = new Set<string>();
    for (const e of await this.#children("proposals")) if (!relPathProblem(e.name)) proposalIds.add(e.name);
    for (const e of await this.#children("tmp/proposals")) {
      if (!relPathProblem(e.name) && this.#proposalLeftover(e.name) === null) proposalIds.add(e.name);
    }
    for (const id of [...proposalIds].sort()) {
      const blocked = this.#proposalLeftover(id);
      if (!blocked) await add("proposal_files", id, [`proposals/${id}`, `tmp/proposals/${id}`], null, true);
    }
    for (const t of await this.#tmpEntries()) {
      const files = await this.#walk(`tmp/${t}`);
      const stale = this.#now() - (await this.#newest(`tmp/${t}`, files)) >= staleTmpMs;
      if (stale) await add("stale_upload", t, [`tmp/${t}`], null, true);
    }
    if (used) for (const name of await this.#orphanIndexes(used)) await add("orphan_index", name, [`db/${name}`], null, true);
    for (const [rel, f] of await this.#auxFiles(rows, attributed)) {
      candidates.push({
        kind: "aux_file",
        target: rel.slice("dictionaries/".length),
        bytes: f.bytes,
        modifiedAt: iso(f.mtimeMs),
        suggested: false,
        blocked: writable ? null : "read_only",
      });
    }

    return { volume, areas: areaBytes, dictDirWritable: writable, catalogChecked: used !== undefined, dicts, candidates };
  }

  // Planning (dry run)

  async plan(adminId: string, refs: readonly StorageItemRef[]): Promise<StoragePlan> {
    const rows = this.#o.registry.all();
    const writable = await this.#dictDirWritable();
    const attributed = await this.#attribute(rows);
    let aux: Map<string, SeenFile & { inUse: boolean }> | undefined;
    let used: Set<string> | undefined | null = null;

    const seen = new Set<string>();
    const items: PlannedItem[] = [];
    for (const ref of refs) {
      const key = `${ref.kind}:${ref.target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const item: PlannedItem = { ref, label: ref.target, files: [], folders: [], blocked: null, warnings: [] };
      items.push(item);
      const single = !relPathProblem(ref.target) && !ref.target.includes("/");

      switch (ref.kind) {
        case "dict_originals":
        case "dict": {
          const row = rows.find((r) => r.id === ref.target);
          if (!row) {
            item.blocked = "not_found";
            break;
          }
          const a = attributed.get(row.id);
          item.label = row.title;
          if (ref.kind === "dict_originals") {
            item.files = a?.originals ?? [];
            item.blocked = await this.#originalsBlocked(row, a, writable);
            item.warnings.push({ code: "no_reindex" });
          } else {
            const index = await this.#indexFiles(row);
            item.files = [...(a?.files ?? []), ...index];
            if (a?.folder) item.folders.push(`dictionaries/${a.folder}`);
            if (index.length && row.libraryDir) item.folders.push(`db/${row.libraryDir}`);
            item.blocked = this.#deleteBlocked(row, a, writable);
            const users = this.#o.db
              .select({ n: sql<number>`count(*)` })
              .from(userDicts)
              .where(and(eq(userDicts.dictId, row.id), eq(userDicts.enabled, true)))
              .get()?.n ?? 0;
            const favs = this.#o.db.select({ n: sql<number>`count(*)` }).from(favorites).where(eq(favorites.dictId, row.id)).get()?.n ?? 0;
            if (users) item.warnings.push({ code: "users_enabled", count: users });
            if (favs) item.warnings.push({ code: "favorites_lost", count: favs });
          }
          break;
        }
        case "proposal_files": {
          if (!single) {
            item.blocked = "not_found";
            break;
          }
          item.blocked = this.#proposalLeftover(ref.target);
          item.folders = [`proposals/${ref.target}`, `tmp/proposals/${ref.target}`];
          item.files = (await Promise.all(item.folders.map((f) => this.#walk(f)))).flat();
          if (!item.blocked && !item.files.length && !(await this.#exists(item.folders))) item.blocked = "not_found";
          break;
        }
        case "stale_upload": {
          if (relPathProblem(ref.target) || !(await this.#tmpEntries()).includes(ref.target)) {
            item.blocked = "not_found";
            break;
          }
          const rel = `tmp/${ref.target}`;
          item.folders = [rel];
          item.files = await this.#walk(rel);
          if (this.#now() - (await this.#newest(rel, item.files)) < staleTmpMs) item.blocked = "in_use";
          if (this.#uploadingProposal(ref.target)) item.warnings.push({ code: "cancels_upload" });
          break;
        }
        case "orphan_index": {
          if (used === null) used = await this.#usedLibraryDirs();
          if (!single) {
            item.blocked = "not_found";
            break;
          }
          if (!used) {
            item.blocked = "unavailable";
            break;
          }
          if (!(await this.#orphanIndexes(used)).includes(ref.target)) {
            item.blocked = used.has(ref.target) ? "in_use" : "not_found";
            break;
          }
          item.folders = [`db/${ref.target}`];
          item.files = await this.#walk(`db/${ref.target}`);
          break;
        }
        case "aux_file": {
          aux ??= await this.#auxFiles(rows, attributed);
          const f = aux.get(`dictionaries/${ref.target}`);
          if (!f) {
            item.blocked = "not_found";
            break;
          }
          item.files = [f];
          if (!writable) item.blocked = "read_only";
          if (f.inUse) item.warnings.push({ code: "may_be_in_use" });
          break;
        }
      }
    }

    const now = this.#now();
    for (const [id, p] of this.#plans) if (p.expiresAt <= now) this.#plans.delete(id);
    while (this.#plans.size >= maxPlans) {
      const oldest = this.#plans.keys().next().value;
      if (oldest === undefined) break;
      this.#plans.delete(oldest);
    }
    const planId = randomBytes(16).toString("hex");
    const expiresAt = now + planTtlMs;
    this.#plans.set(planId, { adminId, expiresAt, items });
    const dto = items.map(
      (i): StoragePlanItem => ({
        ...i.ref,
        label: i.label,
        bytes: sum(i.files),
        paths: i.files.map((f) => ({ path: f.rel, bytes: f.bytes })),
        warnings: i.warnings,
        blocked: i.blocked,
      }),
    );
    return { planId, expiresAt: iso(expiresAt), totalBytes: dto.filter((i) => !i.blocked).reduce((n, i) => n + i.bytes, 0), items: dto };
  }

  async #exists(rels: readonly string[]): Promise<boolean> {
    for (const r of rels) {
      try {
        await fsp.lstat(path.join(this.#o.dataDir, r));
        return true;
      } catch {
        // missing
      }
    }
    return false;
  }

  // Execution

  /** Every planned file is still there, unchanged, and no planned folder gained files. */
  async #unchanged(item: PlannedItem): Promise<boolean> {
    for (const f of item.files) {
      let st: fs.Stats;
      try {
        st = await fsp.lstat(path.join(this.#o.dataDir, f.rel));
      } catch {
        return false;
      }
      if (st.isSymbolicLink() !== f.link || (!f.link && !st.isFile()) || (!f.link && st.size !== f.bytes) || st.mtimeMs !== f.mtimeMs) {
        return false;
      }
    }
    const planned = new Set(item.files.map((f) => f.rel));
    for (const folder of item.folders) {
      for (const f of await this.#walk(folder)) if (!planned.has(f.rel)) return false;
    }
    return true;
  }

  /** Bytes of planned files that no longer exist. */
  async #freed(item: PlannedItem): Promise<number> {
    let n = 0;
    for (const f of item.files) {
      try {
        await fsp.lstat(path.join(this.#o.dataDir, f.rel));
      } catch (err) {
        if (isMissing(err)) n += f.bytes;
      }
    }
    return n;
  }

  /** Removes one path relative to DATA_DIR through safeRemove (its first segment is the area root). */
  async #remove(rel: string): Promise<void> {
    const [area = "", ...rest] = rel.split("/");
    if (!areas.includes(area as StorageArea) || !rest.length) throw new Error(`refusing to remove ${rel}`);
    await safeRemove(path.join(this.#o.dataDir, area), rest.join("/"));
  }

  /** Removes now-empty folders from `rel`'s parent up to (not including) the area root. */
  async #pruneEmpty(rel: string): Promise<void> {
    let dir = path.posix.dirname(rel);
    while (dir.includes("/")) {
      try {
        await fsp.rmdir(await safeJoin(this.#o.dataDir, dir));
      } catch {
        return;
      }
      dir = path.posix.dirname(dir);
    }
  }

  /** Asks wuDict to delete a dictionary (`keepIndex`: only its originals). Throws with wuDict's reason. */
  async #wudictDelete(wudictId: string, keepIndex: boolean): Promise<"deleted" | "unknown"> {
    const query = new URLSearchParams({ dict: wudictId });
    if (keepIndex) query.set("prepared", "0");
    const res = await this.#o.client.request({ method: "DELETE", path: "/api/library", query, headersTimeoutMs: 120_000 });
    const text = (await res.text()).slice(0, 500);
    if (res.status === 200) return "deleted";
    if (res.status === 404 && !keepIndex) return "unknown";
    let reason = text;
    try {
      const body = JSON.parse(text) as { error?: unknown };
      if (typeof body.error === "string") reason = body.error;
    } catch {
      // not JSON
    }
    throw new Error(`the dictionary server refused (HTTP ${String(res.status)}): ${reason}`);
  }

  async #run(item: PlannedItem): Promise<void> {
    const { db, registry } = this.#o;
    const { kind, target } = item.ref;
    switch (kind) {
      case "dict_originals": {
        const row = registry.get(target);
        if (!row?.wudictId) throw new Error("the dictionary is no longer available");
        await this.#wudictDelete(row.wudictId, true);
        // wuDict removes the main and .mdd files; the CSS/JS beside them is the gateway's job.
        for (const f of item.files) await this.#remove(f.rel);
        const first = item.files[0];
        if (first) await this.#pruneEmpty(first.rel);
        db.update(dictionaries)
          .set({ sourcePath: null, sourceBytes: 0, sourceDeletedAt: new Date(this.#now()), updatedAt: new Date(this.#now()) })
          .where(eq(dictionaries.id, target))
          .run();
        return;
      }
      case "dict": {
        const row = registry.get(target);
        if (!row) throw new Error("the dictionary no longer exists");
        if (row.wudictId) await this.#wudictDelete(row.wudictId, false);
        for (const folder of item.folders) await this.#remove(folder);
        for (const f of item.files) await this.#remove(f.rel);
        const first = item.files.find((f) => f.rel.startsWith("dictionaries/"));
        if (first) await this.#pruneEmpty(first.rel);
        // user_dicts and favorites go with it (ON DELETE CASCADE).
        db.delete(dictionaries).where(eq(dictionaries.id, target)).run();
        return;
      }
      case "stale_upload": {
        const id = this.#uploadingProposal(target);
        if (id) await this.#o.proposals.discardUpload(id);
        for (const folder of item.folders) await this.#remove(folder);
        return;
      }
      case "proposal_files":
      case "orphan_index":
        for (const folder of item.folders) await this.#remove(folder);
        return;
      case "aux_file":
        for (const f of item.files) await this.#remove(f.rel);
        return;
    }
  }

  /** Deletes what a plan listed (only the admin who made it may run it, once). */
  async execute(adminId: string, planId: string): Promise<StorageExecuteResult> {
    const plan = this.#plans.get(planId);
    if (!plan || plan.adminId !== adminId || plan.expiresAt <= this.#now()) {
      throw new StorageError(404, "plan_expired", "this preview expired; preview the deletion again");
    }
    if (this.#executing) throw new StorageError(409, "busy", "another deletion is running");
    this.#plans.delete(planId);
    this.#executing = true;
    const results: StorageExecuteItem[] = [];
    let touchedDicts = false;
    try {
      for (const item of plan.items) {
        const base = { kind: item.ref.kind, target: item.ref.target };
        if (item.blocked) {
          results.push({ ...base, status: "skipped", bytesFreed: 0, reason: item.blocked });
          continue;
        }
        const row = item.ref.kind === "dict" || item.ref.kind === "dict_originals" ? this.#o.registry.get(item.ref.target) : undefined;
        if (row && this.#o.publisher.status(row.id).state === "running") {
          results.push({ ...base, status: "skipped", bytesFreed: 0, reason: "busy" });
          continue;
        }
        if (!(await this.#unchanged(item))) {
          results.push({ ...base, status: "skipped", bytesFreed: 0, reason: "changed since the preview" });
          continue;
        }
        let failure: string | null = null;
        try {
          if (row) touchedDicts = true;
          await this.#run(item);
        } catch (err) {
          failure = err instanceof Error ? err.message : String(err);
          this.#o.logger.error("storage deletion failed", { kind: item.ref.kind, target: item.ref.target, err });
        }
        const bytesFreed = await this.#freed(item);
        results.push({ ...base, status: failure ? "failed" : "done", bytesFreed, reason: failure });
        if (!failure || bytesFreed) {
          recordAudit(this.#o.db, {
            actorUserId: adminId,
            action: "storage.delete",
            targetType: item.ref.kind,
            targetId: item.ref.target,
            details: { label: item.label, files: item.files.length, ...(failure ? { error: failure } : {}) },
            bytesFreed,
          });
        }
        this.#o.logger.info("storage item deleted", { kind: item.ref.kind, target: item.ref.target, bytesFreed, failed: !!failure });
      }
      if (touchedDicts) {
        // wuDict's ids change after originals are deleted; a rescan also drops leftovers from its list.
        try {
          await this.#o.publisher.rescan();
        } catch (err) {
          this.#o.catalog.invalidate();
          this.#o.logger.warn("rescan after deletion failed", { err });
        }
      }
    } finally {
      this.#executing = false;
    }
    return { bytesFreed: results.reduce((n, r) => n + r.bytesFreed, 0), items: results };
  }

  // Background clean-up (jobs.ts)

  /**
   * Removes entries of tmp/ (other than proposal uploads, which ProposalService.cleanup handles)
   * untouched for `staleTmpMs`. Answers the bytes freed.
   */
  async cleanTmp(): Promise<number> {
    let freed = 0;
    for (const e of await this.#children("tmp")) {
      if (e.name === "proposals" || relPathProblem(e.name)) continue;
      const rel = `tmp/${e.name}`;
      const files = await this.#walk(rel);
      if (this.#now() - (await this.#newest(rel, files)) < staleTmpMs) continue;
      await this.#remove(rel);
      freed += sum(files);
    }
    return freed;
  }
}
