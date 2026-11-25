import { describe, expect, it } from "vitest";
import { readSse } from "./publisher";
import { parseInfoUuid } from "./registry";

const stream = (parts: string[]) =>
  new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (const p of parts) ctrl.enqueue(new TextEncoder().encode(p));
      ctrl.close();
    },
  });

describe("readSse", () => {
  it("splits events across chunk boundaries, joins data lines and skips comments", async () => {
    const events = [];
    for await (const ev of readSse(stream(["event: progress\ndata: {\"done\":1,", "\"total\":2}\n\n: keep-alive\n\nevent: done\r\ndata: a\r\ndata: b\r\n\r\n", "data: tail"]))) {
      events.push(ev);
    }
    expect(events).toEqual([
      { event: "progress", data: '{"done":1,"total":2}' },
      { event: "done", data: "a\nb" },
      { event: "message", data: "tail" },
    ]);
  });
});

describe("parseInfoUuid", () => {
  it.each([
    ["name = PXTest\nuuid = 1b4e28ba-2fa1-11d2-883f-0016d3cca427\nmedia = packed\n", "1b4e28ba-2fa1-11d2-883f-0016d3cca427"],
    ["uuid: abcdef0123456789", "abcdef0123456789"],
    ["media = not packed\n", undefined],
    ["uuid = ../../etc\n", undefined],
  ])("%j → %j", (text, uuid) => {
    expect(parseInfoUuid(text)).toBe(uuid);
  });
});
