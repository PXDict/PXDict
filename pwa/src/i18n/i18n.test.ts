import { afterEach, describe, expect, it } from "vitest";
import { catalogs, locales, negotiateLocale, setLocale, sourceLocale, t } from "./index";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("catalogs", () => {
  const source = catalogs[sourceLocale] as Record<string, string>;

  for (const locale of locales) {
    it(`${locale} has the same keys and placeholders as ${sourceLocale}`, () => {
      const messages = catalogs[locale] as Record<string, string>;
      expect(Object.keys(messages).sort()).toEqual(Object.keys(source).sort());
      for (const [key, text] of Object.entries(source)) {
        expect(placeholders(messages[key] ?? ""), key).toEqual(placeholders(text));
      }
    });
  }
});

describe("t", () => {
  afterEach(() => {
    setLocale(sourceLocale);
  });

  it("substitutes placeholders and keeps unknown ones", () => {
    expect(t("status.ok", { version: "1.2.3" })).toBe("Server is up (version 1.2.3).");
    expect(t("status.ok")).toBe("Server is up (version {version}).");
  });

  it("uses the current locale", () => {
    setLocale("vi");
    expect(t("app.tagline")).toBe("Từ điển nhiều người dùng");
    expect(document.documentElement.lang).toBe("vi");
  });
});

describe("negotiateLocale", () => {
  it.each([
    [["vi-VN", "en"], "vi"],
    [["fr", "en-US"], "en"],
    [["fr"], "en"],
    [[], "en"],
  ])("%j → %s", (preferred, want) => {
    expect(negotiateLocale(preferred)).toBe(want);
  });
});
