/// <reference types="vitest/config" />
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import preact from "@preact/preset-vite";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// The gateway (pxdict-gateway) is the only backend. In development Vite serves the PWA and forwards
// every backend path to it; the gateway then talks to wuDict.
const gateway = process.env.PXDICT_GATEWAY_URL ?? "http://127.0.0.1:8080";
// Keys starting with "^" are regular expressions; plain prefixes would also catch e.g. "/robots.txt".
const backendPaths = ["^/(app-api|api|res|r)/", "^/healthz$"];

// The article frame is linked as /frame.html?v=<hash> and served immutable (ADR 0006).
const frameVersion = createHash("sha256")
  .update(readFileSync(new URL("public/frame.html", import.meta.url)))
  .digest("hex")
  .slice(0, 12);

export default defineConfig({
  define: { __FRAME_VERSION__: JSON.stringify(frameVersion) },
  plugins: [
    preact(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src/sw",
      filename: "sw.ts",
      registerType: "prompt",
      // main.tsx registers it (production only) through virtual:pwa-register.
      injectRegister: false,
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,svg,png,webmanifest}"],
      },
      manifest: {
        name: "PXDict",
        short_name: "PXDict",
        description: "Dictionary lookups for you and your team.",
        id: "/",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#14171b",
        theme_color: "#14171b",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
        ],
        // Android: select text in another app → Share → PXDict opens /?q=<text>.
        share_target: {
          action: "/",
          method: "GET",
          params: { title: "title", text: "q", url: "url" },
        },
      },
    }),
  ],
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
    // styles.test.ts reads the stylesheet's source (`?raw`); Vitest empties CSS it does not process.
    css: { include: [/styles\.css/] },
  },
});
