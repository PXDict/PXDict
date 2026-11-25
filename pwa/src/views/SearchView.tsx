// The main screen: search box + results. The query lives in the URL (/?q=…&mode=…), so lookups are
// in the browser history and Android's share target (GET /?q=…) opens straight onto a result.
import { useEffect, useState } from "preact/hooks";
import { listDicts, searchModes, type GatewayDict, type SearchMode } from "../api/wudict";
import { t } from "../i18n";
import { navigate, type Location } from "../lib/router";
import { Results } from "./Results";
import { SearchBox } from "./SearchBox";

const defaultMode: SearchMode = "exact";

function isMode(v: string | null): v is SearchMode {
  return v !== null && (searchModes as readonly string[]).includes(v);
}

/** The query from the URL; share targets may send the text as `q`, `title` or `url`. */
export function queryFrom(params: URLSearchParams): { q: string; mode: SearchMode; only?: string } {
  const raw = params.get("q") ?? params.get("title") ?? params.get("url") ?? "";
  const q = raw.trim().slice(0, 500);
  const mode = params.get("mode");
  const only = params.get("dict");
  return { q, mode: isMode(mode) ? mode : defaultMode, ...(only ? { only } : {}) };
}

export function searchPath(q: string, mode: SearchMode, only?: string): string {
  const p = new URLSearchParams();
  if (q) p.set("q", q);
  if (mode !== defaultMode) p.set("mode", mode);
  if (only) p.set("dict", only);
  const s = p.toString();
  return s ? `/?${s}` : "/";
}

export function SearchView({ loc }: { loc: Location }) {
  const { q, mode, only } = queryFrom(loc.query);
  const [dicts, setDicts] = useState<ReadonlyMap<string, GatewayDict>>(new Map());

  useEffect(() => {
    const ctrl = new AbortController();
    listDicts(ctrl.signal).then(
      (list) => {
        setDicts(new Map(list.map((d) => [d.id, d])));
      },
      () => {
        // Offline without a cached list: results render sandboxed, which is always safe.
      },
    );
    return () => {
      ctrl.abort();
    };
  }, []);

  // Normalise a shared ?title= / ?url= into ?q= so reloads and history look the same.
  useEffect(() => {
    if (q && !loc.query.has("q")) navigate(searchPath(q, mode, only), true);
  }, [q, mode, only, loc.query]);

  useEffect(() => {
    document.title = q ? `${q} – ${t("app.name")}` : t("app.name");
  }, [q]);

  const lookup = (word: string) => {
    navigate(searchPath(word, mode));
    scrollTo(0, 0);
  };

  return (
    <>
      <SearchBox
        query={q}
        mode={mode}
        onSearch={(word, m) => {
          navigate(searchPath(word || q, m), !word);
        }}
      />
      {only && (
        <p class="muted small">
          {t("search.onlyOne", { name: dicts.get(only)?.name ?? only })}{" "}
          <button type="button" class="link" onClick={() => { navigate(searchPath(q, mode)); }}>
            {t("search.allDicts")}
          </button>
        </p>
      )}
      {q ? (
        <Results
          q={q}
          mode={mode}
          {...(only ? { only } : {})}
          dicts={dicts}
          onLookup={lookup}
          onOnly={(d) => {
            navigate(searchPath(q, mode, d));
          }}
        />
      ) : (
        <p class="muted hint-text">{t("search.hint")}</p>
      )}
    </>
  );
}
