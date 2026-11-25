# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Project documentation: `AGENTS.md`, phased plan (`docs/PLAN.md`), original design archive, ADRs.
- Phase 0: verified wuDict v3.7.11 behaviour (`docs/wudict-notes.md`), ADR 0002 (build wuDict from
  source as purego), spike helpers in `scripts/spike/`, GPL-3.0-or-later `LICENSE`.
- Phase 1: npm workspace (`shared/`, `gateway/`, `pwa/`) with one ESLint config and lockfile; TypeScript
  gateway skeleton on Node.js + Hono (env config, `/healthz`, JSON error shape, JSON logs, graceful
  shutdown, esbuild bundle); `@pxdict/shared` zod contract and generated wuDict types (`npm run gen:api`);
  Preact + Vite + strict TypeScript PWA with Vitest and `en`/`vi` i18n; `scripts/dev.sh`; CI workflow;
  ADR 0003 (Preact).
- ADR 0004: the gateway is TypeScript and uses Better Auth for self-managed accounts with several sign-in
  methods (password, passkeys, social and OIDC providers, email link/code, two-factor).

### Changed
- Reference wuDict version is v3.7.11 (v3.7.12 is only a pre-release).
- The first Go gateway skeleton was replaced by TypeScript; Cloudflare Access is no longer part of the
  design (PXDict accounts are the only login layer).
- Target runtime is Node.js 26 LTS (`.nvmrc`, `engines >=26.13.0`, esbuild target `node26`,
  `@types/node` 26, planned `node:26-alpine` image).
