import { describe, expect, it } from "vitest";
import { ndjsonTransform } from "./ndjson";

async function run(chunks: string[], map = (v: unknown) => v) {
  const enc = new TextEncoder();
  const invalid: unknown[] = [];
  const src = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  const out = await new Response(src.pipeThrough(ndjsonTransform(map, (e) => invalid.push(e)))).text();
  return { out, invalid };
}

describe("ndjsonTransform", () => {
  it("re-frames lines split across chunks and keeps a last line without newline", async () => {
    const { out } = await run(['{"a":1}\n{"b"', ':2}\n\n', '{"c":"é"}']);
    expect(out).toBe('{"a":1}\n{"b":2}\n{"c":"é"}\n');
  });

  it("drops lines mapped to undefined and invalid JSON without echoing it", async () => {
    const { out, invalid } = await run(['{"keep":1}\n{"drop":1}\nnot json /data/x\n'], (v) =>
      (v as { drop?: number }).drop ? undefined : v,
    );
    expect(out).toBe('{"keep":1}\n');
    expect(invalid).toHaveLength(1);
  });

  it("splits multi-byte characters across chunks correctly", async () => {
    const bytes = new TextEncoder().encode('{"w":"字"}\n');
    const src = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, 8));
        c.enqueue(bytes.slice(8));
        c.close();
      },
    });
    const out = await new Response(src.pipeThrough(ndjsonTransform((v) => v))).text();
    expect(out).toBe('{"w":"字"}\n');
  });
});
