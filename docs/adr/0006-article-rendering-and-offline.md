# 0006. Rendering dictionary articles and keeping them offline

- Status: accepted
- Date: 2026-11-25

## Context

Phase 4 renders wuDict's article HTML in the PWA. Articles are untrusted: they carry their own CSS,
inline and external JavaScript, images, fonts and audio, and user-proposed dictionaries (Phase 6) may be
hostile. The plan asks for "style B" by default (an iframe with `sandbox="allow-scripts"`, so an opaque
origin) with signed `/r/<token>/<dict>/<path>` resource URLs, "style A" (same-origin) only for
dictionaries an admin marks `trusted_render`, and earlier lookups viewable offline.

Three browser rules shape the design:

1. **`srcdoc` and `blob:` frames inherit the parent's CSP.** The PWA's policy is `script-src 'self'`,
   which would block every inline script in an article (and our own height/link runtime). Loosening the
   PWA's own CSP to allow inline scripts is not acceptable.
2. **Opaque-origin frames send no cookies** and cannot be scripted by the parent, so resources need a
   credential in the URL, and everything the frame needs must be posted to it.
3. **A sandboxed frame without `allow-same-origin` is not controlled by the service worker.** Its
   navigation and subresource requests go to the network and the browser's HTTP cache only.

## Decision

- Articles render in an iframe whose `src` is a static page, **`/frame.html`**, served by the gateway
  with its **own CSP** (`script-src <origin> 'unsafe-inline'`, styles/images/media/fonts only from the
  gateway or `data:`, `connect-src 'none'`, `form-action 'none'`, `frame-ancestors 'self'`). The origin
  is spelled out instead of `'self'`, which is ambiguous in an opaque-origin document.
- `frame.html` posts `pxdict:ready` to its parent; the parent answers **once** with `pxdict:render`
  carrying a complete article document, which the frame writes with `document.open/write/close`. That
  document starts with a small runtime in `<head>` (before the untrusted markup) that reports its height
  (`pxdict:height`, `ResizeObserver`) and every link click (`pxdict:link`). The parent accepts messages
  only from that frame's window with the expected origin (`"null"`, or its own for style A), validates
  them, and decides what a link does: `entry://`/`bword://` → a new lookup, an audio file under
  `/res/` or `/r/` → played in the parent, `http(s)` elsewhere → a new tab with `noopener,noreferrer`,
  anything else → nothing.
- Style B: `sandbox="allow-scripts"`. Style A (`trusted_render`): `allow-scripts allow-same-origin
  allow-popups`, same page and protocol. The gateway adds `trustedRender` to each `/api/dicts` row; until
  admins can set the flag (Phase 6) every dictionary is style B.
- `/api/search` bodies have their `/res/<dict>/` prefix rewritten to `/r/<token>/<dict>/`, with
  token = base64url(`<userId>:<expiresAt>`) + `.` + HMAC-SHA256 (key derived from `BETTER_AUTH_SECRET`
  with HKDF) over the payload and the dictionary id. Expiry is rounded up to whole hours (valid 1–2 h),
  so the same lookup yields the same URLs for a while. `/r/*` checks the token and that the user may
  still use the dictionary, then serves the resource like `/res/*` plus `Access-Control-Allow-Origin: *`
  (fonts are CORS requests from an opaque origin; the URL, not a cookie, is the credential).
- **Offline:** the service worker caches `/api/search` (network first) and `/res/` + `/r/` (cache
  first, keyed without the token) in per-user caches. Because style-B frames bypass the service worker,
  they rely on the HTTP cache instead: the PWA links `/frame.html?v=<content hash>`, served
  `immutable` for a year, and `/r/*` answers are `private, max-age=2592000`. A cached search replays the
  exact `/r/` URLs the frame fetched before, so they are fresh HTTP-cache hits offline. Audio is played
  by the parent (controlled by the service worker), so played audio is cached there.

## Consequences

- Untrusted article scripts run in an opaque origin with no network access beyond loading gateway
  resources, cannot read the PWA's storage or cookies, and cannot submit forms or fetch.
- A signed URL is a capability: anyone holding one can read that dictionary's resources until it
  expires (≤ 2 h for the network; a browser may keep its cached copy for 30 days). It is no more than
  what the article HTML that contains it already reveals. The user id is visible in the token.
- Offline viewing of style-B articles depends on the browser keeping its HTTP cache; browsers may evict
  it under storage pressure (the service worker's caches are more durable). This has to be checked on
  Android Chrome and iOS Safari with installed PWAs, together with whether those browsers really bypass
  the service worker for sandboxed frames (if they do not, the service worker's `/r/` route covers them).
- Dictionary JavaScript that needs network access, `localStorage` or same-origin DOM access does not
  work in style B; admins can mark such a dictionary `trusted_render` once Phase 6 lands.
