// Shared HTTP helpers for the adapters in this folder. UI code must not import this module directly:
// use app.ts (PXDict's /app-api) or wudict.ts (wuDict's /api and /res, proxied by the gateway).

/** Error returned by the gateway in its single error shape. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** The gateway's error shape (ErrorBody in @pxdict/shared), read defensively: any body may arrive. */
interface MaybeErrorBody {
  error?: { code?: unknown; message?: unknown };
}

/** Turns a non-2xx response into an ApiError, reading the gateway's error body when present. */
export async function toApiError(res: Response): Promise<ApiError> {
  let code = "http_" + String(res.status);
  let message = res.statusText || code;
  try {
    const body = (await res.json()) as MaybeErrorBody;
    if (typeof body.error?.code === "string") code = body.error.code;
    if (typeof body.error?.message === "string") message = body.error.message;
  } catch {
    // Not JSON: keep the generic code.
  }
  return new ApiError(res.status, code, message);
}

/** Same-origin fetch with credentials and JSON accept header. */
export function send(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  return fetch(path, { ...init, headers, credentials: "same-origin" });
}

/**
 * Yields one parsed JSON value per line of an NDJSON body as lines arrive. Blank lines are skipped.
 * wuDict streams /api/dicts, /api/search and /api/suggest this way.
 */
export async function* readNdjson<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        if (line) yield JSON.parse(line) as T;
      }
    }
    const rest = (buffered + decoder.decode()).trim();
    if (rest) yield JSON.parse(rest) as T;
  } finally {
    reader.releaseLock();
  }
}
