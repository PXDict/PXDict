// Invite codes for REGISTRATION=invite. A code is shown once when created; only its SHA-256 is stored.
// The login screen hands a code to POST /app-api/auth/invite, which keeps it in a short-lived HttpOnly
// cookie, so the same code works for every sign-up method (password, social/OIDC callbacks, magic
// links, email codes). The user-create hook reserves the code atomically.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { invites } from "../db/schema";

/** Crockford base32 (no I, L, O, U): easy to read out and type. */
const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const codeLength = 20; // 100 bits

export const inviteCookieName = "pxdict.invite";
export const inviteCookieMaxAgeSeconds = 30 * 60;

export type InviteRole = "user" | "admin";
export type Invite = typeof invites.$inferSelect;

/** Upper-cases and drops separators, so "abcd-efgh" and "ABCDEFGH" are the same code. */
export function normalizeInviteCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]/g, "");
}

function hashCode(code: string): string {
  return createHash("sha256").update(normalizeInviteCode(code)).digest("hex");
}

/** A new random code, grouped as XXXXX-XXXXX-XXXXX-XXXXX. */
export function generateInviteCode(): string {
  const bytes = randomBytes(codeLength);
  let code = "";
  for (const b of bytes) code += alphabet.charAt(b % alphabet.length);
  return code.replace(/(.{5})(?=.)/g, "$1-");
}

export function createInvite(
  db: Db,
  opts: { createdBy: string; role: InviteRole; expiresInDays: number; note?: string | undefined },
  now = new Date(),
): { invite: Invite; code: string } {
  const code = generateInviteCode();
  const invite = db
    .insert(invites)
    .values({
      id: randomUUID(),
      codeHash: hashCode(code),
      createdBy: opts.createdBy,
      role: opts.role,
      note: opts.note ?? null,
      expiresAt: new Date(now.getTime() + opts.expiresInDays * 86_400_000),
    })
    .returning()
    .get();
  return { invite, code };
}

export function listInvites(db: Db): Invite[] {
  return db.select().from(invites).orderBy(desc(invites.createdAt)).all();
}

/** Deletes an invite (used ones too, to tidy the list). False if it does not exist. */
export function deleteInvite(db: Db, id: string): boolean {
  return db.delete(invites).where(eq(invites.id, id)).run().changes > 0;
}

/** True if the code exists, is unused and has not expired. */
export function isInviteUsable(db: Db, code: string, now = new Date()): boolean {
  const row = db
    .select({ id: invites.id })
    .from(invites)
    .where(and(eq(invites.codeHash, hashCode(code)), isNull(invites.usedAt), gt(invites.expiresAt, now)))
    .get();
  return row !== undefined;
}

/**
 * Marks a usable code as used and returns it, or undefined. One UPDATE, so two sign-ups racing with the
 * same code cannot both succeed.
 */
export function reserveInvite(db: Db, code: string, now = new Date()): Invite | undefined {
  return db
    .update(invites)
    .set({ usedAt: now })
    .where(and(eq(invites.codeHash, hashCode(code)), isNull(invites.usedAt), gt(invites.expiresAt, now)))
    .returning()
    .get();
}

/** Records which account a reserved code created. */
export function markInviteUsedBy(db: Db, id: string, userId: string): void {
  db.update(invites).set({ usedBy: userId }).where(eq(invites.id, id)).run();
}

/** Reads the invite cookie from a Cookie header. */
export function inviteCodeFromCookie(cookieHeader: string | null | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === inviteCookieName) {
      const value = decodeURIComponent(part.slice(eq + 1).trim());
      return value || undefined;
    }
  }
  return undefined;
}
