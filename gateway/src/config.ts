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

/** Social providers PXDict can enable (Better Auth's provider ids). */
export const socialProviderIds = ["google", "github", "microsoft", "apple", "discord", "facebook", "gitlab"] as const;
export type SocialProviderId = (typeof socialProviderIds)[number];

export interface SocialProviderConfig {
  clientId: string;
  clientSecret: string;
  /** AUTH_MICROSOFT_TENANT_ID (Microsoft only; default "common"). */
  tenantId?: string;
  /** AUTH_GITLAB_ISSUER (GitLab only): a self-hosted GitLab's URL. */
  issuer?: string;
}

/** A generic OpenID Connect provider from AUTH_OIDC_<NAME>_*. */
export interface OidcProviderConfig {
  /** Lower-cased <NAME>; the provider id in callback URLs (/app-api/auth/callback/<id>). */
  id: string;
  /** AUTH_OIDC_<NAME>_LABEL, default <NAME>: the button text on the login screen. */
  label: string;
  /** AUTH_OIDC_<NAME>_ISSUER: discovery is read from <issuer>/.well-known/openid-configuration. */
  issuer: URL;
  clientId: string;
  clientSecret: string;
}

export interface AuthConfig {
  /** BETTER_AUTH_SECRET (required, at least 32 characters): signs cookies and tokens. Never log it. */
  secret: string;
  /** ADMIN_EMAIL / ADMIN_USERNAME / ADMIN_PASSWORD: the first admin, created when no admin exists. */
  bootstrapAdmin: { email: string; username: string | undefined; password: string | undefined } | undefined;
  /** AUTH_PASSKEY, default true: passkey (WebAuthn) sign-in. */
  passkey: boolean;
  /** AUTH_HIBP, default false: refuse passwords found in Have I Been Pwned (k-anonymity API). */
  hibp: boolean;
  /** AUTH_REQUIRE_2FA_ADMIN, default false: admin endpoints need two-factor authentication enabled. */
  requireAdmin2fa: boolean;
  /** SMTP_URL + MAIL_FROM: email verification, password reset, magic links and email codes. */
  smtp: { url: string; from: string } | undefined;
  /** AUTH_<PROVIDER>_CLIENT_ID + _CLIENT_SECRET. */
  social: Partial<Record<SocialProviderId, SocialProviderConfig>>;
  /** AUTH_OIDC_<NAME>_ISSUER, _CLIENT_ID, _CLIENT_SECRET, _LABEL. */
  oidc: OidcProviderConfig[];
  /**
   * CLIENT_IP_HEADER, default unset (use the TCP peer address): the header a trusted reverse proxy
   * sets to the client's address, e.g. "cf-connecting-ip" or "x-forwarded-for" (last entry used).
   * Rate limits and session records use it, so only set it when every request passes that proxy.
   */
  clientIpHeader: string | undefined;
}

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
  /** REGISTRATION, default "closed": who may create an account, for every sign-in method. */
  registration: RegistrationMode;
  /** MAX_UPLOAD_BYTES, default 500MB: largest dictionary proposal (Phase 6). */
  maxUploadBytes: number;
  /** MAX_PENDING_PROPOSALS_PER_USER, default 3 (Phase 6). */
  maxPendingProposalsPerUser: number;
  /** MAX_PENDING_BYTES, default 5GB: total size of all pending proposals (Phase 6). */
  maxPendingBytes: number;
  /** MIN_FREE_BYTES, default 1GB: uploads are refused when the volume has less free space (Phase 6). */
  minFreeBytes: number;
  /** HISTORY_DEFAULT_RETENTION_DAYS, default 90; 0 keeps history forever. */
  historyDefaultRetentionDays: number;
  /**
   * BUILTIN_DICT_VISIBILITY, default "global": visibility of a dictionary the gateway finds in DICT_DIR
   * without a proposal (copied in by the operator). "hidden" keeps it from users until an admin
   * publishes it (ADR 0007).
   */
  builtinDictVisibility: "global" | "hidden";
  /** Sign-in methods and accounts. */
  auth: AuthConfig;
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
  BUILTIN_DICT_VISIBILITY: "global",
  BETTER_AUTH_SECRET: "",
  ADMIN_EMAIL: "",
  ADMIN_USERNAME: "",
  ADMIN_PASSWORD: "",
  AUTH_PASSKEY: "true",
  AUTH_HIBP: "false",
  AUTH_REQUIRE_2FA_ADMIN: "false",
  SMTP_URL: "",
  MAIL_FROM: "",
  CLIENT_IP_HEADER: "",
} as const;

