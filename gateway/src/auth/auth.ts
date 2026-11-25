// The Better Auth instance: every sign-in method, sessions, rate limits, registration policy, the
// last-admin rule and audit logging. Mounted at /app-api/auth/* by app.ts (AGENTS.md §2 rule 8).
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { recordAudit } from "../audit/audit";
import { minPasswordLength, type Config, type SocialProviderId } from "../config";
import type { Db } from "../db/client";
import * as schema from "../db/schema";
import type { Logger } from "../log";
import { inviteCodeFromCookie, inviteCookieName, markInviteUsedBy, reserveInvite } from "./invites";
import type { Mailer } from "./mailer";
import { appName, buildPlugins } from "./plugins";
import { SignInFailureTracker } from "./failures";

export const authBasePath = "/app-api/auth";
/** Set by the gateway on every request it hands to Better Auth (see http/client-ip.ts). */
export const clientIpHeader = "x-pxdict-client-ip";

const days = 24 * 60 * 60;
export const sessionPolicy = {
  /** Sliding expiry: a session used at least once every 30 days stays valid (installed PWAs). */
  expiresIn: 30 * days,
  /** The expiry is pushed back at most once a day. */
  updateAge: 1 * days,
  /**
   * Session data cached in a signed cookie, so most requests skip the database. A revoked session or
   * a ban takes effect for user routes within this time; admin routes always read the database.
   */
  cookieCacheSeconds: 60,
};

/** Paths whose failures count towards a "burst of failed sign-ins" audit entry. */
const signInPaths = new Set([
  "/sign-in/email",
  "/sign-in/username",
  "/sign-in/email-otp",
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
  "/passkey/verify-authentication",
]);

/** Admin plugin endpoints that change nothing (not audited). */
const readOnlyAdminPaths = new Set([
  "/admin/list-users",
  "/admin/get-user",
  "/admin/list-user-sessions",
  "/admin/has-permission",
]);

/** Request body fields copied into audit details (never passwords or tokens). */
const auditedFields = ["role", "banReason", "banExpiresIn", "email", "username", "name"] as const;

export interface AuthDeps {
  config: Config;
  db: Db;
  logger: Logger;
  /** Outgoing email; email-based methods are enabled only with a mailer (SMTP_URL). */
  mailer: Mailer | undefined;
  /** Rate limiting; on by default (tests turn it off unless they test it). */
  rateLimit?: boolean;
}

/** True if a Better Auth role value ("admin", "user,admin" or an array) includes admin. */
export function hasAdminRole(role: unknown): boolean {
  const roles = Array.isArray(role) ? role : typeof role === "string" ? role.split(",") : [];
  return roles.some((r) => typeof r === "string" && r.trim() === "admin");
}

/** Ids of admins who are not banned. */
export function activeAdminIds(db: Db): string[] {
  return db
    .select({ id: schema.user.id, role: schema.user.role, banned: schema.user.banned })
    .from(schema.user)
    .all()
    .filter((u) => hasAdminRole(u.role) && !u.banned)
    .map((u) => u.id);
}

function socialProviders(config: Config): NonNullable<BetterAuthOptions["socialProviders"]> {
  const out: NonNullable<BetterAuthOptions["socialProviders"]> = {};
  for (const [id, p] of Object.entries(config.auth.social) as [SocialProviderId, (typeof config.auth.social)[SocialProviderId]][]) {
    if (!p) continue;
    const base = { clientId: p.clientId, clientSecret: p.clientSecret };
    switch (id) {
      case "google":
        out.google = { ...base, prompt: "select_account" };
        break;
      case "microsoft":
        out.microsoft = { ...base, tenantId: p.tenantId ?? "common" };
        break;
      case "gitlab":
        out.gitlab = p.issuer ? { ...base, issuer: p.issuer } : base;
        break;
      default:
        out[id] = base;
    }
  }
  return out;
}

