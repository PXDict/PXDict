// Multi-dictionary results: one collapsible section per dictionary, in the user's order (the gateway
// sends slots in that order), each article in its own frame.
import { useEffect, useState } from "preact/hooks";
import { isNetworkError } from "../api/app";
import { search, type GatewayDict, type SearchMode } from "../api/wudict";
import { t } from "../i18n";
import { errorMessage } from "../lib/errors";
import { applyLine, emptySearch, type SearchState, type Slot } from "../lib/results";
import { ArticleFrame } from "./ArticleFrame";
import { Notice } from "./Field";

/** Articles shown per dictionary before "show more". */
const initialArticles = 5;

export interface ResultsProps {
  q: string;
  mode: SearchMode;
  /** Restrict to these dictionaries (e.g. "search only this dictionary"). */
  only?: string;
  dicts: ReadonlyMap<string, GatewayDict>;
  onLookup: (word: string) => void;
  onOnly: (dict: string) => void;
}

export function Results({ q, mode, only, dicts, onLookup, onOnly }: ResultsProps) {
  const [state, setState] = useState<SearchState>(emptySearch);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    setState(emptySearch);
    setError(null);
    void (async () => {
      try {
        let s = emptySearch;
        for await (const line of search({ q, mode, ...(only ? { dicts: [only] } : {}) }, ctrl.signal)) {
          s = applyLine(s, line);
          setState(s);
        }
      } catch (err) {
        if (ctrl.signal.aborted) return;
        setError(isNetworkError(err) ? t("results.offline") : errorMessage(err));
      }
    })();
    return () => {
      ctrl.abort();
    };
  }, [q, mode, only]);

  if (error) return <Notice kind="error">{error}</Notice>;

  const found = state.slots.filter((s) => s.state === "found");
  const pending = state.slots.filter((s) => s.state === "pending");
  const missed = state.slots.filter((s) => s.state === "empty");
  const skipped = state.slots.filter((s) => s.state === "skipped");
  const deferred = state.slots.filter((s) => s.state === "deferred");
  const failed = state.slots.filter((s) => s.state === "error");

  return (
    <section class="results" aria-busy={!state.done} aria-live="polite">
      {state.morph && found.some((s) => s.lemma) && (
        <p class="muted">{t("results.lemma", { from: state.morph.from, to: state.morph.to })}</p>
      )}
      {found.map((slot) => (
        <DictSection key={slot.dict} slot={slot} trusted={dicts.get(slot.dict)?.trustedRender === true} onLookup={onLookup} />
      ))}
      {pending.length > 0 && (
        <p class="muted" role="status">
          {t("results.searching", { count: pending.length })}
        </p>
      )}
      {state.done && found.length === 0 && <p class="empty">{t("results.none", { q })}</p>}
      {missed.length > 0 && found.length > 0 && (
        <p class="muted small">{t("results.notIn", { names: missed.map((s) => s.name).join(", ") })}</p>
      )}
      {skipped.length > 0 && (
        <p class="muted small">{t("results.skipped", { names: skipped.map((s) => s.name).join(", ") })}</p>
      )}
      {deferred.map((s) => (
        <p key={s.dict} class="muted small">
          {t("results.deferred", { name: s.name })}{" "}
          <button type="button" class="link" onClick={() => { onOnly(s.dict); }}>
            {t("results.searchOnly")}
          </button>
        </p>
      ))}
      {failed.length > 0 && (
        <p class="muted small">{t("results.failed", { names: failed.map((s) => s.name).join(", ") })}</p>
      )}
    </section>
  );
}

function DictSection({ slot, trusted, onLookup }: { slot: Slot; trusted: boolean; onLookup: (w: string) => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? slot.results : slot.results.slice(0, initialArticles);
  return (
    <details class="dict" open>
      <summary>
        <span class="dict-name">{slot.name}</span>
        <span class="count">{slot.results.length}</span>
      </summary>
      {shown.map((r, i) => (
        <article key={`${String(i)}:${r.Headword ?? ""}`} class="entry">
          {r.Headword && <h3 class="headword">{r.Headword}</h3>}
          <ArticleFrame
            key={r.Body}
            body={r.Body ?? ""}
            trusted={trusted}
            title={t("results.articleTitle", { word: r.Headword ?? "", dict: slot.name })}
            onLookup={onLookup}
          />
        </article>
      ))}
      {!all && slot.results.length > initialArticles && (
        <button type="button" class="btn btn-secondary more" onClick={() => { setAll(true); }}>
          {t("results.more", { count: slot.results.length - initialArticles })}
        </button>
      )}
    </details>
  );
}
