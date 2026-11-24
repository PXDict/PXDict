/// <reference types="vitest/config" />
import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

// The gateway (pxdict-gateway) is the only backend. In development Vite serves the PWA and forwards
// every backend path to it; the gateway then talks to wuDict.
const gateway = process.env.PXDICT_GATEWAY_URL ?? "http://127.0.0.1:8080";
// Keys starting with "^" are regular expressions; plain prefixes would also catch e.g. "/robots.txt".
const backendPaths = ["^/(app-api|api|res|r)/", "^/healthz$"];

export default defineConfig({
  plugins: [preact()],
  build: {
    // Must not be "assets": wuDict owns /assets/* (AGENTS.md §5).
    assetsDir: "app-assets",
    sourcemap: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: Object.fromEntries(backendPaths.map((p) => [p, { target: gateway, changeOrigin: false }])),
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
