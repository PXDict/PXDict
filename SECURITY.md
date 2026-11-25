# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's
[private vulnerability reporting](https://github.com/thanhhvnqb/PXDict/security/advisories/new)
instead. Include steps to reproduce, the affected version or commit, and the impact you expect.

You should receive an acknowledgement within 7 days.

## Scope

In scope: the gateway (`gateway/`), the shared contract (`shared/`), the PWA (`pwa/`), the container
image and deployment files. Vulnerabilities in [Better Auth](https://github.com/better-auth/better-auth)
itself should also be reported upstream; tell us too if PXDict's configuration makes it exploitable.

Vulnerabilities in wuDict itself should be reported upstream at <https://github.com/PXDict/wudict>.

## Threat model notes

- Dictionary content (HTML/CSS/JS inside dictionaries) is treated as **untrusted** and rendered in a
  sandboxed iframe by default.
- wuDict listens on loopback only; its access token never leaves the gateway.
- Accounts and sign-in (password, passkeys, OAuth/OIDC, email links/codes, two-factor) are handled by
  Better Auth inside the gateway; there is no outer login layer.
- See section 6 of [`AGENTS.md`](AGENTS.md) for the security invariants the code must keep.
