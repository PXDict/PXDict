// Contract tests: the gateway against the real wuDict binary (docs/wudict-notes.md). They run only when
// WUDICT_BIN points to a wuDict executable built at the pinned tag, e.g.
//
//   WUDICT_BIN=$PWD/.cache/wudict/v3.7.11-source/wudict npm test -w @pxdict/gateway -- contract
//
// CI builds the purego binary from source in a separate job (.github/workflows/ci.yml).
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { harness, ndjsonLines } from "../test/harness";
import { WudictClient } from "./client";

const bin = process.env.WUDICT_BIN;
/** A 1×1 PNG. */
const pngBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const token = "contract-".padEnd(48, "k");

const dsl = [
  '#NAME "PXDict Contract"',
  '#INDEX_LANGUAGE "English"',
  '#CONTENTS_LANGUAGE "English"',
  "",
  "hello",
  "\t[m1]a greeting[/m]",
  "help",
  "\t[m1]assistance[/m]",
  "picture",
  "\t[m1][s]pic.png[/s] an image[/m]",
  "",
].join("\n");

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => {
        if (addr && typeof addr === "object") resolve(addr.port);
        else reject(new Error("no port"));
      });
    });
  });
}

describe.skipIf(!bin)("contract with the real wuDict", () => {
  let dir: string;
  let proc: ChildProcess | undefined;
  let base: URL;
  let app: { request: (path: string) => Promise<Response> };
  /** The gateway without any session (as a sandboxed iframe calls it). */
  let anonymous: { request: (path: string) => Response | Promise<Response> };
  let dictId: string;
  let h: ReturnType<typeof harness>;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pxdict-contract-"));
    for (const d of ["dictionaries/contract", "db", ".wudict/config", ".wudict/data", ".wudict/state", ".wudict/home"]) {
      fs.mkdirSync(path.join(dir, d), { recursive: true });
    }
    fs.writeFileSync(path.join(dir, "dictionaries/contract/contract.dsl"), dsl);
    fs.writeFileSync(path.join(dir, "dictionaries/contract/pic.png"), pngBytes);
    const port = await freePort();
    base = new URL(`http://127.0.0.1:${String(port)}`);

    proc = spawn(bin ?? "", ["serve"], {
      stdio: "ignore",
      env: {
        PATH: process.env.PATH,
        HOME: path.join(dir, ".wudict/home"),
        XDG_CONFIG_HOME: path.join(dir, ".wudict/config"),
        XDG_DATA_HOME: path.join(dir, ".wudict/data"),
        XDG_STATE_HOME: path.join(dir, ".wudict/state"),
        DICT_DIR: path.join(dir, "dictionaries"),
        DB_DIR: path.join(dir, "db"),
        AUTH: "on",
        AUTH_TOKEN: token,
        SERVER_IP: "127.0.0.1",
        SERVER_PORT: String(port),
        USE_CACHED: "1",
        INDEX_WORKERS: "1",
        NO_BROWSER: "1",
        TRAY: "0",
      },
    });

    for (let i = 0; ; i++) {
      try {
        if ((await fetch(new URL("/api/dicts", base))).ok) break;
      } catch {
        // not listening yet
      }
      if (i > 100) throw new Error("wuDict did not start");
      await new Promise((r) => setTimeout(r, 100));
    }

    const client = new WudictClient({ baseUrl: base, token });
    // DATA_DIR is wuDict's data folder, as in the image (proposals move into its DICT_DIR).
    h = harness({ wudict: client, dataDir: dir });
    // Signed in as a regular user, as the PWA would be.
    app = { request: h.request };
    anonymous = h.app;

    const lines = await ndjsonLines(await app.request("/api/dicts"));
    const row = lines.find((l) => l.t === "dict");
    dictId = String((row?.dict as { id?: unknown } | undefined)?.id);
  }, 30_000);

  afterAll(() => {
    proc?.kill("SIGTERM");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("wuDict itself requires the token (Q1)", async () => {
    expect((await fetch(new URL("/api/suggest?q=h", base))).status).toBe(401);
    expect((await fetch(new URL("/api/config", base), { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await fetch(new URL("/api/config", base), { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
  });

  it("/healthz reaches wuDict with the token", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
  });

  it("/api/dicts lists the dictionary without the howto or filesystem fields", async () => {
    const res = await app.request("/api/dicts");
    expect(res.status).toBe(200);
    const lines = await ndjsonLines(res);
    const dicts = lines.filter((l) => l.t === "dict").map((l) => l.dict as Record<string, unknown>);
    expect(dicts.map((d) => d.name)).toEqual(["PXDict Contract"]);
    expect(dictId).toMatch(/^[0-9a-f]{12}$/);
    const text = JSON.stringify(lines);
    expect(text).not.toContain(dir);
    expect(text).not.toContain("wudict-howto");
    expect(lines[0]).toEqual({ t: "begin" });
    expect(lines.at(-1)).toEqual({ t: "end" });
  });

  it("/api/search streams wuDict's NDJSON for the allowed dictionaries (Q5)", async () => {
    const res = await app.request("/api/search?q=hello&mode=exact");
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    const lines = await ndjsonLines(res);
    expect(lines[0]).toMatchObject({ t: "begin", slots: [{ dict: dictId }] });
    const hit = lines.find((l) => l.t === "hit");
    expect(hit).toMatchObject({ dict: dictId, results: [{ Headword: "hello" }] });
    expect(JSON.stringify(hit)).toContain("a greeting");
    expect(lines.at(-1)).toMatchObject({ t: "end" });
  });

  it("/api/search passes format=text and n through", async () => {
    const lines = await ndjsonLines(await app.request("/api/search?q=he&mode=prefix&format=text&n=1"));
    const hit = lines.find((l) => l.t === "hit") as { results?: { Body: string }[] } | undefined;
    expect(hit?.results).toHaveLength(1);
    expect(hit?.results?.[0]?.Body).not.toContain("<");
  });

  it("/api/suggest needs the token, which the gateway adds", async () => {
    const res = await app.request("/api/suggest?q=hel");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ words: ["hello", "help"] });
  });

  it("article resources are signed (/r/) and load without a session (Q7)", async () => {
    const lines = await ndjsonLines(await app.request("/api/search?q=picture&mode=exact"));
    const hit = lines.find((l) => l.t === "hit") as { results?: { Body: string }[] } | undefined;
    const body = hit?.results?.[0]?.Body ?? "";
    expect(body).not.toContain(`/res/${dictId}/`);
    const m = new RegExp(`/r/[^/"]+/${dictId}/pic\\.png`).exec(body);
    expect(m, body).not.toBeNull();
    const res = await anonymous.request(m?.[0] ?? "");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(pngBytes);
    // The session-protected path refuses the same request without a session.
    expect((await anonymous.request(`/res/${dictId}/pic.png`)).status).toBe(401);
  });

  it("an approved proposal is rescanned, indexed and searchable (Phase 6, Q10)", async () => {
    const proposed = dsl.replace("PXDict Contract", "PXDict Proposal").replace("hello", "proposal");
    const user = (await h.signedIn({ email: "proposer@example.com" })).client;
    const created = await user.post("/app-api/proposals", { title: "Proposal", files: [{ name: "proposal.dsl", size: Buffer.byteLength(proposed) }] });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const put = await user.request(`/app-api/proposals/${id}/files/0`, { method: "PUT", headers: { "Upload-Offset": "0" }, body: proposed });
    expect(put.status).toBe(200);
    const submitted = await user.post(`/app-api/proposals/${id}/submit`, {});
    expect(await submitted.json()).toMatchObject({ status: "pending", metadata: { format: "dsl", title: "PXDict Proposal" } });

    const admin = (await h.signedIn({ email: "admin@example.com", role: "admin" })).client;
    const approved = await admin.post(`/app-api/admin/proposals/${id}/approve`, { dictId: "proposed", scope: "global" });
    expect(approved.status).toBe(202);
    await h.app.services.publisher.publish("proposed");
    expect(h.app.services.publisher.status("proposed")).toMatchObject({ state: "done", error: null });

    const row = h.app.services.registry.get("proposed");
    expect(row).toMatchObject({ visibility: "global", source: "proposal", mediaPacked: true });
    expect(row?.wudictId).toMatch(/^[0-9a-f]{12}$/);
    // The uuid comes from the real db/<name>/info.txt.
    expect(row?.wudictUuid).toBeTruthy();
    expect(row?.libraryDir).toBeTruthy();

    const lines = await ndjsonLines(await user.request("/api/search?q=proposal&mode=exact"));
    const hit = lines.find((l) => l.t === "hit" && l.dict === row?.wudictId);
    expect(hit).toMatchObject({ name: "Proposal", results: [{ Headword: "proposal" }] });
  }, 30_000);

  it("storage administration deletes a whole dictionary through DELETE /api/library (Phase 7, Q11)", async () => {
    const admin = (await h.signedIn({ email: "storage-admin@example.com", role: "admin" })).client;
    const row = h.app.services.registry.get("proposed");
    expect(row?.libraryDir).toBeTruthy();
    fs.writeFileSync(path.join(dir, "dictionaries/proposed/readme.bak"), "left behind by wuDict");

    const overview = (await (await admin.request("/app-api/admin/storage")).json()) as {
      dicts: { id: string; originalsBlocked: string | null; deleteBlocked: string | null; indexBytes: number }[];
    };
    const d = overview.dicts.find((x) => x.id === "proposed");
    // Deleting originals is verified for MDX only.
    expect(d).toMatchObject({ originalsBlocked: "format_unsupported", deleteBlocked: null });
    expect(d?.indexBytes).toBeGreaterThan(0);

    const plan = (await (await admin.post("/app-api/admin/storage/plan", { items: [{ kind: "dict", target: "proposed" }] })).json()) as {
      planId: string;
      totalBytes: number;
    };
    const res = await admin.post("/app-api/admin/storage/execute", { planId: plan.planId });
    const result = (await res.json()) as { bytesFreed: number; items: { status: string; reason: string | null }[] };
    expect(result.items[0]).toMatchObject({ status: "done", reason: null });
    expect(result.bytesFreed).toBe(plan.totalBytes);
    expect(fs.existsSync(path.join(dir, "dictionaries/proposed"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "db", row?.libraryDir ?? "missing"))).toBe(false);
    expect(h.app.services.registry.get("proposed")).toBeUndefined();

    // wuDict no longer lists it, and the next sync does not bring it back.
    h.catalog.invalidate();
    const snap = await h.catalog.snapshot();
    expect(snap.rows.some((r) => r.id === row?.wudictId)).toBe(false);
    await h.app.services.registry.refresh();
    expect(h.app.services.registry.all().map((r) => r.id)).not.toContain("proposed");
  }, 30_000);

  it("an unknown resource is a 404", async () => {
    expect((await app.request(`/res/${dictId}/missing.png`)).status).toBe(404);
  });
});
