// Named types for wuDict's API, from wudict.schema.d.ts (generated from wuDict's openapi.yaml at the
// tag in ../../WUDICT_VERSION by `npm run gen:api`). Both the gateway's proxy and the PWA use them.
import type { components } from "./wudict.schema";

export type { components as WudictComponents, paths as WudictPaths } from "./wudict.schema";

export type DictInfo = components["schemas"]["DictInfo"];
