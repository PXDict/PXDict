// /reset-password?token=…: the page a password-reset email links to.
import { useState } from "preact/hooks";
import { resetPassword } from "../api/app";
import { t } from "../i18n";
import { errorMessage } from "../lib/errors";
import { navigate } from "../lib/router";
import { Field, Notice } from "./Field";

export function ResetPassword({ token }: { token: string | null }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(token ? null : t("error.invalidToken"));
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <main class="auth">
      <h1>{t("app.name")}</h1>
      <h2>{t("reset.title")}</h2>
      {error && <Notice kind="error">{error}</Notice>}
      {done ? (
        <>
          <Notice kind="info">{t("reset.done")}</Notice>
          <button class="btn btn-primary" type="button" onClick={() => { navigate("/login"); }}>
            {t("login.signIn")}
          </button>
        </>
      ) : (
        token && (
          <form
            class="stack"
            onSubmit={(e) => {
              e.preventDefault();
              setBusy(true);
              setError(null);
              resetPassword(token, password).then(
                () => {
                  setDone(true);
                  setBusy(false);
                },
                (err: unknown) => {
                  setError(errorMessage(err));
                  setBusy(false);
                },
              );
            }}
          >
            <Field label={t("reset.newPassword")} name="new-password" type="password" value={password} onInput={setPassword} autoComplete="new-password" required autoFocus />
            <button class="btn btn-primary" type="submit" disabled={busy}>
              {t("reset.submit")}
            </button>
          </form>
        )
      )}
    </main>
  );
}
