import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AdminDict, AdminProposal, ChunkResponse, Me, MyDictList, Proposal, ProposalList } from "@pxdict/shared";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditLog, dictionaries, proposals as proposalsTable } from "../db/schema";
import { harness, ndjsonLines, type TestClient } from "../test/harness";
import { makeMdx, makeZip } from "../test/zip";

type H = ReturnType<typeof harness>;

const mdx = makeMdx({ GeneratedByEngineVersion: "2.0", Encrypted: "2", Encoding: "UTF-8", Title: "PX Test" }, 7);

interface Upload {
  name: string;
  data: Buffer | string;
}

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

async function create(c: TestClient, files: Upload[], title = "PX Test"): Promise<Response> {
  return c.post("/app-api/proposals", {
    title,
    description: "a test dictionary",
    sourceUrl: "https://example.com/dict",
    licenseNote: "CC BY 4.0",
    files: files.map((f) => ({ name: f.name, size: Buffer.byteLength(f.data) })),
  });
}

const put = (c: TestClient, id: string, index: number, offset: number, body: Buffer | string) =>
  c.request(`/app-api/proposals/${id}/files/${String(index)}`, {
    method: "PUT",
    headers: { "Upload-Offset": String(offset), "Content-Type": "application/offset+octet-stream" },
    body: typeof body === "string" ? body : new Uint8Array(body),
  });

/** Creates, uploads (in two chunks per file) and submits a proposal. */
async function propose(c: TestClient, files: Upload[], title?: string): Promise<{ res: Response; id: string }> {
  const created = await create(c, files, title);
  expect(created.status).toBe(201);
  const { id } = await json<Proposal>(created);
  for (const [i, f] of files.entries()) {
    const data = Buffer.from(f.data);
    const half = Math.ceil(data.length / 2);
    expect((await put(c, id, i, 0, data.subarray(0, half))).status).toBe(200);
    const last = await put(c, id, i, half, data.subarray(half));
    expect(await json<ChunkResponse>(last)).toEqual({ received: data.length, complete: true });
  }
  return { res: await c.post(`/app-api/proposals/${id}/submit`, {}), id };
}

