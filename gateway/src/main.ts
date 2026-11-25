// Entry point of pxdict-gateway, the single entry point of a PXDict container: it serves the PWA, the
// /app-api endpoints and an allowlisted proxy to the loopback wuDict server.
//
//   node pxdict-gateway.mjs                                   run the server
//   node pxdict-gateway.mjs user reset-password <email|username>   rescue: print a new password
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { createAuth } from "./auth/auth";
import { bootstrapAdmin, resetPasswordCli } from "./auth/bootstrap";
import { createSmtpMailer } from "./auth/mailer";
import { ConfigError, loadConfig, type Config } from "./config";
import { databaseFile, openDatabase, type Db } from "./db/client";
import { startJobs } from "./jobs";
import { createLogger, type Logger } from "./log";
import { WudictCatalog } from "./wudict/catalog";
import { WudictClient } from "./wudict/client";

const version = typeof __PXDICT_VERSION__ === "string" ? __PXDICT_VERSION__ : "dev";
const bundled = typeof __PXDICT_BUNDLED__ === "boolean" && __PXDICT_BUNDLED__;
const migrationsDir = fileURLToPath(new URL(bundled ? "./drizzle/" : "../drizzle/", import.meta.url));
const shutdownTimeoutMs = 10_000;

/** process.env without blank values, so a blank variable does not hide a default. */
function definedEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => !!e[1]?.trim()));
}

const usage = "usage: node pxdict-gateway.mjs [user reset-password <email|username>]";

/** `user reset-password <email|username>`: sets a random password, signs the user out, prints it. */
async function runCli(args: string[], config: Config, db: Db, logger: Logger): Promise<number> {
  const [group, command, identifier, ...rest] = args;
  if (group !== "user" || command !== "reset-password" || !identifier || rest.length) {
    process.stderr.write(`${usage}\n`);
    return 2;
  }
  const auth = createAuth({ config, db, logger, mailer: undefined, rateLimit: false });
  const result = await resetPasswordCli(auth, db, identifier);
  if (!result) {
    process.stderr.write(`no user with email or username ${JSON.stringify(identifier)}\n`);
    return 1;
  }
  process.stdout.write(`New password for ${identifier} (all sessions were signed out):\n${result.password}\n`);
  return 0;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let config: Config;
  try {
    // The CLI talks to neither wuDict nor browsers: placeholders stand in for their secrets when it
    // runs without the server's environment (e.g. `docker exec`).
    const placeholder = randomBytes(32).toString("hex");
    const cliDefaults = args.length ? { AUTH_TOKEN: placeholder, BETTER_AUTH_SECRET: placeholder } : {};
    config = loadConfig({ ...cliDefaults, ...definedEnv() });
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    createLogger().error("pxdict-gateway stopped: invalid configuration", { issues: err.issues });
    process.exit(1);
  }

  // The CLI logs only warnings and errors (to stderr), so its stdout is just the result.
  const logger = args.length
    ? createLogger("warn", (line) => process.stderr.write(line))
    : createLogger(config.logLevel);
  if (config.publicUrlIsDefault && !args.length) {
    logger.warn("PUBLIC_URL is not set; using the default", { publicUrl: config.publicUrl.origin });
  }

  const file = databaseFile(config.dataDir);
  let db;
  try {
    db = openDatabase({ file, migrationsDir });
  } catch (err) {
    logger.error("pxdict-gateway stopped: cannot open the database", { file, err });
    process.exit(1);
  }
  if (args.length) {
    const code = await runCli(args, config, db, logger);
    db.$client.close();
    process.exit(code);
  }
  logger.info("database ready", { file });

  const mailer = config.auth.smtp ? createSmtpMailer(config.auth.smtp) : undefined;
  const auth = createAuth({ config, db, logger, mailer });
  try {
    await bootstrapAdmin(auth, db, config, logger);
  } catch (err) {
    logger.error("pxdict-gateway stopped: cannot create the first admin", { err });
    process.exit(1);
  }
  const methods = {
    registration: config.registration,
    passkey: config.auth.passkey,
    email: mailer !== undefined,
    social: Object.keys(config.auth.social),
    oidc: config.auth.oidc.map((p) => p.id),
  };
  logger.info("sign-in methods", methods);

  const pwaFound = fs.existsSync(config.pwaDir);
  if (!pwaFound) logger.warn("PWA_DIR does not exist; serving the API only", { pwaDir: config.pwaDir });

  const wudict = new WudictClient({ baseUrl: config.wudictUrl, token: config.authToken });
  const app = createApp({
    version,
    config,
    logger,
    db,
    auth,
    emailEnabled: mailer !== undefined,
    wudict,
    catalog: new WudictCatalog({ client: wudict }),
    ...(pwaFound ? { pwaDir: config.pwaDir } : {}),
  });

  const stopJobs = startJobs({ db, logger, historyDefaultRetentionDays: config.historyDefaultRetentionDays });

  const server = serve(
    { fetch: app.fetch, port: config.listen.port, ...(config.listen.host ? { hostname: config.listen.host } : {}) },
    (info) => {
      logger.info("pxdict-gateway listening", {
        address: info.address,
        port: info.port,
        version,
        wudict: config.wudictUrl.origin,
      });
    },
  );

  server.on("error", (err) => {
    logger.error("pxdict-gateway stopped", { err });
    process.exit(1);
  });

  let stopping = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    logger.info("pxdict-gateway shutting down", { signal });
    stopJobs();
    const exit = (code: number) => {
      db.$client.close();
      process.exit(code);
    };
    // Stop accepting connections; force-exit if in-flight requests (e.g. streams) do not finish.
    setTimeout(() => {
      logger.warn("shutdown timed out, exiting");
      exit(0);
    }, shutdownTimeoutMs).unref();
    server.close(() => {
      exit(0);
    });
    if ("closeIdleConnections" in server) server.closeIdleConnections();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

void main();
