// Bundle the gateway into one ES module: dist/pxdict-gateway.mjs (run with `node`).
//
// PXDICT_VERSION sets the version reported by /healthz (default: `git describe`, else "dev").
// better-sqlite3 is a native module: it stays `external` and the image ships its package (with the
// bundled prebuilds) in node_modules next to the bundle. drizzle/ (SQL migrations) is copied to
// dist/drizzle, where the bundle looks for it.
import { execFileSync } from "node:child_process";
import { cpSync, rmSync } from "node:fs";
import { build } from "esbuild";

const dist = new URL("../dist/", import.meta.url);
rmSync(dist, { recursive: true, force: true });

function version() {
  if (process.env.PXDICT_VERSION) return process.env.PXDICT_VERSION;
  try {
    return execFileSync("git", ["describe", "--tags", "--always", "--dirty"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "dev";
  }
}

await build({
  entryPoints: [new URL("../src/main.ts", import.meta.url).pathname],
  outfile: new URL("../dist/pxdict-gateway.mjs", import.meta.url).pathname,
  bundle: true,
  platform: "node",
  target: "node26",
  format: "esm",
  sourcemap: true,
  legalComments: "linked",
  external: ["better-sqlite3"],
  define: { __PXDICT_VERSION__: JSON.stringify(version()), __PXDICT_BUNDLED__: "true" },
  // Bundled CommonJS dependencies may call require(); give them one in the ES module output.
  banner: { js: "import { createRequire as __pxdictCreateRequire } from 'node:module'; const require = __pxdictCreateRequire(import.meta.url);" },
  logLevel: "info",
});

cpSync(new URL("../drizzle/", import.meta.url), new URL("drizzle/", dist), { recursive: true });
