import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminProposal, Me, Proposal } from "../api/app";
import { App } from "../App";
import { me, methods, stubBackend, type FakeBackend } from "../test/backend";

let root: HTMLElement | undefined;
let backend: FakeBackend;

function mount(path: string): HTMLElement {
  history.replaceState(null, "", path);
  const el = document.createElement("div");
  document.body.append(el);
  render(<App />, el);
  root = el;
  return el;
}

const text = () => root?.textContent ?? "";
const shows = (s: string) =>
  vi.waitFor(() => {
    expect(text()).toContain(s);
  });

const proposal = (more: Partial<Proposal> = {}): Proposal => ({
  id: "a".repeat(24),
  title: "Oxford",
  description: "desc",
  sourceUrl: "https://example.com",
  licenseNote: null,
  status: "pending",
  totalBytes: 1500,
  fileCount: 1,
  files: [{ path: "oxford.mdx", bytes: 1500, received: 1500, sha256: "f".repeat(64), kind: "main" }],
  metadata: { format: "mdx", mainFile: "oxford.mdx", title: "Oxford", description: null, version: "2.0", encoding: "UTF-8", entries: 42, languages: null },
  warnings: [{ code: "contains_js", message: "scripts run", path: "x.js" }],
  reviewNote: null,
  reviewedAt: null,
  approvedScope: null,
  dictId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  submittedAt: "2026-01-01T00:00:00.000Z",
  ...more,
});

const limits = { maxUploadBytes: 500e6, chunkBytes: 32 << 20, maxFiles: 50, maxPendingProposals: 3, extensions: [".mdx", ".zip"] };

function withMe(m: Me) {
  backend.on("GET", "/app-api/me", () => Response.json(m));
  backend.on("GET", "/app-api/auth/methods", () => Response.json(methods));
  backend.on("GET", "/api/dicts", () => new Response("", { headers: { "Content-Type": "application/x-ndjson" } }));
}

beforeEach(() => {
  backend = stubBackend();
});
afterEach(() => {
  if (root) render(null, root);
  root?.remove();
  root = undefined;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("proposals", () => {
  it("lists the user's proposals and acknowledges decisions", async () => {
    withMe({ ...me, proposalUpdates: [{ id: "b".repeat(24), title: "Rejected one", status: "rejected" }] });
    backend.on("GET", "/app-api/proposals/limits", () => Response.json(limits));
    backend.on("GET", "/app-api/me/proposals", () =>
      Response.json({ proposals: [proposal(), proposal({ id: "b".repeat(24), title: "Rejected one", status: "rejected", reviewNote: "no license" })] }),
    );
    backend.on("POST", "/app-api/me/proposals/seen", () => new Response(null, { status: 204 }));
    mount("/proposals");
    await shows("waiting for review");
    expect(text()).toContain("Propose a dictionary");
    expect(text()).toContain("Reason: no license");
    expect(text()).not.toContain("was rejected");
    expect(backend.requests.some((r) => r.method === "POST" && r.url.endsWith("/app-api/me/proposals/seen"))).toBe(true);
  });

  it("announces a decision on other pages", async () => {
    withMe({ ...me, proposalUpdates: [{ id: "b".repeat(24), title: "Oxford", status: "approved" }] });
    backend.on("GET", "/app-api/me/dicts", () => Response.json({ dicts: [] }));
    mount("/dictionaries");
    await shows("Your proposal “Oxford” was approved.");
  });
});

describe("admin pages", () => {
  it("are not offered to regular users", async () => {
    withMe(me);
    mount("/admin/proposals");
    await shows("This page does not exist.");
    expect(text()).not.toContain("Admin");
  });

  it("show pending proposals with their checks to admins", async () => {
    withMe({ ...me, user: { ...me.user, role: "admin" } });
    const p: AdminProposal = { ...proposal(), proposer: { id: "u1", name: "Una", email: "una@example.com" }, reviewedBy: null };
    backend.on("GET", "/app-api/admin/proposals", () => Response.json({ proposals: [p] }));
    mount("/admin/proposals");
    await shows("Proposed by Una (una@example.com)");
    const review = [...(root?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Review");
    review?.click();
    await shows("Headwords");
    expect(text()).toContain("42");
    expect(text()).toContain("scripts run");
    const idInput = root?.querySelector<HTMLInputElement>(`#f-dictId-${p.id}`);
    expect(idInput?.value).toBe("oxford");
  });
});
