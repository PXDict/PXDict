// Dictionary proposals (docs/PLAN.md Phase 6, ADR 0008).
//
// Life of a proposal and its files (all under DATA_DIR, so every move is a same-filesystem rename):
//
//   create   → row "uploading", quotas checked          tmp/proposals/<id>/upload/<name>   (chunks)
//   submit   → zip unpacked / files checked             tmp/proposals/<id>/files/…
//            → row "pending"                            proposals/<id>/…                    (quarantine)
//   approve  → row "approved", dictionary row "hidden"  dictionaries/<dictId>/…  → rescan + ingest
//   reject / withdraw → files deleted at once, the row (and its reason) kept
//
// Chunks are written at the offset the gateway expects (Upload-Offset), so an interrupted upload resumes
// where the stored bytes end. SHA-256 is computed while writing; when the in-memory state is lost (a
// failed chunk, a restart) the file is hashed again on submit.
import { createHash, randomBytes, type Hash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
  AdminProposal,
  ApprovalScope,
  CreateProposalRequest,
  DictionaryMetadata,
  Proposal,
  ProposalFile,
  ProposalStatus,
  ProposalUpdate,
  ProposalWarning,
  UploadLimits,
} from "@pxdict/shared";
import { and, desc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { recordAudit } from "../audit/audit";
import type { Db } from "../db/client";
import { dictionaries, proposalFiles, proposals, user } from "../db/schema";
import type { DictPublisher } from "../dicts/publisher";
import type { Logger } from "../log";
import { freeBytes as statFreeBytes, relPathProblem, safeJoin, safeRemove } from "../storage/safe-path";
import { acceptedExtensions, classify, type FileKind } from "./formats";
import { readHeader } from "./headers";
import { defaultZipLimits, unpackZip, ZipRejectedError } from "./zip";

export type ProposalRow = typeof proposals.$inferSelect;
type FileRow = typeof proposalFiles.$inferSelect;

/** A refusal with an HTTP status and an error code for the API's error shape. */
export class ProposalError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 413 | 422 | 507,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProposalError";
  }
}

export interface ProposalLimits {
  maxUploadBytes: number;
  maxPendingProposalsPerUser: number;
  maxPendingBytes: number;
  minFreeBytes: number;
}

export interface ProposalServiceOptions {
  db: Db;
  dataDir: string;
  limits: ProposalLimits;
  logger: Logger;
  publisher: Pick<DictPublisher, "publish">;
  /** Free bytes on the volume; replaced in tests. */
  freeBytes?: (dir: string) => Promise<number>;
  now?: () => Date;
}

/** Largest body of one chunk: below Cloudflare's 100 MB request limit (docs/PLAN.md Phase 9). */
export const chunkBytes = 32 * 2 ** 20;
export const maxFilesPerProposal = 50;
/** Unfinished uploads are dropped after this long. */
export const staleUploadMs = 24 * 60 * 60 * 1000;

const openStatuses: ProposalStatus[] = ["uploading", "pending"];

class ChunkTooLargeError extends Error {}

async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest("hex");
}

async function sizeOf(file: string): Promise<number | undefined> {
  try {
    return (await fsp.stat(file)).size;
  } catch {
    return undefined;
  }
}

export class ProposalService {
  readonly #db: Db;
  readonly #limits: ProposalLimits;
  readonly #logger: Logger;
  readonly #publisher: Pick<DictPublisher, "publish">;
  readonly #freeBytes: (dir: string) => Promise<number>;
  readonly #now: () => Date;
  readonly #dataDir: string;
  readonly #tmpRoot: string;
  readonly #quarantine: string;
  readonly #dictDir: string;
  /** "<id>/<position>" → hash of the bytes stored so far. */
  readonly #hashes = new Map<string, { hash: Hash; offset: number }>();
  /** "<id>/<position>" while a chunk is written, "<id>" while a proposal is submitted or approved. */
  readonly #busy = new Set<string>();

