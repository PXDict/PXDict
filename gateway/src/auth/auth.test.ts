import { AuthMethods, ErrorBody, Me } from "@pxdict/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditLog, invites, session as sessionTable } from "../db/schema";
import { harness, testOrigin, testPassword } from "../test/harness";

const errorCode = async (res: Response) => ErrorBody.parse(await res.json()).error.code;

describe("GET /app-api/auth/methods", () => {
  it("lists only what is configured", async () => {
    const h = harness();
    const res = await h.client().request("/app-api/auth/methods");
    expect(res.status).toBe(200);
    expect(AuthMethods.parse(await res.json())).toEqual({
      registration: "closed",
      password: true,
      passkey: true,
      magicLink: false,
      emailOtp: false,
      passwordReset: false,
      emailVerification: false,
      twoFactor: true,
      adminRequiresTwoFactor: false,
      minPasswordLength: 10,
      providers: [],
    });
  });

  it("includes email methods, social and OIDC providers when configured", async () => {
    const h = harness({
      mail: true,
      env: {
        REGISTRATION: "invite",
        AUTH_PASSKEY: "false",
        AUTH_GITHUB_CLIENT_ID: "id",
        AUTH_GITHUB_CLIENT_SECRET: "secret",
        AUTH_GOOGLE_CLIENT_ID: "id",
        AUTH_GOOGLE_CLIENT_SECRET: "secret",
      },
    });
    const m = AuthMethods.parse(await (await h.client().request("/app-api/auth/methods")).json());
    expect(m).toMatchObject({ registration: "invite", passkey: false, magicLink: true, emailOtp: true, passwordReset: true });
    expect(m.providers).toEqual([
      { id: "google", label: "Google", kind: "social" },
      { id: "github", label: "GitHub", kind: "social" },
    ]);
  });
});

describe("password sign-in and sessions", () => {
  it("signs in by email or username and reports the user on /me", async () => {
    const h = harness();
    await h.createUser({ email: "ann@example.com", username: "ann" });

    const byEmail = h.client();
    expect((await byEmail.post("/app-api/auth/sign-in/email", { email: "ann@example.com", password: testPassword })).status).toBe(200);
    expect([...byEmail.cookies.keys()]).toContain("pxdict.session_token");

    const byUsername = h.client();
    expect((await byUsername.post("/app-api/auth/sign-in/username", { username: "ANN", password: testPassword })).status).toBe(200);

    const me = Me.parse(await (await byUsername.request("/app-api/me")).json());
    expect(me.user).toMatchObject({ email: "ann@example.com", username: "ann", role: "user", twoFactorEnabled: false });
    expect(me.session.impersonatedBy).toBeNull();
    expect(new Date(me.session.expiresAt).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
  });

  it("sets HttpOnly, SameSite=Lax session cookies with the pxdict prefix", async () => {
    const h = harness();
    await h.createUser({ email: "ann@example.com" });
    const res = await h.client().post("/app-api/auth/sign-in/email", { email: "ann@example.com", password: testPassword });
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("pxdict.session_token="));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).not.toMatch(/Secure/i); // PUBLIC_URL is http in tests
  });

  it("uses __Secure- cookies when COOKIE_SECURE is on", async () => {
    const h = harness({ env: { COOKIE_SECURE: "true" } });
    await h.createUser({ email: "ann@example.com" });
    const res = await h.client().post("/app-api/auth/sign-in/email", { email: "ann@example.com", password: testPassword });
    const cookie = res.headers.getSetCookie().find((c) => c.includes("pxdict.session_token="));
    expect(cookie).toMatch(/^__Secure-pxdict\.session_token=.*; Secure/i);
  });

  it("gives the same answer for a wrong password and an unknown account", async () => {
    const h = harness();
    await h.createUser({ email: "ann@example.com" });
    const wrong = await h.client().post("/app-api/auth/sign-in/email", { email: "ann@example.com", password: "wrong password!" });
    const unknown = await h.client().post("/app-api/auth/sign-in/email", { email: "bob@example.com", password: "wrong password!" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.json()).toEqual(await unknown.json());
  });

  it("requires a session for the wuDict proxy and /me", async () => {
    const h = harness();
    for (const url of ["/api/search?q=cat", "/api/suggest?q=ca", "/api/dicts", "/res/aaaaaaaaaaaa/img/cat.png", "/app-api/me"]) {
      const res = await h.client().request(url);
      expect(res.status, url).toBe(401);
      expect(await errorCode(res)).toBe("unauthenticated");
    }
    expect(h.upstream("/api/search")).toEqual([]);
    expect((await h.request("/api/search?q=cat")).status).toBe(200);
  });

  it("signs out", async () => {
    const h = harness();
    const { client } = await h.signedIn({ email: "ann@example.com" });
    expect((await client.post("/app-api/auth/sign-out", {})).status).toBe(200);
    expect((await client.request("/app-api/me")).status).toBe(401);
  });

  it("rejects expired sessions", async () => {
    const h = harness();
    const { user, client } = await h.signedIn({ email: "ann@example.com" });
    h.db.update(sessionTable).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(sessionTable.userId, user.id)).run();
    client.cookies.delete("pxdict.session_data"); // the cookie cache would hide it for up to a minute
    expect((await client.request("/app-api/me")).status).toBe(401);
  });

  it("replaces a client-supplied client IP header", async () => {
    const h = harness();
    await h.createUser({ email: "ann@example.com" });
    const c = h.client("203.0.113.7");
    await c.post("/app-api/auth/sign-in/email", { email: "ann@example.com", password: testPassword }, {
      headers: { "X-PXDict-Client-Ip": "10.9.9.9" },
    });
    const row = h.db.select().from(sessionTable).get();
    expect(row?.ipAddress).toBe("203.0.113.7");
  });
});

