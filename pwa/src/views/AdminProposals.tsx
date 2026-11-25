// Admin review of dictionary proposals: list by status, details (proposer, files, hashes, what the
// file header says, warnings), approve with an id, scope and rendering choice, or reject with a reason.
// After an approval the indexing progress is shown until the dictionary is ready.
import { useCallback, useEffect, useState } from "preact/hooks";
import {
  approveProposal,
  getAdminProposals,
  getIndexStatus,
  rejectProposal,
  type AdminProposal,
  type ApproveProposalRequest,
  type IndexStatus,
  type ProposalStatus,
} from "../api/app";
import { getLocale, t, type MessageKey } from "../i18n";
import { errorMessage } from "../lib/errors";
import { navigate } from "../lib/router";
import { formatBytes, suggestDictId } from "../lib/upload";
import { Field, Notice } from "./Field";

const filters: (ProposalStatus | "all")[] = ["pending", "approved", "rejected", "uploading", "withdrawn", "all"];

const statusKey: Record<ProposalStatus, MessageKey> = {
  uploading: "proposals.status.uploading",
  pending: "proposals.status.pending",
  approved: "proposals.status.approved",
  rejected: "proposals.status.rejected",
  withdrawn: "proposals.status.withdrawn",
};

export function indexText(s: IndexStatus): string {
  switch (s.state) {
    case "running":
      return t("admin.indexState.running", { done: s.done, total: s.total || "?" });
    case "done":
      return t("admin.indexState.done");
    case "error":
      return t("admin.indexState.error", { error: s.error ?? "" });
    default:
      return t("admin.indexState.idle");
  }
}

/** Follows indexing of `dictId` until it ends. */
function IndexProgress({ dictId }: { dictId: string }) {
  const [status, setStatus] = useState<IndexStatus | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () => {
      getIndexStatus(dictId, ctrl.signal).then(
        (s) => {
          setStatus(s);
          if (s.state === "running" || s.state === "idle") timer = setTimeout(poll, 1500);
        },
        () => {
          if (!ctrl.signal.aborted) timer = setTimeout(poll, 5000);
        },
      );
    };
    poll();
    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [dictId]);
  if (!status) return null;
  return <p role="status">{indexText(status)}</p>;
}

export function AdminNav({ current }: { current: "proposals" | "dicts" }) {
  const link = (path: string, key: MessageKey, on: boolean) => (
    <a
      href={path}
      aria-current={on ? "page" : undefined}
      onClick={(e) => {
        e.preventDefault();
        navigate(path);
      }}
    >
      {t(key)}
    </a>
  );
  return (
    <nav class="subnav" aria-label={t("admin.nav")}>
      {link("/admin/proposals", "admin.proposals", current === "proposals")}
      {link("/admin/dicts", "admin.dicts", current === "dicts")}
    </nav>
  );
}

