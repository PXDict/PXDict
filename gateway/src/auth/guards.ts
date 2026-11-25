// Session guards for PXDict's routes and the wuDict proxy. The session comes from Better Auth (its
// signed cookie); refreshed session cookies it returns are passed on to the response.
import type { Context, MiddlewareHandler } from "hono";
import { jsonError } from "../http/errors";
import { hasAdminRole, type Auth, type SessionInfo } from "./auth";

export interface AuthVariables {
  session: SessionInfo;
}
export interface AuthEnv {
  Variables: AuthVariables;
}

export interface Guards {
  /** Any signed-in user who is not banned. */
  requireUser: MiddlewareHandler<AuthEnv>;
  /** An admin, checked against the database (never the cookie cache), with 2FA if required. */
  requireAdmin: MiddlewareHandler<AuthEnv>;
}

export function createGuards(auth: Auth, opts: { requireAdmin2fa: boolean }): Guards {
  const load = async (c: Context, fresh: boolean): Promise<SessionInfo | null> => {
    const { headers, response } = await auth.api.getSession({
      headers: c.req.raw.headers,
      query: fresh ? { disableCookieCache: true } : {},
      returnHeaders: true,
    });
    // Sliding expiry and the cookie cache renew cookies here; keep them.
    for (const cookie of headers.getSetCookie()) c.header("Set-Cookie", cookie, { append: true });
    return response;
  };

  const requireUser: MiddlewareHandler<AuthEnv> = async (c, next) => {
    const s = await load(c, false);
    if (!s) return jsonError(c, 401, "unauthenticated", "sign in first");
    if (s.user.banned) return jsonError(c, 403, "banned", "this account is suspended");
    c.set("session", s);
    await next();
  };

  const requireAdmin: MiddlewareHandler<AuthEnv> = async (c, next) => {
    const s = await load(c, true);
    if (!s) return jsonError(c, 401, "unauthenticated", "sign in first");
    if (s.user.banned) return jsonError(c, 403, "banned", "this account is suspended");
    if (!hasAdminRole(s.user.role)) return jsonError(c, 403, "forbidden", "administrators only");
    if (opts.requireAdmin2fa && !s.user.twoFactorEnabled) {
      return jsonError(c, 403, "two_factor_required", "enable two-factor authentication to use admin features");
    }
    c.set("session", s);
    await next();
  };

  return { requireUser, requireAdmin };
}
