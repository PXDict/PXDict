// Propose a dictionary: a form that uploads the files in resumable chunks, and the user's proposals
// with their status (an unfinished upload can be continued by choosing the same files again).
import { useCallback, useEffect, useState } from "preact/hooks";
import {
  createProposal,
  getMyProposals,
  getUploadLimits,
  markProposalsSeen,
  submitProposal,
  withdrawProposal,
  type Proposal,
  type UploadLimits,
} from "../api/app";
import { getLocale, t, type MessageKey } from "../i18n";
import { errorMessage } from "../lib/errors";
import { formatBytes, matchFiles, uploadFiles, type UploadProgress } from "../lib/upload";
import { Field, Notice } from "./Field";

const statusKey: Record<Proposal["status"], MessageKey> = {
  uploading: "proposals.status.uploading",
  pending: "proposals.status.pending",
  approved: "proposals.status.approved",
  rejected: "proposals.status.rejected",
  withdrawn: "proposals.status.withdrawn",
};

const lowerExt = (name: string, exts: readonly string[]) => exts.some((e) => name.toLowerCase().endsWith(e));

function ProgressLine({ p }: { p: UploadProgress | "checking" | null }) {
  if (!p) return null;
  if (p === "checking") return <p role="status">{t("proposals.checking")}</p>;
  const locale = getLocale();
  return (
    <p role="status">
      <progress max={p.total} value={p.sent} />{" "}
      {t("proposals.uploading", { file: p.file || "…", sent: formatBytes(p.sent, locale), total: formatBytes(p.total, locale) })}
    </p>
  );
}

