// Saved words: filter, look up again (in the dictionary it was saved from), notes, remove, export.
import { useEffect, useState } from "preact/hooks";
import { deleteFavorite, exportUrl, getFavorites, getMyDicts, saveFavorite, type Favorite } from "../api/app";
import { t } from "../i18n";
import { errorMessage } from "../lib/errors";
import { navigate } from "../lib/router";
import { getDefaultMode } from "../lib/search-prefs";
import { Notice } from "./Field";
import { searchPath } from "./SearchView";

export function Favorites() {
  const [list, setList] = useState<Favorite[] | null>(null);
  /** PXDict id → wuDict id, to search only the dictionary a word was saved from. */
  const [wudictIds, setWudictIds] = useState<ReadonlyMap<string, string>>(new Map());
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    getFavorites(ctrl.signal).then(setList, (err: unknown) => {
      if (!ctrl.signal.aborted) setError(errorMessage(err));
    });
    getMyDicts(ctrl.signal).then(
      (dicts) => {
        setWudictIds(new Map(dicts.flatMap((d) => (d.wudictId ? [[d.id, d.wudictId] as const] : []))));
      },
      () => {
        // Lookups then search every dictionary.
      },
    );
    return () => {
      ctrl.abort();
    };
  }, []);

  const remove = (f: Favorite) => {
    deleteFavorite(f.headword, f.dictId).then(
      () => {
        setList((l) => l?.filter((x) => x !== f) ?? null);
      },
      (err: unknown) => {
        setError(errorMessage(err));
      },
    );
  };

  const saveNote = async (f: Favorite, note: string) => {
    await saveFavorite({ headword: f.headword, dictId: f.dictId, note: note.trim() || null });
    setList((l) => l?.map((x) => (x === f ? { ...x, note: note.trim() || null } : x)) ?? null);
  };

  const needle = filter.trim().toLowerCase();
  const shown = list?.filter(
    (f) => !needle || f.headword.toLowerCase().includes(needle) || (f.note ?? "").toLowerCase().includes(needle),
  );

  return (
    <main>
      <h2>{t("favorites.title")}</h2>
      {list && list.length > 0 && (
        <div class="toolbar">
          <input
            type="search"
            value={filter}
            placeholder={t("favorites.filter")}
            aria-label={t("favorites.filter")}
            autocomplete="off"
            onInput={(e) => {
              setFilter(e.currentTarget.value);
            }}
          />
        </div>
      )}
      {error && <Notice kind="error">{error}</Notice>}
      {list === null && !error && <p class="muted">{t("status.loading")}</p>}
      {list?.length === 0 && <p class="empty">{t("favorites.empty")}</p>}
      {list && list.length > 0 && shown?.length === 0 && <p class="empty">{t("favorites.noMatch", { q: filter.trim() })}</p>}
      <ul class="favorites">
        {shown?.map((f) => (
          <FavoriteItem
            key={`${f.dictId}\n${f.headword}`}
            f={f}
            href={searchPath(f.headword, getDefaultMode(), wudictIds.get(f.dictId))}
            onRemove={() => {
              remove(f);
            }}
            onSaveNote={(note) => saveNote(f, note)}
          />
        ))}
      </ul>
      {list && list.length > 0 && (
        <p class="row actions">
          <span class="muted small">{t("favorites.export")}:</span>
          <a href={exportUrl("favorites", "csv")} download>
            CSV
          </a>
          <a href={exportUrl("favorites", "json")} download>
            JSON
          </a>
        </p>
      )}
    </main>
  );
}

interface FavoriteItemProps {
  f: Favorite;
  href: string;
  onRemove: () => void;
  onSaveNote: (note: string) => Promise<void>;
}

function FavoriteItem({ f, href, onRemove, onSaveNote }: FavoriteItemProps) {
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(f.note ?? "");
  const [error, setError] = useState<string | null>(null);
  return (
    <li class="card favorite">
      <div class="row">
        <a
          class="headword"
          href={href}
          onClick={(e) => {
            e.preventDefault();
            navigate(href);
          }}
        >
          {f.headword}
        </a>
        <span class="muted small">{f.dictTitle ?? t("favorites.unavailable")}</span>
      </div>
      {editing ? (
        <form
          class="stack"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            onSaveNote(note).then(
              () => {
                setEditing(false);
              },
              (err: unknown) => {
                setError(errorMessage(err));
              },
            );
          }}
        >
          <label class="field">
            <span>{t("favorites.note")}</span>
            <textarea
              value={note}
              maxLength={2000}
              rows={3}
              onInput={(e) => {
                setNote(e.currentTarget.value);
              }}
            />
          </label>
          {error && <Notice kind="error">{error}</Notice>}
          <div class="row">
            <button type="submit" class="btn btn-primary btn-small">
              {t("favorites.saveNote")}
            </button>
            <button
              type="button"
              class="btn btn-secondary btn-small"
              onClick={() => {
                setNote(f.note ?? "");
                setEditing(false);
              }}
            >
              {t("favorites.cancel")}
            </button>
          </div>
        </form>
      ) : (
        f.note && <p class="note">{f.note}</p>
      )}
      {!editing && (
        <div class="row">
          <button
            type="button"
            class="link"
            onClick={() => {
              setEditing(true);
            }}
          >
            {t(f.note ? "favorites.editNote" : "favorites.addNote")}
          </button>
          <button type="button" class="link danger" onClick={onRemove}>
            {t("favorites.remove")}
          </button>
        </div>
      )}
    </li>
  );
}