/** Variables whose values must never appear in error messages or logs. */
const secretKeys = new Set<string>(["AUTH_TOKEN", "BETTER_AUTH_SECRET", "ADMIN_PASSWORD", "SMTP_URL"]);
const isSecretKey = (key: string) => secretKeys.has(key) || key.endsWith("_CLIENT_SECRET");

/** The smallest password PXDict accepts (Better Auth's minPasswordLength, ADMIN_PASSWORD). */
export const minPasswordLength = 10;

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

const flag = z
  .enum(["true", "false", "1", "0"], 'must be "true" or "false"')
  .transform((v) => v === "true" || v === "1");

/** "" (unset) or a value. */
const optional = <S extends z.ZodType<unknown, string>>(inner: S) =>
  z.union([z.literal("").transform(() => undefined), inner]);

const usernamePattern = /^[a-zA-Z0-9_.]{3,30}$/;

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
  BUILTIN_DICT_VISIBILITY: z.enum(["global", "hidden"]),
  BETTER_AUTH_SECRET: z
    .string()
    .min(32, "must be set to a random string of at least 32 characters (e.g. openssl rand -hex 32)"),
  ADMIN_EMAIL: optional(z.email("must be an email address")),
  ADMIN_USERNAME: optional(
    z.string().regex(usernamePattern, "must be 3–30 letters, digits, '_' or '.'").transform((u) => u.toLowerCase()),
  ),
  ADMIN_PASSWORD: optional(z.string().min(minPasswordLength, `must be at least ${String(minPasswordLength)} characters`)),
  AUTH_PASSKEY: flag,
  AUTH_HIBP: flag,
  AUTH_REQUIRE_2FA_ADMIN: flag,
  SMTP_URL: optional(
    z.string().refine((raw) => {
      try {
        const u = new URL(raw);
        return (u.protocol === "smtp:" || u.protocol === "smtps:") && u.hostname !== "";
      } catch {
        return false;
      }
    }, "must be smtp://user:pass@host:587 or smtps://user:pass@host:465"),
  ),
  MAIL_FROM: z.string(),
  CLIENT_IP_HEADER: optional(
    z
      .string()
      .regex(/^[A-Za-z0-9-]+$/, "must be a header name such as cf-connecting-ip")
      .transform((h) => h.toLowerCase()),
  ),
});

