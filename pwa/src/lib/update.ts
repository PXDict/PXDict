// "A new version is available" state, set by the service worker registration in main.tsx
// (registerType "prompt": the app updates only when the user agrees).
type Listener = (waiting: boolean) => void;

let waiting = false;
let apply: (() => Promise<void>) | undefined;
const listeners = new Set<Listener>();

/** Called by the registration when a new service worker is waiting. */
export function setUpdateWaiting(update: () => Promise<void>): void {
  waiting = true;
  apply = update;
  for (const l of listeners) l(true);
}

export function isUpdateWaiting(): boolean {
  return waiting;
}

export function onUpdateWaiting(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Activates the waiting service worker and reloads the page. */
export async function applyUpdate(): Promise<void> {
  await apply?.();
}
