"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import {
  ADMIN_NAV_ITEMS,
  TENANT_SCOPED_ADMIN_PATHS,
  type AdminNavItem,
} from "./admin-nav-config";

/**
 * THE Platform Admin console navigation.
 *
 * ADM-025 — rendered by EVERY genuine platform-admin page. Nineteen of the
 * thirty-nine admin pages used to omit it, so arriving on one from the command
 * palette left no route back into the console except the browser Back button.
 *
 * Grouped rather than flat: nineteen undifferentiated pills is a list to read,
 * not a structure to navigate, and the three groups encode a real distinction
 * (the control plane, the commercial surfaces, the analysis surfaces).
 *
 * Colours come from the canonical design tokens so the console matches the rest
 * of the product on the light enterprise surface.
 */

const GROUP_LABEL: Record<AdminNavItem["group"], string> = {
  CONTROL_PLANE: "Control plane",
  COMMERCIAL: "Commercial",
  PLATFORM: "Platform",
};

const GROUP_ORDER: AdminNavItem["group"][] = [
  "CONTROL_PLANE",
  "COMMERCIAL",
  "PLATFORM",
];

export default function AdminConsoleNav() {
  const pathname = usePathname();

  // `/admin` must match exactly so it does not light up on every nested route.
  // Every other entry treats a sub-path as active, so `/admin/workspaces/<id>`
  // still highlights "Workspaces".
  const isActive = (href: string) => {
    if (href === "/admin") return pathname === "/admin";
    return pathname === href || pathname?.startsWith(`${href}/`);
  };

  return (
    <nav aria-label="Platform admin sections" className="mb-6 flex flex-col gap-3">
      {GROUP_ORDER.map((group) => {
        const items = ADMIN_NAV_ITEMS.filter((i) => i.group === group);
        if (items.length === 0) return null;
        return (
          <div key={group} className="flex flex-wrap items-center gap-2.5">
            <span className="mr-1 text-[11px] font-bold uppercase tracking-[0.12em] text-[color:var(--ink-muted)]">
              {GROUP_LABEL[group]}
            </span>
            {items.map((item) => {
              const active = isActive(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  title={item.purpose}
                  aria-current={active ? "page" : undefined}
                  className={`rounded-full border px-4 py-2 text-sm transition-all duration-200 ${
                    active
                      ? "border-[color:var(--accent-500)] bg-[color:var(--accent-050)] font-bold text-[color:var(--accent-600)] shadow-[0_1px_2px_rgba(15,23,42,0.06)]"
                      : "border-[color:var(--border-default)] bg-[color:var(--surface-card)] font-semibold text-[color:var(--ink-secondary)] hover:border-[color:var(--accent-500)] hover:bg-[color:var(--accent-050)] hover:text-[color:var(--accent-600)]"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}

/**
 * ADM-013 / ADM-034 — the honest label on a surface that is NOT platform-wide.
 *
 * Several pages under `/admin/*` resolve a `teamId` from the operator's own
 * active workspace and call a tenant API. They sit behind the PLATFORM_ADMIN
 * gate and are titled "Platform" / "Identity operations", so an operator
 * reasonably reads them as cross-tenant. They are not, and a page that shows one
 * workspace's sessions while implying it shows every workspace's is a worse
 * failure than a missing page.
 *
 * Rendering this banner is the honest interim state while the re-homing lands:
 * it says plainly whose data is on screen. Do NOT delete it to tidy a page up —
 * delete it when the page moves out of `/admin/*`.
 */
export function AdminTenantScopeNotice({
  workspaceLabel,
}: {
  workspaceLabel?: string | null;
}) {
  return (
    <div
      role="note"
      className="mb-5 rounded-lg border border-[color:var(--warning-border,#e0b070)] bg-[color:var(--warning-surface,#fdf6ec)] px-4 py-3 text-sm text-[color:var(--ink-secondary)]"
    >
      <strong className="font-semibold text-[color:var(--ink-primary)]">
        Workspace-scoped surface.
      </strong>{" "}
      This page administers{" "}
      {workspaceLabel ? (
        <strong>{workspaceLabel}</strong>
      ) : (
        "your own active workspace"
      )}{" "}
      — not the platform. Cross-tenant views live under Customers, Workspaces and
      Operations.
    </div>
  );
}

/** Is this path one of the known workspace-scoped surfaces under `/admin/*`? */
export function isTenantScopedAdminPath(pathname: string | null): boolean {
  if (!pathname) return false;
  return TENANT_SCOPED_ADMIN_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}
