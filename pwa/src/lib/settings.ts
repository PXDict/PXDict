// Applies the signed-in user's settings (from /app-api/me) on this device: language, theme, text size.
// Each is also cached locally (theme.ts, font.ts, i18n) so the next start, the login screen and offline
// use look the same before the server answers.
import type { UserSettings } from "../api/app";
import { followDeviceLocale, locales, setLocalePref, type Locale } from "../i18n";
import { setFontPref } from "./font";
import { setDefaultMode } from "./search-prefs";
import { setThemePref } from "./theme";

const isLocale = (v: string): v is Locale => (locales as readonly string[]).includes(v);

export function applySettings(s: UserSettings): void {
  setThemePref(s.theme);
  setFontPref(s.fontSize);
  setDefaultMode(s.defaultMode);
  const base = s.uiLang?.toLowerCase().split("-")[0] ?? "";
  if (isLocale(base)) {
    setLocalePref(base);
  } else {
    followDeviceLocale(navigator.languages);
  }
}
