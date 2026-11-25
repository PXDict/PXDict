# pwa

The PXDict Progressive Web App: Vite + strict TypeScript + Preact
([ADR 0003](../docs/adr/0003-pwa-ui-framework-preact.md)). First usable in Phase 4.

```bash
npm run dev -w @pxdict/pwa       # Vite on :5173, backend paths proxied to the gateway (PXDICT_GATEWAY_URL)
npm test -w @pxdict/pwa
npm run build -w @pxdict/pwa     # dist/, assets under dist/app-assets/
```

Install, typecheck and lint run from the repository root (`npm ci`, `npm run typecheck`, `npm run lint`).

- All network calls go through `src/api/` (`app.ts` for `/app-api`, `wudict.ts` for wuDict routes);
  ESLint rejects `fetch` anywhere else.
- Types for both APIs come from [`@pxdict/shared`](../shared/) (type-only imports).
- UI strings live in `src/i18n/en.json` (source) and `vi.json`; a test checks both have the same keys.
