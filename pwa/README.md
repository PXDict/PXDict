# pwa

The PXDict Progressive Web App: Vite + strict TypeScript + Preact
([ADR 0003](../docs/adr/0003-pwa-ui-framework-preact.md)). First usable in Phase 4.

```bash
npm ci
npm run dev          # Vite on :5173, backend paths proxied to the gateway (PXDICT_GATEWAY_URL)
npm run typecheck && npm run lint && npm test
npm run build        # dist/, assets under dist/app-assets/
npm run gen:api      # regenerate src/api/*.schema.d.ts (add `-- --check` to verify)
```

- All network calls go through `src/api/` (`app.ts` for `/app-api`, `wudict.ts` for wuDict routes);
  ESLint rejects `fetch` anywhere else.
- UI strings live in `src/i18n/en.json` (source) and `vi.json`; a test checks both have the same keys.
- `src/api/wudict.schema.d.ts` comes from wuDict's `openapi.yaml` at the tag in `../WUDICT_VERSION`.
