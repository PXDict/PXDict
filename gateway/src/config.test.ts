import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseListenAddress } from "./config";

describe("loadConfig", () => {
  it("applies defaults", () => {
    const c = loadConfig({});
    expect(c.listen).toEqual({ host: undefined, port: 8080 });
    expect(c.dataDir).toBe("/data");
    expect(c.wudictUrl.href).toBe("http://127.0.0.1:6888/");
    expect(c.pwaDir).toBe("/srv/pwa");
    expect(c.logLevel).toBe("info");
  });

  it("treats blank values as unset and normalises paths", () => {
    const c = loadConfig({ LISTEN_ADDR: "  ", DATA_DIR: "/srv//data/", PWA_DIR: "/a/b/../pwa" });
    expect(c.listen.port).toBe(8080);
    expect(c.dataDir).toBe("/srv/data");
    expect(c.pwaDir).toBe("/a/pwa");
  });

  it("reads every variable", () => {
    const c = loadConfig({
      LISTEN_ADDR: "127.0.0.1:9000",
      DATA_DIR: "/tmp/d",
      WUDICT_URL: "http://localhost:7000",
      PWA_DIR: "/tmp/pwa",
      LOG_LEVEL: "debug",
    });
    expect(c.listen).toEqual({ host: "127.0.0.1", port: 9000 });
    expect(c.wudictUrl.host).toBe("localhost:7000");
    expect(c.logLevel).toBe("debug");
  });

  it.each([
    ["LISTEN_ADDR", "8080"],
    ["LISTEN_ADDR", ":70000"],
    ["DATA_DIR", "data"],
    ["PWA_DIR", "./pwa"],
    ["WUDICT_URL", "not a url"],
    ["WUDICT_URL", "https://127.0.0.1:6888"],
    ["WUDICT_URL", "http://127.0.0.1:6888/api"],
    ["WUDICT_URL", "http://u:p@127.0.0.1:6888"],
    ["WUDICT_URL", "http://127.0.0.1:6888?k=x"],
    ["LOG_LEVEL", "verbose"],
  ])("rejects %s=%j", (key, value) => {
    expect(() => loadConfig({ [key]: value })).toThrow(ConfigError);
  });

  it("reports every problem at once", () => {
    try {
      loadConfig({ LISTEN_ADDR: "x", DATA_DIR: "rel", LOG_LEVEL: "loud" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const keys = (err as ConfigError).issues.map((i) => i.split("=")[0]);
      expect(keys.sort()).toEqual(["DATA_DIR", "LISTEN_ADDR", "LOG_LEVEL"]);
    }
  });
});

describe("parseListenAddress", () => {
  it.each([
    [":8080", { host: undefined, port: 8080 }],
    ["0.0.0.0:80", { host: "0.0.0.0", port: 80 }],
    ["localhost:3000", { host: "localhost", port: 3000 }],
    ["[::1]:8080", { host: "::1", port: 8080 }],
    ["[::]:8080", { host: "::", port: 8080 }],
    [":0", undefined],
    ["host", undefined],
    ["::1:8080", undefined],
    ["host:port", undefined],
  ])("%j", (raw, want) => {
    expect(parseListenAddress(raw)).toEqual(want);
  });
});
