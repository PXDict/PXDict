// Better Auth's browser client (/app-api/auth/*), wrapped so UI code sees plain promises that throw
// ApiError. Re-exported by app.ts, the adapter UI code imports; nothing else talks to Better Auth.
import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/client";
import { adminClient, emailOTPClient, magicLinkClient, twoFactorClient, usernameClient } from "better-auth/client/plugins";
import { ApiError, notifyUnauthorized } from "./http";

export const authBasePath = "/app-api/auth";

const client = createAuthClient({
  baseURL: location.origin,
  basePath: authBasePath,
  // Every sign-in method the gateway may enable; GET /app-api/auth/methods says which are on.
  plugins: [usernameClient(), twoFactorClient(), passkeyClient(), magicLinkClient(), emailOTPClient(), adminClient()],
  // Looks fetch up on every call instead of keeping the one present at load (tests stub it).
  fetchOptions: { credentials: "same-origin", customFetchImpl: (input, init) => fetch(input, init) },
});

interface BetterAuthError {
  status: number;
  statusText?: string;
  code?: string | undefined;
  message?: string | undefined;
}

type Result<T> = { data: T; error: null } | { data: null; error: BetterAuthError };

/**
 * Unwraps Better Auth's `{data, error}` result. `session` marks calls that need a signed-in user, where
 * a 401 means the session ended (sign-in calls answer 401 for wrong credentials).
 */
async function unwrap<T>(call: Promise<Result<T>>, session = false): Promise<NonNullable<T>> {
  const { data, error } = await call;
  if (error) {
    if (session && error.status === 401) notifyUnauthorized();
    const code = error.code ? error.code.toLowerCase() : `http_${String(error.status)}`;
    throw new ApiError(error.status, code, error.message ?? error.statusText ?? code);
  }
  if (data === null || data === undefined) throw new ApiError(500, "empty_response", "empty response");
  return data;
}

/** Sign-in results that need a second step. */
export type SignInOutcome = "signed-in" | "two-factor";

const outcome = (data: unknown): SignInOutcome =>
  typeof data === "object" && data !== null && "twoFactorRedirect" in data && data.twoFactorRedirect === true
    ? "two-factor"
    : "signed-in";

/** Sign in with an email address or a username and a password. */
export async function signInWithPassword(login: string, password: string, rememberMe = true): Promise<SignInOutcome> {
  const data = login.includes("@")
    ? await unwrap(client.signIn.email({ email: login, password, rememberMe }))
    : await unwrap(client.signIn.username({ username: login, password, rememberMe }));
  return outcome(data);
}

/** Passkey sign-in. `autoFill` uses conditional UI (passkeys offered in the username field's autofill). */
export async function signInWithPasskey(autoFill = false): Promise<SignInOutcome> {
  return outcome(await unwrap(client.signIn.passkey({ autoFill })));
}

/** True when the browser can offer passkeys in autofill (conditional mediation). */
export async function passkeyAutofillAvailable(): Promise<boolean> {
  try {
    return typeof PublicKeyCredential !== "undefined" && (await PublicKeyCredential.isConditionalMediationAvailable());
  } catch {
    return false;
  }
}

/** Starts a social or OIDC sign-in (or account link); the browser leaves for the provider. */
export async function signInWithProvider(provider: string, callbackURL: string): Promise<void> {
  const data = await unwrap(
    client.signIn.social({ provider, callbackURL, errorCallbackURL: "/login", newUserCallbackURL: callbackURL }),
  );
  if ("url" in data && typeof data.url === "string") location.assign(data.url);
}

export async function sendMagicLink(email: string, callbackURL: string): Promise<void> {
  await unwrap(client.signIn.magicLink({ email, callbackURL }));
}

export async function sendSignInCode(email: string): Promise<void> {
  await unwrap(client.emailOtp.sendVerificationOtp({ email, type: "sign-in" }));
}

export async function signInWithCode(email: string, otp: string): Promise<void> {
  await unwrap(client.signIn.emailOtp({ email, otp }));
}

/** Second step after a sign-in answered "two-factor": an authenticator code or a backup code. */
export async function verifyTwoFactor(code: string, kind: "totp" | "backup", trustDevice: boolean): Promise<void> {
  if (kind === "totp") await unwrap(client.twoFactor.verifyTotp({ code, trustDevice }));
  else await unwrap(client.twoFactor.verifyBackupCode({ code, trustDevice }));
}

export interface SignUpInput {
  name: string;
  email: string;
  username?: string;
  password: string;
}

export async function signUp(input: SignUpInput): Promise<void> {
  await unwrap(
    client.signUp.email({
      name: input.name,
      email: input.email,
      password: input.password,
      ...(input.username ? { username: input.username } : {}),
    }),
  );
}

export async function requestPasswordReset(email: string): Promise<void> {
  await unwrap(client.requestPasswordReset({ email, redirectTo: "/reset-password" }));
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  await unwrap(client.resetPassword({ token, newPassword }));
}

export async function signOut(): Promise<void> {
  await unwrap(client.signOut());
}

// ----- Account settings (need a session) -----

export async function changePassword(currentPassword: string, newPassword: string, revokeOtherSessions: boolean) {
  await unwrap(client.changePassword({ currentPassword, newPassword, revokeOtherSessions }), true);
}

export interface PasskeyInfo {
  id: string;
  name: string | null;
  createdAt: Date;
  deviceType: string;
}

