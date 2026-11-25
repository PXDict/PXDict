// Gateway configuration: read once from environment variables, with defaults and validation.
// Every problem is reported at once so a misconfigured container fails with one clear message.
import path from "node:path";
import { z } from "zod";

export interface ListenAddress {
  /** Interface to bind; undefined listens on every interface. */
  host: string | undefined;
  port: number;
}

export type LogLevel = "debug" | "info" | "warn" | "error";
export type RegistrationMode = "closed" | "invite" | "open";

export interface Config {
  /** LISTEN_ADDR, default ":8080" ("host:port", "[v6]:port" or ":port"). */
  listen: ListenAddress;
  /** DATA_DIR, default "/data": the persistent volume (absolute path). */
  dataDir: string;
  /** WUDICT_URL, default "http://127.0.0.1:6888": the loopback wuDict server. */
  wudictUrl: URL;
  /** AUTH_TOKEN (required, at least 32 characters): wuDict's access token. Never log it. */
  authToken: string;
  /** PWA_DIR, default "/srv/pwa": the built PWA served at "/" (absolute path). */
  pwaDir: string;
  /** LOG_LEVEL, default "info". */
  logLevel: LogLevel;
  /** PUBLIC_URL, default "http://localhost:8080": the origin users open (scheme + host + port). */
  publicUrl: URL;
  /** True when PUBLIC_URL was not set, so main.ts can warn about the default. */
  publicUrlIsDefault: boolean;
  /** COOKIE_SECURE, default: true when PUBLIC_URL is https. */
  cookieSecure: boolean;
  /** REGISTRATION, default "closed": who may create an account (Phase 3). */
  registration: RegistrationMode;
  /** MAX_UPLOAD_BYTES, default 500MB: largest dictionary proposal (Phase 6). */
  maxUploadBytes: number;
  /** MAX_PENDING_PROPOSALS_PER_USER, default 3 (Phase 6). */
  maxPendingProposalsPerUser: number;
  /** MAX_PENDING_BYTES, default 5GB: total size of all pending proposals (Phase 6). */
  maxPendingBytes: number;
  /** MIN_FREE_BYTES, default 1GB: uploads are refused when the volume has less free space (Phase 6). */
  minFreeBytes: number;
  /** HISTORY_DEFAULT_RETENTION_DAYS, default 90; 0 keeps history forever (Phase 5). */
  historyDefaultRetentionDays: number;
}

export const defaults = {
  LISTEN_ADDR: ":8080",
  DATA_DIR: "/data",
  WUDICT_URL: "http://127.0.0.1:6888",
  AUTH_TOKEN: "",
  PWA_DIR: "/srv/pwa",
  LOG_LEVEL: "info",
  PUBLIC_URL: "http://localhost:8080",
  COOKIE_SECURE: "",
  REGISTRATION: "closed",
  MAX_UPLOAD_BYTES: "500MB",
  MAX_PENDING_PROPOSALS_PER_USER: "3",
  MAX_PENDING_BYTES: "5GB",
  MIN_FREE_BYTES: "1GB",
  HISTORY_DEFAULT_RETENTION_DAYS: "90",
} as const;

/** Variables whose values must never appear in error messages or logs. */
const secretKeys = new Set<string>(["AUTH_TOKEN"]);