export function Proposals({ onSeen }: { onSeen: () => void }) {
  const [limits, setLimits] = useState<UploadLimits | null>(null);
  const [list, setList] = useState<Proposal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [license, setLicense] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<UploadProgress | "checking" | null>(null);
  const busy = progress !== null;

  const reload = useCallback(async (signal?: AbortSignal) => {
    setList(await getMyProposals(signal));
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    Promise.all([getUploadLimits(ctrl.signal).then(setLimits), reload(ctrl.signal)]).catch((err: unknown) => {
      if (!ctrl.signal.aborted) setError(errorMessage(err));
    });
    // Opening this page acknowledges approvals and rejections.
    markProposalsSeen().then(onSeen, () => {
      // Announced again next time.
    });
    return () => {
      ctrl.abort();
    };
  }, [reload, onSeen]);

  const locale = getLocale();
  const total = files.reduce((n, f) => n + f.size, 0);
  const refused = limits ? files.filter((f) => !lowerExt(f.name, limits.extensions)).map((f) => f.name) : [];
  const tooLarge = limits !== null && total > limits.maxUploadBytes;

  /** Uploads the rest of `p` from `picked`, then submits it. */
  const send = async (p: Proposal, picked: File[]) => {
    if (!limits) return;
    await uploadFiles(p, picked, limits.chunkBytes, setProgress);
    setProgress("checking");
    await submitProposal(p.id);
  };

  const submit = (e: Event) => {
    e.preventDefault();
    if (!limits || busy || !files.length || refused.length || tooLarge) return;
    setError(null);
    setDone(null);
    void (async () => {
      try {
        setProgress({ sent: 0, total, file: "" });
        const p = await createProposal({
          title: title.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(sourceUrl.trim() ? { sourceUrl: sourceUrl.trim() } : {}),
          ...(license.trim() ? { licenseNote: license.trim() } : {}),
          files: files.map((f) => ({ name: f.name, size: f.size })),
        });
        await send(p, files);
        setDone(t("proposals.submitted"));
        setTitle("");
        setDescription("");
        setSourceUrl("");
        setLicense("");
        setFiles([]);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setProgress(null);
        await reload().catch(() => undefined);
      }
    })();
  };

  const resume = (p: Proposal, picked: File[]) => {
    const matched = matchFiles(p, picked);
    if (!matched) {
      setError(t("proposals.resumeMismatch"));
      return;
    }
    setError(null);
    setDone(null);
    void (async () => {
      try {
        await send(p, matched);
        setDone(t("proposals.submitted"));
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setProgress(null);
        await reload().catch(() => undefined);
      }
    })();
  };

  const withdraw = (p: Proposal) => {
    if (!confirm(t("proposals.withdrawConfirm", { title: p.title }))) return;
    withdrawProposal(p.id).then(
      () => reload(),
      (err: unknown) => {
        setError(errorMessage(err));
      },
    );
  };

  return (
    <main>
      <h2>{t("proposals.title")}</h2>
      <p class="muted small">{t("proposals.hint")}</p>
      {error && <Notice kind="error">{error}</Notice>}
      {done && <Notice kind="info">{done}</Notice>}
      <form class="stack" onSubmit={submit}>
        <Field label={t("proposals.name")} name="title" value={title} onInput={setTitle} required />
        <label class="field" for="f-description">
          <span>{t("proposals.description")}</span>
          <textarea id="f-description" rows={3} maxLength={5000} value={description} onInput={(e) => { setDescription(e.currentTarget.value); }} />
        </label>
        <Field label={t("proposals.sourceUrl")} name="sourceUrl" value={sourceUrl} onInput={setSourceUrl} inputMode="text" />
        <Field label={t("proposals.license")} name="license" value={license} onInput={setLicense} />
        <label class="field" for="f-files">
          <span>{t("proposals.files")}</span>
          <input
            id="f-files"
            type="file"
            multiple
            accept={limits?.extensions.join(",")}
            onChange={(e) => {
              setFiles([...(e.currentTarget.files ?? [])]);
            }}
          />
          {limits && <small class="hint">{t("proposals.filesHint", { size: formatBytes(limits.maxUploadBytes, locale) })}</small>}
        </label>
        {files.length > 0 && (
          <p class="small muted">
            {files.map((f) => f.name).join(", ")} · {formatBytes(total, locale)}
          </p>
        )}
        {refused.length > 0 && <Notice kind="error">{t("proposals.badType", { names: refused.join(", ") })}</Notice>}
        {tooLarge && <Notice kind="error">{t("proposals.tooLarge", { size: formatBytes(limits.maxUploadBytes, locale) })}</Notice>}
        <ProgressLine p={progress} />
        <button type="submit" class="btn" disabled={busy || !limits || !files.length || !title.trim() || refused.length > 0 || tooLarge}>
          {t("proposals.submit")}
        </button>
      </form>

      <h3>{t("proposals.mine")}</h3>
      {list === null ? (
        <p class="muted">{t("status.loading")}</p>
      ) : list.length === 0 ? (
        <p class="empty">{t("proposals.none")}</p>
      ) : (
        <ul class="proposal-list">
          {list.map((p) => (
            <li key={p.id} class="card">
              <div class="row">
                <strong>{p.title}</strong> <span class={`badge badge-${p.status}`}>{t(statusKey[p.status])}</span>
              </div>
              <p class="small muted">
                {t("proposals.summary", {
                  count: p.fileCount,
                  size: formatBytes(p.totalBytes, locale),
                  date: new Date(p.createdAt).toLocaleDateString(locale),
                })}
              </p>
              {p.status === "rejected" && p.reviewNote && <p>{t("proposals.reason", { note: p.reviewNote })}</p>}
              {p.status === "approved" && p.reviewNote && <p>{t("proposals.note", { note: p.reviewNote })}</p>}
              {p.status === "uploading" && (
                <label class="field">
                  <span>{t("proposals.resume")}</span>
                  <input
                    type="file"
                    multiple
                    disabled={busy}
                    onChange={(e) => {
                      resume(p, [...(e.currentTarget.files ?? [])]);
                    }}
                  />
                  <small class="hint">{t("proposals.resumeHint")}</small>
                </label>
              )}
              {(p.status === "pending" || p.status === "uploading") && (
                <button
                  type="button"
                  class="btn btn-small btn-secondary"
                  disabled={busy}
                  onClick={() => {
                    withdraw(p);
                  }}
                >
                  {t("proposals.withdraw")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
