// Happy paths of the sign-in methods other than plain passwords: two-factor, passkeys (options only; a
// full WebAuthn ceremony needs a browser), email links and codes, password reset by email.
import { createHmac } from "node:crypto";
import { Me } from "@pxdict/shared";
import { describe, expect, it } from "vitest";
import { harness, testPassword } from "../test/harness";

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) for a base32 secret. */
function totp(base32: string, now = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of base32.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)?.map((b) => parseInt(b, 2)) ?? []);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const mac = createHmac("sha1", key).update(counter).digest();
  const offset = (mac.at(-1) ?? 0) & 0xf;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, "0");
}

describe("two-factor authentication", () => {
  it("enables TOTP, then asks for a code at sign-in", async () => {
    const h = harness();
    const { client } = await h.signedIn({ email: "ann@example.com" });

    const enable = await client.post("/app-api/auth/two-factor/enable", { password: testPassword });
    expect(enable.status).toBe(200);
    const { totpURI, backupCodes } = (await enable.json()) as { totpURI: string; backupCodes: string[] };
    expect(backupCodes.length).toBeGreaterThan(0);
    const secret = new URL(totpURI).searchParams.get("secret") ?? "";
    expect((await client.post("/app-api/auth/two-factor/verify-totp", { code: totp(secret) })).status).toBe(200);
    expect(Me.parse(await (await client.request("/app-api/me")).json()).user.twoFactorEnabled).toBe(true);

    // A new sign-in stops at the second factor.
    const c = h.client();
    const first = await c.post("/app-api/auth/sign-in/email", { email: "ann@example.com", password: testPassword });
    expect(((await first.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);
    expect((await c.request("/app-api/me")).status).toBe(401);
    expect((await c.post("/app-api/auth/two-factor/verify-totp", { code: "000000" })).status).toBe(401);
    expect((await c.post("/app-api/auth/two-factor/verify-totp", { code: totp(secret) })).status).toBe(200);
    expect((await c.request("/app-api/me")).status).toBe(200);

    // A backup code works once.
    const d = h.client();
    await d.post("/app-api/auth/sign-in/email", { email: "ann@example.com", password: testPassword });
    expect((await d.post("/app-api/auth/two-factor/verify-backup-code", { code: backupCodes[0] })).status).toBe(200);
  });

  it("lets an admin with two-factor in when it is required", async () => {
    const h = harness({ env: { AUTH_REQUIRE_2FA_ADMIN: "1" } });
    const { client } = await h.signedIn({ email: "root@example.com", role: "admin" });
    const { totpURI } = (await (await client.post("/app-api/auth/two-factor/enable", { password: testPassword })).json()) as { totpURI: string };
    await client.post("/app-api/auth/two-factor/verify-totp", { code: totp(new URL(totpURI).searchParams.get("secret") ?? "") });
    expect((await client.request("/app-api/admin/invites")).status).toBe(200);
  });
});

describe("passkeys", () => {
  it("offers registration to signed-in users with the PUBLIC_URL host as relying party", async () => {
    const h = harness();
    expect((await h.client().request("/app-api/auth/passkey/generate-register-options")).status).toBe(401);
    const { client } = await h.signedIn({ email: "ann@example.com" });
    const res = await client.request("/app-api/auth/passkey/generate-register-options");
    expect(res.status).toBe(200);
    const options = (await res.json()) as { rp: { id: string; name: string }; challenge: string };
    expect(options.rp).toEqual({ id: "localhost", name: "PXDict" });
    expect(options.challenge.length).toBeGreaterThan(16);
  });

  it("offers passwordless sign-in options to anyone", async () => {
    const h = harness();
    const res = await h.client().request("/app-api/auth/passkey/generate-authenticate-options");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { rpId: string }).rpId).toBe("localhost");
  });

  it("is absent when AUTH_PASSKEY is off", async () => {
    const h = harness({ env: { AUTH_PASSKEY: "false" } });
    expect((await h.client().request("/app-api/auth/passkey/generate-authenticate-options")).status).toBe(404);
  });
});

/** The first URL in a text email. */
const linkIn = (text: string | undefined) => /https?:\/\/\S+/.exec(text ?? "")?.[0] ?? "";
const pathOf = (url: string) => {
  const u = new URL(url);
  return u.pathname + u.search;
};

