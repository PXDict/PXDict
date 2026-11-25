// The Better Auth plugins PXDict uses, enabled by configuration. Kept apart from auth.ts so the schema
// generator (scripts/auth-schema.config.ts) can build the same plugin list without a database.
import { passkey } from "@better-auth/passkey";
import type { BetterAuthPlugin } from "better-auth";
import { admin, emailOTP, genericOAuth, haveIBeenPwned, magicLink, twoFactor, username } from "better-auth/plugins";
import type { OidcProviderConfig } from "../config";

export const appName = "PXDict";

/** Usernames: 3–30 letters, digits, "_" or "." (stored lower-case). */
export const usernameRules = { min: 3, max: 30, pattern: /^[a-zA-Z0-9_.]+$/ };

/** How long an admin may impersonate a user. */
export const impersonationSeconds = 60 * 60;

export interface PluginOptions {
  publicUrl: URL;
  passkey: boolean;
  hibp: boolean;
  oidc: OidcProviderConfig[];
  /** Email senders; magic links and email codes are enabled only when present. */
  email:
    | {
        sendMagicLink(data: { email: string; url: string }): Promise<void>;
        sendOtp(data: { email: string; otp: string; type: string }): Promise<void>;
      }
    | undefined;
}

export function buildPlugins(opts: PluginOptions): BetterAuthPlugin[] {
  const plugins: BetterAuthPlugin[] = [
    username({
      minUsernameLength: usernameRules.min,
      maxUsernameLength: usernameRules.max,
      usernameValidator: (u) => usernameRules.pattern.test(u),
    }),
    admin({
      defaultRole: "user",
      adminRoles: ["admin"],
      impersonationSessionDuration: impersonationSeconds,
      allowImpersonatingAdmins: false,
      bannedUserMessage: "This account is suspended. Contact an administrator.",
    }),
    twoFactor({ issuer: appName }),
  ];
  if (opts.passkey) {
    plugins.push(
      passkey({
        rpID: opts.publicUrl.hostname,
        rpName: appName,
        origin: opts.publicUrl.origin,
      }),
    );
  }
  if (opts.oidc.length) {
    plugins.push(
      genericOAuth({
        config: opts.oidc.map((p) => ({
          providerId: p.id,
          name: p.label,
          discoveryUrl: new URL(".well-known/openid-configuration", p.issuer.href.endsWith("/") ? p.issuer : `${p.issuer.href}/`).href,
          clientId: p.clientId,
          clientSecret: p.clientSecret,
          scopes: ["openid", "email", "profile"],
          pkce: true,
          requireIdTokenVerification: true,
        })),
      }),
    );
  }
  if (opts.email) {
    const email = opts.email;
    plugins.push(
      magicLink({
        expiresIn: 10 * 60,
        sendMagicLink: ({ email: to, url }) => email.sendMagicLink({ email: to, url }),
      }),
      emailOTP({
        otpLength: 6,
        expiresIn: 10 * 60,
        allowedAttempts: 5,
        sendVerificationOTP: ({ email: to, otp, type }) => email.sendOtp({ email: to, otp, type }),
      }),
    );
  }
  if (opts.hibp) plugins.push(haveIBeenPwned());
  return plugins;
}
