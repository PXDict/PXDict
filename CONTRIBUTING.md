# Contributing to PXDict

Thanks for helping! A few rules keep the project consistent.

## Before you start

1. Read [`AGENTS.md`](AGENTS.md) — it applies to humans as well as AI agents.
2. Find the phase your change belongs to in [`docs/PLAN.md`](docs/PLAN.md). Keep each PR within one phase.
3. For anything that changes the architecture, open an issue or write an ADR in [`docs/adr/`](docs/adr/) first.

## Language

All code, comments, commits, PRs, issues and docs are written in **English**.
User-facing strings go through the i18n files (`pwa/src/i18n/`).

## Workflow

```bash
git switch -c feat/<short-name>
# make changes
npm ci
npm run typecheck && npm run lint && npm test
```

- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):
  `feat(gateway): add the wuDict proxy`, `fix(pwa): wipe caches on logout`.
- Tick the matching checklist item in `docs/PLAN.md` in the same PR.
- Add an entry under `Unreleased` in [`CHANGELOG.md`](CHANGELOG.md) for user-visible changes.
- Images, automatic wuDict updates and the release process are described in
  [`docs/releasing.md`](docs/releasing.md).

## Never commit

`.env` files, tokens, passwords, dictionary files (`*.mdx`, `*.mdd`, `*.zim`, …), or databases (`*.db`).
