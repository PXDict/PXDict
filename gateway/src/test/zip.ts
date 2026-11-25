// A minimal zip writer for tests (stored or deflated entries, Unix modes), so archive checks can be
// tested with hand-made and hostile archives without another dependency.
import zlib from "node:zlib";

export interface ZipEntrySpec {
  name: string;
  data?: Buffer | string;
  /** Deflate the data (default: store). */
  deflate?: boolean;
  /** Unix mode in the external attributes, e.g. 0o120777 for a symlink. */
  mode?: number;
  /** Mark the entry as encrypted (general purpose bit 0). */
  encrypted?: boolean;
  /** Lie about the uncompressed size in the headers. */
  declaredSize?: number;
}

export function makeZip(entries: ZipEntrySpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? "");
    const body = e.deflate ? zlib.deflateRawSync(raw) : raw;
    const name = Buffer.from(e.name, "utf8");
    const crc = zlib.crc32(raw);
    const size = e.declaredSize ?? raw.length;
    const flags = 0x0800 | (e.encrypted ? 1 : 0);
    const method = e.deflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((e.mode ?? (e.name.endsWith("/") ? 0o040755 : 0o100644)) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** A minimal MDX: the UTF-16LE header, its checksum, and a v2 keyword-section header with `entries`. */
export function makeMdx(attrs: Record<string, string>, entries = 3): Buffer {
  const xml = `<Dictionary ${Object.entries(attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ")}/>\r\n\0`;
  const header = Buffer.from(xml, "utf16le");
  const size = Buffer.alloc(4);
  size.writeUInt32BE(header.length);
  const keys = Buffer.alloc(40 + 4);
  keys.writeBigUInt64BE(1n, 0);
  keys.writeBigUInt64BE(BigInt(entries), 8);
  return Buffer.concat([size, header, Buffer.alloc(4), keys, Buffer.from("rest of the file")]);
}
