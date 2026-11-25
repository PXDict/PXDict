// Builds a gateway app for tests: in-memory database, real Better Auth, fake wuDict, optional PWA
// folder, and clients that keep cookies like a browser.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../app";
import { createAuth } from "../auth/auth";
import { MemoryMailer } from "../auth/mailer";
import { loadConfig } from "../config";
import { openDatabase } from "../db/client";
import { createLogger } from "../log";
import { WudictCatalog } from "../wudict/catalog";
import { WudictClient } from "../wudict/client";
import { FakeWudict } from "../wudict/fake";

export const testToken = "test-token-".padEnd(40, "x");
export const testSecret = "test-secret-".padEnd(40, "s");
export const testOrigin = "http://localhost:8080";
export const testPassword = "correct horse battery";
export const migrationsDir = fileURLToPath(new URL("../../drizzle/", import.meta.url));

export interface HarnessOptions {
  pwaDir?: string;
  headersTimeoutMs?: number;
  /** Catalogue cache lifetime; 0 (default) asks wuDict on every request. */
  catalogTtlMs?: number;
  /** Replaces the fake wuDict's fetch (e.g. to simulate a hanging server). */
  fetch?: typeof fetch;
  /** A client for a real wuDict instead of the fake (contract tests). */
  wudict?: WudictClient;
  /** Extra environment variables for loadConfig. */
  env?: Record<string, string>;
  /** Configure a (memory) mailer, which enables the email-based methods. */
  mail?: boolean;
  /** Better Auth's rate limiter (off by default so tests can sign in repeatedly). */
  rateLimit?: boolean;
  /**
   * DATA_DIR (a temp folder) for tests that touch files; the fake wuDict then scans its dictionaries/
   * on /api/rescan and writes db/<name>/info.txt on /api/ingest.
   */
  dataDir?: string;
  /** Free bytes reported for the volume (default: plenty). */
  freeBytes?: () => number;
}

type Init = Omit<RequestInit, "headers"> & { headers?: Record<string, string> };

/** A browser-like client: keeps cookies, sends Origin on writes, optionally a fixed client IP. */
export class TestClient {
  readonly cookies = new Map<string, string>();

  constructor(
    private readonly app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> },
    private readonly ip?: string,
  ) {}

  async request(path: string, init: Init = {}): Promise<Response> {
    const method = (init.method ?? "GET").toUpperCase();
    const given = { ...(method !== "GET" && method !== "HEAD" ? { Origin: testOrigin } : {}), ...init.headers };
    // An empty value means "send no such header" (e.g. Origin: "").
    const headers = Object.fromEntries(Object.entries(given).filter(([, v]) => v !== ""));
    if (this.ip) headers["X-Test-Client-Ip"] = this.ip;
    const jar = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (jar) headers.Cookie = headers.Cookie ? `${headers.Cookie}; ${jar}` : jar;
    const res = await this.app.request(path, { ...init, headers });
    for (const c of res.headers.getSetCookie()) {
      const [pair = "", ...attrs] = c.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === "";
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }

  /** JSON POST. */
  post(path: string, body: unknown, init: Init = {}): Promise<Response> {
    return this.request(path, {
      ...init,
      method: "POST",
      headers: { "Content-Type": "application/json", ...init.headers },
      body: JSON.stringify(body),
    });
  }
}

export interface NewUser {
  email: string;
  password?: string;
  username?: string;
  name?: string;
  role?: "user" | "admin";
  emailVerified?: boolean;
}

export function harness(opts: HarnessOptions = {}) {
  const lines: string[] = [];
  const logger = createLogger("debug", (l) => lines.push(l));
  const fake = new FakeWudict({
    token: testToken,
    ...(opts.dataDir ? { dictDir: path.join(opts.dataDir, "dictionaries"), dbDir: path.join(opts.dataDir, "db") } : {}),
  });
  const db = openDatabase({ file: ":memory:", migrationsDir });
  const config = loadConfig({
    AUTH_TOKEN: testToken,
    BETTER_AUTH_SECRET: testSecret,
    PUBLIC_URL: testOrigin,
    CLIENT_IP_HEADER: "x-test-client-ip",
    ...(opts.dataDir ? { DATA_DIR: opts.dataDir } : {}),
    ...opts.env,
  });
  const mailer = opts.mail ? new MemoryMailer() : undefined;
  const auth = createAuth({ config, db, logger, mailer, rateLimit: opts.rateLimit ?? false });
  const wudict = opts.wudict ?? new WudictClient({
    baseUrl: new URL("http://127.0.0.1:6888"),
    token: testToken,
    fetch: opts.fetch ?? fake.fetch,
    ...(opts.headersTimeoutMs ? { headersTimeoutMs: opts.headersTimeoutMs } : {}),
  });
  const catalog = new WudictCatalog({ client: wudict, ttlMs: opts.catalogTtlMs ?? 0 });
  const app = createApp({
    version: "1.2.3",
    config,
    logger,
    db,
    auth,
    emailEnabled: mailer !== undefined,
    wudict,
    catalog,
    freeBytes: () => Promise.resolve(opts.freeBytes?.() ?? 100e9),
    ...(opts.pwaDir ? { pwaDir: opts.pwaDir } : {}),
  });
  /** Requests the fake wuDict received for one path. */
  const upstream = (pathname: string) => fake.requests.filter((r) => r.url.pathname === pathname);

  /** Creates a user directly (no registration policy), with a password unless `password` is "". */
  const createUser = async (u: NewUser) => {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      {
        email: u.email,
        name: u.name ?? u.email.split("@")[0] ?? "user",
        emailVerified: u.emailVerified ?? true,
        role: u.role ?? "user",
        ...(u.username ? { username: u.username, displayUsername: u.username } : {}),
      },
      { method: "admin" },
    );
    if (u.password !== "") {
      const hash = await ctx.password.hash(u.password ?? testPassword);
      await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: hash });
    }
    return user;
  };

  const client = (ip?: string) => new TestClient(app, ip);

  /** Creates a user and returns a client signed in as them. */
  const signedIn = async (u: NewUser) => {
    const user = await createUser(u);
    const c = client();
    const res = await c.post("/app-api/auth/sign-in/email", { email: u.email, password: u.password ?? testPassword });
    if (res.status !== 200) throw new Error(`sign-in failed: ${String(res.status)} ${await res.text()}`);
    return { user, client: c };
  };

  let defaultUser: Promise<TestClient> | undefined;
  /** A request as a signed-in regular user (created on first use). */
  const request = async (path: string, init: Init = {}) => {
    defaultUser ??= signedIn({ email: "reader@example.com" }).then((s) => s.client);
    return (await defaultUser).request(path, init);
  };

  return { app, auth, config, fake, db, lines, catalog, mailer, upstream, createUser, client, signedIn, request };
}

/** Reads an NDJSON response body into parsed lines. */
export async function ndjsonLines(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}
