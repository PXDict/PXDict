// The app shell: who is signed in (with an offline fallback), the routes, and the header.
import { useCallback, useEffect, useState } from "preact/hooks";
import { getMe, isNetworkError, onUnauthorized, signOut, ApiError, type Me } from "./api/app";
import { onLocaleChange, t } from "./i18n";
import { readLastUser, setActiveUser, wipeUserData, type LastUser } from "./lib/offline";
import { loginUrl, navigate, safeNext, useLocation } from "./lib/router";
import { Account } from "./views/Account";
import { Notice } from "./views/Field";
import { Login } from "./views/Login";
import { ResetPassword } from "./views/ResetPassword";
import { SearchView } from "./views/SearchView";
import { UpdatePrompt } from "./views/UpdatePrompt";

type Session =
  | { kind: "loading" }
  | { kind: "signed-out" }
  /** Online, with the full /app-api/me answer. */
  | { kind: "signed-in"; me: Me }
  /** The server cannot be reached; earlier lookups are available from the cache. */
  | { kind: "offline"; user: LastUser };

/** Paths the login screen owns while signed out. */
const publicPaths = new Set(["/login", "/reset-password"]);

export function App() {
  const loc = useLocation();
  const [session, setSession] = useState<Session>({ kind: "loading" });
  const [fatal, setFatal] = useState<string | null>(null);
  const [, setLocaleTick] = useState(0);

  useEffect(
    () =>
      onLocaleChange(() => {
        setLocaleTick((n) => n + 1);
      }),
    [],
  );

  const loadMe = useCallback(async () => {
    try {
      const me = await getMe();
      setSession({ kind: "signed-in", me });
      setFatal(null);
      await setActiveUser({ id: me.user.id, name: me.user.name, role: me.user.role });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setSession({ kind: "signed-out" });
      } else if (isNetworkError(err)) {
        const last = readLastUser();
        setSession(last ? { kind: "offline", user: last } : { kind: "signed-out" });
        if (!last) setFatal(t("error.offline"));
      } else {
        setFatal(t("error.server"));
        setSession({ kind: "signed-out" });
      }
    }
  }, []);

  useEffect(() => {
    void loadMe();
  }, [loadMe]);

  // Back online after starting offline: check the session again.
  useEffect(() => {
    if (session.kind !== "offline") return;
    const retry = () => void loadMe();
    addEventListener("online", retry);
    return () => {
      removeEventListener("online", retry);
    };
  }, [session.kind, loadMe]);

  // Any 401 (session expired or revoked elsewhere) goes back to the login screen, keeping the page.
  useEffect(
    () =>
      onUnauthorized(() => {
        setSession((s) => {
          if (s.kind === "signed-in" || s.kind === "offline") {
            if (!publicPaths.has(location.pathname)) navigate(loginUrl(), true);
            return { kind: "signed-out" };
          }
          return s;
        });
      }),
    [],
  );

  // Signed out on a private page: go to the login screen and come back afterwards.
  useEffect(() => {
    if (session.kind === "signed-out" && !publicPaths.has(loc.path)) navigate(loginUrl(), true);
    if (session.kind === "signed-in" && publicPaths.has(loc.path)) navigate(safeNext(loc.query.get("next")), true);
  }, [session.kind, loc]);

  const doSignOut = () => {
    void (async () => {
      try {
        await signOut();
      } catch {
        // Offline or already signed out: still forget everything on this device.
      }
      await wipeUserData();
      setSession({ kind: "signed-out" });
      navigate("/login", true);
    })();
  };

  if (session.kind === "loading") {
    return (
      <main class="shell">
        <p role="status" class="muted">
          {t("status.loading")}
        </p>
      </main>
    );
  }

  if (session.kind === "signed-out") {
    return (
      <>
        {fatal && <Notice kind="error">{fatal}</Notice>}
        {loc.path === "/reset-password" ? (
          <ResetPassword token={loc.query.get("token")} />
        ) : (
          <Login next={safeNext(loc.query.get("next"))} callbackError={loc.query.get("error")} onSignedIn={loadMe} />
        )}
        <UpdatePrompt />
      </>
    );
  }

  const name = session.kind === "signed-in" ? session.me.user.name : session.user.name;
  let page;
  if (loc.path === "/") page = <SearchView loc={loc} />;
  else if (loc.path === "/account" && session.kind === "signed-in") {
    page = <Account me={session.me} onChanged={loadMe} onSignOut={doSignOut} />;
  } else if (loc.path === "/account") page = <Notice kind="info">{t("error.offline")}</Notice>;
  else if (publicPaths.has(loc.path)) page = null;
  else {
    page = (
      <main class="shell">
        <p>{t("error.notFound")}</p>
        <a href="/" onClick={(e) => { e.preventDefault(); navigate("/"); }}>
          {t("nav.search")}
        </a>
      </main>
    );
  }

  return (
    <>
      <header class="topbar">
        <a class="brand" href="/" onClick={(e) => { e.preventDefault(); navigate("/"); }}>
          {t("app.name")}
        </a>
        <nav>
          {session.kind === "offline" && <span class="badge">{t("status.offline")}</span>}
          <a
            href="/account"
            aria-current={loc.path === "/account" ? "page" : undefined}
            onClick={(e) => {
              e.preventDefault();
              navigate("/account");
            }}
          >
            {name}
          </a>
          <button type="button" class="link" onClick={doSignOut}>
            {t("nav.signOut")}
          </button>
        </nav>
      </header>
      <div class="shell">{page}</div>
      <UpdatePrompt />
    </>
  );
}
