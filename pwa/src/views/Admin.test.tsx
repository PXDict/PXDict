import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditPage, Me, StorageExecuteResult, StorageOverview, StoragePlan } from "../api/app";
import { App } from "../App";
import { me, methods, stubBackend, type FakeBackend } from "../test/backend";

let root: HTMLElement | undefined;
let backend: FakeBackend;

const adminMe: Me = { ...me, user: { ...me.user, id: "admin1", name: "Boss", role: "admin" } };

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
const button = (label: string) => {
  const b = [...(root?.querySelectorAll("button") ?? [])].find((x) => x.textContent.includes(label));
  if (!b) throw new Error(`no button ${label}`);
  return b;
};
const bodyOf = async (path: string, method = "POST") => {
  const req = backend.requests.find((r) => r.method === method && new URL(r.url).pathname === path);
  return req ? ((await req.json()) as unknown) : undefined;
};

const overview: StorageOverview = {
  volume: { totalBytes: 10e9, freeBytes: 4e9 },
  areas: [
    { area: "dictionaries", bytes: 5e8 },
    { area: "db", bytes: 2e8 },
    { area: "proposals", bytes: 0 },
    { area: "tmp", bytes: 1000 },
    { area: "gateway", bytes: 5e5 },
  ],
  dictDirWritable: true,
  catalogChecked: true,
  dicts: [
    {
      id: "oxford",
      title: "Oxford",
      format: "mdx",
      available: true,
      sourceBytes: 5e8,
      indexBytes: 2e8,
      sourceDeletedAt: null,
      enabledUsers: 3,
      originalsBlocked: null,
      deleteBlocked: null,
    },
    {
      id: "dsl-one",
      title: "DSL One",
      format: "dsl",
      available: true,
      sourceBytes: 100,
      indexBytes: 50,
      sourceDeletedAt: null,
      enabledUsers: 0,
      originalsBlocked: "format_unsupported",
      deleteBlocked: null,
    },
  ],
  candidates: [
    { kind: "stale_upload", target: "old", bytes: 1000, modifiedAt: "2026-01-01T00:00:00.000Z", suggested: true, blocked: null },
    { kind: "aux_file", target: "oxford/notes.bak", bytes: 10, modifiedAt: "2026-01-01T00:00:00.000Z", suggested: false, blocked: null },
  ],
};

const plan: StoragePlan = {
  planId: "a".repeat(32),
  expiresAt: "2026-01-01T00:10:00.000Z",
  totalBytes: 5e8 + 2e8 + 1000,
  items: [
    {
      kind: "dict",
      target: "oxford",
      label: "Oxford",
      bytes: 7e8,
      paths: [
        { path: "dictionaries/oxford/oxford.mdx", bytes: 5e8 },
        { path: "db/oxford/text.db", bytes: 2e8 },
      ],
      warnings: [{ code: "users_enabled", count: 3 }],
      blocked: null,
    },
    { kind: "stale_upload", target: "old", label: "old", bytes: 1000, paths: [{ path: "tmp/old", bytes: 1000 }], warnings: [], blocked: null },
  ],
};

beforeEach(() => {
  backend = stubBackend();
  backend.on("GET", "/app-api/me", () => Response.json(adminMe));
  backend.on("GET", "/app-api/auth/methods", () => Response.json(methods));
});
afterEach(() => {
  if (root) render(null, root);
  root?.remove();
  root = undefined;
  vi.unstubAllGlobals();
});

