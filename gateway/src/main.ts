// Entry point of pxdict-gateway, the single entry point of a PXDict container: it serves the PWA, the
// /app-api endpoints and an allowlisted proxy to the loopback wuDict server.
import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { ConfigError, loadConfig } from "./config";
import { createLogger } from "./log";

const version = typeof __PXDICT_VERSION__ === "string" ? __PXDICT_VERSION__ : "dev";
const shutdownTimeoutMs = 10_000;

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    createLogger().error("pxdict-gateway stopped: invalid configuration", { issues: err.issues });
    process.exit(1);
  }

  const logger = createLogger(config.logLevel);
  const app = createApp({ version, logger });

  const server = serve(
    { fetch: app.fetch, port: config.listen.port, ...(config.listen.host ? { hostname: config.listen.host } : {}) },
    (info) => {
      logger.info("pxdict-gateway listening", { address: info.address, port: info.port, version });
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
    // Stop accepting connections; force-exit if in-flight requests (e.g. streams) do not finish.
    setTimeout(() => {
      logger.warn("shutdown timed out, exiting");
      process.exit(0);
    }, shutdownTimeoutMs).unref();
    server.close(() => process.exit(0));
    if ("closeIdleConnections" in server) server.closeIdleConnections();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main();
