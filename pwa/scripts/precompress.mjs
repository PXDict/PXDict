// Writes .br and .gz next to every compressible file in dist/ so the gateway can serve them
// precompressed (serveStatic `precompressed: true`) instead of compressing on every request.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const dist = new URL("../dist/", import.meta.url).pathname;
const compressible = /\.(?:html|js|mjs|css|svg|json|webmanifest|txt|xml|wasm)$/;
const minBytes = 1024;

let count = 0;
for (const entry of readdirSync(dist, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !compressible.test(entry.name)) continue;
  const file = path.join(entry.parentPath, entry.name);
  if (statSync(file).size < minBytes) continue;
  const data = readFileSync(file);
  const br = brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
  const gz = gzipSync(data, { level: 9 });
  // Only keep a variant that is actually smaller.
  if (br.length < data.length) writeFileSync(file + ".br", br);
  if (gz.length < data.length) writeFileSync(file + ".gz", gz);
  count++;
}
console.log(`precompressed ${String(count)} files in ${dist}`);