describe("admin storage", () => {
  it("previews first and deletes only after confirming the preview", async () => {
    let loads = 0;
    backend.on("GET", "/app-api/admin/storage", () => {
      loads++;
      return Response.json(overview);
    });
    backend.on("POST", "/app-api/admin/storage/plan", () => Response.json(plan));
    const result: StorageExecuteResult = {
      bytesFreed: 7e8,
      items: [
        { kind: "dict", target: "oxford", status: "done", bytesFreed: 7e8, reason: null },
        { kind: "stale_upload", target: "old", status: "skipped", bytesFreed: 0, reason: "changed since the preview" },
      ],
    };
    backend.on("POST", "/app-api/admin/storage/execute", () => Response.json(result));
    mount("/admin/storage");
    await shows("4 GB free of 10 GB");
    expect(text()).toContain("enabled by 3 users");
    expect(text()).toContain("only possible for MDX dictionaries");

    // The DSL dictionary's "delete originals" is disabled; the suggested clean-up starts picked.
    const boxes = [...(root?.querySelectorAll<HTMLInputElement>("input[type=checkbox]") ?? [])];
    expect(boxes.map((b) => [b.disabled, b.checked])).toEqual([
      [false, false],
      [false, false],
      [true, false],
      [false, false],
      [false, true],
      [false, false],
    ]);
    // Pick "delete the dictionary" for Oxford.
    boxes[1]?.click();
    await vi.waitFor(() => {
      expect(button("Preview deletion (2)")).toBeTruthy();
    });
    button("Preview deletion").click();
    await shows("Preview: nothing has been deleted yet");
    expect(text()).toContain("3 users have it enabled.");
    expect(text()).toContain("dictionaries/oxford/oxford.mdx");
    expect(await bodyOf("/app-api/admin/storage/plan")).toEqual({
      items: [
        { kind: "stale_upload", target: "old" },
        { kind: "dict", target: "oxford" },
      ],
    });
    expect(backend.requests.some((r) => new URL(r.url).pathname === "/app-api/admin/storage/execute")).toBe(false);

    button("Delete 2 items").click();
    await shows("Freed 700 MB.");
    expect(text()).toContain("Skipped old: changed since the preview");
    expect(await bodyOf("/app-api/admin/storage/execute")).toEqual({ planId: plan.planId });
    await vi.waitFor(() => {
      expect(loads).toBe(2);
    });
  });

  it("explains a read-only dictionary folder", async () => {
    backend.on("GET", "/app-api/admin/storage", () => Response.json({ ...overview, dictDirWritable: false, candidates: [] }));
    mount("/admin/storage");
    await shows("The dictionary folder is read-only");
    expect(text()).toContain("Nothing to clean up.");
  });
});

describe("admin users and audit log", () => {
  it("lists users and changes a role after confirming", async () => {
    backend.on("GET", "/app-api/auth/admin/list-users", () =>
      Response.json({
        users: [
          { id: "admin1", name: "Boss", email: "boss@example.com", role: "admin", banned: false, emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
          { id: "u2", name: "Reader", email: "reader@example.com", role: "user", banned: true, banReason: "spam", emailVerified: true, createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" },
        ],
        total: 2,
      }),
    );
    backend.on("POST", "/app-api/auth/admin/set-role", () => Response.json({ user: {} }));
    backend.on("GET", "/app-api/admin/invites", () => Response.json({ invites: [] }));
    vi.stubGlobal("confirm", () => true);
    mount("/admin/users");
    await shows("reader@example.com");
    expect(text()).toContain("suspended");
    expect(text()).toContain("spam");
    // No actions on one's own account.
    expect(root?.querySelectorAll("button.btn-danger")).toHaveLength(1);
    button("Make admin").click();
    await shows("Saved.");
    expect(await bodyOf("/app-api/auth/admin/set-role")).toEqual({ userId: "u2", role: "admin" });
  });

  it("creates an invite and shows its code once", async () => {
    backend.on("GET", "/app-api/auth/admin/list-users", () => Response.json({ users: [], total: 0 }));
    backend.on("GET", "/app-api/admin/invites", () => Response.json({ invites: [] }));
    backend.on("POST", "/app-api/admin/invites", () =>
      Response.json(
        {
          invite: { id: "i1", role: "user", note: null, createdBy: "admin1", createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-08T00:00:00.000Z", usedAt: null, usedBy: null, status: "active" },
          code: "SECRET-CODE",
        },
        { status: 201 },
      ),
    );
    mount("/admin/users");
    await shows("Invite codes");
    button("Create invite").click();
    await shows("SECRET-CODE");
    expect(await bodyOf("/app-api/admin/invites")).toEqual({ role: "user", expiresInDays: 7 });
  });

  it("pages through the audit log", async () => {
    const page1: AuditPage = {
      entries: [{ id: 5, actor: { id: "admin1", name: "Boss" }, action: "storage.delete", targetType: "dict", targetId: "oxford", details: null, bytesFreed: 7e8, createdAt: "2026-01-01T00:00:00.000Z" }],
      nextCursor: 5,
    };
    const page2: AuditPage = {
      entries: [{ id: 4, actor: null, action: "system.vacuum", targetType: null, targetId: null, details: null, bytesFreed: 0, createdAt: "2026-01-01T00:00:00.000Z" }],
      nextCursor: null,
    };
    backend.on("GET", "/app-api/admin/audit", (req) => Response.json(new URL(req.url).searchParams.get("cursor") === "5" ? page2 : page1));
    mount("/admin/audit");
    await shows("storage.delete");
    expect(text()).toContain("700 MB");
    button("Show more").click();
    await shows("system.vacuum");
    expect(text()).toContain("storage.delete");
    expect(() => button("Show more")).toThrow();
  });

  it("is not offered to regular users", async () => {
    backend.on("GET", "/app-api/me", () => Response.json(me));
    mount("/admin/storage");
    await shows("This page does not exist.");
  });
});
