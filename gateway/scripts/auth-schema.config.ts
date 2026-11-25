// Input for the Better Auth CLI only (`npm run auth:schema -w @pxdict/gateway`): every plugin that adds
// tables or columns is enabled, so src/db/auth-schema.ts covers every configuration. Never imported by
// the gateway itself.
import { betterAuth } from "better-auth";
import { buildPlugins } from "../src/auth/plugins";

export const auth = betterAuth({
  baseURL: "https://pxdict.invalid",
  rateLimit: { enabled: true, storage: "database" },
  plugins: buildPlugins({
    publicUrl: new URL("https://pxdict.invalid"),
    passkey: true,
    hibp: true,
    // generic-oauth adds no tables, and its discovery would fetch the issuer at startup.
    oidc: [],
    email: { sendMagicLink: () => Promise.resolve(), sendOtp: () => Promise.resolve() },
  }),
});
