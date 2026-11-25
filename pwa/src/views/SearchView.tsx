// The main screen: search box + results. The query lives in the URL (/?q=…&mode=…), so lookups are
// in the browser history and Android's share target (GET /?q=…) opens straight onto a result. A URL
// without `mode` uses the user's default search mode.
import { useEffect, useState } from "preact/hooks";
import { deleteFavorite, getFavorites, getHistory, saveFavorite } from "../api/app";
import { listDicts, searchModes, type GatewayDict, type SearchMode } from "../api/wudict";
import { t } from "../i18n";
import { navigate, type Location } from "../lib/router";
import { getDefaultMode } from "../lib/search-prefs";
import { Results } from "./Results";
import { SearchBox } from "./SearchBox";

export function isMode(v: string | null): v is SearchMode {
  return v !== null && (searchModes as readonly string[]).includes(v);
}

/** The query from the URL; share targets may send the text as `q`, `title` or `url`. */
export function queryFrom(params: URLSearchParams): { q: string; mode: SearchMode; only?: string } {
  const raw = params.get("q") ?? params.get("title") ?? params.get("url") ?? "";
  const q = raw.trim().slice(0, 500);
  const mode = params.get("mode");
  const only = params.get("dict");
  return { q, mode: isMode(mode) ? mode : getDefaultMode(), ...(only ? { only } : {}) };
}

export function searchPath(q: string, mode: string, only?: string): string {
  const p = new URLSearchParams();
  if (q) p.set("q", q);
  if (mode !== getDefaultMode() && isMode(mode)) p.set("mode", mode);
  if (only) p.set("dict", only);
  const s = p.toString();
  return s ? `/?${s}` : "/";
}

/** Key of a saved word in the favorites set. */
export const favoriteKey = (dictId: string, headword: string) => `${dictId}\n${headword}`;

/** Recent distinct lookups offered while the search box is empty. */
const recentCount = 8;

export function SearchView({ loc, historyEnabled }: { loc: Location; historyEnabled: boolean }) {
  const { q, mode, only } = queryFrom(loc.query);
  const [dicts, setDicts] = useState<ReadonlyMap<string, GatewayDict>>(new Map());
  const [saved, setSaved] = useState<ReadonlySet<string> | null>(null);
  const [recent, setRecent] = useState<string[]>([]);

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
    getFavorites(ctrl.signal).then(
      (list) => {
        setSaved(new Set(list.map((f) => favoriteKey(f.dictId, f.headword))));
      },
      () => {
        // Offline: no save buttons.
      },
    );
    return () => {
      ctrl.abort();
    };
  }, []);

  // Recent lookups, refreshed after each search.
  useEffect(() => {
    if (!historyEnabled) {
      setRecent([]);
      return;
    }
    const ctrl = new AbortController();
    getHistory({ unique: true, limit: recentCount }, ctrl.signal).then(
      (page) => {
        setRecent(page.entries.map((e) => e.query));
      },
      () => {
        // Offline: no recent searches.
      },
    );
    return () => {
      ctrl.abort();
    };
  }, [q, historyEnabled]);

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

  const toggleSaved = (dictId: string, headword: string) => {
    if (!saved) return;
    const key = favoriteKey(dictId, headword);
    const was = saved.has(key);
    const flip = (on: boolean) => {
      setSaved((s) => {
        const next = new Set(s);
        if (on) next.add(key);
        else next.delete(key);
        return next;
      });
    };
    flip(!was);
    (was ? deleteFavorite(headword, dictId) : saveFavorite({ headword, dictId })).catch(() => {
      flip(was);
    });
  };

  return (
    <>
      <SearchBox
        query={q}
        mode={mode}
        recent={recent}
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
          saved={saved}
          onToggleSaved={toggleSaved}
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
