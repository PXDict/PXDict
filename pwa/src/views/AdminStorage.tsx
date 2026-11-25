// Storage administration: where the volume's space goes, and a two-step deletion. Picking items and
// pressing "Preview" asks the gateway for a dry run (every path and size); only "Delete" in that
// preview deletes anything, and the gateway skips files that changed in between.
import { useCallback, useEffect, useState } from "preact/hooks";
import {
  executeStoragePlan,
  getStorage,
  planStorageDeletion,
  type StorageExecuteResult,
  type StorageItemRef,
  type StorageOverview,
  type StoragePlan,
} from "../api/app";
import { getLocale, t, type MessageKey } from "../i18n";
import { errorMessage } from "../lib/errors";
import { formatBytes } from "../lib/upload";
import { AdminNav } from "./AdminNav";
import { Notice } from "./Field";

type Kind = StorageItemRef["kind"];
type Block = NonNullable<StorageOverview["dicts"][number]["originalsBlocked"]>;
type Warning = StoragePlan["items"][number]["warnings"][number];

const kindKey: Record<Kind, MessageKey> = {
  dict_originals: "storage.kind.dict_originals",
  dict: "storage.kind.dict",
  proposal_files: "storage.kind.proposal_files",
  stale_upload: "storage.kind.stale_upload",
  orphan_index: "storage.kind.orphan_index",
  aux_file: "storage.kind.aux_file",
};

const blockKey: Record<Block, MessageKey> = {
  read_only: "storage.block.read_only",
  format_unsupported: "storage.block.format_unsupported",
  media_not_packed: "storage.block.media_not_packed",
  not_indexed: "storage.block.not_indexed",
  unavailable: "storage.block.unavailable",
  no_originals: "storage.block.no_originals",
  busy: "storage.block.busy",
  in_use: "storage.block.in_use",
  not_found: "storage.block.not_found",
};

const isBlock = (r: string): r is Block => Object.hasOwn(blockKey, r);
const blockText = (r: string) => (isBlock(r) ? t(blockKey[r]) : r);

function warningText(w: Warning): string {
  const n = w.count ?? 0;
  switch (w.code) {
    case "users_enabled":
      return t("storage.warn.users_enabled", { count: n });
    case "favorites_lost":
      return t("storage.warn.favorites_lost", { count: n });
    case "no_reindex":
      return t("storage.warn.no_reindex");
    case "may_be_in_use":
      return t("storage.warn.may_be_in_use");
    case "cancels_upload":
      return t("storage.warn.cancels_upload");
  }
}

const key = (r: StorageItemRef) => `${r.kind}:${r.target}`;

