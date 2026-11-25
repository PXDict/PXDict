// The search box: debounced suggestions (listbox), search mode, keyboard shortcuts
// ("/" or Ctrl/Cmd+K focuses it, arrows move through suggestions, Escape closes or clears).
import { useEffect, useRef, useState } from "preact/hooks";
import { searchModes, suggest, type SearchMode } from "../api/wudict";
import { t } from "../i18n";

export interface SearchBoxProps {
  query: string;
  mode: SearchMode;
  /** Recent lookups, offered while the box is empty. */
  recent?: readonly string[];
  onSearch: (q: string, mode: SearchMode) => void;
}

const debounceMs = 150;
const noRecent: readonly string[] = [];

export function SearchBox({ query, mode, recent = noRecent, onSearch }: SearchBoxProps) {
  const [text, setText] = useState(query);
  const [words, setWords] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement>(null);

  // A new search from outside (history, a cross-reference) replaces what is typed.
  useEffect(() => {
    setText(query);
    setOpen(false);
  }, [query]);

  // Suggestions while typing; recent lookups while the box is empty.
  useEffect(() => {
    const q = text.trim();
    if (!open) {
      setWords([]);
      return;
    }
    if (!q) {
      setWords([...recent]);
      setActive(-1);
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      suggest(q, ctrl.signal).then(
        (w) => {
          setWords(w);
          setActive(-1);
        },
        () => {
          // Offline or a server error: no suggestions.
        },
      );
    }, debounceMs);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [text, open, recent]);

  // Global shortcuts to focus the search box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target?.closest("input, textarea, select, [contenteditable]") !== null && target !== null;
      if ((e.key === "/" && !typing) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k")) {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    addEventListener("keydown", onKey);
    return () => {
      removeEventListener("keydown", onKey);
    };
  }, []);

  const submit = (q: string) => {
    const word = q.trim();
    setOpen(false);
    if (word) onSearch(word, mode);
  };

  const showList = open && words.length > 0;

  return (
    <form
      class="searchbox"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        submit(active >= 0 ? (words[active] ?? text) : text);
      }}
    >
      <div class="combo">
        <input
          ref={input}
          type="search"
          name="q"
          value={text}
          placeholder={t("search.placeholder")}
          aria-label={t("search.label")}
          role="combobox"
          // Preact's typings ask combobox inputs for `list`; suggestions use aria-controls instead.
          list={undefined}
          aria-expanded={showList}
          aria-controls="suggestions"
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `sugg-${String(active)}` : undefined}
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
          enterKeyHint="search"
          onInput={(e) => {
            setText(e.currentTarget.value);
            setOpen(true);
          }}
          onFocus={() => {
            if (!text.trim()) setOpen(true);
          }}
          onBlur={() => {
            // Let a click on a suggestion land first.
            setTimeout(() => {
              setOpen(false);
            }, 150);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && words.length) {
              e.preventDefault();
              setOpen(true);
              setActive((a) => (a + 1) % words.length);
            } else if (e.key === "ArrowUp" && words.length) {
              e.preventDefault();
              setActive((a) => (a <= 0 ? words.length - 1 : a - 1));
            } else if (e.key === "Escape") {
              if (showList) setOpen(false);
              else setText("");
            }
          }}
        />
        {showList && (
          <ul id="suggestions" class="suggestions" role="listbox" aria-label={t(text.trim() ? "search.suggestions" : "history.recent")}>
            {words.map((w, i) => (
              <li
                key={w}
                id={`sugg-${String(i)}`}
                role="option"
                aria-selected={i === active}
                class={i === active ? "active" : undefined}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setText(w);
                  submit(w);
                }}
              >
                {w}
              </li>
            ))}
          </ul>
        )}
      </div>
      <select
        aria-label={t("search.mode")}
        value={mode}
        onChange={(e) => {
          const m = e.currentTarget.value as SearchMode;
          if (text.trim()) onSearch(text.trim(), m);
          else onSearch("", m);
        }}
      >
        {searchModes.map((m) => (
          <option key={m} value={m}>
            {t(`search.mode.${m}`)}
          </option>
        ))}
      </select>
      <button class="btn btn-primary" type="submit">
        {t("search.submit")}
      </button>
    </form>
  );
}
