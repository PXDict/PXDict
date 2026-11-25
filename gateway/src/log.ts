// Minimal structured logger: one JSON object per line on stdout (container logs).
// Never pass passwords, tokens, cookies or Authorization headers as fields (AGENTS.md §6).
import type { LogLevel } from "./config";

export type Fields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
}

const rank: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Turns Error values into plain objects so JSON.stringify keeps their message and stack. */
function serialize(fields: Fields): Fields {
  const out: Fields = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v;
  }
  return out;
}

export function createLogger(
  level: LogLevel = "info",
  write: (line: string) => void = (line) => process.stdout.write(line),
): Logger {
  const log = (lvl: LogLevel, msg: string, fields: Fields = {}) => {
    if (rank[lvl] < rank[level]) return;
    write(JSON.stringify({ time: new Date().toISOString(), level: lvl, msg, ...serialize(fields) }) + "\n");
  };
  return {
    debug: (msg, fields) => {
      log("debug", msg, fields);
    },
    info: (msg, fields) => {
      log("info", msg, fields);
    },
    warn: (msg, fields) => {
      log("warn", msg, fields);
    },
    error: (msg, fields) => {
      log("error", msg, fields);
    },
  };
}
