import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { databaseFile, openDatabase } from "../db/client";
import { auditLog, user as userTable } from "../db/schema";
import { createLogger } from "../log";
import { harness, migrationsDir, testPassword } from "../test/harness";
import { bootstrapAdmin, placeholderAdminEmail, resetPasswordCli } from "./bootstrap";

const signIn = (h: ReturnType<typeof harness>, body: Record<string, string>) =>
  h.client().post(`/app-api/auth/sign-in/${"username" in body ? "username" : "email"}`, body);

describe("bootstrapAdmin", () => {
  it("creates the admin from ADMIN_EMAIL / ADMIN_USERNAME / ADMIN_PASSWORD, once", async () => {
    const h = harness({ env: { ADMIN_EMAIL: "root@example.com", ADMIN_USERNAME: "root", ADMIN_PASSWORD: "a long admin password" } });
    const first = await bootstrapAdmin(h.auth, h.db, h.config, createLogger("error", () => undefined));
    expect(first.kind).toBe("created");
    expect((await bootstrapAdmin(h.auth, h.db, h.config, createLogger("error", () => undefined))).kind).toBe("exists");

    expect((await signIn(h, { username: "root", password: "a long admin password" })).status).toBe(200);
    const row = h.db.select().from(userTable).get();
    expect(row).toMatchObject({ email: "root@example.com", role: "admin", emailVerified: true });
    expect(h.db.select().from(auditLog).where(eq(auditLog.action, "user.bootstrap_admin")).all()).toHaveLength(1);
  });

  it("without settings, creates 'admin' with a one-time password printed to the log", async () => {
    const h = harness();
    const lines: string[] = [];
    const result = await bootstrapAdmin(h.auth, h.db, h.config, createLogger("info", (l) => lines.push(l)));
    if (result.kind !== "created" || !result.generatedPassword) throw new Error(`unexpected ${result.kind}`);
    expect(result.generatedPassword).toMatch(/^[a-zA-Z0-9]{20}$/);
    const logged = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.oneTimePassword);
    expect(logged).toMatchObject({ level: "warn", username: "admin", email: placeholderAdminEmail, oneTimePassword: result.generatedPassword });
    expect((await signIn(h, { username: "admin", password: result.generatedPassword })).status).toBe(200);
  });

  it("promotes an existing ADMIN_EMAIL account when no admin exists", async () => {
    const h = harness({ env: { ADMIN_EMAIL: "ann@example.com" } });
    const ann = await h.createUser({ email: "ann@example.com" });
    const result = await bootstrapAdmin(h.auth, h.db, h.config, createLogger("error", () => undefined));
    expect(result).toEqual({ kind: "promoted", userId: ann.id });
    expect(h.db.select().from(userTable).where(eq(userTable.id, ann.id)).get()?.role).toBe("admin");
    // The password was not touched.
    expect((await signIn(h, { email: "ann@example.com", password: testPassword })).status).toBe(200);
  });
});

describe("resetPasswordCli", () => {
  it("sets a new password by email or username and signs the user out", async () => {
    const h = harness();
    const { client } = await h.signedIn({ email: "ann@example.com", username: "ann" });
    expect(await resetPasswordCli(h.auth, h.db, "nobody")).toBeUndefined();

    const result = await resetPasswordCli(h.auth, h.db, " ANN ");
    if (!result) throw new Error("no result");
    client.cookies.delete("pxdict.session_data");
    expect((await client.request("/app-api/me")).status).toBe(401);
    expect((await signIn(h, { email: "ann@example.com", password: testPassword })).status).toBe(401);
    expect((await signIn(h, { email: "ann@example.com", password: result.password })).status).toBe(200);

    // A user without a password (e.g. OIDC only) gets one.
    await h.createUser({ email: "sso@example.com", password: "" });
    const sso = await resetPasswordCli(h.auth, h.db, "sso@example.com");
    expect((await signIn(h, { email: "sso@example.com", password: sso?.password ?? "" })).status).toBe(200);
  });
});

describe("pxdict-gateway user reset-password (process)", () => {
  const exec = promisify(execFile);
  const main = fileURLToPath(new URL("../main.ts", import.meta.url));
  const tsx = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));

  it("prints a new password, without needing the server's secrets", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pxdict-cli-"));
    try {
      // A database with one user, as the server would leave it.
      const h = harness();
      const ann = await h.createUser({ email: "ann@example.com" });
      const db = openDatabase({ file: databaseFile(dataDir), migrationsDir });
      const src = h.db.select().from(userTable).where(eq(userTable.id, ann.id)).get();
      if (!src) throw new Error("no user");
      db.insert(userTable).values(src).run();
      db.$client.close();

      const env = { PATH: process.env.PATH ?? "", DATA_DIR: dataDir };
      const ok = await exec(tsx, [main, "user", "reset-password", "ann@example.com"], { env });
      expect(ok.stdout).toMatch(/^New password for ann@example\.com .*\n[a-zA-Z0-9]{20}\n$/);

      const missing = await exec(tsx, [main, "user", "reset-password", "bob@example.com"], { env }).catch((e: unknown) => e);
      expect(missing).toMatchObject({ code: 1 });
      const usage = await exec(tsx, [main, "user", "frobnicate"], { env }).catch((e: unknown) => e);
      expect(usage).toMatchObject({ code: 2 });
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("db backup writes a copy and refuses to overwrite it", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pxdict-cli-"));
    try {
      const env = { PATH: process.env.PATH ?? "", DATA_DIR: dataDir };
      const out = path.join(dataDir, "tmp", "snap.db");
      const ok = await exec(tsx, [main, "db", "backup", out], { env });
      expect(ok.stdout).toBe(`${out}\n`);
      expect(fs.statSync(out).size).toBeGreaterThan(0);
      const again = await exec(tsx, [main, "db", "backup", out], { env }).catch((e: unknown) => e);
      expect(again).toMatchObject({ code: 1 });
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});
