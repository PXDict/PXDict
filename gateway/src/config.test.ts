import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseByteSize, parseListenAddress } from "./config";

const token = "t".repeat(32);
const secret = "s".repeat(32);
const load = (env: Record<string, string>) => loadConfig({ AUTH_TOKEN: token, BETTER_AUTH_SECRET: secret, ...env });

function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof ConfigError) return err.issues;
    throw err;
  }
  return expect.unreachable("no ConfigError thrown");
}

describe("loadConfig", () => {
  it("applies defaults", () => {
    const c = load({});
    expect(c.listen).toEqual({ host: undefined, port: 8080 });
    expect(c.dataDir).toBe("/data");
    expect(c.wudictUrl.href).toBe("http://127.0.0.1:6888/");
    expect(c.authToken).toBe(token);
    expect(c.pwaDir).toBe("/srv/pwa");
    expect(c.logLevel).toBe("info");
    expect(c.publicUrl.origin).toBe("http://localhost:8080");
    expect(c.publicUrlIsDefault).toBe(true);
    expect(c.cookieSecure).toBe(false);
    expect(c.registration).toBe("closed");
    expect(c.maxUploadBytes).toBe(500e6);
    expect(c.maxPendingProposalsPerUser).toBe(3);
    expect(c.maxPendingBytes).toBe(5e9);
    expect(c.minFreeBytes).toBe(1e9);
    expect(c.historyDefaultRetentionDays).toBe(90);
    expect(c.auth).toEqual({
      secret,
      bootstrapAdmin: undefined,
      passkey: true,
      hibp: false,
      requireAdmin2fa: false,
      smtp: undefined,
      social: {},
      oidc: [],
      clientIpHeader: undefined,
    });
  });

  it("treats blank values as unset and normalises paths", () => {
    const c = load({ LISTEN_ADDR: "  ", DATA_DIR: "/srv//data/", PWA_DIR: "/a/b/../pwa" });
    expect(c.listen.port).toBe(8080);
    expect(c.dataDir).toBe("/srv/data");
    expect(c.pwaDir).toBe("/a/pwa");
  });

  it("reads every variable", () => {
    const c = load({
      LISTEN_ADDR: "127.0.0.1:9000",
      DATA_DIR: "/tmp/d",
      WUDICT_URL: "http://localhost:7000",
      PWA_DIR: "/tmp/pwa",
      LOG_LEVEL: "debug",
      PUBLIC_URL: "https://dict.example.com",
      REGISTRATION: "invite",
      MAX_UPLOAD_BYTES: "2GiB",
      MAX_PENDING_PROPOSALS_PER_USER: "0",
      MAX_PENDING_BYTES: "10GB",
      MIN_FREE_BYTES: "512MiB",
      HISTORY_DEFAULT_RETENTION_DAYS: "0",
    });
    expect(c.listen).toEqual({ host: "127.0.0.1", port: 9000 });
    expect(c.wudictUrl.host).toBe("localhost:7000");
    expect(c.logLevel).toBe("debug");
    expect(c.publicUrl.origin).toBe("https://dict.example.com");
    expect(c.publicUrlIsDefault).toBe(false);
    expect(c.cookieSecure).toBe(true);
    expect(c.registration).toBe("invite");
    expect(c.maxUploadBytes).toBe(2 * 2 ** 30);
    expect(c.maxPendingProposalsPerUser).toBe(0);
    expect(c.maxPendingBytes).toBe(10e9);
    expect(c.minFreeBytes).toBe(512 * 2 ** 20);
    expect(c.historyDefaultRetentionDays).toBe(0);
  });

  it.each([
    ["https://x.example", "", true],
    ["https://x.example", "false", false],
    ["http://x.example", "", false],
    ["http://x.example", "1", true],
  ])("COOKIE_SECURE for PUBLIC_URL=%s and %j is %s", (url, secure, want) => {
    expect(load({ PUBLIC_URL: url, COOKIE_SECURE: secure }).cookieSecure).toBe(want);
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
    ["PUBLIC_URL", "dict.example.com"],
    ["PUBLIC_URL", "ftp://dict.example.com"],
    ["PUBLIC_URL", "https://dict.example.com/app"],
    ["COOKIE_SECURE", "yes"],
    ["REGISTRATION", "public"],
    ["MAX_UPLOAD_BYTES", "lots"],
    ["MAX_UPLOAD_BYTES", "0"],
    ["MAX_UPLOAD_BYTES", "5 parsecs"],
    ["MAX_PENDING_PROPOSALS_PER_USER", "-1"],
    ["MAX_PENDING_PROPOSALS_PER_USER", "2.5"],
    ["HISTORY_DEFAULT_RETENTION_DAYS", "forever"],
  ])("rejects %s=%j", (key, value) => {
    expect(() => load({ [key]: value })).toThrow(ConfigError);
  });

  it("requires AUTH_TOKEN and BETTER_AUTH_SECRET and never echoes them", () => {
    const missing = issuesOf(() => loadConfig({}));
    expect(missing).toHaveLength(2);
    expect(missing[0]).toMatch(/^AUTH_TOKEN=\(hidden\): /);
    expect(missing[1]).toMatch(/^BETTER_AUTH_SECRET=\(hidden\): /);

    const short = issuesOf(() => loadConfig({ AUTH_TOKEN: "short-secret", BETTER_AUTH_SECRET: "short-too" }));
    expect(short.join("\n")).not.toContain("short-secret");
    expect(short.join("\n")).not.toContain("short-too");

    const spaced = issuesOf(() => loadConfig({ AUTH_TOKEN: "a b".repeat(20), BETTER_AUTH_SECRET: secret }));
    expect(spaced[0]).toMatch(/^AUTH_TOKEN=\(hidden\): /);
  });

  it("reads the sign-in settings", () => {
    const c = load({
      ADMIN_EMAIL: "Root@Example.com",
      ADMIN_USERNAME: "Root",
      ADMIN_PASSWORD: "long enough password",
      AUTH_PASSKEY: "false",
      AUTH_HIBP: "1",
      AUTH_REQUIRE_2FA_ADMIN: "true",
      SMTP_URL: "smtps://u:p@mail.example.com:465",
      MAIL_FROM: "PXDict <dict@example.com>",
      CLIENT_IP_HEADER: "CF-Connecting-IP",
      AUTH_GITHUB_CLIENT_ID: "gh-id",
      AUTH_GITHUB_CLIENT_SECRET: "gh-secret",
      AUTH_MICROSOFT_CLIENT_ID: "ms-id",
      AUTH_MICROSOFT_CLIENT_SECRET: "ms-secret",
      AUTH_MICROSOFT_TENANT_ID: "contoso",
      AUTH_OIDC_KEYCLOAK_ISSUER: "https://sso.example.com/realms/home",
      AUTH_OIDC_KEYCLOAK_CLIENT_ID: "kc-id",
      AUTH_OIDC_KEYCLOAK_CLIENT_SECRET: "kc-secret",
      AUTH_OIDC_KEYCLOAK_LABEL: "Home SSO",
    });
    expect(c.auth.bootstrapAdmin).toEqual({ email: "root@example.com", username: "root", password: "long enough password" });
    expect(c.auth.passkey).toBe(false);
    expect(c.auth.hibp).toBe(true);
    expect(c.auth.requireAdmin2fa).toBe(true);
    expect(c.auth.smtp).toEqual({ url: "smtps://u:p@mail.example.com:465", from: "PXDict <dict@example.com>" });
    expect(c.auth.clientIpHeader).toBe("cf-connecting-ip");
    expect(c.auth.social).toEqual({
      github: { clientId: "gh-id", clientSecret: "gh-secret" },
      microsoft: { clientId: "ms-id", clientSecret: "ms-secret", tenantId: "contoso" },
    });
    expect(c.auth.oidc).toEqual([
      {
        id: "keycloak",
        label: "Home SSO",
        issuer: new URL("https://sso.example.com/realms/home"),
        clientId: "kc-id",
        clientSecret: "kc-secret",
      },
    ]);
  });

  it.each([
    [{ ADMIN_EMAIL: "not-an-email" }, "ADMIN_EMAIL"],
    [{ ADMIN_PASSWORD: "long enough password" }, "ADMIN_EMAIL"],
    [{ ADMIN_EMAIL: "a@example.com", ADMIN_PASSWORD: "short" }, "ADMIN_PASSWORD"],
    [{ ADMIN_EMAIL: "a@example.com", ADMIN_USERNAME: "no spaces" }, "ADMIN_USERNAME"],
    [{ AUTH_HIBP: "yes" }, "AUTH_HIBP"],
    [{ SMTP_URL: "http://mail.example.com" }, "SMTP_URL"],
    [{ SMTP_URL: "smtp://mail.example.com" }, "MAIL_FROM"],
    [{ CLIENT_IP_HEADER: "x forwarded" }, "CLIENT_IP_HEADER"],
    [{ AUTH_GOOGLE_CLIENT_ID: "id" }, "AUTH_GOOGLE_CLIENT_SECRET"],
    [{ AUTH_OIDC_SSO_ISSUER: "https://sso.example.com" }, "AUTH_OIDC_SSO_CLIENT_ID"],
    [{ AUTH_OIDC_SSO_ISSUER: "sso.example.com", AUTH_OIDC_SSO_CLIENT_ID: "i", AUTH_OIDC_SSO_CLIENT_SECRET: "s" }, "AUTH_OIDC_SSO_ISSUER"],
    [{ AUTH_OIDC_GITHUB_ISSUER: "https://x.example", AUTH_OIDC_GITHUB_CLIENT_ID: "i", AUTH_OIDC_GITHUB_CLIENT_SECRET: "s" }, "AUTH_OIDC_GITHUB_ISSUER"],
    [{ AUTH_OIDC_my_ISSUER: "https://x.example" }, "AUTH_OIDC_my_ISSUER"],
  ])("rejects %j (reported as %s)", (env, key) => {
    const issues = issuesOf(() => load(env));
    expect(issues.map((i) => i.split(/[=:]/)[0])).toContain(key);
  });

  it("never echoes passwords or client secrets", () => {
    const issues = issuesOf(() =>
      load({ ADMIN_EMAIL: "a@example.com", ADMIN_PASSWORD: "tiny", AUTH_GITHUB_CLIENT_SECRET: "gh-very-secret" }),
    );
    const text = issues.join("\n");
    expect(text).not.toContain("tiny");
    expect(text).not.toContain("gh-very-secret");
  });

  it("reports every problem at once", () => {
    const keys = issuesOf(() => loadConfig({ LISTEN_ADDR: "x", DATA_DIR: "rel", LOG_LEVEL: "loud" })).map(
      (i) => i.split("=")[0],
    );
    expect(keys.sort()).toEqual(["AUTH_TOKEN", "BETTER_AUTH_SECRET", "DATA_DIR", "LISTEN_ADDR", "LOG_LEVEL"]);
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

describe("parseByteSize", () => {
  it.each([
    ["1048576", 1048576],
    ["500MB", 500e6],
    ["500mb", 500e6],
    ["2GiB", 2 * 2 ** 30],
    ["1.5 GiB", 1.5 * 2 ** 30],
    ["10 kB", 10e3],
    ["7b", 7],
    ["", undefined],
    ["MB", undefined],
    ["-5MB", undefined],
    ["5 PB", undefined],
    ["1e3", undefined],
  ])("%j", (raw, want) => {
    expect(parseByteSize(raw)).toBe(want);
  });
});
