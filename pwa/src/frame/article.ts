// Rendering dictionary articles (docs/PLAN.md Phase 4, ADR 0006).
//
// Articles are untrusted HTML with their own CSS and JS. Each one renders in an iframe loading
// /frame.html, sandboxed to an opaque origin ("style B") unless an admin marked the dictionary
// trusted ("style A", same-origin). The page posts the whole article document to the frame; a small
// runtime inside it reports its height and every link click back to the page, which decides what a
// link does: look up another word, play audio, or open an external page in a new tab.
import { isAudio, resourceUrl } from "../api/wudict";

declare const __FRAME_VERSION__: string;

/** /frame.html with its content hash, so browsers may cache it for long (it is served immutable). */
export const frameSrc = `/frame.html?v=${typeof __FRAME_VERSION__ === "string" ? __FRAME_VERSION__ : "dev"}`;

/** sandbox attribute per rendering style. */
export function sandboxFor(trusted: boolean): string {
  return trusted ? "allow-scripts allow-same-origin allow-popups" : "allow-scripts";
}

/**
 * Runs inside the frame: height sync and link interception. Kept small and dependency-free. It sits in
 * <head>, before the article, so unbalanced article markup cannot swallow it.
 */
const runtime = `(function(){
var post=function(m){parent.postMessage(m,"*")};var last=-1;
function size(){var h=Math.ceil(document.documentElement.scrollHeight);if(h!==last){last=h;post({type:"pxdict:height",height:h})}}
document.addEventListener("DOMContentLoaded",function(){
if(typeof ResizeObserver==="function"){new ResizeObserver(size).observe(document.body)}size()});
addEventListener("load",size);setTimeout(size,500);
document.addEventListener("click",function(e){
var t=e.target;var a=t&&t.closest?t.closest("a[href]"):null;if(!a)return;
var href=a.getAttribute("href")||"";if(href.charAt(0)==="#")return;
e.preventDefault();post({type:"pxdict:link",href:href});
},true);
})();`;

export interface ArticleOptions {
  /** Article HTML from /api/search (resource URLs already signed). */
  body: string;
  theme: "light" | "dark";
  lang: string;
}

const baseCss = (theme: "light" | "dark") => `
:root{color-scheme:${theme}}
html,body{margin:0;padding:0;background:transparent}
body{font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:${theme === "dark" ? "#e6e9ed" : "#1b1f24"};overflow-wrap:anywhere;padding:2px 0}
img,video{max-width:100%;height:auto}
a{color:${theme === "dark" ? "#7cb4ff" : "#0b5cd5"}}`;

const escapeAttr = (s: string) => s.replace(/[&"<>]/g, (c) => `&#${String(c.charCodeAt(0))};`);

/** The document posted into /frame.html for one article. */
export function articleDocument({ body, theme, lang }: ArticleOptions): string {
  return `<!doctype html><html lang="${escapeAttr(lang)}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><style>${baseCss(theme)}</style>` +
    `<script>${runtime}</script></head><body>${body}</body></html>`;
}

/** A message from a frame, validated (frames run untrusted code: anything may arrive). */
export type FrameMessage =
  | { type: "ready" }
  | { type: "height"; height: number }
  | { type: "link"; href: string };

/** Largest height a frame may ask for (px). */
export const maxFrameHeight = 50_000;

export function parseFrameMessage(data: unknown): FrameMessage | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const d = data as Record<string, unknown>;
  switch (d.type) {
    case "pxdict:ready":
      return { type: "ready" };
    case "pxdict:height":
      return typeof d.height === "number" && Number.isFinite(d.height)
        ? { type: "height", height: Math.min(Math.max(0, Math.round(d.height)), maxFrameHeight) }
        : undefined;
    case "pxdict:link":
      return typeof d.href === "string" && d.href.length <= 4096 ? { type: "link", href: d.href } : undefined;
    default:
      return undefined;
  }
}

/** What a link clicked inside an article does. */
export type LinkAction =
  | { kind: "lookup"; word: string }
  | { kind: "audio"; url: string }
  | { kind: "external"; url: string }
  | { kind: "none" };

/** Decides what a link from an article does; anything unexpected does nothing. */
export function linkAction(href: string, origin: string = location.origin): LinkAction {
  const cross = /^(?:entry|bword):\/\/(.*)$/i.exec(href.trim());
  if (cross) {
    let word = cross[1] ?? "";
    try {
      word = decodeURIComponent(word);
    } catch {
      // Keep it as written.
    }
    word = word.replace(/#.*$/, "").replace(/\/+$/, "").trim();
    return word ? { kind: "lookup", word } : { kind: "none" };
  }
  const res = resourceUrl(href, origin);
  if (res) return isAudio(res) ? { kind: "audio", url: res.href } : { kind: "none" };
  try {
    const url = new URL(href);
    if ((url.protocol === "https:" || url.protocol === "http:") && url.origin !== origin) {
      return { kind: "external", url: url.href };
    }
  } catch {
    // Relative or malformed: nothing to do.
  }
  return { kind: "none" };
}