describe("email-based methods", () => {
  it("are disabled without SMTP", async () => {
    const h = harness();
    await h.createUser({ email: "ann@example.com" });
    expect((await h.client().post("/app-api/auth/sign-in/magic-link", { email: "ann@example.com" })).status).toBe(404);
    expect((await h.client().post("/app-api/auth/email-otp/send-verification-otp", { email: "ann@example.com", type: "sign-in" })).status).toBe(404);
    expect((await h.client().post("/app-api/auth/request-password-reset", { email: "ann@example.com", redirectTo: "/reset" })).status).toBe(400);
  });

  it("magic link sign-in", async () => {
    const h = harness({ mail: true });
    await h.createUser({ email: "ann@example.com" });
    const c = h.client();
    expect((await c.post("/app-api/auth/sign-in/magic-link", { email: "ann@example.com", callbackURL: "/" })).status).toBe(200);
    const link = linkIn(h.mailer?.last("ann@example.com")?.text);
    expect(link.startsWith("http://localhost:8080/app-api/auth/magic-link/verify?")).toBe(true);
    const verify = await c.request(pathOf(link));
    expect(verify.status).toBe(302);
    expect(Me.parse(await (await c.request("/app-api/me")).json()).user.email).toBe("ann@example.com");
  });

  it("email one-time code sign-in", async () => {
    const h = harness({ mail: true });
    await h.createUser({ email: "ann@example.com" });
    const c = h.client();
    expect((await c.post("/app-api/auth/email-otp/send-verification-otp", { email: "ann@example.com", type: "sign-in" })).status).toBe(200);
    const otp = /\b(\d{6})\b/.exec(h.mailer?.last("ann@example.com")?.text ?? "")?.[1] ?? "";
    expect(otp).toMatch(/^\d{6}$/);
    expect((await c.post("/app-api/auth/sign-in/email-otp", { email: "ann@example.com", otp })).status).toBe(200);
    expect((await c.request("/app-api/me")).status).toBe(200);
  });

  it("does not create accounts by email when registration is closed", async () => {
    const h = harness({ mail: true });
    const c = h.client();
    await c.post("/app-api/auth/email-otp/send-verification-otp", { email: "stranger@example.com", type: "sign-in" });
    const otp = /\b(\d{6})\b/.exec(h.mailer?.last("stranger@example.com")?.text ?? "")?.[1];
    if (otp) {
      const res = await c.post("/app-api/auth/sign-in/email-otp", { email: "stranger@example.com", otp });
      expect(res.status).toBe(403);
    }
    expect((await c.request("/app-api/me")).status).toBe(401);
  });

  it("password reset by email signs out other sessions", async () => {
    const h = harness({ mail: true });
    const { client: old } = await h.signedIn({ email: "ann@example.com" });
    const c = h.client();
    expect((await c.post("/app-api/auth/request-password-reset", { email: "ann@example.com", redirectTo: "/reset" })).status).toBe(200);
    const link = linkIn(h.mailer?.last("ann@example.com")?.text);
    const res = await c.request(pathOf(link));
    expect(res.status).toBe(302);
    const token = new URL(res.headers.get("location") ?? "", "http://localhost:8080").searchParams.get("token") ?? "";
    expect((await c.post("/app-api/auth/reset-password", { token, newPassword: "a brand new passphrase" })).status).toBe(200);

    old.cookies.delete("pxdict.session_data");
    expect((await old.request("/app-api/me")).status).toBe(401);
    const signIn = await h.client().post("/app-api/auth/sign-in/email", { email: "ann@example.com", password: "a brand new passphrase" });
    expect(signIn.status).toBe(200);
  });

  it("sends a verification email on sign-up", async () => {
    const h = harness({ mail: true, env: { REGISTRATION: "open" } });
    await h.client().post("/app-api/auth/sign-up/email", { email: "new@example.com", password: testPassword, name: "New" });
    const link = linkIn(h.mailer?.last("new@example.com")?.text);
    expect(link).toContain("/app-api/auth/verify-email?token=");
    const c = h.client();
    expect((await c.request(pathOf(link))).status).toBe(302);
    expect(Me.parse(await (await c.request("/app-api/me")).json()).user.emailVerified).toBe(true);
  });
});

describe("passwords", () => {
  it("enforces the minimum length", async () => {
    const h = harness({ env: { REGISTRATION: "open" } });
    const res = await h.client().post("/app-api/auth/sign-up/email", { email: "new@example.com", password: "short", name: "New" });
    expect(res.status).toBe(400);
  });

  it("changing the password works and can sign out other sessions", async () => {
    const h = harness();
    const { client } = await h.signedIn({ email: "ann@example.com" });
    const res = await client.post("/app-api/auth/change-password", {
      currentPassword: testPassword,
      newPassword: "another long passphrase",
      revokeOtherSessions: true,
    });
    expect(res.status).toBe(200);
    expect((await h.client().post("/app-api/auth/sign-in/email", { email: "ann@example.com", password: "another long passphrase" })).status).toBe(200);
  });
});
