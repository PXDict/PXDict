// The user's default search mode (a setting from /app-api/me). Search URLs leave it out, so a link
// without `mode` searches the way the user chose.
import type { SearchMode } from "../api/wudict";

let defaultMode: SearchMode = "exact";

export function getDefaultMode(): SearchMode {
  return defaultMode;
}

export function setDefaultMode(mode: SearchMode): void {
  defaultMode = mode;
}
