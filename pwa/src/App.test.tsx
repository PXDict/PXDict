import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { me, methods, ndjson, stubBackend, unauthorized, type FakeBackend } from "./test/backend";

let root: HTMLElement;
let backend: FakeBackend;

function mount(path = "/"): void {
  history.replaceState(null, "", path);
  root = document.createElement("div");
  document.body.append(root);
  render(<App />, root);
}

const text = () => root.textContent;

/** Lets Preact re-render after state changes (event handlers close over the last render). */
const tick = () => new Promise((r) => setTimeout(r, 0));

async function submit(): Promise<void> {
  await tick();
  root.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

function type(name: string, value: string): void {
  const input = root.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  if (!input) throw new Error(`no input ${name}`);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  backend = stubBackend();
  backend.on("GET", "/app-api/auth/methods", () => Response.json(methods));
  backend.on("GET", "/api/dicts", () =>
    ndjson([{ t: "begin" }, { t: "dict", dict: { id: "d1", name: "Dict One", format: "mdx", entries: 1, caps: {}, trustedRender: false } }, { t: "end" }]),
  );
});

afterEach(() => {
  render(null, root);
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  localStorage.clear();
});

describe("App", () => {
  it("sends a signed-out visitor to the login screen, keeping the pending lookup", async () => {
    backend.on("GET", "/app-api/me", unauthorized);
    mount("/?q=cat");
    await vi.waitFor(() => {
      expect(root.querySelector("h2")?.textContent).toBe("Sign in");
    });
    expect(location.pathname + location.search).toBe("/login?next=%2F%3Fq%3Dcat");
    // Only the methods the server enables are offered.
    expect(text()).not.toContain("passkey");
    expect(text()).not.toContain("Create an account");
    expect(text()).toContain("Ask an administrator");
  });

  it("signs in with a password and returns to the pending lookup", async () => {
    let signedIn = false;
    backend.on("GET", "/app-api/me", () => (signedIn ? Response.json(me) : unauthorized()));
    backend.on("POST", "/app-api/auth/sign-in/username", async (req) => {
      expect(await req.json()).toMatchObject({ username: "reader", password: "correct horse" });
      signedIn = true;
      return Response.json({ token: "t", user: me.user });
    });
    backend.on("GET", "/api/search", () => ndjson([{ t: "begin", slots: [] }, { t: "end" }]));
    mount("/login?next=%2F%3Fq%3Dcat");
    await vi.waitFor(() => {
      expect(root.querySelector('input[name="username"]')).not.toBeNull();
    });
    type("username", "reader");
    type("password", "correct horse");
    await submit();
    await vi.waitFor(() => {
      expect(location.pathname + location.search).toBe("/?q=cat");
    });
    await vi.waitFor(() => {
      expect(text()).toContain("No results for “cat”.");
    });
    expect(root.querySelector(".topbar")?.textContent).toContain("Reader");
  });

  it("shows the two-factor step when the server asks for it", async () => {
    backend.on("GET", "/app-api/me", unauthorized);
    backend.on("POST", "/app-api/auth/sign-in/email", () => Response.json({ twoFactorRedirect: true }));
    mount("/login");
    await vi.waitFor(() => {
      expect(root.querySelector('input[name="username"]')).not.toBeNull();
    });
    type("username", "reader@example.com");
    type("password", "correct horse");
    await submit();
    await vi.waitFor(() => {
      expect(root.querySelector("h2")?.textContent).toBe("Two-factor authentication");
    });
    expect(root.querySelector('input[name="otp"]')).not.toBeNull();
  });

  it("renders results per dictionary in sandboxed frames", async () => {
    backend.on("GET", "/app-api/me", () => Response.json(me));
    backend.on("GET", "/api/search", (req) => {
      expect(new URL(req.url).searchParams.get("q")).toBe("cat");
      return ndjson([
        { t: "begin", slots: [{ dict: "d1", name: "d1" }, { dict: "d2", name: "d2" }] },
        { t: "hit", i: 0, dict: "d1", name: "Dict One", results: [{ Headword: "cat", Body: '<img src="/r/t.s/d1/cat.png">' }] },
        { t: "hit", i: 1, dict: "d2", name: "Dict Two" },
        { t: "end" },
      ]);
    });
    mount("/?q=cat");
    await vi.waitFor(() => {
      expect(root.querySelector(".dict summary")?.textContent).toContain("Dict One");
    });
    const frame = root.querySelector("iframe");
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame?.getAttribute("src")).toMatch(/^\/frame\.html\?v=/);
    expect(text()).toContain("Not found in: Dict Two");
  });

  it("starts offline with the last known user", async () => {
    localStorage.setItem("pxdict.user", JSON.stringify({ id: "user1", name: "Reader", role: "user" }));
    backend.on("GET", "/app-api/me", () => {
      throw new TypeError("offline");
    });
    mount("/");
    await vi.waitFor(() => {
      expect(root.querySelector(".topbar")?.textContent).toContain("Offline");
    });
  });

  it("goes back to login when a later request answers 401", async () => {
    backend.on("GET", "/app-api/me", () => Response.json(me));
    backend.on("GET", "/api/search", unauthorized);
    mount("/?q=cat");
    await vi.waitFor(() => {
      expect(location.pathname).toBe("/login");
    });
    expect(location.search).toBe("?next=%2F%3Fq%3Dcat");
  });
});
