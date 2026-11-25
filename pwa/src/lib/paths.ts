// Paths owned by the gateway or wuDict (gateway/src/wudict/routes.ts reservedRoots): the service
// worker must never answer them with the app shell.
export const reservedPathPattern =
  /^\/(?:api|res|r|app-api|assets|style|files|setup|lemmas|groups|browse|healthz|wudict-admin)(?:\/|$)/;
