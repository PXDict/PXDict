// The user's dictionaries: turn each on or off and choose the order of results. Arrows work everywhere
// (keyboard, touch, screen readers); drag and drop is a shortcut where the browser supports it. Every
// change is saved at once.
import { useEffect, useState } from "preact/hooks";
import { getMyDicts, markDictsSeen, saveMyDicts, type MyDict } from "../api/app";
import { t } from "../i18n";
import { errorMessage } from "../lib/errors";
import { Notice } from "./Field";

/** Moves item `from` to index `to`. */
export function move<T>(list: readonly T[], from: number, to: number): T[] {
  const out = list.slice();
  const [item] = out.splice(from, 1);
  if (item === undefined) return out;
  out.splice(Math.max(0, Math.min(to, out.length)), 0, item);
  return out;
}

export function Dictionaries({ onSeen }: { onSeen: () => void }) {
  const [dicts, setDicts] = useState<MyDict[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    getMyDicts(ctrl.signal).then(
      (list) => {
        setDicts(list);
        // Opening this page acknowledges new dictionaries.
        if (list.some((d) => d.isNew)) {
          markDictsSeen().then(onSeen, () => {
            // Shown again next time.
          });
        }
      },
      (err: unknown) => {
        if (!ctrl.signal.aborted) setError(errorMessage(err));
      },
    );
    return () => {
      ctrl.abort();
    };
  }, [onSeen]);

  const save = (next: MyDict[]) => {
    const previous = dicts;
    setDicts(next);
    setError(null);
    saveMyDicts(next.map((d) => ({ id: d.id, enabled: d.enabled }))).then(setDicts, (err: unknown) => {
      setDicts(previous);
      setError(errorMessage(err));
    });
  };

  if (!dicts) {
    return (
      <main>
        <h2>{t("dicts.title")}</h2>
        {error ? <Notice kind="error">{error}</Notice> : <p class="muted">{t("status.loading")}</p>}
      </main>
    );
  }

  return (
    <main>
      <h2>{t("dicts.title")}</h2>
      <p class="muted small">{t("dicts.hint")}</p>
      {error && <Notice kind="error">{error}</Notice>}
      {dicts.length === 0 && <p class="empty">{t("dicts.empty")}</p>}
      {dicts.length > 0 && dicts.every((d) => !d.enabled) && <Notice kind="info">{t("dicts.allOff")}</Notice>}
      <ol class="dict-list">
        {dicts.map((d, i) => (
          <li
            key={d.id}
            class={dragging === i ? "dragging" : undefined}
            draggable
            onDragStart={(e) => {
              setDragging(i);
              e.dataTransfer?.setData("text/plain", d.id);
            }}
            onDragOver={(e) => {
              e.preventDefault();
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragging !== null && dragging !== i) save(move(dicts, dragging, i));
              setDragging(null);
            }}
            onDragEnd={() => {
              setDragging(null);
            }}
          >
            <span class="grip" aria-hidden="true">
              ⋮⋮
            </span>
            <label class="check dict-toggle">
              <input
                type="checkbox"
                checked={d.enabled}
                onChange={(e) => {
                  const enabled = e.currentTarget.checked;
                  save(dicts.map((x) => (x.id === d.id ? { ...x, enabled } : x)));
                }}
              />
              <span class={d.available ? undefined : "muted"}>{d.title}</span>
            </label>
            {d.visibility === "private" && <span class="badge">{t("dicts.private")}</span>}
            {d.isNew && <span class="badge badge-new">{t("dicts.new")}</span>}
            {!d.available && <span class="badge">{t("dicts.unavailable")}</span>}
            <span class="order">
              <button
                type="button"
                class="btn btn-small btn-secondary"
                aria-label={t("dicts.up", { name: d.title })}
                disabled={i === 0}
                onClick={() => {
                  save(move(dicts, i, i - 1));
                }}
              >
                ↑
              </button>
              <button
                type="button"
                class="btn btn-small btn-secondary"
                aria-label={t("dicts.down", { name: d.title })}
                disabled={i === dicts.length - 1}
                onClick={() => {
                  save(move(dicts, i, i + 1));
                }}
              >
                ↓
              </button>
            </span>
          </li>
        ))}
      </ol>
    </main>
  );
}
