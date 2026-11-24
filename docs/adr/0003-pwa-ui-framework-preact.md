# 0003. Preact for the PWA UI

- Status: accepted
- Date: 2026-11-24

## Context

The PWA ([PLAN.md](../PLAN.md), Phase 1) needs a component framework. It runs on phones, often on
slow networks, and is served by a small VPS. Its screens (search, results, history, settings,
admin pages) are forms and lists, not heavy interactive graphics. The plan suggested Preact or
Svelte.

## Decision

Use **Preact** (with `@preact/preset-vite`), TypeScript JSX (`jsxImportSource: "preact"`) and Preact
hooks. No router or state library yet; add one only with a justification in the PR.

- Preact is ~4 KB gzipped, so the initial bundle stays small.
- It is plain TypeScript + JSX: `tsc` type-checks templates without a separate compiler or language
  server, and `typescript-eslint` covers all UI code (including the "no direct `fetch`" rule).
- The React-style API is widely known, which helps contributors and AI agents.

Rejected: **Svelte** (also small, but templates need `svelte-check` and a separate compiler toolchain;
type errors in templates are caught by a different tool than the rest of the code); **React** (much
larger bundle for no benefit here); no framework (too much hand-written DOM code for the admin UI).

## Consequences

- Components live in `pwa/src/**/*.tsx`; tests use Vitest + jsdom and render with `preact`'s `render`.
- If a React-only library is ever needed, `preact/compat` is available, at some size cost.
