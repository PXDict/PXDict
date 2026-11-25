// localStorage for per-device conveniences (theme, language, last user). Every access may throw
// (private mode, blocked storage), so failures fall back to defaults.

export function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeLocal(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the preference lasts for this page only.
  }
}
