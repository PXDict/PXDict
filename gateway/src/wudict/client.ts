// HTTP client for the loopback wuDict server. It is the only code that holds wuDict's AUTH_TOKEN: every
// request gets `Authorization: Bearer <token>`. `Host` is always WUDICT_URL's host (fetch derives it from
// the URL and ignores a Host header), an IP literal that wuDict's DNS-rebinding guard accepts
// (docs/wudict-notes.md Q4). Callers pass only headers they chose; nothing from the browser is
// forwarded implicitly.

/** wuDict could not be reached (connection refused, reset, DNS, …). */
export class WudictUnavailableError extends Error {
  constructor(cause: unknown) {
    super("wuDict is unavailable", { cause });
    this.name = "WudictUnavailableError";
  }
}

/** wuDict did not send response headers in time. */
export class WudictTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`wuDict did not answer within ${String(timeoutMs)} ms`);
    this.name = "WudictTimeoutError";
  }
}

export interface WudictRequest {
  method?: string;
  /** Path on wuDict, starting with "/" and already percent-encoded. */
  path: string;
  query?: URLSearchParams;
  /** Headers to send; Authorization is always set by the client. */
  headers?: Headers;
  body?: RequestInit["body"];
  /** Aborts the request and its body (e.g. the browser went away). */
  signal?: AbortSignal;
  /** Time allowed until response headers arrive; the body may take longer. */
  headersTimeoutMs?: number;
}

export interface WudictClientOptions {
  baseUrl: URL;
  token: string;
  /** Default time allowed until response headers arrive. */
  headersTimeoutMs?: number;
  /** Replaced in tests by the fake wuDict (fake.ts). */
  fetch?: typeof fetch;
}

export class WudictClient {
  readonly #baseUrl: URL;
  readonly #token: string;
  readonly #headersTimeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(opts: WudictClientOptions) {
    this.#baseUrl = opts.baseUrl;
    this.#token = opts.token;
    this.#headersTimeoutMs = opts.headersTimeoutMs ?? 15_000;
    this.#fetch = opts.fetch ?? fetch;
  }

  /** Builds the upstream URL; `path` must start with "/". */
  url(path: string, query?: URLSearchParams): URL {
    if (!path.startsWith("/") || path.startsWith("//")) throw new Error(`invalid wuDict path: ${path}`);
    const u = new URL(path, this.#baseUrl);
    if (query && query.size > 0) u.search = query.toString();
    return u;
  }

  /**
   * Sends one request. Resolves with wuDict's response (any status) once its headers arrive; rejects
   * with WudictUnavailableError, WudictTimeoutError, or the caller's abort reason.
   */
  async request(req: WudictRequest): Promise<Response> {
    const headers = new Headers(req.headers);
    headers.set("Authorization", `Bearer ${this.#token}`);
    // Loopback traffic gains nothing from compression, and the gateway must see plain bodies.
    headers.set("Accept-Encoding", "identity");

    const timeoutMs = req.headersTimeoutMs ?? this.#headersTimeoutMs;
    const timeout = new AbortController();
    const timer = setTimeout(() => {
      timeout.abort(new WudictTimeoutError(timeoutMs));
    }, timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout.signal]) : timeout.signal;

    const body = req.body ?? null;
    const init: RequestInit & { duplex?: "half" } = {
      method: req.method ?? "GET",
      headers,
      signal,
      redirect: "manual",
      body,
    };
    // A streamed request body (uploads, later phases) is piped through without buffering.
    if (body instanceof ReadableStream) init.duplex = "half";

    try {
      return await this.#fetch(this.url(req.path, req.query), init);
    } catch (err) {
      if (timeout.signal.aborted) throw timeout.signal.reason as Error;
      if (req.signal?.aborted) throw req.signal.reason as Error;
      throw new WudictUnavailableError(err);
    } finally {
      clearTimeout(timer);
    }
  }
}
