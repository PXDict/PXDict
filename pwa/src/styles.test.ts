// Colour contrast of the theme tokens in styles.css (WCAG 2.2 AA, docs/PLAN.md Phase 10): 4.5:1 for
// text, 3:1 for the boundaries of form fields (1.4.11 non-text contrast). Runs on the stylesheet's
// source, so a new colour that is too faint fails here instead of in an audit.
import { describe, expect, it } from "vitest";
import css from "./styles.css?raw";

/** Custom properties declared in the first block that starts with `selector {`. */
function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no block ${selector}`);
  const body = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries([...body.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => [m[1] ?? "", m[2] ?? ""]));
}

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** [foreground, background, minimum ratio] by token name. */
const pairs: [string, string, number][] = [
  ["fg", "bg", 4.5],
  ["fg", "surface", 4.5],
  ["fg", "error-bg", 4.5],
  ["fg", "info-bg", 4.5],
  ["muted", "bg", 4.5],
  ["muted", "surface", 4.5],
  ["muted", "error-bg", 4.5],
  ["muted", "info-bg", 4.5],
  ["accent", "bg", 4.5],
  ["accent", "surface", 4.5],
  ["accent", "info-bg", 4.5],
  ["accent-fg", "accent", 4.5],
  ["danger", "bg", 4.5],
  ["danger", "surface", 4.5],
  ["danger", "error-bg", 4.5],
  ["field-border", "bg", 3],
  ["field-border", "surface", 3],
];

const light = tokens(":root");
const dark = tokens(':root[data-theme="dark"]');
const systemDark = tokens('  :root:not([data-theme="light"])');

describe("theme colour contrast", () => {
  it("defines the same tokens for the system and the explicit dark theme", () => {
    expect(systemDark).toEqual(dark);
    expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort());
  });

  for (const [name, theme] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    it.each(pairs)(`${name}: --%s on --%s is at least %d:1`, (fg, bg, min) => {
      const a = theme[fg];
      const b = theme[bg];
      expect(a, `--${fg}`).toBeDefined();
      expect(b, `--${bg}`).toBeDefined();
      expect(contrast(a ?? "", b ?? "")).toBeGreaterThanOrEqual(min);
    });
  }
});