describe("dictionary proposals", () => {
  let dataDir: string;
  let h: H;
  let free: number;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pxdict-proposals-"));
    free = 100e9;
    h = harness({
      dataDir,
      freeBytes: () => free,
      env: { MAX_UPLOAD_BYTES: "1MB", MAX_PENDING_PROPOSALS_PER_USER: "2", MAX_PENDING_BYTES: "3MB", MIN_FREE_BYTES: "10MB" },
    });
  });
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const exists = (rel: string) => fs.existsSync(path.join(dataDir, rel));
  const admin = () => h.signedIn({ email: "admin@example.com", role: "admin" });

  describe("proposer", () => {
    it("uploads in chunks, checks the files on submit and quarantines them", async () => {
      const { client } = await h.signedIn({ email: "u@example.com" });
      const { res, id } = await propose(client, [
        { name: "pxtest.mdx", data: mdx },
        { name: "pxtest.css", data: "b{color:red}" },
        { name: "pxtest.js", data: "console.log(1)" },
      ]);
      expect(res.status).toBe(200);
      const p = await json<Proposal>(res);
      expect(p).toMatchObject({ status: "pending", fileCount: 3, sourceUrl: "https://example.com/dict", licenseNote: "CC BY 4.0" });
      expect(p.metadata).toMatchObject({ format: "mdx", mainFile: "pxtest.mdx", title: "PX Test", entries: 7, version: "2.0" });
      expect(p.warnings.map((w) => w.code)).toEqual(["contains_js"]);
      expect(p.files.map((f) => [f.path, f.kind])).toEqual([
        ["pxtest.mdx", "main"],
        ["pxtest.css", "resource"],
        ["pxtest.js", "resource"],
      ]);
      expect(p.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256 ?? ""))).toBe(true);
      expect(fs.readFileSync(path.join(dataDir, "proposals", id, "pxtest.mdx"))).toEqual(mdx);
      expect(exists(`tmp/proposals/${id}`)).toBe(false);
      // Not visible to wuDict: nothing in DICT_DIR yet.
      expect(exists("dictionaries")).toBe(false);

      const list = await json<ProposalList>(await client.request("/app-api/me/proposals"));
      expect(list.proposals.map((x) => x.id)).toEqual([id]);
    });

    it("resumes at the stored offset and refuses chunks that do not fit", async () => {
      const { client } = await h.signedIn({ email: "u@example.com" });
      const { id } = await json<Proposal>(await create(client, [{ name: "a.mdx", data: mdx }]));
      expect((await put(client, id, 0, 0, mdx.subarray(0, 10))).status).toBe(200);
      const wrong = await put(client, id, 0, 0, mdx);
      expect(wrong.status).toBe(409);
      expect(await wrong.text()).toContain("expected Upload-Offset 10");
      const status = await json<Proposal>(await client.request(`/app-api/proposals/${id}`));
      expect(status.files[0]?.received).toBe(10);
      expect((await put(client, id, 0, 10, Buffer.concat([mdx.subarray(10), Buffer.from("extra")]))).status).toBe(413);
      expect((await put(client, id, 0, 10, mdx.subarray(10))).status).toBe(200);
      expect((await put(client, id, 1, 0, "x")).status).toBe(404);
      expect((await client.request(`/app-api/proposals/${id}/files/0`, { method: "PUT", body: "x" })).status).toBe(400);
      expect((await client.post(`/app-api/proposals/${id}/submit`, {})).status).toBe(200);
      expect((await put(client, id, 0, mdx.length, "x")).status).toBe(409);
    });

    it("refuses to submit an incomplete upload", async () => {
      const { client } = await h.signedIn({ email: "u@example.com" });
      const { id } = await json<Proposal>(await create(client, [{ name: "a.mdx", data: mdx }]));
      await put(client, id, 0, 0, mdx.subarray(0, 5));
      const res = await client.post(`/app-api/proposals/${id}/submit`, {});
      expect(res.status).toBe(409);
    });

    it.each<[string, Upload[], number, string]>([
      ["an unknown file type", [{ name: "a.mdx", data: "x" }, { name: "x.exe", data: "x" }], 422, "unsupported_file"],
      ["no dictionary file", [{ name: "a.css", data: "x" }], 422, "needs_main_file"],
      ["two dictionaries", [{ name: "a.mdx", data: "x" }, { name: "b.dsl", data: "x" }], 422, "several_main_files"],
      ["a zip with other files", [{ name: "a.zip", data: "x" }, { name: "b.css", data: "x" }], 422, "zip_alone"],
      ["a hidden file name", [{ name: "a.mdx", data: "x" }, { name: ".htaccess.css", data: "x" }], 422, "invalid_name"],
      ["more than MAX_UPLOAD_BYTES", [{ name: "a.mdx", data: Buffer.alloc(1_000_001) }], 413, "too_large"],
    ])("refuses %s on create", async (_label, files, status, code) => {
      const { client } = await h.signedIn({ email: "u@example.com" });
      const res = await create(client, files);
      expect(res.status).toBe(status);
      expect(await res.text()).toContain(code);
    });

    it("refuses path-like names in the request", async () => {
      const { client } = await h.signedIn({ email: "u@example.com" });
      const res = await client.post("/app-api/proposals", { title: "x", files: [{ name: "../a.mdx", size: 1 }] });
      expect(res.status).toBe(400);
    });

    it("enforces the per-user, review-queue and free-disk quotas", async () => {
      const a = (await h.signedIn({ email: "a@example.com" })).client;
      const b = (await h.signedIn({ email: "b@example.com" })).client;
      const big = [{ name: "a.mdx", data: Buffer.alloc(900_000) }];
      expect((await create(a, big)).status).toBe(201);
      expect((await create(a, big)).status).toBe(201);
      const third = await create(a, big);
      expect(third.status).toBe(409);
      expect(await third.text()).toContain("too_many_proposals");
      // 1.8 MB waiting; 0.9 MB more fits under 3 MB, the next does not.
      expect((await create(b, big)).status).toBe(201);
      const full = await create(b, big);
      expect(full.status).toBe(507);
      expect(await full.text()).toContain("review_queue_full");
      free = 10e6;
      const c = (await h.signedIn({ email: "c@example.com" })).client;
      const low = await create(c, [{ name: "a.mdx", data: "x" }]);
      expect(low.status).toBe(507);
      expect(await low.text()).toContain("low_disk");
    });

    it("unpacks a zip on submit", async () => {
      const { client } = await h.signedIn({ email: "u@example.com" });
      const zip = makeZip([
        { name: "Test/" },
        { name: "Test/test.mdx", data: mdx, deflate: true },
        { name: "Test/test.mdd", data: "media" },
        { name: "Test/img/x.png", data: "png" },
      ]);
      const { res, id } = await propose(client, [{ name: "test.zip", data: zip }]);
      expect(res.status).toBe(200);
      const p = await json<Proposal>(res);
      expect(p.files.map((f) => [f.path, f.kind, f.bytes])).toEqual([
        ["test.mdx", "main", mdx.length],
        ["test.mdd", "companion", 5],
        ["img/x.png", "resource", 3],
      ]);
      expect(p.metadata?.entries).toBe(7);
      expect(exists(`proposals/${id}/img/x.png`)).toBe(true);
      expect(exists(`proposals/${id}/test.zip`)).toBe(false);
    });

    it("drops a refused zip entirely, so the user can try again", async () => {
      const { client } = await h.signedIn({ email: "u@example.com" });
      const zip = makeZip([{ name: "a.mdx", data: "x" }, { name: "../../evil.css", data: "x" }]);
      const { res, id } = await propose(client, [{ name: "bad.zip", data: zip }]);
      expect(res.status).toBe(422);
      expect(await res.text()).toContain("invalid_upload");
      expect(exists(`tmp/proposals/${id}`)).toBe(false);
      expect(exists(`proposals/${id}`)).toBe(false);
      expect(h.db.select().from(proposalsTable).all()).toEqual([]);
    });

    it("withdraws a pending proposal and deletes its files at once", async () => {
      const { client } = await h.signedIn({ email: "u@example.com" });
      const { id } = await propose(client, [{ name: "a.mdx", data: mdx }]);
      expect(exists(`proposals/${id}`)).toBe(true);
      expect((await client.request(`/app-api/proposals/${id}`, { method: "DELETE" })).status).toBe(204);
      expect(exists(`proposals/${id}`)).toBe(false);
      expect((await json<ProposalList>(await client.request("/app-api/me/proposals"))).proposals).toEqual([]);
      expect((await client.request(`/app-api/proposals/${id}`, { method: "DELETE" })).status).toBe(409);
    });

    it("keeps proposals private to their proposer", async () => {
      const a = (await h.signedIn({ email: "a@example.com" })).client;
      const b = (await h.signedIn({ email: "b@example.com" })).client;
      const { id } = await propose(a, [{ name: "a.mdx", data: mdx }]);
      expect((await b.request(`/app-api/proposals/${id}`)).status).toBe(404);
      expect((await b.request(`/app-api/proposals/${id}`, { method: "DELETE" })).status).toBe(404);
      expect((await put(b, id, 0, 0, "x")).status).toBe(404);
      expect((await json<ProposalList>(await b.request("/app-api/me/proposals"))).proposals).toEqual([]);
      expect((await h.client().request("/app-api/proposals/limits")).status).toBe(401);
      expect((await a.request("/app-api/proposals/limits")).status).toBe(200);
      // Writes need the origin check.
      expect((await a.post("/app-api/proposals", { title: "x", files: [] }, { headers: { Origin: "https://evil.example" } })).status).toBe(403);
    });

    it("warns about a duplicate of another proposal", async () => {
      const { client } = await h.signedIn({ email: "u@example.com" });
      await propose(client, [{ name: "a.mdx", data: mdx }]);
      const { res } = await propose(client, [{ name: "b.mdx", data: mdx }], "Again");
      const p = await json<Proposal>(res);
      expect(p.warnings.map((w) => w.code)).toEqual(["duplicate"]);
    });

    it("removes abandoned uploads", async () => {
      const { client } = await h.signedIn({ email: "u@example.com" });
      const { id } = await json<Proposal>(await create(client, [{ name: "a.mdx", data: mdx }]));
      await put(client, id, 0, 0, mdx.subarray(0, 5));
      fs.mkdirSync(path.join(dataDir, "tmp/proposals/orphan"), { recursive: true });
      expect(await h.app.services.proposals.cleanup()).toMatchObject({ withdrawn: 0, orphans: 1 });
      h.db.update(proposalsTable).set({ createdAt: new Date(Date.now() - 25 * 3600_000) }).where(eq(proposalsTable.id, id)).run();
      expect(await h.app.services.proposals.cleanup()).toMatchObject({ withdrawn: 1, bytesFreed: 5 });
      expect(exists(`tmp/proposals/${id}`)).toBe(false);
    });
  });

  describe("admin review", () => {
    it("is for admins only", async () => {
      const { client } = await h.signedIn({ email: "u@example.com" });
      expect((await client.request("/app-api/admin/proposals")).status).toBe(403);
      expect((await client.request("/app-api/admin/dicts")).status).toBe(403);
      expect((await client.post("/app-api/admin/dicts/rescan", {})).status).toBe(403);
    });

    it("lists proposals with their proposer and rejects one, deleting its files", async () => {
      const { client, user } = await h.signedIn({ email: "u@example.com", name: "Una" });
      const { id } = await propose(client, [{ name: "a.mdx", data: mdx }]);
      const a = (await admin()).client;
      const list = await json<{ proposals: AdminProposal[] }>(await a.request("/app-api/admin/proposals?status=pending"));
      expect(list.proposals.map((p) => [p.id, p.proposer?.name])).toEqual([[id, "Una"]]);
      expect((await a.request("/app-api/admin/proposals?status=bogus")).status).toBe(400);

      expect((await a.post(`/app-api/admin/proposals/${id}/reject`, { note: "" })).status).toBe(400);
      const res = await a.post(`/app-api/admin/proposals/${id}/reject`, { note: "license unclear" });
      expect(res.status).toBe(200);
      expect(await json<AdminProposal>(res)).toMatchObject({ status: "rejected", reviewNote: "license unclear" });
      expect(exists(`proposals/${id}`)).toBe(false);
      const audit = h.db.select().from(auditLog).where(eq(auditLog.action, "proposal.reject")).get();
      expect(audit).toMatchObject({ targetId: id, bytesFreed: mdx.length });

      // The proposer is told once, sees the reason, and can acknowledge it.
      const me = await json<Me>(await client.request("/app-api/me"));
      expect(me.proposalUpdates).toEqual([{ id, title: "PX Test", status: "rejected" }]);
      const mine = await json<ProposalList>(await client.request("/app-api/me/proposals"));
      expect(mine.proposals[0]).toMatchObject({ status: "rejected", reviewNote: "license unclear" });
      expect((await client.post("/app-api/me/proposals/seen", {})).status).toBe(204);
      expect((await json<Me>(await client.request("/app-api/me"))).proposalUpdates).toEqual([]);
      expect(user.id).toBeTruthy();
      // Decided once.
      expect((await a.post(`/app-api/admin/proposals/${id}/reject`, { note: "again" })).status).toBe(409);
    });

    it("approves globally: files move to DICT_DIR, wuDict rescans and indexes, then every user can search it", async () => {
      const proposer = (await h.signedIn({ email: "u@example.com" })).client;
      const { id } = await propose(proposer, [{ name: "pxtest.mdx", data: mdx }, { name: "pxtest.css", data: "b{}" }]);
      const a = (await admin()).client;
      const res = await a.post(`/app-api/admin/proposals/${id}/approve`, { dictId: "px-test", scope: "global", title: "PX Test Dictionary" });
      expect(res.status).toBe(202);
      expect(await json<AdminProposal>(res)).toMatchObject({ status: "approved", approvedScope: "global", dictId: "px-test" });
      expect(exists(`proposals/${id}`)).toBe(false);
      expect(exists("dictionaries/px-test/pxtest.mdx")).toBe(true);
      expect(exists("dictionaries/px-test/pxtest.css")).toBe(true);
      await h.app.services.publisher.publish("px-test");

      expect(h.upstream("/api/rescan").length).toBeGreaterThan(0);
      expect(h.upstream("/api/ingest")[0]?.url.searchParams.get("media")).toBe("1");
      const row = h.db.select().from(dictionaries).where(eq(dictionaries.id, "px-test")).get();
      expect(row).toMatchObject({ visibility: "global", source: "proposal", proposalId: id, mediaPacked: true, title: "PX Test Dictionary" });
      expect(row?.wudictUuid).toMatch(/^[0-9a-f-]{36}$/);
      expect(row?.indexBytes).toBeGreaterThan(0);

      const other = (await h.signedIn({ email: "o@example.com" })).client;
      const mine = await json<MyDictList>(await other.request("/app-api/me/dicts"));
      expect(mine.dicts.find((d) => d.id === "px-test")).toMatchObject({ enabled: true, available: true });
      const search = await ndjsonLines(await other.request(`/api/search?q=hello&dict=${row?.wudictId ?? ""}`));
      const hit = search.find((l) => l.t === "hit");
      expect(hit).toMatchObject({ dict: row?.wudictId, name: "PX Test Dictionary", results: [{ Headword: "hello" }] });

      const dicts = await json<{ dicts: AdminDict[] }>(await a.request("/app-api/admin/dicts"));
      expect(dicts.dicts.find((d) => d.id === "px-test")).toMatchObject({ indexed: true, index: { state: "done" } });
      expect((await json<Me>(await proposer.request("/app-api/me"))).proposalUpdates).toEqual([{ id, title: "PX Test", status: "approved" }]);
    });

    it("keeps a dictionary hidden while indexing fails, and publishes it after a retry", async () => {
      const proposer = (await h.signedIn({ email: "u@example.com" })).client;
      const { id } = await propose(proposer, [{ name: "pxtest.mdx", data: mdx }]);
      const a = (await admin()).client;
      h.fake.ingestError = "broken file";
      await a.post(`/app-api/admin/proposals/${id}/approve`, { dictId: "px-test", scope: "private" });
      await h.app.services.publisher.publish("px-test");
      const status = await json<{ state: string; error: string }>(await a.request("/app-api/admin/dicts/px-test/index-status"));
      expect(status).toMatchObject({ state: "error", error: "indexing failed: broken file" });
      expect((await json<MyDictList>(await proposer.request("/app-api/me/dicts"))).dicts.map((d) => d.id)).not.toContain("px-test");

      h.fake.ingestError = undefined;
      expect((await a.post("/app-api/admin/dicts/px-test/index", {})).status).toBe(202);
      await h.app.services.publisher.publish("px-test");
      const mine = await json<MyDictList>(await proposer.request("/app-api/me/dicts"));
      expect(mine.dicts.find((d) => d.id === "px-test")).toMatchObject({ visibility: "private" });
      const other = (await h.signedIn({ email: "o@example.com" })).client;
      expect((await json<MyDictList>(await other.request("/app-api/me/dicts"))).dicts.map((d) => d.id)).not.toContain("px-test");
    });

    it("approves as hidden: only admins can try it, then publish it", async () => {
      const proposer = (await h.signedIn({ email: "u@example.com" })).client;
      const { id } = await propose(proposer, [{ name: "pxtest.mdx", data: mdx }]);
      const a = (await admin()).client;
      await a.post(`/app-api/admin/proposals/${id}/approve`, { dictId: "px-test", scope: "hidden" });
      await h.app.services.publisher.publish("px-test");
      const row = h.db.select().from(dictionaries).where(eq(dictionaries.id, "px-test")).get();
      expect(row?.visibility).toBe("hidden");
      const wid = row?.wudictId ?? "";

      // The admin can name it; it is never part of their default set.
      const adminHit = (await ndjsonLines(await a.request(`/api/search?q=hello&dict=${wid}`))).find((l) => l.t === "hit");
      expect(adminHit).toMatchObject({ dict: wid, results: [{ Headword: "hello" }] });
      const adminDefault = await ndjsonLines(await a.request("/api/search?q=hello"));
      expect(adminDefault.some((l) => l.dict === wid)).toBe(false);
      // A regular user cannot.
      const userRes = await proposer.request(`/api/search?q=hello&dict=${wid}`);
      expect((await ndjsonLines(userRes)).some((l) => l.dict === wid)).toBe(false);

      const patched = await a.request("/app-api/admin/dicts/px-test", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visibility: "global", trustedRender: true }),
      });
      expect(await json<AdminDict>(patched)).toMatchObject({ visibility: "global", trustedRender: true });
      expect((await json<MyDictList>(await proposer.request("/app-api/me/dicts"))).dicts.map((d) => d.id)).toContain("px-test");
      const bad = await a.request("/app-api/admin/dicts/px-test", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visibility: "private" }),
      });
      expect(bad.status).toBe(400);
    });

    it("refuses a dictionary id that is taken and a private scope without a proposer", async () => {
      const proposer = await h.signedIn({ email: "u@example.com" });
      const { id } = await propose(proposer.client, [{ name: "pxtest.mdx", data: mdx }]);
      const a = (await admin()).client;
      // "alpha" is a dictionary the fake wuDict already lists.
      await a.request("/app-api/admin/dicts");
      const taken = await a.post(`/app-api/admin/proposals/${id}/approve`, { dictId: "alpha", scope: "global" });
      expect(taken.status).toBe(409);
      expect(await taken.text()).toContain("dict_id_taken");
      expect((await a.post(`/app-api/admin/proposals/${id}/approve`, { dictId: "Bad Id", scope: "global" })).status).toBe(400);
      expect(exists(`proposals/${id}`)).toBe(true);
    });

    it("approves a proposal once when two admins approve it at the same time", async () => {
      const proposer = (await h.signedIn({ email: "u@example.com" })).client;
      const { id } = await propose(proposer, [{ name: "pxtest.mdx", data: mdx }]);
      const a = (await admin()).client;
      const results = await Promise.all([
        a.post(`/app-api/admin/proposals/${id}/approve`, { dictId: "one", scope: "global" }),
        a.post(`/app-api/admin/proposals/${id}/approve`, { dictId: "two", scope: "global" }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([202, 409]);
      await h.app.services.publisher.publish("one");
      await h.app.services.publisher.publish("two");
      const ids = h.db.select({ id: dictionaries.id }).from(dictionaries).where(eq(dictionaries.source, "proposal")).all();
      expect(ids).toHaveLength(1);
    });

    it("rescans on request", async () => {
      const a = (await admin()).client;
      fs.mkdirSync(path.join(dataDir, "dictionaries/manual"), { recursive: true });
      fs.writeFileSync(path.join(dataDir, "dictionaries/manual/manual.dsl"), "#NAME x");
      const res = await a.post("/app-api/admin/dicts/rescan", {});
      const body = await json<{ dicts: AdminDict[] }>(res);
      expect(body.dicts.find((d) => d.id === "manual")).toMatchObject({ source: "builtin", visibility: "global", indexed: false });
      expect(h.db.select().from(auditLog).where(eq(auditLog.action, "dict.rescan")).all()).toHaveLength(1);
    });
  });
});
