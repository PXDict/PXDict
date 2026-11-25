// A stubbed gateway for component tests: answers fetch() by method + path and records requests.
import type { AuthMethods, Me } from "@pxdict/shared";
import { vi } from "vitest";

export type Handler = (req: Request) => Response | Promise<Response>;

export interface FakeBackend {
  requests: Request[];
  on(method: string, path: string, handler: Handler): void;
}

export function stubBackend(): FakeBackend {
  const routes = new Map<string, Handler>();
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
      const req = input instanceof Request ? new Request(url, input) : new Request(url, init);
      requests.push(req.clone());
      const handler = routes.get(`${req.method} ${url.pathname}`);
      return handler ? handler(req) : Response.json({ error: { code: "not_found", message: "no" } }, { status: 404 });
    }),
  );
  return {
    requests,
    on(method, path, handler) {
      routes.set(`${method} ${path}`, handler);
    },
  };
}

export const methods: AuthMethods = {
  registration: "closed",
  password: true,
  passkey: false,
  magicLink: false,
  emailOtp: false,
  passwordReset: false,
  emailVerification: false,
  twoFactor: true,
  adminRequiresTwoFactor: false,
  minPasswordLength: 10,
  providers: [],
};

export const me: Me = {
  user: {
    id: "user1",
    name: "Reader",
    email: "reader@example.com",
    emailVerified: true,
    username: null,
    displayUsername: null,
    image: null,
    role: "user",
    twoFactorEnabled: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  session: { id: "s1", expiresAt: "2026-12-31T00:00:00.000Z", impersonatedBy: null },
};

export const unauthorized = () =>
  Response.json({ error: { code: "unauthenticated", message: "sign in first" } }, { status: 401 });

export function ndjson(lines: unknown[]): Response {
  return new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", {
    headers: { "Content-Type": "application/x-ndjson" },
  });
}
