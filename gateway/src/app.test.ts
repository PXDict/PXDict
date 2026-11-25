import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { ErrorBody, Health } from "@pxdict/shared";
import { afterAll, describe, expect, it } from "vitest";
import { harness } from "./test/harness";

describe("GET /healthz", () => {
  it("reports ok when wuDict and the database answer", async () => {
    const { app, fake } = harness();
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(Health.parse(await res.json())).toEqual({
      status: "ok",
      version: "1.2.3",
      checks: { wudict: "ok", database: "ok" },
    });
    expect(fake.lastRequest()?.headers.get("authorization")).toMatch(/^Bearer /);
  });

  it.each([
    ["wuDict is down", (f: { down: boolean; forceStatus: number | undefined }) => (f.down = true)],
    ["the token is wrong", (f: { down: boolean; forceStatus: number | undefined }) => (f.forceStatus = 401)],
  ])("answers 503 when %s", async (_name, breakIt) => {
    const { app, fake } = harness();
    breakIt(fake);
    const res = await app.request("/healthz");
    expect(res.status).toBe(503);
    expect(Health.parse(await res.json())).toMatchObject({ status: "unavailable", checks: { wudict: "down" } });
  });
});

describe("routing", () => {
  const { app, fake } = harness();

  it.each([
    ["GET", "/app-api/nope"],
    ["POST", "/app-api/me"],
    ["GET", "/unknown"],
    // wuDict routes that are not allowlisted
    ["GET", "/setup"],
    ["GET", "/api/setup"],
    ["GET", "/api/library"],
    ["DELETE", "/api/library?dict=x"],
    ["GET", "/api/rescan"],
    ["GET", "/api/ingest?dict=x"],
    ["GET", "/api/config"],
    ["GET", "/api/prefs"],
    ["GET", "/api/words"],
    ["GET", "/api/groups"],
    ["GET", "/api/openapi.yaml"],
    ["POST", "/api/search?q=cat"],
    ["GET", "/assets/frame.js"],
    ["GET", "/style/user.css"],
    ["GET", "/files/x"],
    ["GET", "/lemmas"],
    ["GET", "/browse"],
  ])("%s %s answers 404 in the error shape without reaching wuDict", async (method, url) => {
    fake.requests.length = 0;
    const res = await app.request(url, { method });
    expect(res.status).toBe(404);
    expect(ErrorBody.parse(await res.json()).error.code).toBe("not_found");
    expect(fake.requests).toEqual([]);
  });

  it("turns thrown errors into a logged 500 without details", async () => {
    const { app, lines } = harness();
    app.get("/test-throw", () => {
      throw new Error("secret detail");
    });
    const res = await app.request("/test-throw");
    expect(res.status).toBe(500);
    const body = ErrorBody.parse(await res.json());
    expect(body.error).toEqual({ code: "internal", message: "internal server error" });
    expect(lines.some((l) => l.includes("secret detail"))).toBe(true);
  });

  it("sets the default security headers", async () => {
    const res = await app.request("/healthz");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("content-security-policy")).toContain("object-src 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(res.headers.get("permissions-policy")).toContain("camera=()");
    expect(res.headers.get("strict-transport-security")).toBeNull();
  });
});

describe("static PWA", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pxdict-pwa-"));
  const write = (rel: string, body: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  };
  const indexHtml = "<!doctype html><title>PXDict</title>";
  write("index.html", indexHtml);
  write("manifest.webmanifest", '{"name":"PXDict"}');
  write("app-assets/index-abc123.js", "console.log('x')".repeat(200));
  write("app-assets/index-abc123.js.br", zlib.brotliCompressSync("console.log('x')".repeat(200)));
  write("icon.svg", "<svg/>");
  write("api/oops.js", "should never be served");
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const { app } = harness({ pwaDir: dir });

  it("serves index.html at / and for client-side routes, revalidated", async () => {
    for (const url of ["/", "/history", "/settings/account"]) {
      const res = await app.request(url);
      expect(res.status, url).toBe(200);
      expect(await res.text()).toBe(indexHtml);
      expect(res.headers.get("content-type")).toMatch(/^text\/html/);
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    }
  });

  it("serves the manifest uncached and hashed assets as immutable", async () => {
    const manifest = await app.request("/manifest.webmanifest");
    expect(manifest.headers.get("content-type")).toBe("application/manifest+json");
    expect(manifest.headers.get("cache-control")).toBe("no-cache");

    const asset = await app.request("/app-assets/index-abc123.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(asset.headers.get("content-encoding")).toBeNull();
  });

  it("serves precompressed variants when accepted", async () => {
    const res = await app.request("/app-assets/index-abc123.js", { headers: { "Accept-Encoding": "gzip, br" } });
    expect(res.headers.get("content-encoding")).toBe("br");
    expect(res.headers.get("vary")).toContain("Accept-Encoding");
    expect(res.headers.get("content-type")).toMatch(/javascript/);
  });

  it.each(["/missing.png", "/app-assets/missing.js", "/api/oops.js", "/setup", "/assets/frame.js"])(
    "answers 404 for %s",
    async (url) => {
      const res = await app.request(url);
      expect(res.status).toBe(404);
    },
  );

  it.each(["/..%2fetc/passwd", "/%2e%2e/%2e%2e/etc/passwd", "/a/../../etc/passwd"])(
    "does not escape the PWA folder for %s",
    async (url) => {
      const res = await app.request(url);
      const text = await res.text();
      expect(text).not.toContain("root:");
    },
  );
});
