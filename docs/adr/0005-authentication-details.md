# 0005. Authentication implementation details

- Status: accepted
- Date: 2026-11-25

## Context

Phase 3 implements accounts with Better Auth ([ADR 0004](0004-typescript-gateway-better-auth.md)).
Building it showed a few places where Better Auth's defaults do not match `AGENTS.md` §6 or where the
plan left the mechanism open:

- Better Auth checks `Origin` only on requests that **carry cookies**. A cookie-less cross-site
  `POST /sign-in/email` is accepted, which allows login CSRF, and the AGENTS.md rule covers every
  state-changing `/app-api` request.
- Better Auth reads the client address for rate limits **only from headers** (default
  `X-Forwarded-For`). With the gateway exposed directly, any client could set that header and get a
  fresh rate-limit bucket per request.
- The plan passes invite codes "through sign-up or the OAuth state". OAuth state is created by Better
  Auth's endpoint and is not readable from the user-create hook in a uniform way; magic links and email
  codes have no state at all.
- Better Auth's cookie cache keeps a session valid in a signed cookie for its `maxAge`, so a ban or a
  revoked session is not seen until it expires.
- The admin bootstrap needs an email address, but the plan also allows starting with no admin
  settings at all.

## Decision

- **Origin check in front of Better Auth.** PXDict's own origin middleware runs on every non-GET request
  to `/app-api/auth/*` as well, except the OAuth callback (`/app-api/auth/callback/<id>`), which
  providers may POST cross-site (Apple, `response_mode=form_post`) and which is protected by the state
  parameter and its cookie.
- **Client IP.** The gateway computes the client address itself and hands it to Better Auth in a header
  it controls (`x-pxdict-client-ip`, always replaced). By default it is the TCP peer address; with
  `CLIENT_IP_HEADER` set (e.g. `cf-connecting-ip`, or `x-forwarded-for`, whose last entry is used) it
  is read from a header that a trusted reverse proxy sets.
- **Invite codes travel in a cookie.** `POST /app-api/auth/invite {code}` checks the code and stores
  it in a 30-minute `HttpOnly`, `SameSite=Lax` cookie scoped to `/app-api/auth`. The user-create hook
  reserves it atomically (one `UPDATE … WHERE used_at IS NULL`), so the same code works for every
  sign-up method. A code is burnt even if that sign-up then fails. Only the SHA-256 of a code is stored.
- **Sessions.** Cookie cache of **60 seconds**. User routes accept the cached session; admin routes and
  Better Auth's admin endpoints always read the database (`disableCookieCache`), so a ban, demotion or
  revocation is immediate there and takes at most a minute elsewhere. Sliding expiry of 30 days,
  renewed at most daily.
- **Bootstrap without settings.** With no admin and no `ADMIN_EMAIL`, the gateway creates the user
  `admin` with the placeholder address `admin@pxdict.invalid` and logs a random one-time password (the
  only password ever logged). With `ADMIN_EMAIL` but no `ADMIN_PASSWORD`, the same happens for that
  address; an existing account with that address is promoted instead.
- **Passkeys can be turned off** with `AUTH_PASSKEY=false` (on by default), e.g. while `PUBLIC_URL` is
  not yet final: credentials are bound to its host name.
- **The last admin** (role `admin`, not banned) cannot be demoted, banned or removed by anyone; enforced
  in a Better Auth `before` hook on the admin endpoints.

## Consequences

- Non-browser API clients must send `Origin: <PUBLIC_URL>` on every write, including sign-in.
- Behind a proxy that is not configured in `CLIENT_IP_HEADER`, every client shares the proxy's address
  for rate limits: sign-in limits then apply to everyone together. The deployment guide (Phase 9) must
  set it for Cloudflare tunnels and reverse proxies.
- Apple sign-in with `REGISTRATION=invite`: Apple's callback is a cross-site POST, so the `Lax` invite
  cookie is not sent and invited users cannot sign up with Apple directly (they can sign up another
  way and link Apple afterwards).
- Deleting a user removes their sessions, accounts, passkeys and two-factor data (foreign keys). The
  per-user tables of later phases must reference `user.id` with `ON DELETE CASCADE`; asking what to do
  with a deleted user's proposals is part of Phase 6.
