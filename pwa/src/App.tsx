// The app shell: who is signed in (with an offline fallback), the routes, and the header.
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  getMe,
  isNetworkError,
  markDictsSeen,
  markProposalsSeen,
  onUnauthorized,
  signOut,
  ApiError,
  type Me,
  type UserSettings,
} from "./api/app";
import { onLocaleChange, t } from "./i18n";
import { readLastUser, setActiveUser, wipeUserData, type LastUser } from "./lib/offline";
import { loginUrl, navigate, safeNext, useLocation } from "./lib/router";
import { applySettings } from "./lib/settings";
import { Account } from "./views/Account";
import { AdminAudit } from "./views/AdminAudit";
import { AdminDicts } from "./views/AdminDicts";
import { AdminProposals } from "./views/AdminProposals";
import { AdminStorage } from "./views/AdminStorage";
import { AdminUsers } from "./views/AdminUsers";
import { Dictionaries } from "./views/Dictionaries";
import { Favorites } from "./views/Favorites";
import { Notice } from "./views/Field";
import { History } from "./views/History";
import { Login } from "./views/Login";
import { Proposals } from "./views/Proposals";
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

/** The page name in the document title (the search page sets its own title from the query). */
function pageTitle(path: string): string | undefined {
  if (path === "/account") return t("account.title");
  if (path === "/history") return t("nav.history");
  if (path === "/favorites") return t("nav.favorites");
  if (path === "/dictionaries") return t("nav.dicts");
  if (path === "/proposals") return t("nav.propose");
  if (path === "/admin" || path.startsWith("/admin/")) return t("admin.nav");
  return undefined;
}

