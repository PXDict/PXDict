import { describe, expect, it, vi } from "vitest";
import { ApiError, type Proposal } from "../api/app";
import { formatBytes, matchFiles, suggestDictId, uploadFiles, type UploadDeps } from "./upload";

const proposal = (sizes: number[], received: number[] = sizes.map(() => 0)): Proposal => ({
  id: "p1",
  title: "T",
  description: null,
  sourceUrl: null,
  licenseNote: null,
  status: "uploading",
  totalBytes: sizes.reduce((a, b) => a + b, 0),
  fileCount: sizes.length,
  files: sizes.map((bytes, i) => ({ path: `f${String(i)}.mdx`, bytes, received: received[i] ?? 0, sha256: null, kind: "main" })),
  metadata: null,
  warnings: [],
  reviewNote: null,
  reviewedAt: null,
  approvedScope: null,
  dictId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  submittedAt: null,
});

/** A fake server that stores bytes per file and can fail on demand. */
function server(sizes: number[], failures: Error[] = []) {
  const stored = sizes.map(() => 0);
  const calls: [number, number, number][] = [];
  const deps: UploadDeps = {
    uploadChunk: vi.fn((_id: string, index: number, offset: number, chunk: Blob) => {
      calls.push([index, offset, chunk.size]);
      const fail = failures.shift();
      if (fail) return Promise.reject(fail);
      if (offset !== stored[index]) return Promise.reject(new ApiError(409, "offset_mismatch", "x"));
      stored[index] = offset + chunk.size;
      return Promise.resolve({ received: stored[index], complete: stored[index] === sizes[index] });
    }),
    getProposal: vi.fn(() => Promise.resolve(proposal(sizes, stored))),
    sleep: () => Promise.resolve(),
  };
  return { stored, calls, deps };
}

const blob = (n: number) => new Blob([new Uint8Array(n)]);

describe("uploadFiles", () => {
  it("sends every file in chunks and reports progress", async () => {
    const s = server([10, 4]);
    const progress: number[] = [];
    await uploadFiles(proposal([10, 4]), [blob(10), blob(4)], 4, (p) => progress.push(p.sent), undefined, s.deps);
    expect(s.calls).toEqual([
      [0, 0, 4],
      [0, 4, 4],
      [0, 8, 2],
      [1, 0, 4],
    ]);
    expect(s.stored).toEqual([10, 4]);
    expect(progress.at(-1)).toBe(14);
  });

  it("starts from what the server already has", async () => {
    const s = server([10]);
    s.stored[0] = 6;
    await uploadFiles(proposal([10], [6]), [blob(10)], 100, () => undefined, undefined, s.deps);
    expect(s.calls).toEqual([[0, 6, 4]]);
  });

  it("retries network failures and resumes at the server's offset", async () => {
    const s = server([8], [new TypeError("offline"), new ApiError(400, "upload_interrupted", "x")]);
    await uploadFiles(proposal([8]), [blob(8)], 8, () => undefined, undefined, s.deps);
    expect(s.stored).toEqual([8]);
    expect(s.deps.getProposal).toHaveBeenCalledTimes(2);
  });

  it("gives up on a refusal", async () => {
    const s = server([8], [new ApiError(413, "chunk_too_large", "x")]);
    await expect(uploadFiles(proposal([8]), [blob(8)], 8, () => undefined, undefined, s.deps)).rejects.toMatchObject({ code: "chunk_too_large" });
  });

  it("gives up after a few retries", async () => {
    const s = server([8], Array.from({ length: 10 }, () => new TypeError("offline")));
    await expect(uploadFiles(proposal([8]), [blob(8)], 8, () => undefined, undefined, s.deps)).rejects.toBeInstanceOf(TypeError);
    expect(s.calls.length).toBe(6);
  });
});

describe("helpers", () => {
  it("matches re-selected files by name and size", () => {
    const p = proposal([3, 5]);
    const a = new File(["abc"], "f0.mdx");
    const b = new File(["abcde"], "f1.mdx");
    expect(matchFiles(p, [b, a])).toEqual([a, b]);
    expect(matchFiles(p, [a])).toBeUndefined();
    expect(matchFiles(p, [a, new File(["x"], "f1.mdx")])).toBeUndefined();
  });

  it.each([
    [0, "0 B"],
    [999, "999 B"],
    [1500, "1.5 kB"],
    [500e6, "500 MB"],
  ])("formatBytes(%d) = %j", (n, s) => {
    expect(formatBytes(n, "en")).toBe(s);
  });

  it("suggests dictionary ids like the gateway", () => {
    expect(suggestDictId("Từ điển Đức–Việt")).toBe("tu-dien-duc-viet");
    expect(suggestDictId("***")).toBe("dict");
  });
});