describe("origin check", () => {
  it("applies to Better Auth's routes", async () => {
    const h = harness();
    await h.createUser({ email: "ann@example.com" });
    const res = await h.client().post(
      "/app-api/auth/sign-in/email",
      { email: "ann@example.com", password: testPassword },
      { headers: { Origin: "https://evil.example" } },
    );
    expect(res.status).toBe(403);
    // Without cookies too (login CSRF), and without any Origin.
    const bare = await h.client().request("/app-api/auth/sign-in/email", {
      method: "POST",
      headers: { Origin: "", "Content-Type": "application/json" },
      body: JSON.stringify({ email: "ann@example.com", password: testPassword }),
    });
    expect(bare.status).toBe(403);
    const sameSite = await h.client().request("/app-api/auth/sign-in/email", {
      method: "POST",
      headers: { Origin: "", "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
      body: JSON.stringify({ email: "ann@example.com", password: testPassword }),
    });
    expect(sameSite.status).toBe(200);
  });

  it("applies to PXDict's state-changing routes", async () => {
    const h = harness();
    const { client } = await h.signedIn({ email: "root@example.com", role: "admin" });
    const create = (headers: Record<string, string>) => client.post("/app-api/admin/invites", {}, { headers });

    const evil = await create({ Origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    expect(await errorCode(evil)).toBe("origin_mismatch");
    expect((await create({ Origin: "null" })).status).toBe(403);

    // No Origin at all: only a same-origin fetch-metadata header is accepted.
    const bare = (headers: Record<string, string>) =>
      client.request("/app-api/admin/invites", { method: "POST", headers: { Origin: "", ...headers }, body: "{}" });
    expect((await bare({ "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await create({ Origin: testOrigin })).status).toBe(201);
    expect(h.db.select().from(invites).all()).toHaveLength(1);
  });
});

describe("admin authorization", () => {
  it("gives regular users 403 on every /app-api/admin path and Better Auth admin endpoint", async () => {
    const h = harness();
    const { client } = await h.signedIn({ email: "ann@example.com" });
    for (const url of ["/app-api/admin/invites", "/app-api/admin/anything", "/app-api/auth/admin/list-users"]) {
      const res = await client.request(url);
      expect(res.status, url).toBe(403);
    }
    expect((await h.client().request("/app-api/admin/invites")).status).toBe(401);
  });

  it("lets admins in", async () => {
    const h = harness();
    const { client } = await h.signedIn({ email: "root@example.com", role: "admin" });
    expect((await client.request("/app-api/admin/invites")).status).toBe(200);
    expect((await client.request("/app-api/admin/anything")).status).toBe(404);
    const users = (await (await client.request("/app-api/auth/admin/list-users")).json()) as { total: number };
    expect(users.total).toBe(1);
  });

  it("requires two-factor authentication for admins when configured", async () => {
    const h = harness({ env: { AUTH_REQUIRE_2FA_ADMIN: "true" } });
    const { client } = await h.signedIn({ email: "root@example.com", role: "admin" });
    const res = await client.request("/app-api/admin/invites");
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("two_factor_required");
    expect((await client.request("/app-api/auth/admin/list-users")).status).toBe(403);
  });
});

describe("registration modes", () => {
  const signUp = (h: ReturnType<typeof harness>, c = h.client(), email = "new@example.com") =>
    c.post("/app-api/auth/sign-up/email", { email, password: testPassword, name: "New" });

  it("closed: nobody can sign up", async () => {
    const h = harness();
    const res = await signUp(h);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe("REGISTRATION_CLOSED");
  });

  it("open: anyone can sign up, as a regular user", async () => {
    const h = harness({ env: { REGISTRATION: "open" } });
    const c = h.client();
    expect((await signUp(h, c)).status).toBe(200);
    expect(Me.parse(await (await c.request("/app-api/me")).json()).user.role).toBe("user");
    // The role cannot be chosen by the client.
    const sneaky = await h.client().post("/app-api/auth/sign-up/email", { email: "x@example.com", password: testPassword, name: "X", role: "admin" });
    expect(sneaky.status).toBe(400);
  });

  it("invite: needs a valid, unused code, which sets the role", async () => {
    const h = harness({ env: { REGISTRATION: "invite" } });
    const { client: admin } = await h.signedIn({ email: "root@example.com", role: "admin" });
    const created = (await (await admin.post("/app-api/admin/invites", { role: "admin", expiresInDays: 1 })).json()) as { code: string; invite: { id: string } };

    expect((await signUp(h)).status).toBe(403); // no code

    const c = h.client();
    const bad = await c.post("/app-api/auth/invite", { code: "NOPE-NOPE" });
    expect(bad.status).toBe(400);
    expect(await errorCode(bad)).toBe("invalid_invite");

    expect((await c.post("/app-api/auth/invite", { code: created.code.toLowerCase() })).status).toBe(204);
    expect((await signUp(h, c)).status).toBe(200);
    const me = Me.parse(await (await c.request("/app-api/me")).json());
    expect(me.user.role).toBe("admin");
    expect(c.cookies.has("pxdict.invite")).toBe(false);

    const row = h.db.select().from(invites).where(eq(invites.id, created.invite.id)).get();
    expect(row?.usedBy).toBe(me.user.id);

    // Single use.
    const again = h.client();
    expect((await again.post("/app-api/auth/invite", { code: created.code })).status).toBe(400);
    again.cookies.set("pxdict.invite", encodeURIComponent(created.code));
    expect((await signUp(h, again, "other@example.com")).status).toBe(403);

    const list = (await (await admin.request("/app-api/admin/invites")).json()) as { invites: { status: string }[] };
    expect(list.invites.map((i) => i.status)).toEqual(["used"]);
  });

  it("invite: refuses expired codes", async () => {
    const h = harness({ env: { REGISTRATION: "invite" } });
    const { client: admin } = await h.signedIn({ email: "root@example.com", role: "admin" });
    const { code } = (await (await admin.post("/app-api/admin/invites", {})).json()) as { code: string };
    h.db.update(invites).set({ expiresAt: new Date(Date.now() - 1000) }).run();
    expect((await h.client().post("/app-api/auth/invite", { code })).status).toBe(400);
  });

  it("admins can always create users", async () => {
    const h = harness();
    const { client: admin } = await h.signedIn({ email: "root@example.com", role: "admin" });
    const res = await admin.post("/app-api/auth/admin/create-user", { email: "ann@example.com", password: testPassword, name: "Ann" });
    expect(res.status).toBe(200);
    const signIn = await h.client().post("/app-api/auth/sign-in/email", { email: "ann@example.com", password: testPassword });
    expect(signIn.status).toBe(200);
  });
});

describe("admin actions", () => {
  it("banning revokes sessions and blocks sign-in; it is audited", async () => {
    const h = harness();
    const { client: admin, user: root } = await h.signedIn({ email: "root@example.com", role: "admin" });
    const { client: ann, user } = await h.signedIn({ email: "ann@example.com" });

    expect((await admin.post("/app-api/auth/admin/ban-user", { userId: user.id, banReason: "spam" })).status).toBe(200);
    ann.cookies.delete("pxdict.session_data");
    expect((await ann.request("/api/search?q=cat")).status).toBe(401);
    const again = await h.client().post("/app-api/auth/sign-in/email", { email: "ann@example.com", password: testPassword });
    expect(again.status).toBe(403);

    const entry = h.db.select().from(auditLog).where(eq(auditLog.action, "user.ban_user")).get();
    expect(entry).toMatchObject({ actorUserId: root.id, targetType: "user", targetId: user.id, detailsJson: { banReason: "spam" } });
  });

  it("a banned user's cached session is refused by the guards", async () => {
    const h = harness();
    const { client: admin } = await h.signedIn({ email: "root@example.com", role: "admin" });
    const { client: ann, user } = await h.signedIn({ email: "ann@example.com" });
    await admin.post("/app-api/auth/admin/ban-user", { userId: user.id });
    // Even while the cookie cache still holds the old session, admin routes read the database.
    expect((await ann.request("/app-api/admin/invites")).status).toBe(401);
  });

  it("the last admin cannot be demoted, banned or removed", async () => {
    const h = harness();
    const { client: admin, user: root } = await h.signedIn({ email: "root@example.com", role: "admin" });
    for (const [path, body] of [
      ["/app-api/auth/admin/set-role", { userId: root.id, role: "user" }],
      ["/app-api/auth/admin/update-user", { userId: root.id, data: { role: "user" } }],
      ["/app-api/auth/admin/remove-user", { userId: root.id }],
    ] as const) {
      const res = await admin.post(path, body);
      expect(res.status, path).toBe(400);
      expect(((await res.json()) as { code?: string }).code).toBe("LAST_ADMIN");
    }

    // With a second admin, demoting the first works.
    const other = await h.createUser({ email: "second@example.com", role: "admin" });
    expect((await admin.post("/app-api/auth/admin/set-role", { userId: root.id, role: "user" })).status).toBe(200);
    expect(other.id).toBeTruthy();
  });

  it("impersonation is audited with the admin as actor", async () => {
    const h = harness();
    const { client: admin, user: root } = await h.signedIn({ email: "root@example.com", role: "admin" });
    const ann = await h.createUser({ email: "ann@example.com" });
    expect((await admin.post("/app-api/auth/admin/impersonate-user", { userId: ann.id })).status).toBe(200);
    const me = Me.parse(await (await admin.request("/app-api/me")).json());
    expect(me.user.id).toBe(ann.id);
    expect(me.session.impersonatedBy).toBe(root.id);
    // While impersonating, admin routes are closed, but ending the impersonation works.
    expect((await admin.request("/app-api/admin/invites")).status).toBe(403);
    expect((await admin.post("/app-api/auth/admin/stop-impersonating", {})).status).toBe(200);
    expect(Me.parse(await (await admin.request("/app-api/me")).json()).user.id).toBe(root.id);

    const actions = h.db.select().from(auditLog).all().map((a) => [a.action, a.actorUserId, a.targetId]);
    expect(actions).toContainEqual(["user.impersonate_user", root.id, ann.id]);
    expect(actions).toContainEqual(["user.stop_impersonating", root.id, null]);
  });

  it("invite management is audited and codes are stored hashed", async () => {
    const h = harness();
    const { client: admin, user: root } = await h.signedIn({ email: "root@example.com", role: "admin" });
    const res = await admin.post("/app-api/admin/invites", { note: "for Bob" });
    expect(res.status).toBe(201);
    const { code, invite } = (await res.json()) as { code: string; invite: { id: string; note: string } };
    expect(invite.note).toBe("for Bob");
    expect(code).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/);
    expect(JSON.stringify(h.db.select().from(invites).all())).not.toContain(code.replace(/-/g, ""));
    expect((await admin.request(`/app-api/admin/invites/${invite.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await admin.request(`/app-api/admin/invites/${invite.id}`, { method: "DELETE" })).status).toBe(404);
    const actions = h.db.select().from(auditLog).all().map((a) => [a.action, a.actorUserId]);
    expect(actions).toEqual([
      ["invite.create", root.id],
      ["invite.delete", root.id],
    ]);
  });
});

describe("rate limiting and failed sign-ins", () => {
  it("limits password sign-in attempts per client", async () => {
    const h = harness({ rateLimit: true });
    await h.createUser({ email: "ann@example.com" });
    const attempt = (ip: string) =>
      h.client(ip).post("/app-api/auth/sign-in/email", { email: "ann@example.com", password: "wrong password!" });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await attempt("198.51.100.1")).status);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
    // Another client is not affected.
    expect((await attempt("198.51.100.2")).status).toBe(401);
  });

  it("records a burst of failed sign-ins once in the audit log", async () => {
    const h = harness();
    await h.createUser({ email: "ann@example.com" });
    for (let i = 0; i < 12; i++) {
      await h.client("192.0.2.9").post("/app-api/auth/sign-in/email", { email: "ann@example.com", password: "wrong password!" });
    }
    const entries = h.db.select().from(auditLog).where(eq(auditLog.action, "auth.sign_in_failures")).all();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ targetType: "ip", targetId: "192.0.2.9", detailsJson: { failures: 10 } });
    expect(JSON.stringify(entries)).not.toContain("wrong password");
  });
});
