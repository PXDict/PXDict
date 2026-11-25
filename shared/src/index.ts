// Contract between pxdict-gateway and the PWA. Every /app-api request and response body has a zod
// schema here: the gateway validates with it, the PWA imports the inferred types with `import type`.
export * from "./api/error";
export * from "./api/health";
