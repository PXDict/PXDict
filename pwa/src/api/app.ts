// The ONLY adapter for PXDict's own API (/app-api and /healthz) that UI code imports. Types come from
// @pxdict/shared, the zod schemas the gateway validates with; only types are imported, so zod is not
// bundled. Better Auth's endpoints (/app-api/auth/*) are wrapped in ./auth and re-exported here.
import type { AuthMethods, ClaimInviteRequest, Health, Me } from "@pxdict/shared";
import { send, toApiError } from "./http";

export { ApiError, isNetworkError, onUnauthorized } from "./http";
export * from "./auth";
export type { AuthMethods, Health, Me };

const opts = (signal?: AbortSignal): RequestInit => (signal ? { signal } : {});

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await send(path, opts(signal));
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as T;
}

/** GET /healthz */
export function getHealth(signal?: AbortSignal): Promise<Health> {
  return getJson<Health>("/healthz", signal);
}

/** GET /app-api/auth/methods: which sign-in methods the login screen offers. Public. */
export function getAuthMethods(signal?: AbortSignal): Promise<AuthMethods> {
  return getJson<AuthMethods>("/app-api/auth/methods", signal);
}

/** GET /app-api/me: the signed-in user; throws ApiError 401 without a session. */
export function getMe(signal?: AbortSignal): Promise<Me> {
  return getJson<Me>("/app-api/me", signal);
}

/** POST /app-api/auth/invite: remembers an invite code (HttpOnly cookie) for the next sign-up. */
export async function claimInvite(code: string): Promise<void> {
  const res = await send("/app-api/auth/invite", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code } satisfies ClaimInviteRequest),
  });
  if (!res.ok) throw await toApiError(res);
}
