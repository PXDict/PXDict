// Admin dictionary catalogue: who may use each dictionary, trusted rendering, indexing status, a rescan
// of the dictionary folder, and a link to try any dictionary (hidden ones included) in the search.
import { useCallback, useEffect, useState } from "preact/hooks";
import { getAdminDicts, reindexDict, rescanDicts, updateAdminDict, type AdminDict, type UpdateAdminDictRequest } from "../api/app";
import { t } from "../i18n";
import { errorMessage } from "../lib/errors";
import { navigate } from "../lib/router";
import { AdminNav } from "./AdminNav";
import { indexText } from "./AdminProposals";
import { Notice } from "./Field";

export function AdminDicts() {
  const [dicts, setDicts] = useState<AdminDict[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback((signal?: AbortSignal) => {
    getAdminDicts(signal).then(setDicts, (err: unknown) => {
      if (!signal?.aborted) setError(errorMessage(err));
    });
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    load(ctrl.signal);
    return () => {
      ctrl.abort();
    };
  }, [load]);

  // Refresh while something is being indexed.
  const indexing = dicts?.some((d) => d.index.state === "running") ?? false;
  useEffect(() => {
    if (!indexing) return;
    const timer = setInterval(() => {
      load();
    }, 2000);
    return () => {
      clearInterval(timer);
    };
  }, [indexing, load]);

  const change = (d: AdminDict, patch: UpdateAdminDictRequest) => {
    setError(null);
    updateAdminDict(d.id, patch).then(
      (next) => {
        setDicts((list) => list?.map((x) => (x.id === next.id ? next : x)) ?? list);
      },
      (err: unknown) => {
        setError(errorMessage(err));
      },
    );
  };

  const rescan = () => {
    setBusy(true);
    setError(null);
    rescanDicts().then(
      (list) => {
        setDicts(list);
        setInfo(t("admin.rescanned"));
        setBusy(false);
      },
      (err: unknown) => {
        setError(errorMessage(err));
        setBusy(false);
      },
    );
  };

  return (
    <main>
      <AdminNav current="dicts" />
      <h2>{t("admin.dicts")}</h2>
      <button type="button" class="btn btn-secondary" disabled={busy} onClick={rescan}>
        {t("admin.rescan")}
      </button>
      {error && <Notice kind="error">{error}</Notice>}
      {info && <Notice kind="info">{info}</Notice>}
      {dicts === null ? (
        <p class="muted">{t("status.loading")}</p>
      ) : dicts.length === 0 ? (
        <p class="empty">{t("dicts.empty")}</p>
      ) : (
        <ul class="proposal-list">
          {dicts.map((d) => (
            <li key={d.id} class="card">
              <div class="row">
                <strong>{d.title}</strong> <code class="small">{d.id}</code>
                {d.format && <span class="badge">{d.format}</span>}
                <span class="badge">{d.source === "proposal" ? t("admin.fromProposal") : t("admin.builtin")}</span>
                {!d.available && <span class="badge">{t("admin.unavailable")}</span>}
                {d.available && !d.indexed && <span class="badge">{t("admin.notIndexed")}</span>}
              </div>
              <div class="row">
                <label class="field inline">
                  <span>{t("admin.visibility")}</span>
                  <select
                    value={d.visibility}
                    onChange={(e) => {
                      change(d, { visibility: e.currentTarget.value as AdminDict["visibility"] });
                    }}
                  >
                    <option value="global">{t("admin.visibility.global")}</option>
                    {d.owner && <option value="private">{t("admin.visibility.private", { name: d.owner.name ?? d.owner.id })}</option>}
                    <option value="hidden">{t("admin.visibility.hidden")}</option>
                  </select>
                </label>
                <label class="check">
                  <input
                    type="checkbox"
                    checked={d.trustedRender}
                    onChange={(e) => {
                      change(d, { trustedRender: e.currentTarget.checked });
                    }}
                  />
                  <span>{t("admin.trusted")}</span>
                </label>
                {d.available && d.wudictId && (
                  <a
                    href={`/?dict=${d.wudictId}`}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(`/?dict=${d.wudictId ?? ""}`);
                    }}
                  >
                    {t("admin.try")}
                  </a>
                )}
              </div>
              {d.index.state !== "idle" && <p class="small" role="status">{indexText(d.index)}</p>}
              {(d.index.state === "error" || (d.available && !d.indexed && d.index.state !== "running")) && (
                <button
                  type="button"
                  class="btn btn-small btn-secondary"
                  onClick={() => {
                    reindexDict(d.id).then(
                      () => {
                        load();
                      },
                      (err: unknown) => {
                        setError(errorMessage(err));
                      },
                    );
                  }}
                >
                  {t("admin.retryIndex")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
