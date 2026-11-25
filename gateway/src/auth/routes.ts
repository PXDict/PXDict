// PXDict's own account endpoints next to Better Auth's: the login screen's method list, invite codes,
// /me and admin invite management. Better Auth's endpoints are mounted by app.ts.
import {
  AuthMethods,
  ClaimInviteRequest,
  CreateInviteRequest,
  type AuthProvider,
  type CreateInviteResponse,
  type Invite as InviteDto,
  type InviteList,
  type Me,
} from "@pxdict/shared";
import { Hono, type Context } from "hono";
import { setCookie } from "hono/cookie";
import type { z } from "zod";
import { recordAudit } from "../audit/audit";
import { minPasswordLength, socialProviderIds, type Config, type SocialProviderId } from "../config";
import type { Db } from "../db/client";
import { jsonError } from "../http/errors";
import { originCheck } from "../http/origin";
import { authBasePath, hasAdminRole } from "./auth";
import type { AuthEnv, Guards } from "./guards";
import {
  createInvite,
  deleteInvite,
  inviteCookieMaxAgeSeconds,
  inviteCookieName,
  isInviteUsable,
  listInvites,
  type Invite,
} from "./invites";

const socialLabels: Record<SocialProviderId, string> = {
  google: "Google",
  github: "GitHub",
  microsoft: "Microsoft",
  apple: "Apple",
  discord: "Discord",
  facebook: "Facebook",
  gitlab: "GitLab",
};

export function authMethods(config: Config, emailEnabled: boolean): AuthMethods {
  const providers: AuthProvider[] = [
    ...socialProviderIds
      .filter((id) => config.auth.social[id])
      .map((id) => ({ id, label: socialLabels[id], kind: "social" as const })),
    ...config.auth.oidc.map((p) => ({ id: p.id, label: p.label, kind: "oidc" as const })),
  ];
  return AuthMethods.parse({
    registration: config.registration,
    password: true,
    passkey: config.auth.passkey,
    magicLink: emailEnabled,
    emailOtp: emailEnabled,
    passwordReset: emailEnabled,
    emailVerification: emailEnabled,
    twoFactor: true,
    adminRequiresTwoFactor: config.auth.requireAdmin2fa,
    minPasswordLength,
    providers,
  } satisfies AuthMethods);
}

function inviteDto(i: Invite, now = new Date()): InviteDto {
  return {
    id: i.id,
    role: i.role,
    note: i.note,
    createdBy: i.createdBy,
    createdAt: i.createdAt.toISOString(),
    expiresAt: i.expiresAt.toISOString(),
    usedAt: i.usedAt?.toISOString() ?? null,
    usedBy: i.usedBy,
    status: i.usedAt ? "used" : i.expiresAt <= now ? "expired" : "active",
  };
}

/** Parses a JSON body with a shared schema; undefined (after answering 400) when invalid. */
async function readJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S> | undefined> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return undefined;
  }
  const result = schema.safeParse(raw);
  return result.success ? result.data : undefined;
}

export interface AuthRoutesOptions {
  config: Config;
  db: Db;
  guards: Guards;
  emailEnabled: boolean;
}

export function createAuthRoutes({ config, db, guards, emailEnabled }: AuthRoutesOptions): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  const methods = authMethods(config, emailEnabled);
  const sameOrigin = originCheck(config.publicUrl.origin);

  app.get(`${authBasePath}/methods`, (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(methods);
  });

  app.post(`${authBasePath}/invite`, sameOrigin, async (c) => {
    if (config.registration !== "invite") return jsonError(c, 400, "invites_disabled", "registration does not use invite codes");
    const body = await readJson(c, ClaimInviteRequest);
    if (!body) return jsonError(c, 400, "bad_request", "invalid request body");
    if (!isInviteUsable(db, body.code)) return jsonError(c, 400, "invalid_invite", "this invite code is invalid, used or expired");
    setCookie(c, inviteCookieName, body.code, {
      path: authBasePath,
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: "Lax",
      maxAge: inviteCookieMaxAgeSeconds,
    });
    c.header("Cache-Control", "no-store");
    return c.body(null, 204);
  });

  app.get("/app-api/me", guards.requireUser, (c) => {
    const { user, session } = c.get("session");
    c.header("Cache-Control", "no-store");
    return c.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        emailVerified: user.emailVerified,
        username: user.username ?? null,
        displayUsername: user.displayUsername ?? null,
        image: user.image ?? null,
        role: hasAdminRole(user.role) ? "admin" : "user",
        twoFactorEnabled: user.twoFactorEnabled ?? false,
        createdAt: new Date(user.createdAt).toISOString(),
      },
      session: {
        expiresAt: new Date(session.expiresAt).toISOString(),
        impersonatedBy: session.impersonatedBy ?? null,
      },
    } satisfies Me);
  });

  // Every /app-api/admin/* path, including unknown ones, needs an admin: a regular user gets 403.
  app.use("/app-api/admin/*", guards.requireAdmin, sameOrigin);

  app.get("/app-api/admin/invites", (c) => {
    c.header("Cache-Control", "no-store");
    const now = new Date();
    return c.json({ invites: listInvites(db).map((i) => inviteDto(i, now)) } satisfies InviteList);
  });

  app.post("/app-api/admin/invites", async (c) => {
    const body = await readJson(c, CreateInviteRequest);
    if (!body) return jsonError(c, 400, "bad_request", "invalid request body");
    const actor = c.get("session").user.id;
    const { invite, code } = createInvite(db, { createdBy: actor, role: body.role, expiresInDays: body.expiresInDays, note: body.note });
    recordAudit(db, {
      actorUserId: actor,
      action: "invite.create",
      targetType: "invite",
      targetId: invite.id,
      details: { role: invite.role, expiresAt: invite.expiresAt.toISOString() },
    });
    c.header("Cache-Control", "no-store");
    return c.json({ invite: inviteDto(invite), code } satisfies CreateInviteResponse, 201);
  });

  app.delete("/app-api/admin/invites/:id", (c) => {
    const id = c.req.param("id");
    if (!deleteInvite(db, id)) return jsonError(c, 404, "not_found", "no such invite");
    recordAudit(db, { actorUserId: c.get("session").user.id, action: "invite.delete", targetType: "invite", targetId: id });
    return c.body(null, 204);
  });

  return app;
}
