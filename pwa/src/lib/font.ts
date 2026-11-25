// Text size: a per-user setting (synced through /app-api/me/settings), cached on the device so the
// app starts at the right size, also offline.
import type { UserSettings } from "@pxdict/shared";
import { readLocal, writeLocal } from "./storage";

export type FontPref = UserSettings["fontSize"];
export const fontPrefs: readonly FontPref[] = ["small", "medium", "large", "xlarge"];

/** Root font-size factor per setting; article frames use the same factor. */
export const fontScale: Record<FontPref, number> = { small: 0.875, medium: 1, large: 1.125, xlarge: 1.25 };

const key = "pxdict.font";

export function getFontPref(): FontPref {
  const v = readLocal(key);
  return (fontPrefs as readonly string[]).includes(v ?? "") ? (v as FontPref) : "medium";
}

export function applyFont(pref: FontPref = getFontPref()): void {
  const root = document.documentElement;
  if (pref === "medium") delete root.dataset.font;
  else root.dataset.font = pref;
}

export function setFontPref(pref: FontPref): void {
  writeLocal(key, pref === "medium" ? null : pref);
  applyFont(pref);
}
