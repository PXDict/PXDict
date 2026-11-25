import { z } from "zod";

export const RegistrationMode = z.enum(["closed", "invite", "open"]);
export type RegistrationMode = z.infer<typeof RegistrationMode>;

export const Role = z.enum(["user", "admin"]);
export type Role = z.infer<typeof Role>;

/** A social or OpenID Connect provider button on the login screen. */
export const AuthProvider = z.object({
  /** Better Auth provider id ("github", or an OIDC provider's lower-cased name). */
  id: z.string(),
  /** Button text. */
  label: z.string(),
  /**
   * "social" (a built-in provider) or "oidc" (configured with AUTH_OIDC_<NAME>_*). Both sign in with
   * `POST /app-api/auth/sign-in/social {provider: id}` and link with `POST /app-api/auth/link-social`.
   */
  kind: z.enum(["social", "oidc"]),
});
export type AuthProvider = z.infer<typeof AuthProvider>;

/** Body of GET /app-api/auth/methods: what the login screen offers. Public. */
export const AuthMethods = z.object({
  registration: RegistrationMode,
  /** Email or username + password (always on). */
  password: z.literal(true),
  passkey: z.boolean(),
  /** Magic link and email one-time code sign-in (SMTP configured). */
  magicLink: z.boolean(),
  emailOtp: z.boolean(),
  /** Password reset by email (SMTP configured); otherwise an admin resets passwords. */
  passwordReset: z.boolean(),
  /** Email addresses are verified by email (SMTP configured). */
  emailVerification: z.boolean(),
  /** TOTP two-factor authentication, optional per user. */
  twoFactor: z.literal(true),
  /** Admins must enable two-factor authentication before using admin features. */
  adminRequiresTwoFactor: z.boolean(),
  minPasswordLength: z.number().int(),
  providers: z.array(AuthProvider),
});
export type AuthMethods = z.infer<typeof AuthMethods>;

/** Body of POST /app-api/auth/invite: remembers an invite code for the next sign-up (HttpOnly cookie). */
export const ClaimInviteRequest = z.object({ code: z.string().min(1).max(64) });
export type ClaimInviteRequest = z.infer<typeof ClaimInviteRequest>;

/** Body of GET /app-api/me. */
export const Me = z.object({
  user: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    emailVerified: z.boolean(),
    username: z.string().nullable(),
    displayUsername: z.string().nullable(),
    image: z.string().nullable(),
    role: Role,
    twoFactorEnabled: z.boolean(),
    createdAt: z.iso.datetime(),
  }),
  session: z.object({
    expiresAt: z.iso.datetime(),
    /** Set while an admin impersonates this user: the admin's user id. */
    impersonatedBy: z.string().nullable(),
  }),
});
export type Me = z.infer<typeof Me>;

/** An invite as listed to admins (the code itself is shown only once, on creation). */
export const Invite = z.object({
  id: z.string(),
  role: Role,
  note: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  usedAt: z.iso.datetime().nullable(),
  usedBy: z.string().nullable(),
  status: z.enum(["active", "used", "expired"]),
});
export type Invite = z.infer<typeof Invite>;

/** Body of GET /app-api/admin/invites. */
export const InviteList = z.object({ invites: z.array(Invite) });
export type InviteList = z.infer<typeof InviteList>;

/** Body of POST /app-api/admin/invites. */
export const CreateInviteRequest = z.object({
  role: Role.default("user"),
  /** 1–90 days, default 7. */
  expiresInDays: z.number().int().min(1).max(90).default(7),
  note: z.string().trim().max(200).optional(),
});
export type CreateInviteRequest = z.input<typeof CreateInviteRequest>;

/** Response of POST /app-api/admin/invites (201): the code, shown this once. */
export const CreateInviteResponse = z.object({ invite: Invite, code: z.string() });
export type CreateInviteResponse = z.infer<typeof CreateInviteResponse>;