export function AdminStorage() {
  const locale = getLocale();
  const bytes = (n: number) => formatBytes(n, locale);
  const [data, setData] = useState<StorageOverview | null>(null);
  const [picked, setPicked] = useState<Map<string, StorageItemRef>>(new Map());
  const [plan, setPlan] = useState<StoragePlan | null>(null);
  const [result, setResult] = useState<StorageExecuteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback((signal?: AbortSignal) => {
    getStorage(signal).then(
      (o) => {
        setData(o);
        // Suggested clean-ups start picked; dictionaries never do.
        setPicked(new Map(o.candidates.filter((c) => c.suggested).map((c) => [key(c), { kind: c.kind, target: c.target }])));
      },
      (err: unknown) => {
        if (!signal?.aborted) setError(errorMessage(err));
      },
    );
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    load(ctrl.signal);
    return () => {
      ctrl.abort();
    };
  }, [load]);

  const toggle = (ref: StorageItemRef, on: boolean) => {
    setPicked((m) => {
      const next = new Map(m);
      if (on) next.set(key(ref), ref);
      else next.delete(key(ref));
      return next;
    });
  };

  const preview = () => {
    // A whole-dictionary deletion already covers its originals.
    const items = [...picked.values()].filter((r) => !(r.kind === "dict_originals" && picked.has(`dict:${r.target}`)));
    setBusy(true);
    setError(null);
    setResult(null);
    planStorageDeletion(items).then(
      (p) => {
        setPlan(p);
        setBusy(false);
      },
      (err: unknown) => {
        setError(errorMessage(err));
        setBusy(false);
      },
    );
  };

  const execute = () => {
    if (!plan) return;
    setBusy(true);
    setError(null);
    executeStoragePlan(plan.planId).then(
      (r) => {
        setResult(r);
        setPlan(null);
        setBusy(false);
        load();
      },
      (err: unknown) => {
        setError(errorMessage(err));
        setPlan(null);
        setBusy(false);
      },
    );
  };

  const check = (ref: StorageItemRef, blocked: string | null, label: string) => (
    <label class="check" title={blocked ? blockText(blocked) : undefined}>
      <input
        type="checkbox"
        disabled={!!blocked || busy || !!plan}
        checked={picked.has(key(ref))}
        onChange={(e) => {
          toggle(ref, e.currentTarget.checked);
        }}
      />
      <span>{label}</span>
    </label>
  );

  if (!data) {
    return (
      <main>
        <AdminNav current="storage" />
        <h2>{t("admin.storage")}</h2>
        {error ? <Notice kind="error">{error}</Notice> : <p class="muted">{t("status.loading")}</p>}
      </main>
    );
  }

  const used = data.volume.totalBytes - data.volume.freeBytes;
  const actionable = plan?.items.filter((i) => !i.blocked) ?? [];

  return (
    <main>
      <AdminNav current="storage" />
      <h2>{t("admin.storage")}</h2>
      {error && <Notice kind="error">{error}</Notice>}
      {result && (
        <Notice kind="info">
          {t("storage.freed", { bytes: bytes(result.bytesFreed) })}
          {result.items.some((i) => i.status !== "done") && (
            <ul>
              {result.items
                .filter((i) => i.status !== "done")
                .map((i) => (
                  <li key={key(i)}>
                    {t(i.status === "failed" ? "storage.failed" : "storage.skipped", { name: i.target, reason: blockText(i.reason ?? "") })}
                  </li>
                ))}
            </ul>
          )}
        </Notice>
      )}

      <section class="card">
        <p>
          {t("storage.volume", { free: bytes(data.volume.freeBytes), total: bytes(data.volume.totalBytes) })}{" "}
          {data.volume.totalBytes > 0 && <progress max={data.volume.totalBytes} value={used} aria-label={t("storage.used")} />}
        </p>
        <table class="files">
          <tbody>
            {data.areas.map((a) => (
              <tr key={a.area}>
                <td>
                  <code>{a.area}/</code>
                </td>
                <td>{bytes(a.bytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!data.dictDirWritable && <Notice kind="info">{t("storage.readOnly")}</Notice>}
        {!data.catalogChecked && <Notice kind="info">{t("storage.catalogUnchecked")}</Notice>}
      </section>

      <h3>{t("admin.dicts")}</h3>
      {data.dicts.length === 0 ? (
        <p class="empty">{t("dicts.empty")}</p>
      ) : (
        <ul class="proposal-list">
          {data.dicts.map((d) => (
            <li key={d.id} class="card">
              <div class="row">
                <strong>{d.title}</strong> <code class="small">{d.id}</code>
                {d.format && <span class="badge">{d.format}</span>}
                {!d.available && <span class="badge">{t("admin.unavailable")}</span>}
                {d.sourceDeletedAt && <span class="badge">{t("storage.originalsDeleted")}</span>}
              </div>
              <p class="small">
                {t("storage.dictUsage", { source: bytes(d.sourceBytes), index: bytes(d.indexBytes), users: d.enabledUsers })}
              </p>
              <div class="row">
                {check({ kind: "dict_originals", target: d.id }, d.originalsBlocked, t("storage.kind.dict_originals"))}
                {check({ kind: "dict", target: d.id }, d.deleteBlocked, t("storage.kind.dict"))}
              </div>
              {d.originalsBlocked && d.originalsBlocked !== "no_originals" && (
                <p class="small muted">{t("storage.originalsWhy", { reason: blockText(d.originalsBlocked) })}</p>
              )}
            </li>
          ))}
        </ul>
      )}

      <h3>{t("storage.cleanup")}</h3>
      {data.candidates.length === 0 ? (
        <p class="empty">{t("storage.nothingToClean")}</p>
      ) : (
        <ul class="proposal-list">
          {data.candidates.map((c) => (
            <li key={key(c)} class="card">
              <div class="row">
                {check({ kind: c.kind, target: c.target }, c.blocked, t(kindKey[c.kind]))}
                <code class="small">{c.target}</code>
                <span>{bytes(c.bytes)}</span>
                <span class="small muted">{new Date(c.modifiedAt).toLocaleString(locale)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {!plan && (
        <button type="button" class="btn" disabled={busy || picked.size === 0} onClick={preview}>
          {t("storage.preview", { count: picked.size })}
        </button>
      )}

      {plan && (
        <section class="card" aria-labelledby="plan-title">
          <h3 id="plan-title">{t("storage.planTitle")}</h3>
          <p>{t("storage.planIntro", { bytes: bytes(plan.totalBytes), time: new Date(plan.expiresAt).toLocaleTimeString(locale) })}</p>
          <ul class="proposal-list">
            {plan.items.map((i) => (
              <li key={key(i)} class="card">
                <div class="row">
                  <strong>{t(kindKey[i.kind])}</strong>: <span>{i.label}</span> <span>{bytes(i.bytes)}</span>
                  {i.blocked && <span class="badge badge-warn">{blockText(i.blocked)}</span>}
                </div>
                {i.warnings.length > 0 && (
                  <ul class="warnings">
                    {i.warnings.map((w) => (
                      <li key={w.code}>{warningText(w)}</li>
                    ))}
                  </ul>
                )}
                <details>
                  <summary>{t("storage.paths", { count: i.paths.length })}</summary>
                  <table class="files">
                    <tbody>
                      {i.paths.map((f) => (
                        <tr key={f.path}>
                          <td>
                            <code>{f.path}</code>
                          </td>
                          <td>{bytes(f.bytes)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              </li>
            ))}
          </ul>
          <div class="row">
            <button type="button" class="btn btn-danger" disabled={busy || actionable.length === 0} onClick={execute}>
              {t("storage.execute", { count: actionable.length, bytes: bytes(plan.totalBytes) })}
            </button>
            <button
              type="button"
              class="btn btn-secondary"
              disabled={busy}
              onClick={() => {
                setPlan(null);
              }}
            >
              {t("common.cancel")}
            </button>
          </div>
        </section>
      )}
    </main>
  );
}
