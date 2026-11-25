// Bundle the gateway into one ES module: dist/pxdict-gateway.mjs (run with `node`).
//
// PXDICT_VERSION sets the version reported by /healthz (default: `git describe`, else "dev").
// Native modules added later (better-sqlite3) must be listed in `external` and installed in the image.
import { execFileSync } from "node:child_process";
import { build } from "esbuild";

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
  external: [],
  define: { __PXDICT_VERSION__: JSON.stringify(version()) },
  // Bundled CommonJS dependencies may call require(); give them one in the ES module output.
  banner: { js: "import { createRequire as __pxdictCreateRequire } from 'node:module'; const require = __pxdictCreateRequire(import.meta.url);" },
  logLevel: "info",
});
