// Search history: grouped by day, filterable, tap a lookup to run it again; delete one, delete all,
// export.
import { useEffect, useState } from "preact/hooks";
import { clearHistory, deleteHistoryEntry, exportUrl, getHistory, type HistoryEntry } from "../api/app";
import { getLocale, t } from "../i18n";
import { errorMessage } from "../lib/errors";
import { navigate } from "../lib/router";
import { Notice } from "./Field";
import { searchPath } from "./SearchView";

const debounceMs = 250;

/** Groups entries (newest first) by local calendar day. */
export function groupByDay(entries: readonly HistoryEntry[], now = new Date()): { day: string; entries: HistoryEntry[] }[] {
  const key = (d: Date) => `${String(d.getFullYear())}-${String(d.getMonth() + 1)}-${String(d.getDate())}`;
  const today = key(now);
  const yesterday = key(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const groups: { day: string; entries: HistoryEntry[] }[] = [];
  for (const e of entries) {
    const d = new Date(e.createdAt);
    const k = key(d);
    const day =
      k === today
        ? t("history.today")
        : k === yesterday
          ? t("history.yesterday")
          : d.toLocaleDateString(getLocale(), { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    const last = groups.at(-1);
    if (last?.day === day) last.entries.push(e);
    else groups.push({ day, entries: [e] });
  }
  return groups;
}

export function History({ enabled }: { enabled: boolean }) {
  const [filter, setFilter] = useState("");
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    const timer = setTimeout(
      () => {
        getHistory(filter.trim() ? { q: filter.trim() } : {}, ctrl.signal).then(
          (page) => {
            setEntries(page.entries);
            setCursor(page.nextCursor);
            setError(null);
          },
          (err: unknown) => {
            if (!ctrl.signal.aborted) setError(errorMessage(err));
          },
        );
      },
      filter ? debounceMs : 0,
    );
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [filter]);

  const more = () => {
    if (cursor === null) return;
    getHistory({ ...(filter.trim() ? { q: filter.trim() } : {}), cursor }).then(
      (page) => {
        setEntries((old) => [...(old ?? []), ...page.entries]);
        setCursor(page.nextCursor);
      },
      (err: unknown) => {
        setError(errorMessage(err));
      },
    );
  };

  const remove = (id: number) => {
    deleteHistoryEntry(id).then(
      () => {
        setEntries((old) => old?.filter((e) => e.id !== id) ?? null);
      },
      (err: unknown) => {
        setError(errorMessage(err));
      },
    );
  };

  const clear = () => {
    if (!confirm(t("history.clearConfirm"))) return;
    clearHistory().then(
      () => {
        setEntries([]);
        setCursor(null);
      },
      (err: unknown) => {
        setError(errorMessage(err));
      },
    );
  };

  const time = (iso: string) => new Date(iso).toLocaleTimeString(getLocale(), { hour: "2-digit", minute: "2-digit" });

  return (
    <main>
      <h2>{t("history.title")}</h2>
      {!enabled && <Notice kind="info">{t("history.off")}</Notice>}
      <div class="toolbar">
        <input
          type="search"
          value={filter}
          placeholder={t("history.filter")}
          aria-label={t("history.filter")}
          autocomplete="off"
          onInput={(e) => {
            setFilter(e.currentTarget.value);
          }}
        />
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {entries === null && !error && <p class="muted">{t("status.loading")}</p>}
      {entries?.length === 0 && <p class="empty">{filter.trim() ? t("history.noMatch", { q: filter.trim() }) : t("history.empty")}</p>}
      {entries &&
        groupByDay(entries).map((g) => (
          <section key={g.day} class="day">
            <h3>{g.day}</h3>
            <ul class="list">
              {g.entries.map((e) => (
                <li key={e.id}>
                  <a
                    href={searchPath(e.query, e.mode)}
                    onClick={(ev) => {
                      ev.preventDefault();
                      navigate(searchPath(e.query, e.mode));
                    }}
                  >
                    {e.query}
                  </a>
                  <span class="muted small">{time(e.createdAt)}</span>
                  <button type="button" class="link danger" aria-label={t("history.delete", { q: e.query })} onClick={() => { remove(e.id); }}>
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      {cursor !== null && (
        <button type="button" class="btn btn-secondary more" onClick={more}>
          {t("history.more")}
        </button>
      )}
      {entries && entries.length > 0 && (
        <p class="row actions">
          <span class="muted small">{t("history.export")}:</span>
          <a href={exportUrl("history", "csv")} download>
            CSV
          </a>
          <a href={exportUrl("history", "json")} download>
            JSON
          </a>
          <button type="button" class="btn btn-danger btn-small" onClick={clear}>
            {t("history.clear")}
          </button>
        </p>
      )}
    </main>
  );
}
