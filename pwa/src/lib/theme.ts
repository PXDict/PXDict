// Light/dark theme: follows the system unless the user picked one on this device.
import { readLocal, writeLocal } from "./storage";

export type ThemePref = "system" | "light" | "dark";
export const themePrefs: readonly ThemePref[] = ["system", "light", "dark"];

const key = "pxdict.theme";

export function getThemePref(): ThemePref {
  const v = readLocal(key);
  return v === "light" || v === "dark" ? v : "system";
}

/** The theme in effect now. */
export function effectiveTheme(pref: ThemePref = getThemePref()): "light" | "dark" {
  if (pref !== "system") return pref;
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(pref: ThemePref = getThemePref()): void {
  const root = document.documentElement;
  if (pref === "system") delete root.dataset.theme;
  else root.dataset.theme = pref;
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute("content", effectiveTheme(pref) === "dark" ? "#14171b" : "#ffffff");
}

export function setThemePref(pref: ThemePref): void {
  writeLocal(key, pref === "system" ? null : pref);
  applyTheme(pref);
}
