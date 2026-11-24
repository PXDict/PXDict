// The ONLY adapter for PXDict's own API (/app-api and /healthz). Types come from app.schema.d.ts,
// generated from gateway/openapi.yaml.
import type { components } from "./app.schema";
import { send, toApiError } from "./http";

export { ApiError } from "./http";

export type Health = components["schemas"]["Health"];

/** GET /healthz */
export async function getHealth(signal?: AbortSignal): Promise<Health> {
  const res = await send("/healthz", signal ? { signal } : {});
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as Health;
}
