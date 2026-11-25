// The admin area's sections (visible to admins only; the gateway checks every /app-api/admin call).
import { t, type MessageKey } from "../i18n";
import { navigate } from "../lib/router";

export type AdminSection = "users" | "proposals" | "dicts" | "storage" | "audit";

const sections: readonly [AdminSection, string, MessageKey][] = [
  ["users", "/admin/users", "admin.users"],
  ["proposals", "/admin/proposals", "admin.proposals"],
  ["dicts", "/admin/dicts", "admin.dicts"],
  ["storage", "/admin/storage", "admin.storage"],
  ["audit", "/admin/audit", "admin.audit"],
];

export function AdminNav({ current }: { current: AdminSection }) {
  return (
    <nav class="subnav" aria-label={t("admin.nav")}>
      {sections.map(([id, path, key]) => (
        <a
          key={id}
          href={path}
          aria-current={current === id ? "page" : undefined}
          onClick={(e) => {
            e.preventDefault();
            navigate(path);
          }}
        >
          {t(key)}
        </a>
      ))}
    </nav>
  );
}
