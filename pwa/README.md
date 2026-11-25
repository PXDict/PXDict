# pwa

The PXDict Progressive Web App: Vite + strict TypeScript + Preact
([ADR 0003](../docs/adr/0003-pwa-ui-framework-preact.md)).

```bash
npm run dev -w @pxdict/pwa       # Vite on :5173, backend paths proxied to the gateway (PXDICT_GATEWAY_URL)
npm test -w @pxdict/pwa
npm run build -w @pxdict/pwa     # dist/, assets under dist/app-assets/
```

Install, typecheck and lint run from the repository root (`npm ci`, `npm run typecheck`, `npm run lint`).

- All network calls go through `src/api/` (`app.ts` for `/app-api`, which re-exports the Better Auth
  client wrapper in `auth.ts`; `wudict.ts` for wuDict routes); ESLint rejects `fetch` anywhere else
  except the service worker.
- Screens live in `src/views/` (`Login`, `SearchView` + `Results`, `Account`); a tiny History API router
  is in `src/lib/router.ts`.
- Articles render in iframes loading `public/frame.html` (sandboxed unless the dictionary is
  `trustedRender`); `src/frame/article.ts` holds the message protocol
  ([ADR 0006](../docs/adr/0006-article-rendering-and-offline.md)).
- The service worker (`src/sw/sw.ts`, production builds only) precaches the app and keeps lookups,
  resources and the dictionary list in per-user caches (`src/lib/cache-names.ts`), deleted on logout.
- Icons are drawn by `node scripts/gen-icons.mjs` (no image tools needed); rerun it after changing the
  icon.
- Types for both APIs come from [`@pxdict/shared`](../shared/) (type-only imports).
- UI strings live in `src/i18n/en.json` (source) and `vi.json`; a test checks both have the same keys.
