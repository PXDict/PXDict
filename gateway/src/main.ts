// Entry point of pxdict-gateway, the single entry point of a PXDict container: it serves the PWA, the
// /app-api endpoints and an allowlisted proxy to the loopback wuDict server.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { ConfigError, loadConfig, type Config } from "./config";
import { databaseFile, openDatabase } from "./db/client";
import { createLogger } from "./log";
import { WudictCatalog } from "./wudict/catalog";
import { WudictClient } from "./wudict/client";

const version = typeof __PXDICT_VERSION__ === "string" ? __PXDICT_VERSION__ : "dev";
const bundled = typeof __PXDICT_BUNDLED__ === "boolean" && __PXDICT_BUNDLED__;
const migrationsDir = fileURLToPath(new URL(bundled ? "./drizzle/" : "../drizzle/", import.meta.url));
const shutdownTimeoutMs = 10_000;

function main(): void {
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    createLogger().error("pxdict-gateway stopped: invalid configuration", { issues: err.issues });
    process.exit(1);
  }

  const logger = createLogger(config.logLevel);
  if (config.publicUrlIsDefault) {
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
  logger.info("database ready", { file });

  const pwaFound = fs.existsSync(config.pwaDir);
  if (!pwaFound) logger.warn("PWA_DIR does not exist; serving the API only", { pwaDir: config.pwaDir });

  const wudict = new WudictClient({ baseUrl: config.wudictUrl, token: config.authToken });
  const app = createApp({
    version,
    logger,
    db,
    wudict,
    access: new WudictCatalog({ client: wudict }),
    ...(pwaFound ? { pwaDir: config.pwaDir } : {}),
    hsts: config.publicUrl.protocol === "https:",
  });

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

main();
