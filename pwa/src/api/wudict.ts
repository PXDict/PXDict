// The ONLY adapter for wuDict's routes (/api/*, /res/*), always reached through the gateway.
// Types come from @pxdict/shared/wudict, generated from wuDict's openapi.yaml at the pinned tag.
// Lookup calls are implemented in Phase 4.
export type { DictInfo } from "@pxdict/shared/wudict";

export { readNdjson } from "./http";
