// Minimal i18n: English is the source locale; every other locale must have exactly the same keys.
// Placeholders use {name}.
import { readLocal, writeLocal } from "../lib/storage";
import en from "./en.json";
import vi from "./vi.json";

export type MessageKey = keyof typeof en;
export type Messages = Record<MessageKey, string>;

export const catalogs = { en, vi } satisfies Record<string, Messages>;
export type Locale = keyof typeof catalogs;
export const locales = Object.keys(catalogs) as Locale[];
export const sourceLocale: Locale = "en";

/** Each locale's name in its own language, for the language picker. */
export const localeNames: Record<Locale, string> = { en: "English", vi: "Tiếng Việt" };

let current: Locale = sourceLocale;

function isLocale(tag: string): tag is Locale {
  return Object.hasOwn(catalogs, tag);
}

/** Picks the first supported locale from a list of BCP 47 tags (e.g. navigator.languages). */
export function negotiateLocale(preferred: readonly string[]): Locale {
  for (const tag of preferred) {
    const base = tag.toLowerCase().split("-")[0] ?? "";
    if (isLocale(base)) return base;
  }
  return sourceLocale;
}

const listeners = new Set<() => void>();

export function setLocale(locale: Locale): void {
  current = locale;
  document.documentElement.lang = locale;
  for (const l of listeners) l();
}

/** Called after every locale change (the app re-renders). Returns an unsubscribe function. */
export function onLocaleChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const prefKey = "pxdict.lang";

/** The locale picked on this device, else the browser's languages. */
export function initialLocale(preferred: readonly string[]): Locale {
  const saved = readLocal(prefKey);
  return saved !== null && isLocale(saved) ? saved : negotiateLocale(preferred);
}

/** Remembers a locale for this device and switches to it. */
export function setLocalePref(locale: Locale): void {
  writeLocal(prefKey, locale);
  setLocale(locale);
}

export function getLocale(): Locale {
  return current;
}

/** Translates key in the current locale, substituting {name} placeholders from params. */
export function t(key: MessageKey, params: Record<string, string | number> = {}): string {
  const template = catalogs[current][key];
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}
