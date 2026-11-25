// Account settings: profile, password, passkeys, linked accounts, two-factor, active sessions, and this
// device's preferences (language, theme).
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { encode } from "uqr";
import {
  addPasskey,
  changePassword,
  deletePasskey,
  disableTwoFactor,
  enableTwoFactor,
  getAuthMethods,
  linkProvider,
  listAccounts,
  listPasskeys,
  listSessions,
  regenerateBackupCodes,
  revokeOtherSessions,
  revokeSession,
  unlinkAccount,
  verifyTwoFactorSetup,
  type AuthMethods,
  type LinkedAccount,
  type Me,
  type PasskeyInfo,
  type SessionInfo,
  type TwoFactorSetup,
} from "../api/app";
import { getLocale, locales, localeNames, setLocalePref, t, type Locale } from "../i18n";
import { errorMessage } from "../lib/errors";
import { getThemePref, setThemePref, themePrefs, type ThemePref } from "../lib/theme";
import { Field, Notice } from "./Field";

export interface AccountProps {
  me: Me;
  /** Re-reads /app-api/me (e.g. after enabling two-factor). */
  onChanged: () => Promise<void>;
  onSignOut: () => void;
}

export function Account({ me, onChanged, onSignOut }: AccountProps) {
  const [methods, setMethods] = useState<AuthMethods | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    getAuthMethods(ctrl.signal).then(setMethods, () => {
      // The sections that need it stay hidden.
    });
    return () => {
      ctrl.abort();
    };
  }, []);

  const u = me.user;
  return (
    <main class="account">
      <h2>{t("account.title")}</h2>
      <Section title={t("account.profile")}>
        <dl class="profile">
          <dt>{t("login.name")}</dt>
          <dd>{u.name}</dd>
          <dt>{t("login.email")}</dt>
          <dd>
            {u.email} {!u.emailVerified && <span class="badge">{t("account.unverified")}</span>}
          </dd>
          {u.displayUsername && (
            <>
              <dt>{t("account.username")}</dt>
              <dd>{u.displayUsername}</dd>
            </>
          )}
          <dt>{t("account.role")}</dt>
          <dd>{t(u.role === "admin" ? "account.roleAdmin" : "account.roleUser")}</dd>
        </dl>
        {me.session.impersonatedBy && <Notice kind="info">{t("account.impersonated")}</Notice>}
      </Section>
      <Preferences />
      <PasswordSection minLength={methods?.minPasswordLength ?? 10} />
      <TwoFactorSection enabled={u.twoFactorEnabled} required={methods?.adminRequiresTwoFactor === true && u.role === "admin"} onChanged={onChanged} />
      {methods?.passkey && <PasskeysSection />}
      {methods && <AccountsSection methods={methods} />}
      <SessionsSection currentId={me.session.id} />
      <Section title={t("account.signOutTitle")}>
        <p class="muted small">{t("account.signOutHint")}</p>
        <button type="button" class="btn btn-secondary" onClick={onSignOut}>
          {t("nav.signOut")}
        </button>
      </Section>
    </main>
  );
}

function Section({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <section class="card">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

/** busy/error/info state for one section's actions. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  /** Runs an action; a returned string is shown as an info message. */
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const msg = await action();
      if (typeof msg === "string" && msg) setInfo(msg);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const notices = (
    <>
      {error && <Notice kind="error">{error}</Notice>}
      {info && <Notice kind="info">{info}</Notice>}
    </>
  );
  return { busy, run, notices };
}

function Preferences() {
  const [locale, setLoc] = useState<Locale>(getLocale());
  const [theme, setTheme] = useState<ThemePref>(getThemePref());
  return (
    <Section title={t("account.device")}>
      <label class="field">
        <span>{t("account.language")}</span>
        <select
          value={locale}
          onChange={(e) => {
            const l = e.currentTarget.value as Locale;
            setLocalePref(l);
            setLoc(l);
          }}
        >
          {locales.map((l) => (
            <option key={l} value={l}>
              {localeNames[l]}
            </option>
          ))}
        </select>
      </label>
      <label class="field">
        <span>{t("account.theme")}</span>
        <select
          value={theme}
          onChange={(e) => {
            const v = e.currentTarget.value as ThemePref;
            setThemePref(v);
            setTheme(v);
          }}
        >
          {themePrefs.map((p) => (
            <option key={p} value={p}>
              {t(`theme.${p}`)}
            </option>
          ))}
        </select>
      </label>
    </Section>
  );
}

function PasswordSection({ minLength }: { minLength: number }) {
  const { busy, run, notices } = useAction();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [revoke, setRevoke] = useState(true);
  return (
    <Section title={t("account.password")}>
      {notices}
      <form
        class="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await changePassword(current, next, revoke);
            setCurrent("");
            setNext("");
            return t("account.passwordChanged");
          });
        }}
      >
        {/* Lets password managers file the change under the right account. */}
        <input type="text" name="username" autocomplete="username" hidden />
        <Field label={t("account.currentPassword")} name="current-password" type="password" value={current} onInput={setCurrent} autoComplete="current-password" required />
        <Field
          label={t("reset.newPassword")}
          name="new-password"
          type="password"
          value={next}
          onInput={setNext}
          autoComplete="new-password"
          minLength={minLength}
          required
          hint={t("login.passwordHint", { min: minLength })}
        />
        <label class="check">
          <input
            type="checkbox"
            checked={revoke}
            onChange={(e) => {
              setRevoke(e.currentTarget.checked);
            }}
          />
          {t("account.revokeOthers")}
        </label>
        <button class="btn btn-primary" type="submit" disabled={busy}>
          {t("account.changePassword")}
        </button>
      </form>
      <p class="muted small">{t("account.noPasswordHint")}</p>
    </Section>
  );
}

