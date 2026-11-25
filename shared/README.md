# shared

`@pxdict/shared`: the contract between the gateway and the PWA.

- `src/api/`: zod schemas for every `/app-api` request and response body. The gateway validates with
  them; the PWA imports only their inferred types (`import type`), so zod is not bundled into the PWA.
- `src/wudict.schema.d.ts`: wuDict's API types, generated from its `openapi.yaml` at the tag in
  [`../WUDICT_VERSION`](../WUDICT_VERSION). Named aliases live in `src/wudict.ts`
  (`import type { DictInfo } from "@pxdict/shared/wudict"`).

```bash
npm run gen:api                # regenerate src/wudict.schema.d.ts (from the repository root)
npm run gen:api -- --check     # fail if it is stale (CI)
```

No Node- or DOM-specific code here; the only runtime dependency is zod.
