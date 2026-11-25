// Renders the PNG app icons from the shapes in public/icon.svg (a "P" on a dark rounded square), so no
// image toolchain is needed. Run after changing the icon: node scripts/gen-icons.mjs
//   icon-192.png, icon-512.png      purpose "any" (rounded square)
//   icon-maskable-512.png           purpose "maskable" (full bleed, glyph inside the safe zone)
//   apple-touch-icon.png (180)      iOS home screen (full bleed; iOS rounds the corners)
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const bg = [0x14, 0x17, 0x1b];
const fg = [0xe8, 0xec, 0xf1];

/** The glyph in icon.svg's 64×64 coordinates. */
function inGlyph(x, y) {
  const inOuter =
    (x >= 18 && x <= 34 && y >= 14 && y <= 38) ||
    (x >= 34 && (x - 34) ** 2 + (y - 26) ** 2 <= 144) ||
    (x >= 18 && x <= 26 && y >= 38 && y <= 50);
  const inHole = (x >= 26 && x <= 34 && y >= 22 && y <= 30) || (x >= 34 && (x - 34) ** 2 + (y - 26) ** 2 <= 16);
  return inOuter && !inHole;
}

function inRoundedSquare(x, y, r) {
  const cx = Math.min(Math.max(x, r), 64 - r);
  const cy = Math.min(Math.max(y, r), 64 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** RGBA pixels with 4×4 supersampling. `scale` shrinks the glyph around the centre (maskable). */
function render(size, { rounded, scale }) {
  const px = Buffer.alloc(size * size * 4);
  const ss = 4;
  for (let py = 0; py < size; py++) {
    for (let pxl = 0; pxl < size; pxl++) {
      let cover = 0;
      let glyph = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = ((pxl + (sx + 0.5) / ss) / size) * 64;
          const y = ((py + (sy + 0.5) / ss) / size) * 64;
          if (rounded && !inRoundedSquare(x, y, 14)) continue;
          cover++;
          const gx = 32 + (x - 32) / scale;
          const gy = 32 + (y - 32) / scale;
          if (inGlyph(gx, gy)) glyph++;
        }
      }
      const i = (py * size + pxl) * 4;
      const n = ss * ss;
      const g = cover ? glyph / cover : 0;
      for (let c = 0; c < 3; c++) px[i + c] = Math.round(bg[c] * (1 - g) + fg[c] * g);
      px[i + 3] = Math.round((cover / n) * 255);
    }
  }
  return px;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const out = new URL("../public/", import.meta.url);
const icons = [
  ["icon-192.png", 192, { rounded: true, scale: 1 }],
  ["icon-512.png", 512, { rounded: true, scale: 1 }],
  ["icon-maskable-512.png", 512, { rounded: false, scale: 0.8 }],
  ["apple-touch-icon.png", 180, { rounded: false, scale: 0.9 }],
];
for (const [name, size, opts] of icons) writeFileSync(new URL(name, out), png(size, render(size, opts)));
console.log(`wrote ${icons.map((i) => i[0]).join(", ")}`);