/** The element that holds the current page; focused after client-side navigation. */
const contentId = "content";
const focusContent = () => {
  document.getElementById(contentId)?.focus();
};

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
      applySettings(me.settings);
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

  // After client-side navigation, move focus to the new page (screen readers announce it, keyboard
  // users continue from there) and name it in the title. The search page focuses its own input.
  const shownPath = useRef<string | undefined>(undefined);
  const inApp = session.kind === "signed-in" || session.kind === "offline";
  useEffect(() => {
    if (!inApp) return;
    const previous = shownPath.current;
    shownPath.current = loc.path;
    const title = pageTitle(loc.path);
    if (title !== undefined) document.title = `${title} – ${t("app.name")}`;
    if (previous !== undefined && previous !== loc.path && loc.path !== "/") focusContent();
  }, [inApp, loc.path]);

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

  /** Saved settings (Account) or acknowledged new dictionaries: update the copy of /me. */
  const patchMe = useCallback((patch: Partial<Me>) => {
    setSession((s) => (s.kind === "signed-in" ? { kind: "signed-in", me: { ...s.me, ...patch } } : s));
  }, []);
  const onSettings = useCallback((settings: UserSettings) => {
    patchMe({ settings });
  }, [patchMe]);
  const onDictsSeen = useCallback(() => {
    patchMe({ newDicts: [] });
  }, [patchMe]);
  const onProposalsSeen = useCallback(() => {
    patchMe({ proposalUpdates: [] });
  }, [patchMe]);

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

  const me = session.kind === "signed-in" ? session.me : undefined;
  const name = me ? me.user.name : session.kind === "offline" ? session.user.name : "";
  // Pages that need the server; offline they say so.
  const offline = <Notice kind="info">{t("error.offline")}</Notice>;
  let page;
  if (loc.path === "/") page = <SearchView loc={loc} historyEnabled={me?.settings.historyEnabled ?? false} />;
  else if (loc.path === "/account") page = me ? <Account me={me} onChanged={loadMe} onSignOut={doSignOut} onSettings={onSettings} /> : offline;
  else if (loc.path === "/history") page = me ? <History enabled={me.settings.historyEnabled} /> : offline;
  else if (loc.path === "/favorites") page = me ? <Favorites /> : offline;
  else if (loc.path === "/dictionaries") page = me ? <Dictionaries onSeen={onDictsSeen} /> : offline;
  else if (loc.path === "/proposals") page = me ? <Proposals onSeen={onProposalsSeen} /> : offline;
  else if ((loc.path === "/admin" || loc.path === "/admin/proposals") && me?.user.role === "admin") page = <AdminProposals />;
  else if (loc.path === "/admin/dicts" && me?.user.role === "admin") page = <AdminDicts />;
  else if (loc.path === "/admin/users" && me?.user.role === "admin") page = <AdminUsers selfId={me.user.id} />;
  else if (loc.path === "/admin/storage" && me?.user.role === "admin") page = <AdminStorage />;
  else if (loc.path === "/admin/audit" && me?.user.role === "admin") page = <AdminAudit />;
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

  const navLink = (path: string, label: string) => (
    <a
      href={path}
      aria-current={loc.path === path ? "page" : undefined}
      onClick={(e) => {
        e.preventDefault();
        navigate(path);
      }}
    >
      {label}
    </a>
  );

  const newDicts = me?.newDicts ?? [];
  const decisions = me?.proposalUpdates ?? [];
  const isAdmin = me?.user.role === "admin";

  return (
    <>
      <a
        class="skip-link"
        href={`#${contentId}`}
        onClick={(e) => {
          e.preventDefault();
          focusContent();
        }}
      >
        {t("nav.skip")}
      </a>
      <header class="topbar">
        <a class="brand" href="/" onClick={(e) => { e.preventDefault(); navigate("/"); }}>
          {t("app.name")}
        </a>
        <nav aria-label={t("nav.main")}>
          {session.kind === "offline" && <span class="badge">{t("status.offline")}</span>}
          {navLink("/history", t("nav.history"))}
          {navLink("/favorites", t("nav.favorites"))}
          {navLink("/dictionaries", t("nav.dicts"))}
          {navLink("/proposals", t("nav.propose"))}
          {isAdmin && (
            <a
              href="/admin/proposals"
              aria-current={loc.path === "/admin" || loc.path.startsWith("/admin/") ? "page" : undefined}
              onClick={(e) => {
                e.preventDefault();
                navigate("/admin/proposals");
              }}
            >
              {t("nav.admin")}
            </a>
          )}
          {navLink("/account", name)}
          <button type="button" class="link" onClick={doSignOut}>
            {t("nav.signOut")}
          </button>
        </nav>
      </header>
      {newDicts.length > 0 && loc.path !== "/dictionaries" && (
        <div class="shell banner" role="status">
          <span>{t("newDicts.notice", { names: newDicts.map((d) => d.title).join(", ") })}</span>{" "}
          <a
            href="/dictionaries"
            onClick={(e) => {
              e.preventDefault();
              navigate("/dictionaries");
            }}
          >
            {t("newDicts.manage")}
          </a>{" "}
          <button
            type="button"
            class="link"
            onClick={() => {
              onDictsSeen();
              markDictsSeen().catch(() => {
                // Announced again next time.
              });
            }}
          >
            {t("newDicts.dismiss")}
          </button>
        </div>
      )}
      {decisions.length > 0 && loc.path !== "/proposals" && (
        <div class="shell banner" role="status">
          {decisions.map((d) => (
            <span key={d.id}>
              {t(d.status === "approved" ? "proposalUpdates.approved" : "proposalUpdates.rejected", { title: d.title })}{" "}
            </span>
          ))}
          <a
            href="/proposals"
            onClick={(e) => {
              e.preventDefault();
              navigate("/proposals");
            }}
          >
            {t("proposalUpdates.view")}
          </a>{" "}
          <button
            type="button"
            class="link"
            onClick={() => {
              onProposalsSeen();
              markProposalsSeen().catch(() => {
                // Announced again next time.
              });
            }}
          >
            {t("newDicts.dismiss")}
          </button>
        </div>
      )}
      <div class="shell" id={contentId} tabIndex={-1}>
        {page}
      </div>
      <UpdatePrompt />
    </>
  );
}
