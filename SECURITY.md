# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's
[private vulnerability reporting](https://github.com/thanhhvnqb/PXDict/security/advisories/new)
instead. Include steps to reproduce, the affected version or commit, and the impact you expect.

You should receive an acknowledgement within 7 days.

## Scope

In scope: the gateway (`gateway/`), the PWA (`pwa/`), the container image and deployment files.

Vulnerabilities in wuDict itself should be reported upstream at <https://github.com/PXDict/wudict>.

## Threat model notes

- Dictionary content (HTML/CSS/JS inside dictionaries) is treated as **untrusted** and rendered in a
  sandboxed iframe by default.
- wuDict listens on loopback only; its access token never leaves the gateway.
- See section 6 of [`AGENTS.md`](AGENTS.md) for the security invariants the code must keep.
