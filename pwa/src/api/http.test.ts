import { describe, expect, it } from "vitest";
import { readNdjson, toApiError } from "./http";

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

describe("readNdjson", () => {
  it("splits lines across chunk boundaries", async () => {
    const lines = await collect(readNdjson(streamOf('{"a":1}\n{"b"', ':2}\n\n{"c":3}')));
    expect(lines).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it("handles an empty body", async () => {
    expect(await collect(readNdjson(streamOf()))).toEqual([]);
  });
});

describe("toApiError", () => {
  it("reads the gateway error shape", async () => {
    const res = new Response(JSON.stringify({ error: { code: "not_found", message: "nope" } }), {
      status: 404,
    });
    const err = await toApiError(res);
    expect(err).toMatchObject({ status: 404, code: "not_found", message: "nope" });
  });

  it("falls back for non-JSON bodies", async () => {
    const err = await toApiError(new Response("oops", { status: 502 }));
    expect(err).toMatchObject({ status: 502, code: "http_502" });
  });
});
