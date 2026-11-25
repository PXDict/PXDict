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
import { createApp } from "../app";
import { openDatabase } from "../db/client";
import { createLogger } from "../log";
import { migrationsDir, ndjsonLines } from "../test/harness";
import { WudictCatalog } from "./catalog";
import { WudictClient } from "./client";

const bin = process.env.WUDICT_BIN;
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
  let app: ReturnType<typeof createApp>;
  let dictId: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pxdict-contract-"));
    for (const d of ["dictionaries/contract", "db", ".wudict/config", ".wudict/data", ".wudict/state", ".wudict/home"]) {
      fs.mkdirSync(path.join(dir, d), { recursive: true });
    }
    fs.writeFileSync(path.join(dir, "dictionaries/contract/contract.dsl"), dsl);
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
    app = createApp({
      version: "contract",
      logger: createLogger("error", () => undefined),
      db: openDatabase({ file: ":memory:", migrationsDir }),
      wudict: client,
      access: new WudictCatalog({ client, ttlMs: 0 }),
    });

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

  it("an unknown resource is a 404", async () => {
    expect((await app.request(`/res/${dictId}/missing.png`)).status).toBe(404);
  });
});