function Review({ p, onChanged }: { p: AdminProposal; onChanged: (p: AdminProposal) => void }) {
  const locale = getLocale();
  const [dictId, setDictId] = useState(suggestDictId(p.metadata?.title ?? p.title));
  const [title, setTitle] = useState(p.title);
  const [scope, setScope] = useState<ApproveProposalRequest["scope"]>("global");
  const [trusted, setTrusted] = useState(false);
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = (action: () => Promise<AdminProposal>) => {
    setBusy(true);
    setError(null);
    action().then(onChanged, (err: unknown) => {
      setError(errorMessage(err));
      setBusy(false);
    });
  };

  const m = p.metadata;
  const meta: [MessageKey, string | number | null][] = m
    ? [
        ["admin.meta.format", m.format],
        ["admin.meta.title", m.title],
        ["admin.meta.entries", m.entries === null ? null : m.entries.toLocaleString(locale)],
        ["admin.meta.version", m.version],
        ["admin.meta.encoding", m.encoding],
        ["admin.meta.languages", m.languages],
      ]
    : [];

  return (
    <div class="stack">
      {p.description && <p class="prewrap">{p.description}</p>}
      {p.sourceUrl && (
        <p>
          {t("admin.source")}:{" "}
          <a href={p.sourceUrl} target="_blank" rel="noopener noreferrer">
            {p.sourceUrl}
          </a>
        </p>
      )}
      {p.licenseNote && (
        <p>
          {t("admin.license")}: {p.licenseNote}
        </p>
      )}
      {meta.length > 0 && (
        <>
          <h4>{t("admin.metadata")}</h4>
          <dl class="meta">
            {meta
              .filter(([, v]) => v !== null && v !== "")
              .map(([k, v]) => (
                <div key={k}>
                  <dt>{t(k)}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
          </dl>
          {m?.description && <p class="small muted prewrap">{m.description}</p>}
        </>
      )}
      {p.warnings.length > 0 && (
        <>
          <h4>{t("admin.warnings")}</h4>
          <ul class="warnings">
            {p.warnings.map((w, i) => (
              <li key={i}>
                {w.path && <code>{w.path}</code>} {w.message}
              </li>
            ))}
          </ul>
        </>
      )}
      <h4>{t("admin.files")}</h4>
      <table class="files">
        <tbody>
          {p.files.map((f) => (
            <tr key={f.path}>
              <td>
                <code>{f.path}</code>
              </td>
              <td>{f.kind}</td>
              <td>{formatBytes(f.bytes, locale)}</td>
              <td>
                <code title={f.sha256 ?? ""}>{f.sha256?.slice(0, 12) ?? "—"}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {error && <Notice kind="error">{error}</Notice>}
      {p.status === "pending" && (
        <div class="review-actions">
          <form
            class="stack"
            onSubmit={(e) => {
              e.preventDefault();
              run(() =>
                approveProposal(p.id, {
                  dictId,
                  scope,
                  trustedRender: trusted,
                  title: title.trim(),
                  ...(note.trim() ? { note: note.trim() } : {}),
                }),
              );
            }}
          >
            <Field label={t("admin.dictId")} name={`dictId-${p.id}`} value={dictId} onInput={setDictId} required hint={t("admin.dictIdHint")} />
            <Field label={t("admin.dictTitle")} name={`title-${p.id}`} value={title} onInput={setTitle} required />
            <label class="field">
              <span>{t("admin.scope")}</span>
              <select
                value={scope}
                onChange={(e) => {
                  setScope(e.currentTarget.value as ApproveProposalRequest["scope"]);
                }}
              >
                <option value="global">{t("admin.scope.global")}</option>
                <option value="private" disabled={!p.proposer}>
                  {t("admin.scope.private")}
                </option>
                <option value="hidden">{t("admin.scope.hidden")}</option>
              </select>
            </label>
            <label class="check">
              <input
                type="checkbox"
                checked={trusted}
                onChange={(e) => {
                  setTrusted(e.currentTarget.checked);
                }}
              />
              <span>{t("admin.trusted")}</span>
            </label>
            <small class="hint">{t("admin.trustedHint")}</small>
            <label class="field">
              <span>{t("admin.reviewNote")}</span>
              <textarea rows={2} maxLength={2000} value={note} onInput={(e) => { setNote(e.currentTarget.value); }} />
            </label>
            <button type="submit" class="btn" disabled={busy || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(dictId) || !title.trim()}>
              {t("admin.approve")}
            </button>
          </form>
          <form
            class="stack"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => rejectProposal(p.id, reason.trim()));
            }}
          >
            <label class="field">
              <span>{t("admin.rejectReason")}</span>
              <textarea rows={2} maxLength={2000} required value={reason} onInput={(e) => { setReason(e.currentTarget.value); }} />
            </label>
            <button type="submit" class="btn btn-secondary" disabled={busy || !reason.trim()}>
              {t("admin.reject")}
            </button>
          </form>
        </div>
      )}
      {p.status === "approved" && p.dictId && <IndexProgress dictId={p.dictId} />}
      {p.status === "rejected" && p.reviewNote && <p>{t("proposals.reason", { note: p.reviewNote })}</p>}
    </div>
  );
}

export function AdminProposals() {
  const [filter, setFilter] = useState<ProposalStatus | "all">("pending");
  const [list, setList] = useState<AdminProposal[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((signal?: AbortSignal) => {
    setList(null);
    getAdminProposals(filter === "all" ? undefined : filter, signal).then(setList, (err: unknown) => {
      if (!signal?.aborted) setError(errorMessage(err));
    });
  }, [filter]);

  useEffect(() => {
    const ctrl = new AbortController();
    load(ctrl.signal);
    return () => {
      ctrl.abort();
    };
  }, [load]);

  const locale = getLocale();
  return (
    <main>
      <AdminNav current="proposals" />
      <h2>{t("admin.proposals")}</h2>
      <label class="field inline">
        <span>{t("admin.filter")}</span>
        <select
          value={filter}
          onChange={(e) => {
            setFilter(e.currentTarget.value as ProposalStatus | "all");
          }}
        >
          {filters.map((f) => (
            <option key={f} value={f}>
              {f === "all" ? t("admin.filter.all") : t(statusKey[f])}
            </option>
          ))}
        </select>
      </label>
      {error && <Notice kind="error">{error}</Notice>}
      {list === null ? (
        <p class="muted">{t("status.loading")}</p>
      ) : list.length === 0 ? (
        <p class="empty">{t("admin.none")}</p>
      ) : (
        <ul class="proposal-list">
          {list.map((p) => (
            <li key={p.id} class="card">
              <div class="row">
                <strong>{p.title}</strong> <span class={`badge badge-${p.status}`}>{t(statusKey[p.status])}</span>
                {p.warnings.length > 0 && <span class="badge badge-warn">⚠ {p.warnings.length}</span>}
              </div>
              <p class="small muted">
                {p.proposer ? t("admin.proposer", { name: p.proposer.name, email: p.proposer.email }) : t("admin.proposerGone")} ·{" "}
                {t("proposals.summary", {
                  count: p.fileCount,
                  size: formatBytes(p.totalBytes, locale),
                  date: new Date(p.createdAt).toLocaleDateString(locale),
                })}
              </p>
              <button
                type="button"
                class="btn btn-small btn-secondary"
                aria-expanded={open === p.id}
                onClick={() => {
                  setOpen(open === p.id ? null : p.id);
                }}
              >
                {open === p.id ? t("admin.hide") : t("admin.review")}
              </button>
              {open === p.id && (
                <Review
                  p={p}
                  onChanged={(next) => {
                    setList((l) => l?.map((x) => (x.id === next.id ? next : x)) ?? l);
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
