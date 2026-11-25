// Sends a proposal's files in chunks (ADR 0008). Each chunk is written at the offset the gateway
// reports, so a dropped connection, a reload or another device resumes where the stored bytes end; a
// failed chunk is retried a few times with a growing pause before the user is asked to try again.
import { ApiError, getProposal, isNetworkError, uploadChunk, type Proposal } from "../api/app";

export interface UploadProgress {
  /** Bytes the server has stored, over every file. */
  sent: number;
  total: number;
  /** The file being sent. */
  file: string;
}

export interface UploadDeps {
  uploadChunk: typeof uploadChunk;
  getProposal: typeof getProposal;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps: UploadDeps = {
  uploadChunk,
  getProposal,
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

const maxRetries = 5;

/** A failure worth retrying: the network, an interrupted body, or the server being busy or down. */
function retryable(err: unknown): boolean {
  if (isNetworkError(err)) return true;
  if (!(err instanceof ApiError)) return false;
  return err.code === "upload_interrupted" || err.code === "busy" || err.status >= 500;
}

/**
 * Pairs the files the user picked with a proposal's file list by name and size (for resuming);
 * undefined when one is missing.
 */
export function matchFiles(proposal: Pick<Proposal, "files">, picked: readonly File[]): File[] | undefined {
  const out: File[] = [];
  for (const f of proposal.files) {
    const m = picked.find((p) => p.name === f.path && p.size === f.bytes);
    if (!m) return undefined;
    out.push(m);
  }
  return out;
}

/**
 * Uploads `files` (in the proposal's file order) from what the server already has. Resolves when every
 * file is complete; throws the last error when retries run out or on a refusal.
 */
export async function uploadFiles(
  proposal: Proposal,
  files: readonly Blob[],
  chunkBytes: number,
  onProgress: (p: UploadProgress) => void,
  signal?: AbortSignal,
  deps: UploadDeps = defaultDeps,
): Promise<void> {
  const total = proposal.files.reduce((n, f) => n + f.bytes, 0);
  const received = proposal.files.map((f) => f.received);
  const sent = () => received.reduce((n, r) => n + r, 0);

  for (const [i, meta] of proposal.files.entries()) {
    const file = files[i];
    if (!file) throw new Error(`missing file ${meta.path}`);
    let retries = 0;
    while ((received[i] ?? 0) < meta.bytes) {
      signal?.throwIfAborted();
      const offset = received[i] ?? 0;
      onProgress({ sent: sent(), total, file: meta.path });
      try {
        const r = await deps.uploadChunk(proposal.id, i, offset, file.slice(offset, offset + chunkBytes), signal);
        received[i] = r.received;
        retries = 0;
      } catch (err) {
        if (signal?.aborted) throw err;
        const mismatch = err instanceof ApiError && err.code === "offset_mismatch";
        if (!mismatch) {
          if (!retryable(err) || ++retries > maxRetries) throw err;
          await deps.sleep(Math.min(30_000, 1000 * 2 ** (retries - 1)));
        }
        // Ask where the stored bytes end (they may have moved on before the error).
        const fresh = await deps.getProposal(proposal.id, signal);
        received[i] = fresh.files[i]?.received ?? offset;
      }
    }
  }
  onProgress({ sent: sent(), total, file: "" });
}

/** "12.3 MB" (decimal units, like the server's MAX_UPLOAD_BYTES). */
export function formatBytes(n: number, locale?: string): string {
  const units = ["B", "kB", "MB", "GB", "TB"];
  let v = n;
  let u = 0;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u++;
  }
  const digits = u === 0 || v >= 100 ? 0 : 1;
  return `${v.toLocaleString(locale, { maximumFractionDigits: digits })} ${units[u] ?? "B"}`;
}

/** A dictionary id suggestion from a title (the gateway's slugify rules: a–z, 0–9 and "-"). */
export function suggestDictId(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return slug || "dict";
}
