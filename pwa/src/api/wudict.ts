// The ONLY adapter for wuDict's routes (/api/*, /res/*), always reached through the gateway.
// Types come from wudict.schema.d.ts, generated from wuDict's openapi.yaml at the pinned tag.
// Lookup calls are implemented in Phase 4.
import type { components } from "./wudict.schema";

export { readNdjson } from "./http";

export type DictInfo = components["schemas"]["DictInfo"];