/** A QR code for an otpauth:// URI, drawn as one SVG path (no HTML injection). */
function QrCode({ text, label }: { text: string; label: string }) {
  const { size, data } = encode(text, { border: 2 });
  let d = "";
  data.forEach((row, y) => {
    row.forEach((on, x) => {
      if (on) d += `M${String(x)} ${String(y)}h1v1h-1z`;
    });
  });
  return (
    <svg class="qr" viewBox={`0 0 ${String(size)} ${String(size)}`} role="img" aria-label={label} shape-rendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}

function secretOf(uri: string): string {
  try {
    return new URL(uri).searchParams.get("secret") ?? "";
  } catch {
    return "";
  }
}

function TwoFactorSection({ enabled, required, onChanged }: { enabled: boolean; required: boolean; onChanged: () => Promise<void> }) {
  const { busy, run, notices } = useAction();
  const [password, setPassword] = useState("");
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState("");

  const passwordField = (
    <Field label={t("account.currentPassword")} name="2fa-password" type="password" value={password} onInput={setPassword} autoComplete="current-password" required />
  );

  let content;
  if (setup) {
    content = (
      <form
        class="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await verifyTwoFactorSetup(code.trim());
            setCodes(setup.backupCodes);
            setSetup(null);
            setCode("");
            await onChanged();
            return t("account.twoFactorOn");
          });
        }}
      >
        <p>{t("account.twoFactorScan")}</p>
        <QrCode text={setup.totpURI} label={t("account.twoFactorQr")} />
        <p class="small">
          {t("account.twoFactorSecret")} <code class="secret">{secretOf(setup.totpURI)}</code>
        </p>
        <a class="small" href={setup.totpURI}>
          {t("account.twoFactorOpenApp")}
        </a>
        <Field label={t("login.totpCode")} name="otp" value={code} onInput={setCode} autoComplete="one-time-code" inputMode="numeric" required />
        <button class="btn btn-primary" type="submit" disabled={busy}>
          {t("login.verify")}
        </button>
      </form>
    );
  } else if (!enabled) {
    content = (
      <form
        class="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            setSetup(await enableTwoFactor(password));
            setPassword("");
          });
        }}
      >
        <p class="muted small">{t("account.twoFactorHint")}</p>
        {passwordField}
        <button class="btn btn-primary" type="submit" disabled={busy}>
          {t("account.twoFactorEnable")}
        </button>
      </form>
    );
  } else {
    content = (
      <form class="stack" onSubmit={(e) => { e.preventDefault(); }}>
        <p>{t("account.twoFactorIsOn")}</p>
        {passwordField}
        <div class="row">
          <button
            type="button"
            class="btn btn-secondary"
            disabled={busy || !password}
            onClick={() =>
              void run(async () => {
                setCodes(await regenerateBackupCodes(password));
                setPassword("");
              })
            }
          >
            {t("account.backupCodesNew")}
          </button>
          <button
            type="button"
            class="btn btn-danger"
            disabled={busy || !password}
            onClick={() =>
              void run(async () => {
                await disableTwoFactor(password);
                setPassword("");
                setCodes(null);
                await onChanged();
                return t("account.twoFactorOff");
              })
            }
          >
            {t("account.twoFactorDisable")}
          </button>
        </div>
      </form>
    );
  }

  return (
    <Section title={t("account.twoFactor")}>
      {required && !enabled && <Notice kind="info">{t("account.twoFactorRequired")}</Notice>}
      {notices}
      {codes && (
        <div class="codes">
          <p>{t("account.backupCodes")}</p>
          <ul>
            {codes.map((c) => (
              <li key={c}>
                <code>{c}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      {content}
    </Section>
  );
}

function PasskeysSection() {
  const { busy, run, notices } = useAction();
  const [list, setList] = useState<PasskeyInfo[] | null>(null);
  const [name, setName] = useState("");
  const reload = async () => {
    setList(await listPasskeys());
  };
  useEffect(() => {
    void run(reload);
    // Load once.
  }, []);
  return (
    <Section title={t("account.passkeys")}>
      {notices}
      {list && list.length === 0 && <p class="muted small">{t("account.passkeysNone")}</p>}
      {list && list.length > 0 && (
        <ul class="list">
          {list.map((p) => (
            <li key={p.id}>
              <span>
                {p.name ?? t("account.passkeyUnnamed")}
                <small class="muted"> · {p.createdAt.toLocaleDateString(getLocale())}</small>
              </span>
              <button
                type="button"
                class="btn btn-small btn-danger"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    if (!confirm(t("account.passkeyDeleteConfirm"))) return;
                    await deletePasskey(p.id);
                    await reload();
                  })
                }
              >
                {t("account.remove")}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        class="row"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await addPasskey(name.trim() || defaultPasskeyName());
            setName("");
            await reload();
            return t("account.passkeyAdded");
          });
        }}
      >
        <Field label={t("account.passkeyName")} name="passkey-name" value={name} onInput={setName} autoComplete="off" />
        <button class="btn btn-primary" type="submit" disabled={busy}>
          {t("account.passkeyAdd")}
        </button>
      </form>
    </Section>
  );
}

function defaultPasskeyName(): string {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${os} passkey` : "Passkey";
}

function AccountsSection({ methods }: { methods: AuthMethods }) {
  const { busy, run, notices } = useAction();
  const [list, setList] = useState<LinkedAccount[] | null>(null);
  const reload = async () => {
    setList(await listAccounts());
  };
  useEffect(() => {
    void run(reload);
  }, []);
  const label = (providerId: string) =>
    providerId === "credential" ? t("account.passwordMethod") : (methods.providers.find((p) => p.id === providerId)?.label ?? providerId);
  const linked = new Set(list?.map((a) => a.providerId));
  const linkable = methods.providers.filter((p) => !linked.has(p.id));
  if (!methods.providers.length && list?.every((a) => a.providerId === "credential")) return null;
  return (
    <Section title={t("account.linked")}>
      {notices}
      {list && (
        <ul class="list">
          {list.map((a) => (
            <li key={a.id}>
              <span>{label(a.providerId)}</span>
              {a.providerId !== "credential" && (
                <button
                  type="button"
                  class="btn btn-small btn-secondary"
                  disabled={busy || list.length <= 1}
                  title={list.length <= 1 ? t("error.lastAccount") : undefined}
                  onClick={() =>
                    void run(async () => {
                      await unlinkAccount(a.accountId);
                      await reload();
                    })
                  }
                >
                  {t("account.unlink")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {linkable.length > 0 && (
        <div class="providers">
          {linkable.map((p) => (
            <button
              key={p.id}
              type="button"
              class="btn btn-secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await linkProvider(p.id, "/account");
                })
              }
            >
              {t("account.link", { provider: p.label })}
            </button>
          ))}
        </div>
      )}
    </Section>
  );
}

/** A short "Browser on OS" description of a User-Agent string. */
export function describeAgent(ua: string | null): string {
  if (!ua) return "";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "";
  const os = /Android/.test(ua)
    ? "Android"
    : /iPhone|iPad/.test(ua)
      ? "iOS"
      : /Mac OS X/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return [browser, os].filter(Boolean).join(" · ") || ua.slice(0, 60);
}

function SessionsSection({ currentId }: { currentId: string }) {
  const { busy, run, notices } = useAction();
  const [list, setList] = useState<SessionInfo[] | null>(null);
  const reload = async () => {
    setList(await listSessions());
  };
  useEffect(() => {
    void run(reload);
  }, []);
  const fmt = (d: Date) => d.toLocaleString(getLocale(), { dateStyle: "medium", timeStyle: "short" });
  return (
    <Section title={t("account.sessions")}>
      {notices}
      {list && (
        <ul class="list">
          {list.map((s) => (
            <li key={s.id}>
              <span>
                {describeAgent(s.userAgent) || t("account.unknownDevice")}
                <small class="muted">
                  {" "}
                  · {t("account.sessionSince", { date: fmt(s.createdAt) })}
                  {s.ipAddress && ` · ${s.ipAddress}`}
                </small>
                {s.id === currentId && <span class="badge">{t("account.thisDevice")}</span>}
              </span>
              {s.id !== currentId && <button
                type="button"
                class="btn btn-small btn-secondary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await revokeSession(s.token);
                    await reload();
                  })
                }
              >
                {t("account.revoke")}
              </button>}
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        class="btn btn-secondary"
        disabled={busy}
        onClick={() =>
          void run(async () => {
            await revokeOtherSessions();
            await reload();
            return t("account.othersRevoked");
          })
        }
      >
        {t("account.revokeOthersNow")}
      </button>
    </Section>
  );
}
