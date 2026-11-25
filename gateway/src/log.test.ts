import { describe, expect, it } from "vitest";
import { createLogger } from "./log";

describe("createLogger", () => {
  it("writes JSON lines at or above the level", () => {
    const lines: string[] = [];
    const log = createLogger("info", (l) => lines.push(l));
    log.debug("hidden");
    log.info("hello", { n: 1 });
    log.error("boom", { err: new Error("bad") });
    expect(lines).toHaveLength(2);
    const [info, error] = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(info).toMatchObject({ level: "info", msg: "hello", n: 1 });
    expect(error).toMatchObject({ level: "error", msg: "boom", err: { name: "Error", message: "bad" } });
  });
});
