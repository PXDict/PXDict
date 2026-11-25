import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AuditPage, StorageExecuteResult, StorageOverview, StoragePlan } from "@pxdict/shared";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dictionaries, userDicts } from "../db/schema";
import { maybeVacuum } from "../jobs";
import { createLogger } from "../log";
import { harness, type TestClient } from "../test/harness";
import { parseInfoMediaPacked, staleTmpMs } from "./admin";

type H = ReturnType<typeof harness>;
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

describe("parseInfoMediaPacked", () => {
  it.each([
    ["media = not packed - resources come from the original files", false],
    ["name = x\nmedia = packed\n", true],
    ["name = x\n", false],
  ])("%j → %s", (text, packed) => {
    expect(parseInfoMediaPacked(text)).toBe(packed);
  });
});

describe("storage administration", () => {
  let dataDir: string;
  let h: H;
  let admin: TestClient;
  const file = (rel: string, data: string | number = "x") => {
    const full = path.join(dataDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof data === "number" ? "x".repeat(data) : data);
    return full;
  };
  const exists = (rel: string) => fs.existsSync(path.join(dataDir, rel));
  const ago = (rel: string, ms: number) => {
    const t = new Date(Date.now() - ms);
    fs.utimesSync(path.join(dataDir, rel), t, t);
  };
  const overview = async () => json<StorageOverview>(await admin.request("/app-api/admin/storage"));
  const plan = async (items: { kind: string; target: string }[]) => {
    const res = await admin.post("/app-api/admin/storage/plan", { items });
    expect(res.status).toBe(200);
    return json<StoragePlan>(res);
  };
  const execute = async (planId: string) => admin.post("/app-api/admin/storage/execute", { planId });

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pxdict-storage-"));
    for (const d of ["dictionaries", "db", "proposals", "tmp", "gateway"]) fs.mkdirSync(path.join(dataDir, d));
    file("dictionaries/oxford/oxford.mdx", 1000);
    file("dictionaries/oxford/oxford.mdd", 500);
    file("dictionaries/oxford/oxford.css", 30);
    file("dictionaries/oxford/img/cat.png", 20);
    file("dictionaries/oxford/old-copy.mdd", 400);
    file("dictionaries/oxford/notes.bak", 10);
    h = harness({ dataDir });
    admin = (await h.signedIn({ email: "admin@example.com", role: "admin" })).client;
    expect((await admin.post("/app-api/admin/dicts/rescan", {})).status).toBe(200);
    await h.app.services.publisher.publish("oxford");
    expect(h.app.services.publisher.status("oxford")).toMatchObject({ state: "done" });
  });

  afterEach(() => {
    fs.chmodSync(path.join(dataDir, "dictionaries"), 0o755);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("is for admins only", async () => {
    expect((await h.request("/app-api/admin/storage")).status).toBe(403);
    const user = (await h.signedIn({ email: "u@example.com" })).client;
    expect((await user.post("/app-api/admin/storage/plan", { items: [{ kind: "dict", target: "oxford" }] })).status).toBe(403);
    expect((await user.request("/app-api/admin/audit")).status).toBe(403);
  });

  it("reports usage per area and per dictionary", async () => {
    const o = await overview();
    expect(o.dictDirWritable).toBe(true);
    expect(o.catalogChecked).toBe(true);
    expect(o.volume.totalBytes).toBeGreaterThan(0);
    expect(o.areas.find((a) => a.area === "dictionaries")?.bytes).toBe(1960);
    const ox = o.dicts.find((d) => d.id === "oxford");
    expect(ox).toMatchObject({ sourceBytes: 1960, originalsBlocked: null, deleteBlocked: null, available: true, sourceDeletedAt: null });
    expect(ox?.indexBytes).toBeGreaterThan(100);
    // Dictionaries whose files are elsewhere have none attributed.
    expect(o.dicts.find((d) => d.id === "alpha")).toMatchObject({ sourceBytes: 0, originalsBlocked: "no_originals" });
    // Stray media and unknown files are listed, never suggested.
    const aux = o.candidates.filter((c) => c.kind === "aux_file").map((c) => [c.target, c.suggested]);
    expect(aux).toEqual([
      ["oxford/notes.bak", false],
      ["oxford/old-copy.mdd", false],
    ]);
  });

  it("a plan is a dry run, and executing it deletes the originals but keeps the index", async () => {
    const p = await plan([{ kind: "dict_originals", target: "oxford" }]);
    expect(p.items[0]).toMatchObject({ kind: "dict_originals", label: "oxford", blocked: null, bytes: 1530, warnings: [{ code: "no_reindex" }] });
    expect(p.items[0]?.paths.map((x) => x.path).sort()).toEqual([
      "dictionaries/oxford/oxford.css",
      "dictionaries/oxford/oxford.mdd",
      "dictionaries/oxford/oxford.mdx",
    ]);
    expect(p.totalBytes).toBe(1530);
    expect(exists("dictionaries/oxford/oxford.mdx")).toBe(true);
    const oldWudictId = h.app.services.registry.get("oxford")?.wudictId;

    const res = await execute(p.planId);
    expect(res.status).toBe(200);
    const r = await json<StorageExecuteResult>(res);
    expect(r).toEqual({ bytesFreed: 1530, items: [{ kind: "dict_originals", target: "oxford", status: "done", bytesFreed: 1530, reason: null }] });
    expect(exists("dictionaries/oxford/oxford.mdx")).toBe(false);
    expect(exists("dictionaries/oxford/oxford.css")).toBe(false);
    expect(exists("dictionaries/oxford/img/cat.png")).toBe(true);
    expect(exists("db/oxford/text.db")).toBe(true);
    expect(h.upstream("/api/library").map((x) => [x.method, x.url.searchParams.get("prepared")])).toEqual([["DELETE", "0"]]);

    // wuDict's id changed; the row followed it through the library folder.
    const row = h.app.services.registry.get("oxford");
    expect(row?.sourceDeletedAt).not.toBeNull();
    expect(row?.wudictId).toBeTruthy();
    expect(row?.wudictId).not.toBe(oldWudictId);

    const audit = await json<AuditPage>(await admin.request("/app-api/admin/audit?action=storage."));
    expect(audit.entries).toMatchObject([{ action: "storage.delete", targetType: "dict_originals", targetId: "oxford", bytesFreed: 1530, actor: { name: "admin" } }]);

    // A plan runs once.
    expect((await execute(p.planId)).status).toBe(404);
    expect((await overview()).dicts.find((d) => d.id === "oxford")?.originalsBlocked).toBe("no_originals");
  });

  it("skips an item whose files changed after the preview", async () => {
    const p = await plan([{ kind: "dict_originals", target: "oxford" }]);
    file("dictionaries/oxford/oxford.css", 31);
    const r = await json<StorageExecuteResult>(await execute(p.planId));
    expect(r.items[0]).toMatchObject({ status: "skipped", bytesFreed: 0 });
    expect(exists("dictionaries/oxford/oxford.mdx")).toBe(true);
    expect(h.upstream("/api/library")).toHaveLength(0);
  });

  it("only the admin who previewed may execute", async () => {
    const p = await plan([{ kind: "dict", target: "oxford" }]);
    const other = (await h.signedIn({ email: "admin2@example.com", role: "admin" })).client;
    expect((await other.post("/app-api/admin/storage/execute", { planId: p.planId })).status).toBe(404);
    expect(exists("dictionaries/oxford/oxford.mdx")).toBe(true);
  });

  it("deletes a whole dictionary with its index, users' lists and favorites", async () => {
    const user = (await h.signedIn({ email: "u@example.com" })).client;
    expect((await user.request("/app-api/me/dicts")).status).toBe(200);
    // Only global dictionaries reach users; the rescan made it global (BUILTIN_DICT_VISIBILITY).
    expect(h.db.select().from(userDicts).where(eq(userDicts.dictId, "oxford")).all()).toHaveLength(1);

    const p = await plan([{ kind: "dict", target: "oxford" }]);
    expect(p.items[0]?.warnings).toEqual([{ code: "users_enabled", count: 1 }]);
    expect(p.items[0]?.paths.some((x) => x.path === "db/oxford/text.db")).toBe(true);
    expect(p.items[0]?.paths.some((x) => x.path === "dictionaries/oxford/notes.bak")).toBe(true);

    const r = await json<StorageExecuteResult>(await execute(p.planId));
    expect(r.items[0]).toMatchObject({ status: "done", reason: null });
    expect(r.bytesFreed).toBe(p.totalBytes);
    expect(exists("dictionaries/oxford")).toBe(false);
    expect(exists("db/oxford")).toBe(false);
    expect(h.db.select().from(dictionaries).where(eq(dictionaries.id, "oxford")).get()).toBeUndefined();
    expect(h.db.select().from(userDicts).where(eq(userDicts.dictId, "oxford")).all()).toHaveLength(0);
    // The rescan afterwards does not bring it back.
    await h.app.services.registry.refresh();
    expect(h.app.services.registry.get("oxford")).toBeUndefined();
  });

  it("refuses to delete originals from a read-only dictionary folder", async () => {
    fs.chmodSync(path.join(dataDir, "dictionaries"), 0o555);
    const o = await overview();
    expect(o.dictDirWritable).toBe(false);
    expect(o.dicts.find((d) => d.id === "oxford")).toMatchObject({ originalsBlocked: "read_only", deleteBlocked: "read_only" });
    const p = await plan([{ kind: "dict_originals", target: "oxford" }]);
    expect(p.items[0]?.blocked).toBe("read_only");
    expect(p.totalBytes).toBe(0);
    const r = await json<StorageExecuteResult>(await execute(p.planId));
    expect(r.items[0]).toMatchObject({ status: "skipped", reason: "read_only" });
  });

  it("offers deleting originals only for MDX with packed media", async () => {
    h.db.update(dictionaries).set({ mediaPacked: false }).where(eq(dictionaries.id, "oxford")).run();
    file("db/oxford/info.txt", "media = not packed - resources come from the original files\n");
    expect((await overview()).dicts.find((d) => d.id === "oxford")?.originalsBlocked).toBe("media_not_packed");
    h.db.update(dictionaries).set({ mediaPacked: true, format: "dsl" }).where(eq(dictionaries.id, "oxford")).run();
    expect((await overview()).dicts.find((d) => d.id === "oxford")?.originalsBlocked).toBe("format_unsupported");
  });

  it("cleans up orphaned indexes, proposal leftovers, stale uploads and auxiliary files", async () => {
    file("db/ghost/info.txt", "uuid = 0123456789abcdef0123456789abcdef\n");
    file("db/ghost/text.db", 50);
    file("db/not-an-index/whatever", 5);
    file(`proposals/${"a".repeat(24)}/x.mdx`, 70);
    file("tmp/old-thing/part", 9);
    ago("tmp/old-thing/part", staleTmpMs + 1000);
    ago("tmp/old-thing", staleTmpMs + 1000);
    file("tmp/fresh", 3);

    const o = await overview();
    const byKind = (k: string) => o.candidates.filter((c) => c.kind === k).map((c) => [c.target, c.bytes, c.suggested]);
    expect(byKind("orphan_index")).toEqual([["ghost", 90, true]]);
    expect(byKind("proposal_files")).toEqual([["a".repeat(24), 70, true]]);
    expect(byKind("stale_upload")).toEqual([["old-thing", 9, true]]);

    const p = await plan([
      { kind: "orphan_index", target: "ghost" },
      { kind: "proposal_files", target: "a".repeat(24) },
      { kind: "stale_upload", target: "old-thing" },
      { kind: "stale_upload", target: "fresh" },
      { kind: "aux_file", target: "oxford/notes.bak" },
      // Not an auxiliary file: refused.
      { kind: "aux_file", target: "oxford/oxford.mdx" },
      { kind: "orphan_index", target: "oxford" },
      { kind: "orphan_index", target: "../gateway" },
    ]);
    expect(p.items.map((i) => [i.target, i.blocked])).toEqual([
      ["ghost", null],
      ["a".repeat(24), null],
      ["old-thing", null],
      ["fresh", "in_use"],
      ["oxford/notes.bak", null],
      ["oxford/oxford.mdx", "not_found"],
      ["oxford", "in_use"],
      ["../gateway", "not_found"],
    ]);
    const r = await json<StorageExecuteResult>(await execute(p.planId));
    expect(r.bytesFreed).toBe(90 + 70 + 9 + 10);
    for (const rel of ["db/ghost", `proposals/${"a".repeat(24)}`, "tmp/old-thing", "dictionaries/oxford/notes.bak"]) expect(exists(rel)).toBe(false);
    for (const rel of ["db/oxford", "db/not-an-index", "tmp/fresh", "dictionaries/oxford/oxford.mdx", "gateway"]) expect(exists(rel)).toBe(true);
  });

  it("rejects malformed requests", async () => {
    expect((await admin.post("/app-api/admin/storage/plan", { items: [] })).status).toBe(400);
    expect((await admin.post("/app-api/admin/storage/plan", { items: [{ kind: "everything", target: "x" }] })).status).toBe(400);
    expect((await admin.post("/app-api/admin/storage/execute", { planId: "nope" })).status).toBe(400);
    expect((await admin.post("/app-api/admin/storage/execute", { planId: "0".repeat(32) })).status).toBe(404);
  });

  it("the tmp job removes only stale entries outside proposal uploads", async () => {
    file("tmp/old/a", 4);
    ago("tmp/old/a", staleTmpMs + 1000);
    ago("tmp/old", staleTmpMs + 1000);
    file("tmp/new", 2);
    file("tmp/proposals/zzz/upload/x", 1);
    ago("tmp/proposals/zzz/upload/x", staleTmpMs + 1000);
    expect(await h.app.services.storage.cleanTmp()).toBe(4);
    expect(exists("tmp/old")).toBe(false);
    expect(exists("tmp/new")).toBe(true);
    expect(exists("tmp/proposals/zzz/upload/x")).toBe(true);
  });
});

