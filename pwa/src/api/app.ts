// The ONLY adapter for PXDict's own API (/app-api and /healthz). Types come from @pxdict/shared, the
// zod schemas the gateway validates with; only types are imported, so zod is not bundled.
import type { Health } from "@pxdict/shared";
import { send, toApiError } from "./http";

export { ApiError } from "./http";
export type { Health };

/** GET /healthz */
export async function getHealth(signal?: AbortSignal): Promise<Health> {
  const res = await send("/healthz", signal ? { signal } : {});
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as Health;
}
