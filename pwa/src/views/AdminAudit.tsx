// The audit log: every admin write action and security event, newest first, filterable by action.
import { useCallback, useEffect, useState } from "preact/hooks";
import { getAudit, type AuditPage } from "../api/app";
import { getLocale, t } from "../i18n";
import { errorMessage } from "../lib/errors";
import { formatBytes } from "../lib/upload";
import { AdminNav } from "./AdminNav";
import { Notice } from "./Field";

type Entry = AuditPage["entries"][number];

/** Action groups for the filter ("" = all). */
const filters = ["", "storage.", "dict.", "proposal.", "user.", "invite.", "auth.", "system."];

export function AdminAudit() {
  const locale = getLocale();
  const [action, setAction] = useState("");
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    (from: number | undefined, signal?: AbortSignal) => {
      getAudit({ ...(from ? { cursor: from } : {}), ...(action ? { action } : {}) }, signal).then(
        (p) => {
          setEntries((old) => (from && old ? [...old, ...p.entries] : p.entries));
          setCursor(p.nextCursor);
        },
        (err: unknown) => {
          if (!signal?.aborted) setError(errorMessage(err));
        },
      );
    },
    [action],
  );
  useEffect(() => {
    const ctrl = new AbortController();
    setEntries(null);
    load(undefined, ctrl.signal);
    return () => {
      ctrl.abort();
    };
  }, [load]);

  return (
    <main>
      <AdminNav current="audit" />
      <h2>{t("admin.audit")}</h2>
      <label class="field inline">
        <span>{t("admin.filter")}</span>
        <select
          value={action}
          onChange={(e) => {
            setAction(e.currentTarget.value);
          }}
        >
          {filters.map((f) => (
            <option key={f} value={f}>
              {f === "" ? t("admin.filter.all") : `${f}*`}
            </option>
          ))}
        </select>
      </label>
      {error && <Notice kind="error">{error}</Notice>}
      {entries === null ? (
        <p class="muted">{t("status.loading")}</p>
      ) : entries.length === 0 ? (
        <p class="empty">{t("admin.none")}</p>
      ) : (
        <table class="files">
          <thead>
            <tr>
              <th>{t("audit.time")}</th>
              <th>{t("audit.actor")}</th>
              <th>{t("audit.action")}</th>
              <th>{t("audit.target")}</th>
              <th>{t("audit.freed")}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} title={e.details ? JSON.stringify(e.details) : undefined}>
                <td>{new Date(e.createdAt).toLocaleString(locale)}</td>
                <td>{e.actor ? (e.actor.name ?? e.actor.id) : t("audit.system")}</td>
                <td>
                  <code>{e.action}</code>
                </td>
                <td>{e.targetId ? `${e.targetType ?? ""} ${e.targetId}`.trim() : ""}</td>
                <td>{e.bytesFreed !== null ? formatBytes(e.bytesFreed, locale) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {cursor !== null && (
        <button
          type="button"
          class="btn btn-secondary"
          onClick={() => {
            load(cursor);
          }}
        >
          {t("audit.more")}
        </button>
      )}
    </main>
  );
}
