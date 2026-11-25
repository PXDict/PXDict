import { render } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArticleFrame } from "./ArticleFrame";

let root: HTMLElement;

async function mount(trusted = false, onLookup = vi.fn()) {
  root = document.createElement("div");
  document.body.append(root);
  render(<ArticleFrame body='<b>cat</b>' trusted={trusted} title="cat" onLookup={onLookup} />, root);
  const frame = root.querySelector("iframe");
  if (!frame?.contentWindow) throw new Error("no frame window");
  const win = frame.contentWindow;
  const post = vi.spyOn(win, "postMessage").mockImplementation(() => undefined);
  // Effects (the message listener) run after the next paint; Preact falls back to a ~35 ms timer
  // where requestAnimationFrame never fires (jsdom).
  await new Promise((r) => setTimeout(r, 50));
  const send = (data: unknown, origin = trusted ? location.origin : "null", source: Window | null = win) => {
    dispatchEvent(new MessageEvent("message", { data, origin, source }));
  };
  return { frame, post, send, onLookup };
}

afterEach(() => {
  render(null, root);
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("ArticleFrame", () => {
  it("sends the article once, when the frame is ready", async () => {
    const { post, send } = await mount();
    send({ type: "pxdict:ready" });
    send({ type: "pxdict:ready" });
    expect(post).toHaveBeenCalledTimes(1);
    const [msg, target] = post.mock.calls[0] as [{ type: string; html: string }, string];
    expect(msg.type).toBe("pxdict:render");
    expect(msg.html).toContain("<b>cat</b>");
    expect(target).toBe("*");
  });

  it("follows height and cross-reference messages from its own frame only", async () => {
    const { frame, send, onLookup } = await mount();
    send({ type: "pxdict:height", height: 321 });
    send({ type: "pxdict:height", height: 999 }, "https://evil.example");
    send({ type: "pxdict:height", height: 777 }, "null", window);
    send({ type: "pxdict:link", href: "entry://dog" });
    await new Promise((r) => setTimeout(r, 0));
    expect(frame.style.height).toBe("321px");
    expect(onLookup).toHaveBeenCalledWith("dog");
  });

  it("opens external links in a new tab without an opener", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const { send } = await mount();
    send({ type: "pxdict:link", href: "https://en.wikipedia.org/wiki/Cat" });
    send({ type: "pxdict:link", href: "javascript:alert(1)" });
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith("https://en.wikipedia.org/wiki/Cat", "_blank", "noopener,noreferrer");
  });

  it("expects same-origin messages from a trusted dictionary's frame", async () => {
    const { frame, post, send } = await mount(true);
    expect(frame.getAttribute("sandbox")).toContain("allow-same-origin");
    send({ type: "pxdict:ready" }, "null");
    expect(post).not.toHaveBeenCalled();
    send({ type: "pxdict:ready" });
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "pxdict:render" }), location.origin);
  });
});