export async function listPasskeys(): Promise<PasskeyInfo[]> {
  const rows = await unwrap(client.passkey.listUserPasskeys(), true);
  return rows.map((p) => ({
    id: p.id,
    name: p.name ?? null,
    createdAt: new Date(p.createdAt),
    deviceType: p.deviceType,
  }));
}

/** Registers a passkey on this device (browser ceremony). */
export async function addPasskey(name: string): Promise<void> {
  const res = await client.passkey.addPasskey({ name });
  if (res.error) {
    const code = "code" in res.error ? res.error.code.toLowerCase() : "passkey_failed";
    throw new ApiError(res.error.status, code, res.error.message ?? code);
  }
}

export async function deletePasskey(id: string): Promise<void> {
  await unwrap(client.passkey.deletePasskey({ id }), true);
}

export interface LinkedAccount {
  id: string;
  providerId: string;
  accountId: string;
  createdAt: Date;
}

export async function listAccounts(): Promise<LinkedAccount[]> {
  const rows = await unwrap(client.listAccounts(), true);
  return rows.map((a) => ({ id: a.id, providerId: a.providerId, accountId: a.accountId, createdAt: new Date(a.createdAt) }));
}

export async function linkProvider(provider: string, callbackURL: string): Promise<void> {
  const data = await unwrap(client.linkSocial({ provider, callbackURL, errorCallbackURL: callbackURL }), true);
  if (typeof data.url === "string") location.assign(data.url);
}

export async function unlinkAccount(accountId: string): Promise<void> {
  await unwrap(client.unlinkAccount({ accountId }), true);
}

export interface TwoFactorSetup {
  totpURI: string;
  backupCodes: string[];
}

/** Starts enabling 2FA; it is on once verifyTwoFactorSetup accepts a code from the authenticator. */
export async function enableTwoFactor(password: string): Promise<TwoFactorSetup> {
  const data = await unwrap(client.twoFactor.enable({ password }), true);
  if (data.method !== "totp") throw new ApiError(500, "unexpected_response", "two-factor setup did not return a TOTP secret");
  return { totpURI: data.totpURI, backupCodes: data.backupCodes };
}

export async function verifyTwoFactorSetup(code: string): Promise<void> {
  await unwrap(client.twoFactor.verifyTotp({ code }), true);
}

export async function disableTwoFactor(password: string): Promise<void> {
  await unwrap(client.twoFactor.disable({ password }), true);
}

export async function regenerateBackupCodes(password: string): Promise<string[]> {
  return (await unwrap(client.twoFactor.generateBackupCodes({ password }), true)).backupCodes;
}

export interface SessionInfo {
  id: string;
  token: string;
  createdAt: Date;
  expiresAt: Date;
  userAgent: string | null;
  ipAddress: string | null;
}

export async function listSessions(): Promise<SessionInfo[]> {
  const rows = await unwrap(client.listSessions(), true);
  return rows.map((s) => ({
    id: s.id,
    token: s.token,
    createdAt: new Date(s.createdAt),
    expiresAt: new Date(s.expiresAt),
    userAgent: s.userAgent ?? null,
    ipAddress: s.ipAddress ?? null,
  }));
}

export async function revokeSession(token: string): Promise<void> {
  await unwrap(client.revokeSession({ token }), true);
}

export async function revokeOtherSessions(): Promise<void> {
  await unwrap(client.revokeOtherSessions(), true);
}

// Admins: user management (Better Auth's admin plugin; the gateway adds its admin check in front)

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  username: string | null;
  role: "user" | "admin";
  banned: boolean;
  banReason: string | null;
  emailVerified: boolean;
  createdAt: string;
}

export interface AdminUserPage {
  users: AdminUser[];
  total: number;
}

const toIso = (v: unknown) => (v instanceof Date ? v.toISOString() : typeof v === "string" ? v : "");

/** Users, newest first, optionally those whose email contains `search`. */
export async function listUsers(o: { search?: string; limit: number; offset: number }): Promise<AdminUserPage> {
  const data = await unwrap(
    client.admin.listUsers({
      query: {
        limit: o.limit,
        offset: o.offset,
        sortBy: "createdAt",
        sortDirection: "desc",
        ...(o.search ? { searchValue: o.search, searchField: "email" as const, searchOperator: "contains" as const } : {}),
      },
    }),
    true,
  );
  const users = data.users.map((u): AdminUser => {
    const x = u as typeof u & { username?: string | null; banReason?: string | null };
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      username: x.username ?? null,
      role: u.role === "admin" ? "admin" : "user",
      banned: u.banned === true,
      banReason: x.banReason ?? null,
      emailVerified: u.emailVerified,
      createdAt: toIso(u.createdAt),
    };
  });
  return { users, total: "total" in data ? data.total : users.length };
}

export async function setUserRole(userId: string, role: "user" | "admin"): Promise<void> {
  await unwrap(client.admin.setRole({ userId, role }), true);
}

/** Suspends an account (and ends its sessions). */
export async function banUser(userId: string, reason?: string): Promise<void> {
  await unwrap(client.admin.banUser({ userId, ...(reason ? { banReason: reason } : {}) }), true);
}

export async function unbanUser(userId: string): Promise<void> {
  await unwrap(client.admin.unbanUser({ userId }), true);
}

/** Signs the user out everywhere. */
export async function revokeUserSessions(userId: string): Promise<void> {
  await unwrap(client.admin.revokeUserSessions({ userId }), true);
}

/** Deletes the account and, with it, the user's own data. */
export async function removeUser(userId: string): Promise<void> {
  await unwrap(client.admin.removeUser({ userId }), true);
}
