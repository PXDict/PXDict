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

export interface Config {
  /** LISTEN_ADDR, default ":8080" ("host:port", "[v6]:port" or ":port"). */
  listen: ListenAddress;
  /** DATA_DIR, default "/data": the persistent volume (absolute path). */
  dataDir: string;
  /** WUDICT_URL, default "http://127.0.0.1:6888": the loopback wuDict server. */
  wudictUrl: URL;
  /** PWA_DIR, default "/srv/pwa": the built PWA served at "/" (absolute path). */
  pwaDir: string;
  /** LOG_LEVEL, default "info". */
  logLevel: LogLevel;
}

export const defaults = {
  LISTEN_ADDR: ":8080",
  DATA_DIR: "/data",
  WUDICT_URL: "http://127.0.0.1:6888",
  PWA_DIR: "/srv/pwa",
  LOG_LEVEL: "info",
} as const;

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

const absolutePath = z
  .string()
  .refine((p) => path.isAbsolute(p), "must be an absolute path")
  .transform((p) => path.normalize(p).replace(/(.)\/$/, "$1"));

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
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      ctx.addIssue({ code: "custom", message: "must be a URL" });
      return z.NEVER;
    }
    if (u.protocol !== "http:" || u.pathname !== "/" || u.search || u.hash || u.username || u.password) {
      ctx.addIssue({
        code: "custom",
        message: "must be http://host:port with no path, query or credentials",
      });
      return z.NEVER;
    }
    return u;
  }),
  PWA_DIR: absolutePath,
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]),
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
    throw new ConfigError(
      result.error.issues.map((issue) => {
        const key = String(issue.path[0] ?? "config");
        // Values are echoed to help fix typos; secrets must never go through this path.
        return `${key}=${JSON.stringify(input[key] ?? "")}: ${issue.message}`;
      }),
    );
  }

  const c = result.data;
  return {
    listen: c.LISTEN_ADDR,
    dataDir: c.DATA_DIR,
    wudictUrl: c.WUDICT_URL,
    pwaDir: c.PWA_DIR,
    logLevel: c.LOG_LEVEL,
  };
}
