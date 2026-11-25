import { ErrorBody, Health } from "@pxdict/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";
import { createLogger } from "./log";

function newApp() {
  const lines: string[] = [];
  const app = createApp({ version: "1.2.3", logger: createLogger("debug", (l) => lines.push(l)) });
  return { app, lines };
}

const { app } = newApp();

describe("gateway app", () => {
  it("GET /healthz reports the version", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(Health.parse(await res.json())).toEqual({ status: "ok", version: "1.2.3" });
  });

  it.each([
    ["GET", "/app-api/nope"],
    ["POST", "/app-api/me"],
    ["GET", "/unknown"],
  ])("%s %s answers 404 in the error shape", async (method, path) => {
    const res = await app.request(path, { method });
    expect(res.status).toBe(404);
    const body = ErrorBody.parse(await res.json());
    expect(body.error.code).toBe("not_found");
  });

  it("turns thrown errors into a logged 500 without details", async () => {
    const { app, lines } = newApp();
    app.get("/test-throw", () => {
      throw new Error("secret detail");
    });
    const res = await app.request("/test-throw");
    expect(res.status).toBe(500);
    const body = ErrorBody.parse(await res.json());
    expect(body.error).toEqual({ code: "internal", message: "internal server error" });
    expect(lines.some((l) => l.includes("secret detail"))).toBe(true);
  });
});
