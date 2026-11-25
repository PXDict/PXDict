// Social and OIDC sign-in against mocked providers: a local OpenID Connect server (discovery, token,
// userinfo, JWKS; RS256 ID tokens) and GitHub's API through a stubbed fetch. Covers the registration
// policy for OAuth sign-ups and the account-linking rules.
import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Me } from "@pxdict/shared";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { account, user as userTable } from "../db/schema";
import { harness, type TestClient } from "../test/harness";

interface Profile {
  sub: string;
  email: string;
  email_verified: boolean;
  name: string;
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString("base64url");

class MockOidcProvider {
  readonly #keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  readonly #kid = randomUUID();
  readonly #codes = new Map<string, { profile: Profile; nonce: string | null; clientId: string }>();
  readonly #tokens = new Map<string, Profile>();
  #server: http.Server | undefined;
  issuer = "";

  async start(): Promise<void> {
    this.#server = http.createServer((req, res) => {
      void this.#handle(req, res);
    });
    await new Promise<void>((resolve) => {
      this.#server?.listen(0, "127.0.0.1", resolve);
    });
    this.issuer = `http://127.0.0.1:${String((this.#server.address() as AddressInfo).port)}`;
  }

  async stop(): Promise<void> {
    await new Promise((resolve) => {
      this.#server?.close(resolve);
    });
  }

  /** What the provider does when the browser reaches its authorization URL: approve as `profile`. */
  approve(authorizationUrl: string, profile: Profile): { code: string; state: string } {
    const u = new URL(authorizationUrl);
    expect(u.origin + u.pathname).toBe(`${this.issuer}/authorize`);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    const code = randomUUID();
    this.#codes.set(code, { profile, nonce: u.searchParams.get("nonce"), clientId: u.searchParams.get("client_id") ?? "" });
    return { code, state: u.searchParams.get("state") ?? "" };
  }

  #idToken(profile: Profile, nonce: string | null, clientId: string): string {
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: this.#kid }));
    const payload = b64url(
      JSON.stringify({ iss: this.issuer, aud: clientId, iat: now, exp: now + 300, ...(nonce ? { nonce } : {}), ...profile }),
    );
    const sig = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(this.#keys.privateKey);
    return `${header}.${payload}.${b64url(sig)}`;
  }

  async #handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.issuer);
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    let body = "";
    for await (const chunk of req) body += String(chunk);

    switch (url.pathname) {
      case "/.well-known/openid-configuration":
        json(200, {
          issuer: this.issuer,
          authorization_endpoint: `${this.issuer}/authorize`,
          token_endpoint: `${this.issuer}/token`,
          userinfo_endpoint: `${this.issuer}/userinfo`,
          jwks_uri: `${this.issuer}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
        });
        break;
      case "/jwks":
        json(200, { keys: [{ ...this.#keys.publicKey.export({ format: "jwk" }), kid: this.#kid, alg: "RS256", use: "sig" }] });
        break;
      case "/token": {
        const code = new URLSearchParams(body).get("code") ?? "";
        const grant = this.#codes.get(code);
        if (!grant) {
          json(400, { error: "invalid_grant" });
          break;
        }
        this.#codes.delete(code);
        const accessToken = randomUUID();
        this.#tokens.set(accessToken, grant.profile);
        json(200, {
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: 3600,
          id_token: this.#idToken(grant.profile, grant.nonce, grant.clientId),
        });
        break;
      }
      case "/userinfo": {
        const profile = this.#tokens.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
        if (profile) json(200, profile);
        else json(401, { error: "invalid_token" });
        break;
      }
      default:
        json(404, { error: "not_found" });
    }
  }
}

const provider = new MockOidcProvider();
beforeAll(() => provider.start());
afterAll(() => provider.stop());

const oidcEnv = () => ({
  AUTH_OIDC_TEST_ISSUER: provider.issuer,
  AUTH_OIDC_TEST_CLIENT_ID: "pxdict-test",
  AUTH_OIDC_TEST_CLIENT_SECRET: "test-client-secret",
  AUTH_OIDC_TEST_LABEL: "Test SSO",
});

const profile = (over: Partial<Profile> = {}): Profile => ({
  sub: randomUUID(),
  email: "oidc@example.com",
  email_verified: true,
  name: "Oidc User",
  ...over,
});

/** Runs the whole browser flow; returns the callback's response (a redirect). */
async function oidcSignIn(c: TestClient, p: Profile, path = "/app-api/auth/sign-in/social"): Promise<Response> {
  const start = await c.post(path, { provider: "test", callbackURL: "/", errorCallbackURL: "/login" });
  const startBody = await start.text();
  expect(start.status, startBody).toBe(200);
  const { url } = JSON.parse(startBody) as { url: string };
  const { code, state } = provider.approve(url, p);
  return c.request(`/app-api/auth/callback/test?code=${code}&state=${encodeURIComponent(state)}`);
}

const location = (res: Response) => new URL(res.headers.get("location") ?? "", "http://localhost:8080");

describe("generic OIDC", () => {
  it("is listed on the login screen", async () => {
    const h = harness({ env: oidcEnv() });
    const methods = (await (await h.client().request("/app-api/auth/methods")).json()) as { providers: unknown[] };
    expect(methods.providers).toEqual([{ id: "test", label: "Test SSO", kind: "oidc" }]);
  });

  it("refuses to create accounts when registration is closed", async () => {
    const h = harness({ env: oidcEnv() });
    const c = h.client();
    const res = await oidcSignIn(c, profile());
    expect(res.status).toBe(302);
    expect(location(res).pathname).toBe("/login");
    expect(location(res).searchParams.get("error")).toBeTruthy();
    expect((await c.request("/app-api/me")).status).toBe(401);
    expect(h.db.select().from(userTable).all()).toEqual([]);
  });

  it("creates an account when registration is open", async () => {
    const h = harness({ env: { ...oidcEnv(), REGISTRATION: "open" } });
    const c = h.client();
    const res = await oidcSignIn(c, profile());
    expect(res.status).toBe(302);
    expect(location(res).pathname).toBe("/");
    const me = Me.parse(await (await c.request("/app-api/me")).json());
    expect(me.user).toMatchObject({ email: "oidc@example.com", emailVerified: true, role: "user" });
    // OAuth tokens are stored encrypted.
    const row = h.db.select().from(account).where(eq(account.providerId, "test")).get();
    expect(row?.accessToken).toBeTruthy();
    expect(row?.accessToken).not.toMatch(/^[0-9a-f-]{36}$/);
  });

  it("uses an invite code from the invite cookie", async () => {
    const h = harness({ env: { ...oidcEnv(), REGISTRATION: "invite" } });
    const { client: admin } = await h.signedIn({ email: "root@example.com", role: "admin" });
    const { code } = (await (await admin.post("/app-api/admin/invites", {})).json()) as { code: string };
    const c = h.client();
    expect((await c.post("/app-api/auth/invite", { code })).status).toBe(204);
    expect(location(await oidcSignIn(c, profile())).pathname).toBe("/");
    expect((await c.request("/app-api/me")).status).toBe(200);
  });

  it("links to an existing account only when both sides have a verified email", async () => {
    const h = harness({ env: oidcEnv() });
    const verified = await h.createUser({ email: "ann@example.com", emailVerified: true });
    await h.createUser({ email: "bob@example.com", emailVerified: false });

    const ann = h.client();
    expect(location(await oidcSignIn(ann, profile({ email: "ann@example.com" }))).pathname).toBe("/");
    expect(Me.parse(await (await ann.request("/app-api/me")).json()).user.id).toBe(verified.id);

    // The provider does not vouch for the email.
    const unvouched = await oidcSignIn(h.client(), profile({ email: "ann@example.com", email_verified: false }));
    expect(location(unvouched).pathname).toBe("/login");

    // The local account's email was never verified.
    const bob = await oidcSignIn(h.client(), profile({ email: "bob@example.com" }));
    expect(location(bob).pathname).toBe("/login");
    expect(h.db.select().from(account).where(eq(account.providerId, "test")).all()).toHaveLength(1);
  });

  it("never removes the last sign-in method", async () => {
    const h = harness({ env: { ...oidcEnv(), REGISTRATION: "open" } });
    const c = h.client();
    await oidcSignIn(c, profile());
    const linked = h.db.select().from(account).where(eq(account.providerId, "test")).get();
    const res = await c.post("/app-api/auth/unlink-account", { accountId: linked?.id });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe("FAILED_TO_UNLINK_LAST_ACCOUNT");
  });

  it("can be linked from settings while signed in", async () => {
    const h = harness({ env: oidcEnv() });
    const { client, user } = await h.signedIn({ email: "ann@example.com" });
    const res = await oidcSignIn(client, profile({ email: "ann@example.com" }), "/app-api/auth/link-social");
    expect(res.status).toBe(302);
    const accounts = h.db.select().from(account).where(eq(account.userId, user.id)).all();
    expect(accounts.map((a) => a.providerId).sort()).toEqual(["credential", "test"]);
    // Now either method can be unlinked, one at a time.
    const oidc = accounts.find((a) => a.providerId === "test");
    const unlink = await client.post("/app-api/auth/unlink-account", { accountId: oidc?.id });
    expect(unlink.status, await unlink.text()).toBe(200);
  });
});

describe("social providers (GitHub, mocked)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("signs in with GitHub", async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
      if (url.href === "https://github.com/login/oauth/access_token") {
        return json({ access_token: "gho_test", token_type: "bearer", scope: "read:user,user:email" });
      }
      if (url.href === "https://api.github.com/user") {
        return json({ id: 4242, login: "octo", name: "Octo Cat", email: null, avatar_url: "https://avatars.example/octo.png" });
      }
      if (url.href === "https://api.github.com/user/emails") {
        return json([{ email: "octo@example.com", primary: true, verified: true, visibility: "public" }]);
      }
      return realFetch(input, init);
    });

    const h = harness({ env: { REGISTRATION: "open", AUTH_GITHUB_CLIENT_ID: "gh-id", AUTH_GITHUB_CLIENT_SECRET: "gh-secret" } });
    const c = h.client();
    const start = await c.post("/app-api/auth/sign-in/social", { provider: "github", callbackURL: "/" });
    expect(start.status).toBe(200);
    const auth = new URL(((await start.json()) as { url: string }).url);
    expect(auth.origin).toBe("https://github.com");
    expect(auth.searchParams.get("redirect_uri")).toBe("http://localhost:8080/app-api/auth/callback/github");

    const state = auth.searchParams.get("state") ?? "";
    const res = await c.request(`/app-api/auth/callback/github?code=gh-code&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(302);
    expect(location(res).pathname, location(res).href).toBe("/");
    const me = Me.parse(await (await c.request("/app-api/me")).json());
    expect(me.user).toMatchObject({ email: "octo@example.com", emailVerified: true });
  });

  it("rejects a callback with a forged state", async () => {
    const h = harness({ env: { REGISTRATION: "open", AUTH_GITHUB_CLIENT_ID: "gh-id", AUTH_GITHUB_CLIENT_SECRET: "gh-secret" } });
    const res = await h.client().request("/app-api/auth/callback/github?code=x&state=forged");
    expect(res.status).toBe(302);
    expect(location(res).pathname).toBe("/login");
    expect(h.db.select().from(userTable).all()).toEqual([]);
  });
});