/** Reads the provider variables, whose names are only known at runtime. */
function loadProviders(env: Env, report: (key: string, message: string) => void) {
  const get = (key: string) => env[key]?.trim() ?? "";
  const social: Partial<Record<SocialProviderId, SocialProviderConfig>> = {};
  for (const id of socialProviderIds) {
    const prefix = `AUTH_${id.toUpperCase()}_`;
    const clientId = get(`${prefix}CLIENT_ID`);
    const clientSecret = get(`${prefix}CLIENT_SECRET`);
    if (!clientId && !clientSecret) continue;
    if (!clientId || !clientSecret) {
      const missing = clientId ? `${prefix}CLIENT_SECRET` : `${prefix}CLIENT_ID`;
      report(missing, `must be set together with ${clientId ? `${prefix}CLIENT_ID` : `${prefix}CLIENT_SECRET`}`);
      continue;
    }
    const p: SocialProviderConfig = { clientId, clientSecret };
    if (id === "microsoft" && get("AUTH_MICROSOFT_TENANT_ID")) p.tenantId = get("AUTH_MICROSOFT_TENANT_ID");
    if (id === "gitlab" && get("AUTH_GITLAB_ISSUER")) p.issuer = get("AUTH_GITLAB_ISSUER");
    social[id] = p;
  }

  const oidc: OidcProviderConfig[] = [];
  const names = new Set<string>();
  for (const key of Object.keys(env)) {
    const m = /^AUTH_OIDC_(.+)_(ISSUER|CLIENT_ID|CLIENT_SECRET|LABEL)$/.exec(key);
    if (m?.[1] && get(key)) names.add(m[1]);
  }
  for (const name of [...names].sort()) {
    const prefix = `AUTH_OIDC_${name}_`;
    const id = name.toLowerCase();
    if (!/^[A-Z0-9]{1,32}$/.test(name)) {
      report(`${prefix}ISSUER`, "<NAME> in AUTH_OIDC_<NAME>_* must be 1–32 upper-case letters or digits");
      continue;
    }
    if ((socialProviderIds as readonly string[]).includes(id) || id === "credential") {
      report(`${prefix}ISSUER`, `"${id}" is a built-in provider; choose another <NAME>`);
      continue;
    }
    const missing = ["ISSUER", "CLIENT_ID", "CLIENT_SECRET"].filter((k) => !get(prefix + k));
    if (missing.length) {
      for (const k of missing) report(prefix + k, `must be set (OIDC provider ${name})`);
      continue;
    }
    let issuer: URL;
    try {
      issuer = new URL(get(`${prefix}ISSUER`));
      if (issuer.protocol !== "https:" && issuer.protocol !== "http:") throw new Error("scheme");
    } catch {
      report(`${prefix}ISSUER`, "must be an https:// (or http://) URL");
      continue;
    }
    oidc.push({
      id,
      label: get(`${prefix}LABEL`) || name,
      issuer,
      clientId: get(`${prefix}CLIENT_ID`),
      clientSecret: get(`${prefix}CLIENT_SECRET`),
    });
  }
  return { social, oidc };
}

type Env = Record<string, string | undefined>;

/** Reads and validates the configuration. Empty or blank variables count as unset. */
export function loadConfig(env: Env = process.env): Config {
  const input: Record<string, string> = {};
  for (const [key, def] of Object.entries(defaults)) {
    const v = env[key]?.trim();
    input[key] = v ? v : def;
  }

  // One line per variable (its first problem). Values are echoed to help fix typos, except secrets.
  const byKey = new Map<string, string>();
  const report = (key: string, message: string) => {
    if (byKey.has(key)) return;
    const shown = isSecretKey(key) ? "(hidden)" : JSON.stringify(input[key] ?? env[key]?.trim() ?? "");
    byKey.set(key, `${key}=${shown}: ${message}`);
  };
  const result = schema.safeParse(input);
  if (!result.success) {
    for (const issue of result.error.issues) report(String(issue.path[0] ?? "config"), issue.message);
  }
  const providers = loadProviders(env, report);
  if (!result.success || byKey.size) throw new ConfigError([...byKey.values()]);

  const c = result.data;
  if (c.SMTP_URL && !c.MAIL_FROM) report("MAIL_FROM", "must be set when SMTP_URL is set");
  if (c.MAIL_FROM && !c.MAIL_FROM.includes("@")) report("MAIL_FROM", 'must be an address such as "PXDict <dict@example.com>"');
  if ((c.ADMIN_PASSWORD || c.ADMIN_USERNAME) && !c.ADMIN_EMAIL) report("ADMIN_EMAIL", "must be set when ADMIN_PASSWORD or ADMIN_USERNAME is set");
  if (byKey.size) throw new ConfigError([...byKey.values()]);

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
    builtinDictVisibility: c.BUILTIN_DICT_VISIBILITY,
    auth: {
      secret: c.BETTER_AUTH_SECRET,
      bootstrapAdmin: c.ADMIN_EMAIL
        ? { email: c.ADMIN_EMAIL.toLowerCase(), username: c.ADMIN_USERNAME, password: c.ADMIN_PASSWORD }
        : undefined,
      passkey: c.AUTH_PASSKEY,
      hibp: c.AUTH_HIBP,
      requireAdmin2fa: c.AUTH_REQUIRE_2FA_ADMIN,
      smtp: c.SMTP_URL ? { url: c.SMTP_URL, from: c.MAIL_FROM } : undefined,
      social: providers.social,
      oidc: providers.oidc,
      clientIpHeader: c.CLIENT_IP_HEADER,
    },
  };
}