export function createAuth({ config, db, logger, mailer, rateLimit = true }: AuthDeps) {
  const origin = config.publicUrl.origin;
  const failures = new SignInFailureTracker();
  /** Invite reserved by a user-create hook, keyed by the endpoint context, for the after hook. */
  const reservedInvites = new WeakMap<object, string>();

  /** Sends without making the caller wait or fail: no timing signal, no error detail to the client. */
  const deliver = (to: string, subject: string, text: string) => {
    if (!mailer) return Promise.resolve();
    mailer.send({ to, subject, text }).catch((err: unknown) => {
      logger.error("sending email failed", { subject, err });
    });
    return Promise.resolve();
  };

  const email = mailer
    ? {
        sendMagicLink: ({ email: to, url }: { email: string; url: string }) =>
          deliver(to, `Sign in to ${appName}`, `Open this link to sign in to ${appName}:\n\n${url}\n\nThe link expires in 10 minutes. If you did not ask for it, ignore this email.`),
        sendOtp: ({ email: to, otp }: { email: string; otp: string; type: string }) =>
          deliver(to, `Your ${appName} code: ${otp}`, `Your ${appName} code is ${otp}\n\nIt expires in 10 minutes. If you did not ask for it, ignore this email.`),
      }
    : undefined;

  const options = {
    appName,
    baseURL: origin,
    basePath: authBasePath,
    secret: config.auth.secret,
    trustedOrigins: [origin],
    telemetry: { enabled: false },
    database: drizzleAdapter(db, { provider: "sqlite", schema }),
    logger: {
      level: "warn",
      log: (level, message) => {
        logger[level === "debug" ? "debug" : level === "info" ? "info" : level === "warn" ? "warn" : "error"](message, {
          component: "better-auth",
        });
      },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength,
      maxPasswordLength: 256,
      revokeSessionsOnPasswordReset: true,
      ...(mailer
        ? {
            sendResetPassword: ({ user, url }) =>
              deliver(user.email, `Reset your ${appName} password`, `Open this link to choose a new ${appName} password:\n\n${url}\n\nThe link expires in 1 hour. If you did not ask for it, ignore this email.`),
          }
        : {}),
    },
    ...(mailer
      ? {
          emailVerification: {
            sendOnSignUp: true,
            autoSignInAfterVerification: true,
            sendVerificationEmail: ({ user, url }) =>
              deliver(user.email, `Confirm your email for ${appName}`, `Open this link to confirm your email address:\n\n${url}`),
          },
        }
      : {}),
    socialProviders: socialProviders(config),
    account: {
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: true,
        // A social/OIDC sign-in joins an existing account only when the provider says the email is
        // verified and the local account's email is verified too (Better Auth's default); otherwise the
        // user links it from settings while signed in.
        trustedProviders: [],
        allowDifferentEmails: false,
        allowUnlinkingAll: false,
      },
    },
    session: {
      expiresIn: sessionPolicy.expiresIn,
      updateAge: sessionPolicy.updateAge,
      cookieCache: { enabled: true, maxAge: sessionPolicy.cookieCacheSeconds },
    },
    rateLimit: {
      enabled: rateLimit,
      storage: "database",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-in/username": { window: 60, max: 5 },
        "/sign-in/email-otp": { window: 60, max: 5 },
        "/sign-up/email": { window: 3600, max: 5 },
        "/request-password-reset": { window: 3600, max: 3 },
        "/send-verification-email": { window: 600, max: 3 },
        "/sign-in/magic-link": { window: 600, max: 3 },
        "/email-otp/send-verification-otp": { window: 600, max: 3 },
        "/two-factor/verify-totp": { window: 60, max: 5 },
        "/two-factor/verify-backup-code": { window: 60, max: 5 },
      },
    },
    advanced: {
      cookiePrefix: "pxdict",
      useSecureCookies: config.cookieSecure,
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure: config.cookieSecure },
      ipAddress: { ipAddressHeaders: [clientIpHeader] },
    },
    onAPIError: { errorURL: `${origin}/login` },
    databaseHooks: {
      user: {
        create: {
          // The registration policy, for every sign-up method (docs/PLAN.md Phase 3).
          before: async (user, ctx) => {
            // No endpoint: the gateway itself (admin bootstrap, CLI). Admin-created users are allowed.
            if (!ctx || ctx.path === "/admin/create-user") return;
            if (config.registration === "open") return;
            if (config.registration === "closed") {
              throw new APIError("FORBIDDEN", { code: "REGISTRATION_CLOSED", message: "Registration is closed. Ask an administrator for an account." });
            }
            const code = inviteCodeFromCookie(ctx.headers?.get("cookie"));
            const invite = code ? reserveInvite(db, code) : undefined;
            if (!invite) {
              throw new APIError("FORBIDDEN", { code: "INVITE_REQUIRED", message: "A valid invite code is required to create an account." });
            }
            reservedInvites.set(ctx, invite.id);
            return Promise.resolve({ data: { ...user, role: invite.role } });
          },
          after: async (user, ctx) => {
            const inviteId = ctx ? reservedInvites.get(ctx) : undefined;
            if (ctx && inviteId) {
              markInviteUsedBy(db, inviteId, user.id);
              ctx.setCookie(inviteCookieName, "", { path: authBasePath, maxAge: 0 });
            }
            // Admin-created users are audited by the after hook; gateway-created ones by their caller.
            if (ctx && ctx.path !== "/admin/create-user") {
              recordAudit(db, {
                actorUserId: user.id,
                action: "user.sign_up",
                targetType: "user",
                targetId: user.id,
                details: { method: ctx.path, ...(inviteId ? { inviteId } : {}) },
              });
            }
            return Promise.resolve();
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // The last active admin cannot be demoted, banned or removed (by anyone, themselves included).
        if (!["/admin/set-role", "/admin/ban-user", "/admin/remove-user", "/admin/update-user"].includes(ctx.path)) return;
        const body = (ctx.body ?? {}) as { userId?: unknown; role?: unknown; data?: { role?: unknown } };
        if (typeof body.userId !== "string") return;
        const admins = activeAdminIds(db);
        if (admins.length > 1 || !admins.includes(body.userId)) return;
        const removesAdmin =
          ctx.path === "/admin/set-role"
            ? !hasAdminRole(body.role)
            : ctx.path === "/admin/update-user"
              ? body.data?.role !== undefined && !hasAdminRole(body.data.role)
              : true;
        if (removesAdmin) {
          throw new APIError("BAD_REQUEST", { code: "LAST_ADMIN", message: "This is the last administrator; promote another user first." });
        }
        return Promise.resolve();
      }),
      after: createAuthMiddleware(async (ctx) => {
        const returned = ctx.context.returned;
        const failed = isAPIError(returned);

        if (signInPaths.has(ctx.path) && failed && (returned.statusCode === 401 || returned.statusCode === 403)) {
          const ip = ctx.headers?.get(clientIpHeader) ?? "unknown";
          const burst = failures.fail(ip);
          if (burst) {
            logger.warn("burst of failed sign-ins", { ip, failures: burst.count, windowMinutes: burst.windowMinutes });
            recordAudit(db, {
              actorUserId: null,
              action: "auth.sign_in_failures",
              targetType: "ip",
              targetId: ip,
              details: { failures: burst.count, windowMinutes: burst.windowMinutes, lastPath: ctx.path },
            });
          }
          return;
        }

        if (ctx.path.startsWith("/admin/") && !readOnlyAdminPaths.has(ctx.path) && !failed) {
          const session = ctx.context.session ?? (await getSessionFromCtx(ctx).catch(() => null));
          const impersonatedBy = (session?.session as { impersonatedBy?: string | null } | undefined)?.impersonatedBy;
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          const details: Record<string, unknown> = {};
          for (const k of auditedFields) if (body[k] !== undefined) details[k] = body[k];
          let targetId = typeof body.userId === "string" ? body.userId : undefined;
          if (!targetId && ctx.path === "/admin/create-user") {
            targetId = (returned as { user?: { id?: string } } | undefined)?.user?.id;
          }
          recordAudit(db, {
            actorUserId: impersonatedBy ?? session?.user.id ?? null,
            action: `user.${ctx.path.slice("/admin/".length).replace(/-/g, "_")}`,
            targetType: "user",
            ...(targetId ? { targetId } : {}),
            details,
          });
        }
      }),
    },
    plugins: buildPlugins({
      publicUrl: config.publicUrl,
      passkey: config.auth.passkey,
      hibp: config.auth.hibp,
      oidc: config.auth.oidc,
      email,
    }),
  } satisfies BetterAuthOptions;

  return betterAuth(options);
}

export type Auth = ReturnType<typeof createAuth>;

/** Session as returned by auth.api.getSession, with the plugin fields PXDict reads. */
export interface SessionUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string | null | undefined;
  username?: string | null | undefined;
  displayUsername?: string | null | undefined;
  role?: string | null | undefined;
  banned?: boolean | null | undefined;
  twoFactorEnabled?: boolean | null | undefined;
  createdAt: Date;
}

export interface SessionInfo {
  user: SessionUser;
  session: { id: string; expiresAt: Date; impersonatedBy?: string | null | undefined };
}
