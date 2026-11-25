// The first admin, and the rescue CLI's password reset. Both run inside the gateway process (startup or
// `node pxdict-gateway.mjs user …`), never through an HTTP endpoint.
import { randomBytes } from "node:crypto";
import { eq, or } from "drizzle-orm";
import { recordAudit } from "../audit/audit";
import type { Config } from "../config";
import type { Db } from "../db/client";
import { user as userTable } from "../db/schema";
import type { Logger } from "../log";
import { hasAdminRole, type Auth } from "./auth";

/** Placeholder address for an admin created without ADMIN_EMAIL (RFC 2606 .invalid). */
export const placeholderAdminEmail = "admin@pxdict.invalid";

/** A random password from an unambiguous alphabet: 20 characters, about 115 bits. */
export function randomPassword(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (const b of randomBytes(20)) out += alphabet.charAt(b % alphabet.length);
  return out;
}

async function setPassword(auth: Auth, userId: string, password: string): Promise<void> {
  const ctx = await auth.$context;
  const hash = await ctx.password.hash(password);
  const credential = await ctx.internalAdapter.findCredentialAccount(userId);
  if (credential) await ctx.internalAdapter.updatePassword(userId, hash);
  else await ctx.internalAdapter.linkAccount({ userId, providerId: "credential", accountId: userId, password: hash });
}

export type BootstrapResult =
  | { kind: "exists" }
  | { kind: "promoted"; userId: string }
  | { kind: "created"; userId: string; generatedPassword: string | undefined };

/**
 * Makes sure an admin exists. With none: promotes the user with ADMIN_EMAIL if there is one, otherwise
 * creates that account (or "admin" with a placeholder email) with ADMIN_PASSWORD or a random password,
 * which is logged once.
 */
export async function bootstrapAdmin(auth: Auth, db: Db, config: Config, logger: Logger): Promise<BootstrapResult> {
  const users = db.select({ id: userTable.id, role: userTable.role }).from(userTable).all();
  if (users.some((u) => hasAdminRole(u.role))) return { kind: "exists" };

  const spec = config.auth.bootstrapAdmin;
  const email = spec?.email ?? placeholderAdminEmail;
  const username = spec?.username ?? (spec ? undefined : "admin");
  const ctx = await auth.$context;

  const existing = db.select().from(userTable).where(eq(userTable.email, email)).get();
  if (existing) {
    await ctx.internalAdapter.updateUser(existing.id, { role: "admin" });
    recordAudit(db, { actorUserId: null, action: "user.bootstrap_admin", targetType: "user", targetId: existing.id, details: { promoted: true } });
    logger.warn("no admin existed; promoted the ADMIN_EMAIL account to admin", { userId: existing.id });
    return { kind: "promoted", userId: existing.id };
  }

  const generatedPassword = spec?.password ? undefined : randomPassword();
  const created = await ctx.internalAdapter.createUser(
    {
      email,
      name: username ?? email.split("@")[0] ?? "admin",
      emailVerified: spec !== undefined,
      role: "admin",
      ...(username ? { username, displayUsername: username } : {}),
    },
    { method: "admin" },
  );
  await setPassword(auth, created.id, spec?.password ?? generatedPassword ?? randomPassword());
  recordAudit(db, { actorUserId: null, action: "user.bootstrap_admin", targetType: "user", targetId: created.id, details: { email } });
  if (generatedPassword) {
    // The only time a password is logged: it was generated here, and must be changed after signing in.
    logger.warn("created the first admin with a one-time password; sign in and change it now", {
      username: username ?? null,
      email,
      oneTimePassword: generatedPassword,
    });
  } else {
    logger.info("created the first admin from ADMIN_EMAIL", { email });
  }
  return { kind: "created", userId: created.id, generatedPassword };
}

/**
 * Rescue: sets a new random password for the user with this email or username and signs them out
 * everywhere. Returns undefined when no such user exists.
 */
export async function resetPasswordCli(
  auth: Auth,
  db: Db,
  identifier: string,
): Promise<{ userId: string; password: string } | undefined> {
  const id = identifier.trim().toLowerCase();
  const found = db
    .select({ id: userTable.id })
    .from(userTable)
    .where(or(eq(userTable.email, id), eq(userTable.username, id)))
    .get();
  if (!found) return undefined;
  const password = randomPassword();
  await setPassword(auth, found.id, password);
  const ctx = await auth.$context;
  await ctx.internalAdapter.deleteUserSessions(found.id);
  recordAudit(db, { actorUserId: null, action: "user.reset_password_cli", targetType: "user", targetId: found.id });
  return { userId: found.id, password };
}
