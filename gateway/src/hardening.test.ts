// Phase 10 hardening: request body limits, the origin check on every state-changing route, and the
// optional /metrics endpoint.
import { describe, expect, it } from "vitest";
import { maxJsonBodyBytes } from "./app";
import { routeGroup } from "./http/metrics";
import { harness, testPassword, testSecret } from "./test/harness";

const errorCode = async (res: Response) => ((await res.json()) as { error?: { code?: string } }).error?.code;

describe("request body limit", () => {
  const big = JSON.stringify({ email: "ann@example.com", password: "x".repeat(maxJsonBodyBytes) });

  it("refuses large bodies on Better Auth's routes before anyone signs in", async () => {
    const h = harness();
    const declared = await h.client().request("/app-api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(big)) },
      body: big,
    });
    expect(declared.status).toBe(413);
    expect(await errorCode(declared)).toBe("payload_too_large");

    // Without Content-Length (chunked): counted while streaming.
    const stream = new ReadableStream<Uint8Array>({
      start(ctl) {
        ctl.enqueue(new TextEncoder().encode(big));
        ctl.close();
      },
    });
    const chunked = await h.client().request("/app-api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: stream,
      duplex: "half",
    });
    expect(chunked.status).toBe(413);
  });

  it("refuses large bodies on PXDict's routes and still accepts normal ones", async () => {
    const h = harness();
    const { client } = await h.signedIn({ email: "ann@example.com" });
    const huge = await client.request("/app-api/me/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme: "dark", pad: "x".repeat(maxJsonBodyBytes) }),
    });
    expect(huge.status).toBe(413);
    const signIn = await h.client().post("/app-api/auth/sign-in/email", { email: "ann@example.com", password: testPassword });
    expect(signIn.status).toBe(200);
  });

  it("does not apply to proposal file chunks (streamed to disk with their own limits)", async () => {
    const h = harness();
    const { client } = await h.signedIn({ email: "ann@example.com" });
    const res = await client.request(`/app-api/proposals/${"a".repeat(24)}/files/0`, {
      method: "PUT",
      headers: { "Upload-Offset": "0", "Content-Type": "application/offset+octet-stream" },
      body: new Uint8Array(maxJsonBodyBytes + 10),
    });
    expect(res.status).not.toBe(413);
    expect(await errorCode(res)).toBe("not_found");
  });
});

/** Sample values for route parameters, by their pattern. A new pattern must be added here. */
const paramSamples: [RegExp, string][] = [
  [/^:[a-z]+\{\[0-9a-f\]\{24\}\}$/i, "a".repeat(24)],
  [/^:[a-z]+\{\[0-9\]\{1,\d+\}\}$/i, "1"],
  [/^:[a-z]+$/i, "x"],
];

function samplePath(routePath: string): string {
  return routePath
    .split("/")
    .map((seg) => {
      if (!seg.startsWith(":")) return seg;
      const sample = paramSamples.find(([re]) => re.test(seg));
      if (!sample) throw new Error(`no sample value for route parameter ${seg} in ${routePath}`);
      return sample[1];
    })
    .join("/");
}

/** Better Auth's state-changing endpoints the PWA uses (it mounts them behind one wildcard route). */
const betterAuthWrites = [
  "/sign-in/email",
  "/sign-in/username",
  "/sign-up/email",
  "/sign-out",
  "/change-password",
  "/change-email",
  "/update-user",
  "/delete-user",
  "/revoke-session",
  "/revoke-other-sessions",
  "/link-social",
  "/unlink-account",
  "/two-factor/enable",
  "/two-factor/disable",
  "/two-factor/verify-totp",
  "/passkey/delete-passkey",
  "/admin/set-role",
  "/admin/ban-user",
  "/admin/remove-user",
  "/admin/create-user",
  "/admin/impersonate-user",
  "/admin/stop-impersonating",
];

