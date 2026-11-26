# Security review (Phase 10)

- Date: 2026-11-26
- Scope: the gateway (`gateway/src`), the PWA's article rendering (`pwa/src/frame`, `pwa/public/frame.html`)
  and the shipped configuration (`deploy/`, `docker/entrypoint.sh`), at the commit that adds this file.
- Method: code reading against [AGENTS.md §6](../AGENTS.md#6-security--things-that-must-not-go-wrong) and
  the Phase 10 list in [`PLAN.md`](PLAN.md), plus the existing test suite and the image smoke test. This
  is a self-review, not a penetration test: an outside review of a deployed instance is still open
  (see [Open items](#open-items)).

## Findings

| # | Severity | Finding | Status |
|---|---|---|---|
| F1 | Medium | `/app-api` request bodies had no size limit. Better Auth parses the body of every sign-in, sign-up and reset request before anyone is authenticated, so one client could make the gateway buffer an arbitrarily large body (memory exhaustion on a 1 GB VPS). | **Fixed.** Every `/app-api` request body is capped at 1 MiB (`maxJsonBodyBytes` in `app.ts`, Hono's `bodyLimit`), counted while streaming when there is no `Content-Length`; `413 payload_too_large`. Proposal file chunks are exempt: they are streamed to disk with their own limits (32 MiB per chunk, declared sizes, `MAX_UPLOAD_BYTES`). Tests: `hardening.test.ts`. |
| F2 | Low | The origin check was tested route by route; a new state-changing route could be added without it. | **Fixed.** `hardening.test.ts` enumerates every non-GET `/app-api` route of the app (plus Better Auth's write endpoints) and requires `403 origin_mismatch` for `Origin: https://evil.example` and `Origin: null`, as a signed-in admin. Verified by disabling the check for one route: the test fails. |

No other problem was found. The checks below record what was looked at, so a later review can start from
here.

## Checked

### Better Auth configuration (`gateway/src/auth/auth.ts`, `plugins.ts`)

- **Origins:** `baseURL` and `trustedOrigins` are exactly `PUBLIC_URL`'s origin; telemetry is off.
- **Cookies:** prefix `pxdict`, `HttpOnly`, `SameSite=Lax`, `Secure` whenever `PUBLIC_URL` is https
  (`COOKIE_SECURE` overrides). The invite cookie uses the same attributes and is scoped to
  `/app-api/auth`.
- **Sessions:** 30-day sliding expiry renewed at most daily; the signed cookie cache lasts 60 s, and admin
  routes (`requireAdmin`) always read the database, so a demotion or ban applies to admin actions at once.
  Password resets revoke every session.
- **Account linking:** only through emails verified on both sides (`trustedProviders: []`,
  `allowDifferentEmails: false`), and the last sign-in method cannot be unlinked. OAuth tokens are
  encrypted at rest; generic OIDC uses PKCE and verifies ID tokens.
- **Registration policy:** enforced in the `user.create.before` database hook, which every sign-up path
  goes through (password, magic link, email code, first social/OIDC sign-in); only the admin
  plugin's `create-user` and the gateway itself (bootstrap, CLI) bypass it.
- **Rate limits:** stored in the database (survive restarts); 5/min for password, username, email-code and
  2FA sign-ins, 5/h sign-ups, 3/h password resets, 3 per 10 min for email sending; 100/min elsewhere.
  Email codes allow 5 attempts each. The client address is the TCP peer, or `CLIENT_IP_HEADER` when set;
  the gateway strips any incoming copy of the header Better Auth reads (`x-pxdict-client-ip`) before
  setting its own.
- **Admin plugin:** admins cannot be impersonated; impersonation lasts at most 1 h; the last active admin
  cannot be demoted, banned or removed; every admin write is audited with the real actor during
  impersonation. `/app-api/auth/admin/*` is behind the gateway's `requireAdmin` (2FA policy included).
- **Errors:** sign-in failures do not reveal whether an account exists (Better Auth's generic errors);
  bursts of failures are logged and audited per IP.

### CSRF / origin checks (`http/origin.ts`, `app.ts`)

State-changing requests on PXDict's routes and on Better Auth's need `Origin` equal to `PUBLIC_URL`'s
origin, or no `Origin` with `Sec-Fetch-Site: same-origin`; `Origin: null` is refused. Only
`/app-api/auth/callback/<provider>` is exempt (providers may POST it cross-site; it is protected by the
OAuth state and its cookie). Covered by the sweep in F2 and by `auth.test.ts`.

### Path traversal in upload and delete (`storage/safe-path.ts`, `proposals/`, `storage/admin.ts`)

- Every path built from data the gateway did not choose goes through `safeJoin`/`safeJoinSync`: plain
  relative segments only (no `..`, absolute paths, backslashes, colons, control characters, hidden names,
  over-long names), the result must stay below the root, and no existing component may be a symlink.
- Uploads: file names are validated by the shared schema and again by `safeJoin`; zip archives are
  checked for entry names, symlinks, entry count, total uncompressed size and compression ratio before
  anything is extracted (`zip.ts`). Quarantine lives in `/data/proposals/`, outside `DICT_DIR`.
- Deletion: only items listed in a stored dry-run plan are deleted, and an item whose files changed since
  the plan (size, type, modification time, new files) is skipped; symlinks are removed as links, never
  followed. Tests: `safe-path.test.ts`, `zip.test.ts`,
  `proposals/routes.test.ts`, `storage/admin.test.ts`.

### SSRF via `source_url` and other outgoing requests

- `source_url` must be an `http(s)` URL of at most 2000 characters, is stored as text and is **never
  fetched**; the admin review page shows it as a link with `target="_blank" rel="noopener noreferrer"`.
- The gateway makes outgoing requests only to: wuDict on loopback (`WUDICT_URL`, fixed by the
  entrypoint), the SMTP server, the OAuth/OIDC providers configured by the operator (OIDC discovery URLs
  come from `AUTH_OIDC_*_ISSUER`, never from users), and Have I Been Pwned when `AUTH_HIBP=true`.

### Response headers and CSP (`http/security.ts`, `static/pwa.ts`, `wudict/proxy.ts`)

- PWA: `default-src 'self'`, no inline scripts or styles, `object-src 'none'`, `base-uri 'none'`,
  `frame-ancestors 'self'`; `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, a
  restrictive `Permissions-Policy`, `X-Frame-Options: SAMEORIGIN`, `Cross-Origin-Opener-Policy` and
  `Cross-Origin-Resource-Policy: same-origin`; HSTS (1 year) when `PUBLIC_URL` is https. HSTS
  deliberately leaves out `includeSubDomains` and `preload`: they would affect the operator's other
  hosts.
- Article frame (`/frame.html`): `default-src 'none'`; scripts, styles, media and fonts only from the
  gateway's origin or inline (dictionaries need inline code); `connect-src`, `frame-src`, `form-action`
  `'none'`.
- Dictionary resources (`/res/`, `/r/`): `Content-Security-Policy: sandbox; default-src 'none'; …`, so an
  HTML file opened directly gets an opaque origin; `Cache-Control: private`.

### Article iframes (ADR 0006)

- Untrusted dictionaries render in `sandbox="allow-scripts"` (opaque origin, no cookies); only
  dictionaries an admin marks `trusted_render` get `allow-same-origin allow-popups`.
- Messages from frames are checked for source window and shape (`parseFrameMessage`), heights are
  clamped, and link actions are limited to look-ups, audio from the gateway and external `http(s)` pages
  opened with `noopener,noreferrer`.
- Sandboxed frames load resources through `/r/<token>/…`: an HMAC (key derived from
  `BETTER_AUTH_SECRET` with HKDF) over user, expiry and dictionary, valid 1–2 hours, compared in constant
  time; a wrong token answers the same 404 as a missing file.

### wuDict isolation and logging

- wuDict listens on `127.0.0.1` with `AUTH=on`; browsers reach only the allowlisted routes with
  allowlisted query parameters and headers; wuDict's token is added by the gateway and never returned.
  The smoke test checks the 404s, the loopback binding and that no secret appears in the logs.
- Logs are JSON; passwords, tokens, cookies and `Authorization` values are never logged. The new
  debug-level access log records the route group (`/api/search`, `/app-api/me`, …), never the path or
  query, because those contain look-ups.

## Accepted risks

- **Trusted dictionaries run with the PXDict origin.** That is what `trusted_render` means; a proposal
  that ships scripts gets a warning at review, and the flag is off by default.
- **Signed resource URLs are bearer capabilities** for 1–2 hours, the same exposure as the article HTML
  that contains them.
- **Session tokens are stored unhashed** by Better Auth, so `pxdict.db` and its backups are secrets
  ([ADR 0004](adr/0004-typescript-gateway-better-auth.md)); backups are encrypted (`scripts/backup.sh`).
- **Endpoints without a custom rate limit** (e.g. `change-password`, which needs a session) fall under
  Better Auth's default of 100 requests per minute per address.

## Open items

- An outside review or penetration test of a deployed instance.
- The production checks in [`operations.md`](operations.md#verify-in-production) (Cloudflare cache rule,
  sandboxed frames through the tunnel, cookies and passkeys in installed PWAs).
