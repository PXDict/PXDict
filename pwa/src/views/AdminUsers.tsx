// User management for admins: accounts (role, suspend, sign out everywhere, delete) through Better
// Auth's admin plugin, and invite codes for REGISTRATION=invite.
import { useCallback, useEffect, useState } from "preact/hooks";
import {
  banUser,
  createInvite,
  deleteInvite,
  getInvites,
  listUsers,
  removeUser,
  revokeUserSessions,
  setUserRole,
  unbanUser,
  type AdminUser,
  type CreateInviteResponse,
  type Invite,
} from "../api/app";
import { getLocale, t, type MessageKey } from "../i18n";
import { errorMessage } from "../lib/errors";
import { AdminNav } from "./AdminNav";
import { Field, Notice } from "./Field";

const pageSize = 50;

const inviteStatusKey: Record<Invite["status"], MessageKey> = {
  active: "users.invite.active",
  used: "users.invite.used",
  expired: "users.invite.expired",
};

function Invites() {
  const locale = getLocale();
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [role, setRole] = useState<"user" | "admin">("user");
  const [days, setDays] = useState("7");
  const [note, setNote] = useState("");
  const [created, setCreated] = useState<CreateInviteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((signal?: AbortSignal) => {
    getInvites(signal).then(setInvites, (err: unknown) => {
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

  const create = (e: Event) => {
    e.preventDefault();
    setError(null);
    const expiresInDays = Math.min(90, Math.max(1, Number(days) || 7));
    createInvite({ role, expiresInDays, ...(note.trim() ? { note: note.trim() } : {}) }).then(
      (r) => {
        setCreated(r);
        setNote("");
        load();
      },
      (err: unknown) => {
        setError(errorMessage(err));
      },
    );
  };

  return (
    <section>
      <h3>{t("users.invites")}</h3>
      {error && <Notice kind="error">{error}</Notice>}
      <form class="row" onSubmit={create}>
        <label class="field inline">
          <span>{t("users.role")}</span>
          <select
            value={role}
            onChange={(e) => {
              setRole(e.currentTarget.value === "admin" ? "admin" : "user");
            }}
          >
            <option value="user">{t("account.roleUser")}</option>
            <option value="admin">{t("account.roleAdmin")}</option>
          </select>
        </label>
        <Field label={t("users.invite.days")} name="invite-days" value={days} onInput={setDays} inputMode="numeric" />
        <Field label={t("users.invite.note")} name="invite-note" value={note} onInput={setNote} />
        <button type="submit" class="btn btn-secondary">
          {t("users.invite.create")}
        </button>
      </form>
      {created && (
        <Notice kind="info">
          {t("users.invite.code")} <code class="prewrap">{created.code}</code>
        </Notice>
      )}
      {invites && invites.length > 0 && (
        <table class="files">
          <tbody>
            {invites.map((i) => (
              <tr key={i.id}>
                <td>{t(inviteStatusKey[i.status])}</td>
                <td>{t(i.role === "admin" ? "account.roleAdmin" : "account.roleUser")}</td>
                <td>{i.note ?? ""}</td>
                <td>{t("users.invite.expires", { date: new Date(i.expiresAt).toLocaleDateString(locale) })}</td>
                <td>
                  {i.status === "active" && (
                    <button
                      type="button"
                      class="link"
                      onClick={() => {
                        deleteInvite(i.id).then(
                          () => {
                            load();
                          },
                          (err: unknown) => {
                            setError(errorMessage(err));
                          },
                        );
                      }}
                    >
                      {t("users.invite.delete")}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function AdminUsers({ selfId }: { selfId: string }) {
  const locale = getLocale();
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<{ users: AdminUser[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const load = useCallback(
    (signal?: AbortSignal) => {
      listUsers({ search: search.trim(), limit: pageSize, offset }).then(
        (p) => {
          if (!signal?.aborted) setPage(p);
        },
        (err: unknown) => {
          if (!signal?.aborted) setError(errorMessage(err));
        },
      );
    },
    [search, offset],
  );
  useEffect(() => {
    const ctrl = new AbortController();
    load(ctrl.signal);
    return () => {
      ctrl.abort();
    };
  }, [load]);

  /** Runs an action, then reloads the list. */
  const act = (fn: () => Promise<void>, done: string) => {
    setError(null);
    setInfo(null);
    fn().then(
      () => {
        setInfo(done);
        load();
      },
      (err: unknown) => {
        setError(errorMessage(err));
      },
    );
  };

  return (
    <main>
      <AdminNav current="users" />
      <h2>{t("admin.users")}</h2>
      <Field
        label={t("users.search")}
        name="user-search"
        type="email"
        value={search}
        onInput={(v) => {
          setSearch(v);
          setOffset(0);
        }}
      />
      {error && <Notice kind="error">{error}</Notice>}
      {info && <Notice kind="info">{info}</Notice>}
      {page === null ? (
        <p class="muted">{t("status.loading")}</p>
      ) : page.users.length === 0 ? (
        <p class="empty">{t("admin.none")}</p>
      ) : (
        <ul class="proposal-list">
          {page.users.map((u) => {
            const self = u.id === selfId;
            return (
              <li key={u.id} class="card">
                <div class="row">
                  <strong>{u.name}</strong> <span>{u.email}</span>
                  {u.username && <code class="small">{u.username}</code>}
                  <span class="badge">{t(u.role === "admin" ? "account.roleAdmin" : "account.roleUser")}</span>
                  {u.banned && <span class="badge badge-warn">{t("users.banned")}</span>}
                  {!u.emailVerified && <span class="badge">{t("users.unverified")}</span>}
                  <span class="small muted">{t("users.since", { date: new Date(u.createdAt).toLocaleDateString(locale) })}</span>
                </div>
                {u.banned && u.banReason && <p class="small">{u.banReason}</p>}
                {!self && (
                  <div class="row">
                    <button
                      type="button"
                      class="btn btn-small btn-secondary"
                      onClick={() => {
                        const next = u.role === "admin" ? "user" : "admin";
                        if (!confirm(t(next === "admin" ? "users.makeAdminConfirm" : "users.makeUserConfirm", { name: u.name }))) return;
                        act(() => setUserRole(u.id, next), t("users.saved"));
                      }}
                    >
                      {t(u.role === "admin" ? "users.makeUser" : "users.makeAdmin")}
                    </button>
                    {u.banned ? (
                      <button
                        type="button"
                        class="btn btn-small btn-secondary"
                        onClick={() => {
                          act(() => unbanUser(u.id), t("users.saved"));
                        }}
                      >
                        {t("users.unban")}
                      </button>
                    ) : (
                      <button
                        type="button"
                        class="btn btn-small btn-secondary"
                        onClick={() => {
                          const reason = prompt(t("users.banReason", { name: u.name }));
                          if (reason === null) return;
                          act(() => banUser(u.id, reason.trim() || undefined), t("users.saved"));
                        }}
                      >
                        {t("users.ban")}
                      </button>
                    )}
                    <button
                      type="button"
                      class="btn btn-small btn-secondary"
                      onClick={() => {
                        act(() => revokeUserSessions(u.id), t("users.signedOut"));
                      }}
                    >
                      {t("users.signOutAll")}
                    </button>
                    <button
                      type="button"
                      class="btn btn-small btn-danger"
                      onClick={() => {
                        if (!confirm(t("users.removeConfirm", { name: u.name, email: u.email }))) return;
                        act(() => removeUser(u.id), t("users.removed"));
                      }}
                    >
                      {t("users.remove")}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {page && page.total > pageSize && (
        <div class="row">
          <button
            type="button"
            class="btn btn-small btn-secondary"
            disabled={offset === 0}
            onClick={() => {
              setOffset(Math.max(0, offset - pageSize));
            }}
          >
            {t("users.prev")}
          </button>
          <span>{t("users.range", { from: offset + 1, to: Math.min(offset + pageSize, page.total), total: page.total })}</span>
          <button
            type="button"
            class="btn btn-small btn-secondary"
            disabled={offset + pageSize >= page.total}
            onClick={() => {
              setOffset(offset + pageSize);
            }}
          >
            {t("users.next")}
          </button>
        </div>
      )}
      <Invites />
    </main>
  );
}
