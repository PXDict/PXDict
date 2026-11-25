import { render } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

function mount(): HTMLElement {
  const root = document.createElement("div");
  document.body.append(root);
  render(<App />, root);
  return root;
}

const statusText = (root: HTMLElement) => root.querySelector('[role="status"]')?.textContent;

describe("App", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("shows the gateway version once /healthz answers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          Response.json({ status: "ok", version: "1.2.3", checks: { wudict: "ok", database: "ok" } }),
        ),
      ),
    );
    const root = mount();
    expect(root.querySelector("h1")?.textContent).toBe("PXDict");
    await vi.waitFor(() => {
      expect(statusText(root)).toBe("Server is up (version 1.2.3).");
    });
  });

  it("reports an unreachable server", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("network"))),
    );
    const root = mount();
    await vi.waitFor(() => {
      expect(statusText(root)).toBe("Cannot reach the server.");
    });
  });
});