describe("origin check on every state-changing route", () => {
  it("refuses cross-site writes on every /app-api route, even from a signed-in admin", async () => {
    const h = harness();
    const { client } = await h.signedIn({ email: "root@example.com", role: "admin" });

    const pxdictWrites = h.app.routes
      .filter((r) => r.path.startsWith("/app-api/") && !["GET", "HEAD", "OPTIONS", "ALL"].includes(r.method))
      .map((r) => ({ method: r.method, path: samplePath(r.path) }));
    // Guards against the sweep silently covering nothing.
    expect(pxdictWrites.length).toBeGreaterThan(20);
    const routes = [...pxdictWrites, ...betterAuthWrites.map((p) => ({ method: "POST", path: `/app-api/auth${p}` }))];

    const missed: string[] = [];
    for (const { method, path } of routes) {
      for (const origin of ["https://evil.example", "null"]) {
        const res = await client.request(path, {
          method,
          headers: { Origin: origin, "Content-Type": "application/json" },
          body: "{}",
        });
        if (res.status !== 403 || (await errorCode(res)) !== "origin_mismatch") {
          missed.push(`${method} ${path} (Origin ${origin}): ${String(res.status)}`);
        }
      }
    }
    expect(missed).toEqual([]);
    // The admin is still signed in and nothing changed.
    expect((await client.request("/app-api/me")).status).toBe(200);
    expect((await client.request("/app-api/admin/invites")).status).toBe(200);
  });
});

describe("GET /metrics", () => {
  const metricsToken = "metrics-token-".padEnd(40, "m");
  const on = { METRICS: "true", METRICS_TOKEN: metricsToken };

  it("does not exist unless METRICS is on", async () => {
    const h = harness();
    const { client } = await h.signedIn({ email: "root@example.com", role: "admin" });
    const res = await client.request("/metrics");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("is for admins and for the metrics token only", async () => {
    const h = harness({ env: on });
    expect((await h.client().request("/metrics")).status).toBe(401);
    expect((await h.request("/metrics")).status).toBe(403);
    for (const auth of [`Bearer ${metricsToken}x`, `Bearer ${testSecret}`, metricsToken, "Bearer "]) {
      expect((await h.client().request("/metrics", { headers: { Authorization: auth } })).status).toBe(401);
    }
    const scraper = await h.client().request("/metrics", { headers: { Authorization: `Bearer ${metricsToken}` } });
    expect(scraper.status).toBe(200);
    expect(scraper.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
    expect(scraper.headers.get("cache-control")).toBe("no-store");
    const { client } = await h.signedIn({ email: "root@example.com", role: "admin" });
    expect((await client.request("/metrics")).status).toBe(200);
  });

  it("counts requests by route group, never by path or query", async () => {
    const h = harness({ env: { METRICS: "true" } });
    expect((await h.request("/api/search?q=secretword&dict=all")).status).toBe(200);
    await h.request("/app-api/me");
    const { client } = await h.signedIn({ email: "root@example.com", role: "admin" });
    const text = await (await client.request("/metrics")).text();
    expect(text).toMatch(/^pxdict_http_requests_total\{method="GET",route="\/api\/search",status="200"\} 1$/m);
    expect(text).toMatch(/^pxdict_http_request_duration_seconds_count\{route="\/api\/search"\} 1$/m);
    expect(text).toMatch(/^pxdict_http_request_duration_seconds_bucket\{route="\/api\/search",le="\+Inf"\} 1$/m);
    expect(text).toMatch(/^pxdict_users 2$/m);
    expect(text).toMatch(/^pxdict_nodejs_heap_used_bytes \d+$/m);
    expect(text).toMatch(/^pxdict_nodejs_eventloop_delay_seconds\{quantile="0.99"\} [\d.e-]+$/m);
    expect(text).not.toContain("secretword");
    // Every sample line is "name{labels} value".
    for (const line of text.trim().split("\n")) {
      if (!line.startsWith("#")) expect(line).toMatch(/^[a-z_]+(\{[^}]*\})? [-+\d.eInfNa]+$/);
    }
    h.app.services.metrics?.close();
  });

  it("refuses METRICS_TOKEN without METRICS", () => {
    expect(() => harness({ env: { METRICS_TOKEN: metricsToken } })).toThrow(/METRICS_TOKEN=\(hidden\): is set but METRICS is off/);
  });
});

describe("routeGroup", () => {
  it.each([
    ["/api/search", "/api/search"],
    ["/api/library", "/api/other"],
    ["/app-api/auth/sign-in/email", "/app-api/auth"],
    ["/app-api/me/history/12", "/app-api/me"],
    ["/app-api/whatever", "/app-api/other"],
    ["/res/abc/x.png", "/res"],
    ["/r/tok/abc/x.png", "/r"],
    ["/setup", "other"],
    ["/", "static"],
    ["/app-assets/index-abc.js", "static"],
    ["/healthz", "/healthz"],
  ])("%s → %s", (p, group) => {
    expect(routeGroup(p)).toBe(group);
  });
});