describe("audit log", () => {
  it("pages newest first and filters by action", async () => {
    const h = harness();
    const admin = (await h.signedIn({ email: "admin@example.com", role: "admin" })).client;
    for (let i = 0; i < 3; i++) await admin.post("/app-api/admin/invites", { note: `n${String(i)}` });
    const first = await json<AuditPage>(await admin.request("/app-api/admin/audit?limit=2"));
    expect(first.entries.map((e) => e.action)).toEqual(["invite.create", "invite.create"]);
    expect(first.nextCursor).toBe(first.entries[1]?.id);
    const second = await json<AuditPage>(await admin.request(`/app-api/admin/audit?limit=2&cursor=${String(first.nextCursor)}`));
    expect(second.entries).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect((await json<AuditPage>(await admin.request("/app-api/admin/audit?action=invite."))).entries).toHaveLength(3);
    expect((await json<AuditPage>(await admin.request("/app-api/admin/audit?action=invite"))).entries).toHaveLength(0);
    expect((await json<AuditPage>(await admin.request("/app-api/admin/audit?action=invite.create"))).entries).toHaveLength(3);
    expect((await admin.request("/app-api/admin/audit?limit=0")).status).toBe(400);
  });
});

describe("maybeVacuum", () => {
  it("runs weekly, only when idle", () => {
    const h = harness();
    const logger = createLogger("error", () => undefined);
    const now = Date.now();
    expect(maybeVacuum(h.db, logger, { inFlight: 1, lastRequestAt: 0 }, now)).toBe(false);
    expect(maybeVacuum(h.db, logger, { inFlight: 0, lastRequestAt: now - 1000 }, now)).toBe(false);
    expect(maybeVacuum(h.db, logger, { inFlight: 0, lastRequestAt: 0 }, now)).toBe(true);
    expect(maybeVacuum(h.db, logger, { inFlight: 0, lastRequestAt: 0 }, now + 1000)).toBe(false);
    expect(maybeVacuum(h.db, logger, { inFlight: 0, lastRequestAt: 0 }, now + 8 * 24 * 3600 * 1000)).toBe(true);
  });
});
