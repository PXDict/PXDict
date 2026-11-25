// A tiny History API router: the PWA has a handful of screens, so no router library (ADR 0003).
import { useEffect, useState } from "preact/hooks";

const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

addEventListener("popstate", notify);

export interface Location {
  path: string;
  query: URLSearchParams;
}

function current(): Location {
  return { path: location.pathname, query: new URLSearchParams(location.search) };
}

/** Goes to `to` (path + optional query); `replace` keeps the history entry count. */
export function navigate(to: string, replace = false): void {
  if (to === location.pathname + location.search) return;
  if (replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  notify();
}

/** The current location; re-renders on navigation. */
export function useLocation(): Location {
  const [loc, setLoc] = useState(current);
  useEffect(() => {
    const update = () => {
      setLoc(current());
    };
    listeners.add(update);
    return () => {
      listeners.delete(update);
    };
  }, []);
  return loc;
}

/**
 * A same-origin path to return to after signing in, from `?next=`; "/" for anything else (an absolute
 * or protocol-relative URL would be an open redirect).
 */
export function safeNext(raw: string | null): string {
  if (!raw?.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  return raw;
}

/** The login URL that comes back to the current page. */
export function loginUrl(): string {
  const here = location.pathname + location.search;
  return here === "/" || here.startsWith("/login") ? "/login" : `/login?${new URLSearchParams({ next: here }).toString()}`;
}