/** Thrown by loadConfig; `issues` holds one "VAR: problem" line per invalid variable. */
export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid configuration:\n  ${issues.join("\n  ")}`);
    this.name = "ConfigError";
  }
}

/** Parses "host:port", "[v6]:port" or ":port". */
export function parseListenAddress(raw: string): ListenAddress | undefined {
  const m = /^(?:\[([0-9a-fA-F:.]+)\]|([^:[\]]*)):(\d{1,5})$/.exec(raw);
  if (!m) return undefined;
  const port = Number(m[3]);
  if (port < 1 || port > 65535) return undefined;
  const host = m[1] ?? m[2];
  return { host: host === "" ? undefined : host, port };
}

const sizeUnits: Record<string, number> = {
  "": 1,
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
  kib: 2 ** 10,
  mib: 2 ** 20,
  gib: 2 ** 30,
  tib: 2 ** 40,
};

/** Parses a byte size: "1048576", "500MB", "1.5 GiB" (case-insensitive). */
export function parseByteSize(raw: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/i.exec(raw.trim());
  if (!m) return undefined;
  const unit = sizeUnits[(m[2] ?? "").toLowerCase()];
  if (unit === undefined) return undefined;
  const bytes = Math.round(Number(m[1]) * unit);
  return Number.isSafeInteger(bytes) ? bytes : undefined;
}

const absolutePath = z
  .string()
  .refine((p) => path.isAbsolute(p), "must be an absolute path")
  .transform((p) => path.normalize(p).replace(/(.)\/$/, "$1"));

const byteSize = z.string().transform((raw, ctx) => {
  const n = parseByteSize(raw);
  if (n === undefined || n < 1) {
    ctx.addIssue({ code: "custom", message: 'must be a positive size such as "500MB" or "2GiB"' });
    return z.NEVER;
  }
  return n;
});

const integer = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d+$/, "must be a whole number")
    .transform(Number)
    .pipe(z.number().int().min(min, `must be at least ${String(min)}`).max(max, `must be at most ${String(max)}`));

function parseUrl(raw: string, ctx: z.RefinementCtx): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    ctx.addIssue({ code: "custom", message: "must be a URL" });
    return undefined;
  }
}

const schema = z.object({
  LISTEN_ADDR: z.string().transform((raw, ctx) => {
    const addr = parseListenAddress(raw);
    if (!addr) {
      ctx.addIssue({ code: "custom", message: 'must be "host:port", "[v6]:port" or ":port"' });
      return z.NEVER;
    }
    return addr;
  }),
  DATA_DIR: absolutePath,
  WUDICT_URL: z.string().transform((raw, ctx) => {
    const u = parseUrl(raw, ctx);
    if (!u) return z.NEVER;
    if (u.protocol !== "http:" || u.pathname !== "/" || u.search || u.hash || u.username || u.password) {
      ctx.addIssue({
        code: "custom",
        message: "must be http://host:port with no path, query or credentials",
      });
      return z.NEVER;
    }
    return u;
  }),
  AUTH_TOKEN: z
    .string()
    .min(32, "must be set to a random string of at least 32 characters (e.g. openssl rand -hex 32)")
    .regex(/^[\x21-\x7e]+$/, "must contain printable ASCII characters only (no spaces)"),
  PWA_DIR: absolutePath,
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]),
  PUBLIC_URL: z.string().transform((raw, ctx) => {
    const u = parseUrl(raw, ctx);
    if (!u) return z.NEVER;
    if (
      (u.protocol !== "http:" && u.protocol !== "https:") ||
      u.pathname !== "/" ||
      u.search ||
      u.hash ||
      u.username ||
      u.password
    ) {
      ctx.addIssue({
        code: "custom",
        message: "must be an origin such as https://dict.example.com (no path, query or credentials)",
      });
      return z.NEVER;
    }
    return u;
  }),
  COOKIE_SECURE: z.enum(["", "true", "false", "1", "0"], 'must be "true" or "false"'),
  REGISTRATION: z.enum(["closed", "invite", "open"]),
  MAX_UPLOAD_BYTES: byteSize,
  MAX_PENDING_PROPOSALS_PER_USER: integer(0, 1000),
  MAX_PENDING_BYTES: byteSize,
  MIN_FREE_BYTES: byteSize,
  HISTORY_DEFAULT_RETENTION_DAYS: integer(0, 36500),
});

type Env = Record<string, string | undefined>;

/** Reads and validates the configuration. Empty or blank variables count as unset. */
export function loadConfig(env: Env = process.env): Config {
  const input: Record<string, string> = {};
  for (const [key, def] of Object.entries(defaults)) {
    const v = env[key]?.trim();
    input[key] = v ? v : def;
  }

  const result = schema.safeParse(input);
  if (!result.success) {
    // One line per variable (its first problem). Values are echoed to help fix typos, except secrets.
    const byKey = new Map<string, string>();
    for (const issue of result.error.issues) {
      const key = String(issue.path[0] ?? "config");
      if (byKey.has(key)) continue;
      const shown = secretKeys.has(key) ? "(hidden)" : JSON.stringify(input[key] ?? "");
      byKey.set(key, `${key}=${shown}: ${issue.message}`);
    }
    throw new ConfigError([...byKey.values()]);
  }

  const c = result.data;
  const cookieSecure =
    c.COOKIE_SECURE === "" ? c.PUBLIC_URL.protocol === "https:" : c.COOKIE_SECURE === "true" || c.COOKIE_SECURE === "1";
  return {
    listen: c.LISTEN_ADDR,
    dataDir: c.DATA_DIR,
    wudictUrl: c.WUDICT_URL,
    authToken: c.AUTH_TOKEN,
    pwaDir: c.PWA_DIR,
    logLevel: c.LOG_LEVEL,
    publicUrl: c.PUBLIC_URL,
    publicUrlIsDefault: !env.PUBLIC_URL?.trim(),
    cookieSecure,
    registration: c.REGISTRATION,
    maxUploadBytes: c.MAX_UPLOAD_BYTES,
    maxPendingProposalsPerUser: c.MAX_PENDING_PROPOSALS_PER_USER,
    maxPendingBytes: c.MAX_PENDING_BYTES,
    minFreeBytes: c.MIN_FREE_BYTES,
    historyDefaultRetentionDays: c.HISTORY_DEFAULT_RETENTION_DAYS,
  };
}