  constructor(opts: ProposalServiceOptions) {
    this.#db = opts.db;
    this.#limits = opts.limits;
    this.#logger = opts.logger;
    this.#publisher = opts.publisher;
    this.#freeBytes = opts.freeBytes ?? statFreeBytes;
    this.#now = opts.now ?? (() => new Date());
    this.#dataDir = opts.dataDir;
    this.#tmpRoot = path.join(opts.dataDir, "tmp", "proposals");
    this.#quarantine = path.join(opts.dataDir, "proposals");
    this.#dictDir = path.join(opts.dataDir, "dictionaries");
  }

  uploadLimits(): UploadLimits {
    return {
      maxUploadBytes: this.#limits.maxUploadBytes,
      chunkBytes,
      maxFiles: maxFilesPerProposal,
      maxPendingProposals: this.#limits.maxPendingProposalsPerUser,
      extensions: [...acceptedExtensions],
    };
  }

  // Reading

  #files(id: string): FileRow[] {
    return this.#db.select().from(proposalFiles).where(eq(proposalFiles.proposalId, id)).orderBy(proposalFiles.position, proposalFiles.relPath).all();
  }

  #row(id: string): ProposalRow | undefined {
    return this.#db.select().from(proposals).where(eq(proposals.id, id)).get();
  }

  /** The proposal if it belongs to `userId`; the same 404 otherwise. */
  #owned(userId: string, id: string): ProposalRow {
    const p = this.#row(id);
    if (!p || p.userId !== userId) throw new ProposalError(404, "not_found", "no such proposal");
    return p;
  }

  #dto(p: ProposalRow, files = this.#files(p.id)): Proposal {
    return {
      id: p.id,
      title: p.title,
      description: p.description,
      sourceUrl: p.sourceUrl,
      licenseNote: p.licenseNote,
      status: p.status,
      totalBytes: p.totalBytes,
      fileCount: p.fileCount,
      files: files.map(
        (f): ProposalFile => ({ path: f.relPath, bytes: f.bytes, received: f.received, sha256: f.sha256, kind: f.kind }),
      ),
      metadata: (p.metadataJson as DictionaryMetadata | null) ?? null,
      warnings: (p.warningsJson as ProposalWarning[] | null) ?? [],
      reviewNote: p.reviewNote,
      reviewedAt: p.reviewedAt?.toISOString() ?? null,
      approvedScope: p.approvedScope,
      dictId: p.dictId,
      createdAt: p.createdAt.toISOString(),
      submittedAt: p.submittedAt?.toISOString() ?? null,
    };
  }

  /** The user's proposals (withdrawn ones left out), newest first. */
  listForUser(userId: string): Proposal[] {
    return this.#db
      .select()
      .from(proposals)
      .where(and(eq(proposals.userId, userId), ne(proposals.status, "withdrawn")))
      .orderBy(desc(proposals.createdAt))
      .all()
      .map((p) => this.#dto(p));
  }

  getForUser(userId: string, id: string): Proposal {
    return this.#dto(this.#owned(userId, id));
  }

  #adminDto(p: ProposalRow, proposer: { id: string; name: string; email: string } | null): AdminProposal {
    return { ...this.#dto(p), proposer, reviewedBy: p.reviewedBy };
  }

  /** Every proposal (optionally of one status), newest first, with its proposer. */
  listAdmin(status?: ProposalStatus): AdminProposal[] {
    return this.#db
      .select({ p: proposals, u: { id: user.id, name: user.name, email: user.email } })
      .from(proposals)
      .leftJoin(user, eq(user.id, proposals.userId))
      .where(status ? eq(proposals.status, status) : undefined)
      .orderBy(desc(proposals.createdAt))
      .all()
      .map(({ p, u }) => this.#adminDto(p, u));
  }

  getAdmin(id: string): AdminProposal {
    const r = this.#db
      .select({ p: proposals, u: { id: user.id, name: user.name, email: user.email } })
      .from(proposals)
      .leftJoin(user, eq(user.id, proposals.userId))
      .where(eq(proposals.id, id))
      .get();
    if (!r) throw new ProposalError(404, "not_found", "no such proposal");
    return this.#adminDto(r.p, r.u);
  }

  /** Approvals and rejections the user has not acknowledged. */
  unseenDecisions(userId: string): ProposalUpdate[] {
    return this.#db
      .select({ id: proposals.id, title: proposals.title, status: proposals.status })
      .from(proposals)
      .where(and(eq(proposals.userId, userId), eq(proposals.decisionSeen, false), inArray(proposals.status, ["approved", "rejected"])))
      .orderBy(desc(proposals.reviewedAt))
      .all()
      .map((r) => ({ id: r.id, title: r.title, status: r.status === "approved" ? "approved" : "rejected" }));
  }

  markDecisionsSeen(userId: string): void {
    this.#db
      .update(proposals)
      .set({ decisionSeen: true })
      .where(and(eq(proposals.userId, userId), eq(proposals.decisionSeen, false)))
      .run();
  }

  // Creating and uploading

  /** Checks names, sizes and quotas, then creates an "uploading" proposal. */
  async create(userId: string, req: CreateProposalRequest): Promise<Proposal> {
    const limits = this.#limits;
    if (limits.maxPendingProposalsPerUser === 0) throw new ProposalError(403, "proposals_disabled", "dictionary proposals are turned off");
    if (req.files.length > maxFilesPerProposal) {
      throw new ProposalError(422, "too_many_files", `at most ${String(maxFilesPerProposal)} files; put more into one .zip`);
    }
    const files = req.files.map((f) => {
      const problem = relPathProblem(f.name);
      if (problem) throw new ProposalError(422, "invalid_name", `${f.name}: invalid file name (${problem})`);
      const c = classify(f.name);
      if (!c) throw new ProposalError(422, "unsupported_file", `${f.name}: this file type is not accepted`);
      return { ...f, kind: c.kind };
    });
    checkComposition(files.map((f) => ({ relPath: f.name, kind: f.kind })), true);

    const total = files.reduce((n, f) => n + f.size, 0);
    if (total > limits.maxUploadBytes) {
      throw new ProposalError(413, "too_large", `a proposal may be at most ${String(limits.maxUploadBytes)} bytes`);
    }
    const free = await this.#freeBytes(this.#dataDir);
    if (free - total < limits.minFreeBytes) throw new ProposalError(507, "low_disk", "the server is low on disk space; try again later");

    const id = randomBytes(12).toString("hex");
    this.#db.transaction((tx) => {
      const mine = tx
        .select({ n: sql<number>`count(*)` })
        .from(proposals)
        .where(and(eq(proposals.userId, userId), inArray(proposals.status, openStatuses)))
        .get();
      if ((mine?.n ?? 0) >= limits.maxPendingProposalsPerUser) {
        throw new ProposalError(409, "too_many_proposals", `at most ${String(limits.maxPendingProposalsPerUser)} proposals may wait for review`);
      }
      const pending = tx
        .select({ bytes: sql<number>`coalesce(sum(${proposals.totalBytes}), 0)` })
        .from(proposals)
        .where(inArray(proposals.status, openStatuses))
        .get();
      if ((pending?.bytes ?? 0) + total > limits.maxPendingBytes) {
        throw new ProposalError(507, "review_queue_full", "too many files are waiting for review; try again later");
      }
      tx.insert(proposals)
        .values({
          id,
          userId,
          title: req.title,
          description: req.description || null,
          sourceUrl: req.sourceUrl ?? null,
          licenseNote: req.licenseNote || null,
          status: "uploading",
          totalBytes: total,
          fileCount: files.length,
        })
        .run();
      files.forEach((f, position) => {
        tx.insert(proposalFiles).values({ proposalId: id, position, relPath: f.name, bytes: f.size, kind: f.kind }).run();
      });
    });
    await fsp.mkdir(path.join(this.#tmpRoot, id, "upload"), { recursive: true });
    this.#logger.info("proposal created", { proposalId: id, userId, files: files.length, bytes: total });
    return this.getForUser(userId, id);
  }

  /**
   * Stores one chunk of file `position` at `offset`, which must equal the bytes stored so far. A chunk
   * cut short keeps what arrived; the client resumes from `received`.
   */
  async writeChunk(
    userId: string,
    id: string,
    position: number,
    offset: number,
    body: ReadableStream<Uint8Array> | null,
  ): Promise<{ received: number; complete: boolean }> {
    const p = this.#owned(userId, id);
    if (p.status !== "uploading") throw new ProposalError(409, "not_uploading", "this proposal no longer accepts files");
    const f = this.#files(id).find((x) => x.position === position);
    if (!f) throw new ProposalError(404, "not_found", "no such file in this proposal");
    if (offset !== f.received) {
      throw new ProposalError(409, "offset_mismatch", `expected Upload-Offset ${String(f.received)}`);
    }
    if (f.received === f.bytes) {
      await body?.cancel();
      return { received: f.received, complete: true };
    }
    if (!body) throw new ProposalError(400, "bad_request", "missing request body");
    const key = `${id}/${String(position)}`;
    if (this.#busy.has(key) || this.#busy.has(id)) throw new ProposalError(409, "busy", "this file is being written");
    this.#busy.add(key);
    try {
      const target = await safeJoin(path.join(this.#tmpRoot, id, "upload"), f.relPath);
      const size = (await sizeOf(target)) ?? 0;
      if (size < offset) {
        // The stored file is shorter than recorded (e.g. a crash): resume from what is there.
        this.#setReceived(id, position, size);
        this.#hashes.delete(key);
        throw new ProposalError(409, "offset_mismatch", `expected Upload-Offset ${String(size)}`);
      }
      if (size > offset) await fsp.truncate(target, offset);

      const allowed = Math.min(chunkBytes, f.bytes - offset);
      const state = this.#hashes.get(key);
      const hash = state?.offset === offset ? state.hash : offset === 0 ? createHash("sha256") : undefined;
      let written = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          if (written + chunk.length > allowed) {
            cb(new ChunkTooLargeError());
            return;
          }
          written += chunk.length;
          hash?.update(chunk);
          cb(null, chunk);
        },
      });
      let failure: unknown;
      try {
        await pipeline(
          Readable.fromWeb(body),
          meter,
          fs.createWriteStream(target, offset === 0 ? { flags: "w" } : { flags: "r+", start: offset }),
        );
      } catch (err) {
        failure = err;
      }
      const stored = (await sizeOf(target)) ?? 0;
      this.#setReceived(id, position, stored);
      if (!failure && hash && stored === offset + written) this.#hashes.set(key, { hash, offset: stored });
      else this.#hashes.delete(key);
      if (failure instanceof ChunkTooLargeError) {
        throw new ProposalError(413, "chunk_too_large", `a chunk may hold at most ${String(allowed)} more bytes for this file`);
      }
      if (failure) throw new ProposalError(400, "upload_interrupted", "the upload was interrupted; resume it");
      return { received: stored, complete: stored === f.bytes };
    } finally {
      this.#busy.delete(key);
    }
  }

  #setReceived(id: string, position: number, received: number): void {
    this.#db
      .update(proposalFiles)
      .set({ received })
      .where(and(eq(proposalFiles.proposalId, id), eq(proposalFiles.position, position)))
      .run();
  }

  #lock(id: string): void {
    if (this.#busy.has(id) || [...this.#busy].some((k) => k.startsWith(`${id}/`))) {
      throw new ProposalError(409, "busy", "this proposal is being changed; try again");
    }
    this.#busy.add(id);
  }

  /** Checks the uploaded files and moves them into quarantine ("pending"). A refused upload is deleted. */
  async submit(userId: string, id: string): Promise<Proposal> {
    const p = this.#owned(userId, id);
    if (p.status !== "uploading") throw new ProposalError(409, "not_uploading", "this proposal was already submitted");
    const uploaded = this.#files(id);
    if (uploaded.some((f) => f.received !== f.bytes)) throw new ProposalError(409, "incomplete", "some files are not fully uploaded");
    this.#lock(id);
    const work = path.join(this.#tmpRoot, id);
    try {
      const final = await this.#prepare(id, uploaded, work);
      const main = final.find((f) => f.kind === "main");
      const format = main ? classify(path.posix.basename(main.relPath))?.format : undefined;
      if (!main || !format) throw new ProposalError(422, "needs_main_file", "no dictionary file found");
      const filesDir = path.join(work, "files");
      const header = await readHeader(await safeJoin(filesDir, main.relPath), main.relPath, format);
      const warnings = [...header.warnings, ...this.#jsWarnings(final), ...(await this.#duplicates(id, final))];

      await fsp.mkdir(this.#quarantine, { recursive: true });
      const dest = await safeJoin(this.#quarantine, id);
      await fsp.rename(filesDir, dest);
      const now = this.#now();
      this.#db.transaction((tx) => {
        tx.delete(proposalFiles).where(eq(proposalFiles.proposalId, id)).run();
        final.forEach((f, position) => {
          tx.insert(proposalFiles)
            .values({ proposalId: id, position, relPath: f.relPath, bytes: f.bytes, received: f.bytes, sha256: f.sha256, kind: f.kind })
            .run();
        });
        tx.update(proposals)
          .set({
            status: "pending",
            metadataJson: header.metadata,
            warningsJson: warnings,
            totalBytes: final.reduce((n, f) => n + f.bytes, 0),
            fileCount: final.length,
            submittedAt: now,
            updatedAt: now,
          })
          .where(eq(proposals.id, id))
          .run();
      });
      await fsp.rm(work, { recursive: true, force: true });
      this.#forgetHashes(id);
      this.#logger.info("proposal submitted", { proposalId: id, userId, files: final.length, warnings: warnings.map((w) => w.code) });
      return this.getForUser(userId, id);
    } catch (err) {
      if (err instanceof ZipRejectedError || (err instanceof ProposalError && err.status === 422)) {
        // Nothing an admin needs to see: drop the upload so the user can fix it and try again.
        await fsp.rm(work, { recursive: true, force: true });
        this.#db.delete(proposals).where(eq(proposals.id, id)).run();
        this.#forgetHashes(id);
        this.#logger.info("proposal refused on submit", { proposalId: id, userId, reason: err.message });
        throw new ProposalError(422, "invalid_upload", err.message);
      }
      throw err;
    } finally {
      this.#busy.delete(id);
    }
  }

  /** Unpacks a zip or moves the uploaded files into work/files; answers every file with its hash. */
  async #prepare(id: string, uploaded: FileRow[], work: string): Promise<{ relPath: string; bytes: number; sha256: string; kind: FileKind }[]> {
    const uploadDir = path.join(work, "upload");
    const filesDir = path.join(work, "files");
    await fsp.rm(filesDir, { recursive: true, force: true });
    const [only] = uploaded;
    if (uploaded.length === 1 && only?.kind === "zip") {
      const free = await this.#freeBytes(this.#dataDir);
      const room = free - this.#limits.minFreeBytes;
      if (room <= 0) throw new ProposalError(507, "low_disk", "the server is low on disk space; try again later");
      const limits = defaultZipLimits(this.#limits.maxUploadBytes);
      const zipFile = await safeJoin(uploadDir, only.relPath);
      const unpacked = await unpackZip(zipFile, filesDir, { ...limits, maxTotalBytes: Math.min(limits.maxTotalBytes, room) });
      await fsp.rm(uploadDir, { recursive: true, force: true });
      const final = unpacked.map((u) => ({ ...u, kind: classify(path.posix.basename(u.relPath))?.kind ?? "resource" }));
      checkComposition(final, false);
      return final;
    }
    const final = [];
    for (const f of uploaded) {
      const file = await safeJoin(uploadDir, f.relPath);
      const st = await fsp.lstat(file);
      if (!st.isFile() || st.size !== f.bytes) throw new ProposalError(409, "incomplete", `${f.relPath} is not fully uploaded`);
      const state = this.#hashes.get(`${id}/${String(f.position)}`);
      const sha256 = state?.offset === f.bytes ? state.hash.digest("hex") : await hashFile(file);
      final.push({ relPath: f.relPath, bytes: f.bytes, sha256, kind: f.kind });
    }
    await fsp.rename(uploadDir, filesDir);
    return final;
  }

  #forgetHashes(id: string): void {
    for (const k of this.#hashes.keys()) if (k.startsWith(`${id}/`)) this.#hashes.delete(k);
  }

  #jsWarnings(files: readonly { relPath: string }[]): ProposalWarning[] {
    const js = files.filter((f) => f.relPath.toLowerCase().endsWith(".js"));
    return js.map((f) => ({
      code: "contains_js" as const,
      message: "scripts run inside the article frame; keep trusted rendering off unless you reviewed them",
      path: f.relPath,
    }));
  }

  /** The same dictionary or media file in another open/approved proposal, or as an existing dictionary. */
  async #duplicates(id: string, files: readonly { relPath: string; bytes: number; sha256: string; kind: FileKind }[]): Promise<ProposalWarning[]> {
    const warnings: ProposalWarning[] = [];
    const important = files.filter((f) => f.kind === "main" || f.kind === "companion");
    for (const f of important) {
      const same = this.#db
        .select({ id: proposals.id, title: proposals.title, status: proposals.status, dictId: proposals.dictId })
        .from(proposalFiles)
        .innerJoin(proposals, eq(proposals.id, proposalFiles.proposalId))
        .where(and(eq(proposalFiles.sha256, f.sha256), ne(proposals.id, id), inArray(proposals.status, ["pending", "approved"])))
        .all();
      for (const s of same) {
        warnings.push({
          code: "duplicate",
          message: s.status === "approved" ? `same file as dictionary "${s.dictId ?? s.title}" (approved proposal)` : `same file as the pending proposal "${s.title}"`,
          path: f.relPath,
        });
      }
    }
    // Dictionaries copied in by the operator: compare by size first, hash only on a match.
    const main = files.find((f) => f.kind === "main");
    if (main) {
      const builtins = this.#db.select().from(dictionaries).where(eq(dictionaries.source, "builtin")).all();
      let hashed = 0;
      for (const d of builtins) {
        if (!d.sourcePath?.startsWith(this.#dictDir + path.sep) || hashed >= 5) continue;
        const size = await sizeOf(d.sourcePath);
        if (size !== main.bytes) continue;
        hashed++;
        const sha = await hashFile(d.sourcePath).catch(() => undefined);
        if (sha === main.sha256) warnings.push({ code: "duplicate", message: `same file as dictionary "${d.title}"`, path: main.relPath });
      }
    }
    return warnings;
  }

  // Withdrawing, rejecting, approving

  /** Deletes the files of an open proposal; answers the bytes freed. */
  async #removeFiles(id: string): Promise<number> {
    let freed = 0;
    freed += await safeRemove(this.#tmpRoot, id);
    freed += await safeRemove(this.#quarantine, id);
    this.#forgetHashes(id);
    return freed;
  }

  /** The proposer withdraws an "uploading" or "pending" proposal; its files are deleted at once. */
  async withdraw(userId: string, id: string): Promise<void> {
    const p = this.#owned(userId, id);
    if (!openStatuses.includes(p.status)) throw new ProposalError(409, "not_open", "only proposals waiting for review can be withdrawn");
    this.#lock(id);
    try {
      this.#db.update(proposals).set({ status: "withdrawn", updatedAt: this.#now() }).where(eq(proposals.id, id)).run();
      const freed = await this.#removeFiles(id);
      this.#logger.info("proposal withdrawn", { proposalId: id, userId, bytesFreed: freed });
    } finally {
      this.#busy.delete(id);
    }
  }

  #pending(id: string): ProposalRow {
    const p = this.#row(id);
    if (!p) throw new ProposalError(404, "not_found", "no such proposal");
    if (p.status !== "pending") throw new ProposalError(409, "not_pending", "only pending proposals can be reviewed");
    return p;
  }

  /** Rejects a pending proposal: its files are deleted at once, the reason is kept for the proposer. */
  async reject(adminId: string, id: string, note: string): Promise<AdminProposal> {
    this.#pending(id);
    this.#lock(id);
    try {
      // Checked again under the lock: another review may have finished meanwhile.
      this.#pending(id);
      const now = this.#now();
      this.#db
        .update(proposals)
        .set({ status: "rejected", reviewNote: note, reviewedBy: adminId, reviewedAt: now, decisionSeen: false, updatedAt: now })
        .where(eq(proposals.id, id))
        .run();
      const freed = await this.#removeFiles(id);
      recordAudit(this.#db, { actorUserId: adminId, action: "proposal.reject", targetType: "proposal", targetId: id, bytesFreed: freed });
      return this.getAdmin(id);
    } finally {
      this.#busy.delete(id);
    }
  }

  /**
   * Approves a pending proposal: creates the dictionary (hidden), moves the files into
   * DICT_DIR/<dictId>/ and starts rescan + indexing; `scope` applies once indexing succeeded.
   */
  async approve(
    adminId: string,
    id: string,
    req: { dictId: string; scope: ApprovalScope; trustedRender: boolean; title?: string | undefined; note?: string | undefined },
  ): Promise<AdminProposal> {
    const p = this.#pending(id);
    if (req.scope === "private" && !p.userId) {
      throw new ProposalError(409, "no_proposer", "the proposer's account no longer exists; choose global or hidden");
    }
    const main = this.#files(id).find((f) => f.kind === "main");
    if (!main) throw new ProposalError(409, "needs_main_file", "the proposal has no dictionary file");
    if (this.#db.select({ id: dictionaries.id }).from(dictionaries).where(eq(dictionaries.id, req.dictId)).get()) {
      throw new ProposalError(409, "dict_id_taken", "a dictionary with this id already exists");
    }
    const dest = await safeJoin(this.#dictDir, req.dictId);
    if ((await sizeOf(dest)) !== undefined) throw new ProposalError(409, "dict_id_taken", "a folder with this id already exists");
    const src = await safeJoin(this.#quarantine, id);
    if ((await sizeOf(src)) === undefined) throw new ProposalError(409, "files_missing", "the proposal's files are missing on disk");

    this.#lock(id);
    try {
      // Checked again under the lock: the checks above awaited, and another review may have finished.
      this.#pending(id);
      const format = classify(path.posix.basename(main.relPath))?.format ?? null;
      // The row exists before the files appear in DICT_DIR, so the catalogue sync claims them by path
      // instead of creating a "builtin" row that users could see before indexing.
      this.#db
        .insert(dictionaries)
        .values({
          id: req.dictId,
          title: req.title ?? p.title,
          format,
          source: "proposal",
          visibility: "hidden",
          trustedRender: req.trustedRender,
          sourcePath: path.join(dest, ...main.relPath.split("/")),
          sourceBytes: p.totalBytes,
          proposalId: id,
        })
        .run();
      try {
        await fsp.mkdir(this.#dictDir, { recursive: true });
        await fsp.rename(src, dest);
      } catch (err) {
        this.#db.delete(dictionaries).where(eq(dictionaries.id, req.dictId)).run();
        throw err;
      }
      const now = this.#now();
      this.#db
        .update(proposals)
        .set({
          status: "approved",
          approvedScope: req.scope,
          dictId: req.dictId,
          reviewNote: req.note || null,
          reviewedBy: adminId,
          reviewedAt: now,
          decisionSeen: false,
          updatedAt: now,
        })
        .where(eq(proposals.id, id))
        .run();
      recordAudit(this.#db, {
        actorUserId: adminId,
        action: "proposal.approve",
        targetType: "proposal",
        targetId: id,
        details: { dictId: req.dictId, scope: req.scope, trustedRender: req.trustedRender },
      });
      void this.#publisher.publish(req.dictId, {
        visibility: req.scope,
        ownerUserId: req.scope === "private" ? p.userId : null,
      });
      return this.getAdmin(id);
    } finally {
      this.#busy.delete(id);
    }
  }

  /** The target visibility of a dictionary approved from a proposal, for an indexing retry. */
  publishTargetOf(dictId: string): { visibility: ApprovalScope; ownerUserId: string | null } | undefined {
    const p = this.#db.select().from(proposals).where(and(eq(proposals.dictId, dictId), eq(proposals.status, "approved"))).get();
    if (!p?.approvedScope) return undefined;
    return { visibility: p.approvedScope, ownerUserId: p.approvedScope === "private" ? p.userId : null };
  }

  // Background clean-up (jobs.ts)

  /**
   * Withdraws uploads unfinished for `staleUploadMs` and open proposals whose proposer was deleted, and
   * removes upload folders without a proposal. Answers what it did.
   */
  async cleanup(): Promise<{ withdrawn: number; orphans: number; bytesFreed: number }> {
    const cutoff = new Date(this.#now().getTime() - staleUploadMs);
    const stale = this.#db
      .select({ id: proposals.id })
      .from(proposals)
      .where(
        or(
          and(eq(proposals.status, "uploading"), lt(proposals.createdAt, cutoff)),
          and(inArray(proposals.status, openStatuses), isNull(proposals.userId)),
        ),
      )
      .all();
    let bytesFreed = 0;
    let withdrawn = 0;
    for (const { id } of stale) {
      if (this.#busy.has(id) || [...this.#busy].some((k) => k.startsWith(`${id}/`))) continue;
      this.#db.update(proposals).set({ status: "withdrawn", updatedAt: this.#now() }).where(eq(proposals.id, id)).run();
      bytesFreed += await this.#removeFiles(id);
      withdrawn++;
    }
    let orphans = 0;
    let names: string[] = [];
    try {
      names = await fsp.readdir(this.#tmpRoot);
    } catch {
      // No uploads yet.
    }
    const uploading = new Set(
      this.#db.select({ id: proposals.id }).from(proposals).where(eq(proposals.status, "uploading")).all().map((r) => r.id),
    );
    for (const name of names) {
      if (uploading.has(name) || this.#busy.has(name) || relPathProblem(name)) continue;
      bytesFreed += await safeRemove(this.#tmpRoot, name);
      orphans++;
    }
    return { withdrawn, orphans, bytesFreed };
  }
}

/**
 * A proposal is one .zip on its own, or exactly one main dictionary file with its companions and
 * resources. `uploading` allows the single zip (unpacked and checked again on submit).
 */
export function checkComposition(files: readonly { relPath: string; kind: FileKind }[], uploading: boolean): void {
  const zips = files.filter((f) => f.kind === "zip");
  if (zips.length) {
    if (!uploading || files.length > 1) throw new ProposalError(422, "zip_alone", "a .zip must be the only file of a proposal");
    return;
  }
  const mains = files.filter((f) => f.kind === "main");
  if (mains.length === 0) throw new ProposalError(422, "needs_main_file", "add the dictionary file itself (.mdx, .dsl, .ifo, …)");
  if (mains.length > 1) {
    throw new ProposalError(422, "several_main_files", `one dictionary per proposal; found ${mains.map((m) => m.relPath).join(", ")}`);
  }
}
