import { useEffect, useState } from "preact/hooks";
import { getHealth } from "./api/app";
import { t } from "./i18n";

type Status = { kind: "checking" } | { kind: "ok"; version: string } | { kind: "down" };

export function App() {
  const [status, setStatus] = useState<Status>({ kind: "checking" });

  useEffect(() => {
    const ctrl = new AbortController();
    getHealth(ctrl.signal).then(
      (h) => {
        setStatus({ kind: "ok", version: h.version });
      },
      () => {
        if (!ctrl.signal.aborted) setStatus({ kind: "down" });
      },
    );
    return () => {
      ctrl.abort();
    };
  }, []);

  return (
    <main class="shell">
      <h1>{t("app.name")}</h1>
      <p>{t("app.tagline")}</p>
      <p class="status" role="status">
        {status.kind === "ok"
          ? t("status.ok", { version: status.version })
          : t(status.kind === "down" ? "status.down" : "status.checking")}
      </p>
    </main>
  );
}
