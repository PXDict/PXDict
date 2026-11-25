// The login screen, driven by GET /app-api/auth/methods: password (email or username), passkeys
// (button + autofill), social/OIDC providers, magic link and email code when SMTP is configured, the
// two-factor step, registration (with an invite code when required) and password reset.
import { useEffect, useState } from "preact/hooks";
import {
  claimInvite,
  getAuthMethods,
  passkeyAutofillAvailable,
  requestPasswordReset,
  sendMagicLink,
  sendSignInCode,
  signInWithCode,
  signInWithPasskey,
  signInWithPassword,
  signInWithProvider,
  signUp,
  verifyTwoFactor,
  type AuthMethods,
  type SignInOutcome,
} from "../api/app";
import { t } from "../i18n";
import { errorMessage } from "../lib/errors";
import { Field, Notice } from "./Field";

type Step = "sign-in" | "two-factor" | "register" | "forgot" | "magic-link" | "email-code";

export interface LoginProps {
  /** Path to open after signing in. */
  next: string;
  /** `?error=` from an OAuth callback. */
  callbackError: string | null;
  /** Called once a session exists; the app reloads /app-api/me. */
  onSignedIn: () => Promise<void>;
}

export function Login({ next, callbackError, onSignedIn }: LoginProps) {
  const [methods, setMethods] = useState<AuthMethods | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("sign-in");
  const [error, setError] = useState<string | null>(callbackError ? t("login.providerFailed") : null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [useBackup, setUseBackup] = useState(false);
  const [trustDevice, setTrustDevice] = useState(false);
  const [codeSent, setCodeSent] = useState(false);
  const [reg, setReg] = useState({ name: "", email: "", username: "", password: "", invite: "" });

  useEffect(() => {
    const ctrl = new AbortController();
    getAuthMethods(ctrl.signal).then(setMethods, (err: unknown) => {
      if (!ctrl.signal.aborted) setLoadError(errorMessage(err));
    });
    return () => {
      ctrl.abort();
    };
  }, []);

  // Passkeys in the username field's autofill (conditional UI); resolves only if the user picks one.
  useEffect(() => {
    if (!methods?.passkey || step !== "sign-in") return;
    let live = true;
    void passkeyAutofillAvailable().then((ok) => {
      if (!ok || !live) return;
      signInWithPasskey(true).then(
        (o) => {
          if (live) void finish(o);
        },
        () => {
          // Dismissed or not chosen: the form stays usable.
        },
      );
    });
    return () => {
      live = false;
    };
    // Deliberately not re-run on every render: that would restart the WebAuthn ceremony.
  }, [methods?.passkey, step]);

  const go = (s: Step) => {
    setStep(s);
    setError(null);
    setInfo(null);
    setCode("");
    setCodeSent(false);
  };

  /** Runs one action with the busy flag and error display. */
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const finish = async (outcome: SignInOutcome) => {
    if (outcome === "two-factor") {
      go("two-factor");
      return;
    }
    await onSignedIn();
  };

  if (loadError) {
    return (
      <main class="auth">
        <h1>{t("app.name")}</h1>
        <Notice kind="error">{loadError}</Notice>
      </main>
    );
  }
  if (!methods) {
    return (
      <main class="auth">
        <h1>{t("app.name")}</h1>
        <p role="status">{t("status.loading")}</p>
      </main>
    );
  }

  const canRegister = methods.registration !== "closed";

  const providers = methods.providers.length > 0 && (
    <div class="providers">
      {methods.providers.map((p) => (
        <button
          key={p.id}
          type="button"
          class="btn btn-secondary"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              if (step === "register" && reg.invite.trim()) await claimInvite(reg.invite.trim());
              await signInWithProvider(p.id, next);
            })
          }
        >
          {t("login.continueWith", { provider: p.label })}
        </button>
      ))}
    </div>
  );

  let body;
  switch (step) {
    case "sign-in":
      body = (
        <>
          <form
            class="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await finish(await signInWithPassword(login.trim(), password));
              });
            }}
          >
            <Field
              label={t("login.emailOrUsername")}
              name="username"
              value={login}
              onInput={setLogin}
              autoComplete={methods.passkey ? "username webauthn" : "username"}
              required
              autoFocus
            />
            <Field
              label={t("login.password")}
              name="password"
              type="password"
              value={password}
              onInput={setPassword}
              autoComplete="current-password"
              required
            />
            <button class="btn btn-primary" type="submit" disabled={busy}>
              {t("login.signIn")}
            </button>
          </form>
          {methods.passkey && (
            <button
              type="button"
              class="btn btn-secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await finish(await signInWithPasskey(false));
                })
              }
            >
              {t("login.passkey")}
            </button>
          )}
          {providers}
          <nav class="links">
            {methods.magicLink && (
              <button type="button" class="link" onClick={() => { go("magic-link"); }}>
                {t("login.magicLink")}
              </button>
            )}
            {methods.emailOtp && (
              <button type="button" class="link" onClick={() => { go("email-code"); }}>
                {t("login.emailCode")}
              </button>
            )}
            {methods.passwordReset && (
              <button type="button" class="link" onClick={() => { go("forgot"); }}>
                {t("login.forgot")}
              </button>
            )}
            {canRegister && (
              <button type="button" class="link" onClick={() => { go("register"); }}>
                {t("login.createAccount")}
              </button>
            )}
          </nav>
          {!methods.passwordReset && <p class="muted small">{t("login.forgotAskAdmin")}</p>}
        </>
      );
      break;

    case "two-factor":
      body = (
        <form
          class="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await verifyTwoFactor(code.trim(), useBackup ? "backup" : "totp", trustDevice);
              await onSignedIn();
            });
          }}
        >
          <p>{useBackup ? t("login.backupPrompt") : t("login.totpPrompt")}</p>
          <Field
            label={useBackup ? t("login.backupCode") : t("login.totpCode")}
            name="otp"
            value={code}
            onInput={setCode}
            autoComplete="one-time-code"
            inputMode={useBackup ? "text" : "numeric"}
            required
            autoFocus
          />
          <label class="check">
            <input
              type="checkbox"
              checked={trustDevice}
              onChange={(e) => {
                setTrustDevice(e.currentTarget.checked);
              }}
            />
            {t("login.trustDevice")}
          </label>
          <button class="btn btn-primary" type="submit" disabled={busy}>
            {t("login.verify")}
          </button>
          <button
            type="button"
            class="link"
            onClick={() => {
              setUseBackup(!useBackup);
              setCode("");
            }}
          >
            {useBackup ? t("login.useTotp") : t("login.useBackup")}
          </button>
        </form>
      );
      break;

    case "register":
      body = (
        <>
          <form
            class="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                if (reg.invite.trim()) await claimInvite(reg.invite.trim());
                await signUp({
                  name: reg.name.trim(),
                  email: reg.email.trim(),
                  password: reg.password,
                  ...(reg.username.trim() ? { username: reg.username.trim() } : {}),
                });
                // Better Auth signs the new user in; if the server ever requires a verified email first,
                // the session check fails and this screen stays with the hint below.
                if (methods.emailVerification) setInfo(t("login.verifyEmailSent"));
                await onSignedIn();
              });
            }}
          >
            {methods.registration === "invite" && (
              <Field
                label={t("login.inviteCode")}
                name="invite"
                value={reg.invite}
                onInput={(v) => {
                  setReg({ ...reg, invite: v });
                }}
                autoComplete="off"
                required
                hint={t("login.inviteHint")}
              />
            )}
            <Field label={t("login.name")} name="name" value={reg.name} onInput={(v) => { setReg({ ...reg, name: v }); }} autoComplete="name" required />
            <Field label={t("login.email")} name="email" type="email" value={reg.email} onInput={(v) => { setReg({ ...reg, email: v }); }} autoComplete="email" required inputMode="email" />
            <Field
              label={t("login.usernameOptional")}
              name="new-username"
              value={reg.username}
              onInput={(v) => {
                setReg({ ...reg, username: v });
              }}
              autoComplete="username"
            />
            <Field
              label={t("login.password")}
              name="new-password"
              type="password"
              value={reg.password}
              onInput={(v) => {
                setReg({ ...reg, password: v });
              }}
              autoComplete="new-password"
              minLength={methods.minPasswordLength}
              required
              hint={t("login.passwordHint", { min: methods.minPasswordLength })}
            />
            <button class="btn btn-primary" type="submit" disabled={busy}>
              {t("login.register")}
            </button>
          </form>
          {providers}
          <button type="button" class="link" onClick={() => { go("sign-in"); }}>
            {t("login.haveAccount")}
          </button>
        </>
      );
      break;

    case "forgot":
    case "magic-link":
    case "email-code":
      body = (
        <form
          class="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const email = login.trim();
              if (step === "forgot") {
                await requestPasswordReset(email);
                setInfo(t("login.resetSent"));
              } else if (step === "magic-link") {
                await sendMagicLink(email, next);
                setInfo(t("login.magicLinkSent"));
              } else if (!codeSent) {
                await sendSignInCode(email);
                setCodeSent(true);
                setInfo(t("login.codeSent"));
              } else {
                await signInWithCode(email, code.trim());
                await onSignedIn();
              }
            });
          }}
        >
          <p>{t(step === "forgot" ? "login.forgotPrompt" : step === "magic-link" ? "login.magicLinkPrompt" : "login.emailCodePrompt")}</p>
          <Field label={t("login.email")} name="email" type="email" value={login} onInput={setLogin} autoComplete="email" inputMode="email" required autoFocus />
          {step === "email-code" && codeSent && (
            <Field label={t("login.emailCodeLabel")} name="otp" value={code} onInput={setCode} autoComplete="one-time-code" inputMode="numeric" required autoFocus />
          )}
          <button class="btn btn-primary" type="submit" disabled={busy}>
            {step === "email-code" && codeSent ? t("login.signIn") : t("login.send")}
          </button>
          <button type="button" class="link" onClick={() => { go("sign-in"); }}>
            {t("login.back")}
          </button>
        </form>
      );
      break;
  }

  return (
    <main class="auth">
      <h1>{t("app.name")}</h1>
      <h2>{t(step === "register" ? "login.registerTitle" : step === "two-factor" ? "login.twoFactorTitle" : "login.title")}</h2>
      {error && <Notice kind="error">{error}</Notice>}
      {info && <Notice kind="info">{info}</Notice>}
      {body}
    </main>
  );
}
