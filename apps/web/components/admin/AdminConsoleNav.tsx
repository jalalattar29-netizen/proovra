"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

import { useAdminEntityCrumbValue } from "./AdminEntityCrumb";
import { returnHrefFor } from "../../lib/navigation/adminReturnState";

import {
  ADMIN_NAV_SECTIONS,
  resolveAdminLocation,
  type AdminNavSection,
} from "./adminNavigation";

/**
 * THE Admin control-plane navigation.
 *
 * ===========================================================================
 * WHAT REPLACED WHAT
 * ===========================================================================
 * Twenty pills in three undifferentiated rows, plus a "More advanced (24)"
 * disclosure holding the rest. Twenty is a list to read, not a structure to
 * navigate: an operator looking for queue depth had to already know it lives
 * under a page called "Operations" and not the one called "System health".
 *
 * Nine primary sections, and the open section's children as a second row. The
 * page shows nine choices and then the handful that matter, instead of
 * thirty-seven at once.
 *
 * ===========================================================================
 * THE FOUR THINGS THIS FIXES BEYOND THE COUNT
 * ===========================================================================
 * 1. STALE ACTIVE STATE. Active resolution is LONGEST-HREF-WINS, from the same
 *    resolver the breadcrumb uses. Before, `/admin/evidence-ops/records` lit up
 *    `/admin/evidence-ops`, so opening a child looked like going nowhere.
 *
 * 2. DEEP LINKS WITH NO PARENT. Arriving on `/admin/customers/<id>` from search
 *    used to light up nothing. Contextual detail routes resolve to their
 *    section, so a deep link keeps its place in the structure.
 *
 * 3. SCOPE, ON THE CONTROL. Several surfaces here administer ONE workspace
 *    while sitting behind the platform gate and being titled "Platform". The
 *    scope is a required field on every registry entry, and a workspace-scoped
 *    child says so on its own chip — before the operator clicks it, rather than
 *    in a banner after.
 *
 * 4. NO SEPARATE MOBILE TRUTH. The same two rows scroll horizontally inside
 *    their own containers below the cutover. There is no second component with
 *    its own copy of the list to fall out of step.
 */
export default function AdminConsoleNav() {
  const pathname = usePathname();
  const location = resolveAdminLocation(pathname);
  const activeSection = location?.section ?? null;

  return (
    <nav className="adminnav" aria-label="Platform admin">
      {/* ------------------------------------------------------------------ */}
      {/* PRIMARY — nine sections, always all nine.                           */}
      {/* ------------------------------------------------------------------ */}
      <ul className="adminnav__primary">
        {ADMIN_NAV_SECTIONS.map((section) => {
          const active = activeSection?.id === section.id;
          return (
            <li key={section.id}>
              <Link
                href={section.href}
                title={section.purpose}
                aria-current={active ? "page" : undefined}
                data-adminnav-section={section.id}
                data-active={active ? "true" : "false"}
                className="adminnav__primary-link"
              >
                {section.label}
              </Link>
            </li>
          );
        })}
      </ul>

      {/* ------------------------------------------------------------------ */}
      {/* SECONDARY — only the open section's children, and only when there   */}
      {/* is more than one. A single-child section renders no second row: one */}
      {/* choice presented as a choice is furniture.                          */}
      {/* ------------------------------------------------------------------ */}
      {activeSection && activeSection.children.length > 1 ? (
        <AdminSecondaryNav section={activeSection} pathname={pathname} />
      ) : null}
    </nav>
  );
}

function AdminSecondaryNav({
  section,
  pathname,
}: {
  section: AdminNavSection;
  pathname: string | null;
}) {
  const location = resolveAdminLocation(pathname);
  return (
    <ul
      className="adminnav__secondary"
      aria-label={`${section.label} surfaces`}
      data-adminnav-secondary={section.id}
    >
      {section.children.map((child) => {
        const active = location?.child?.href === child.href;
        return (
          <li key={child.href}>
            <Link
              href={child.href}
              title={child.purpose}
              aria-current={active ? "page" : undefined}
              data-active={active ? "true" : "false"}
              data-scope={child.scope}
              className="adminnav__secondary-link"
            >
              {child.label}
              {child.scope === "WORKSPACE" ? (
                <span className="adminnav__scope" aria-label="Workspace-scoped">
                  Workspace
                </span>
              ) : null}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The breadcrumb for `/admin/*`.
 *
 * Rendered by the layout so no page can omit it — nineteen of the thirty-nine
 * admin pages omitted the console nav for exactly as long as rendering it was
 * each page's job.
 *
 * It shows the SECTION and the SURFACE, and for a contextual detail it shows
 * the list the detail came from. That last crumb is the return path: before it
 * existed, an operator who reached a customer from search had the browser Back
 * button and nothing else.
 */
export function AdminBreadcrumb() {
  const pathname = usePathname();
  const entityLabel = useAdminEntityCrumbValue();
  const searchParams = useSearchParams();
  const location = resolveAdminLocation(pathname);
  if (!location) return null;

  const { section, child, contextual, isDetail } = location;

  const crumbs: Array<{ label: string; href?: string }> = [
    { label: "Platform admin", href: "/admin" },
  ];
  if (section.id !== "overview") {
    crumbs.push({ label: section.label, href: section.href });
  }

  if (isDetail && contextual) {
    // The RETURN PATH. `parentHref` is a link and the record is not, so the
    // last thing an operator can click is the list they came from.
    /*
     * PHASE 6 §7 — the RETURN PATH, back to the list AS IT WAS.
     *
     * This was the bare collection href, so an operator who filtered a list
     * to three rows, opened one and clicked back landed on the unfiltered
     * first page of everything and re-typed the filter. The list state
     * travelled here on the detail URL; `returnHrefFor` puts it back, and
     * falls back to the bare collection when nothing travelled.
     */
    crumbs.push({
      label: contextual.parentLabel,
      href: returnHrefFor(contextual.parentHref, searchParams?.toString() ?? null),
    });
    /*
     * PHASE 6 6 - the record, by name where the page could tell us.
     *
     * This was `contextual.label`, a static type name, so every customer
     * page ended "... > Customer directory > Customer" - three crumbs
     * identical on every customer, and the fourth, which is the one that
     * would say WHICH customer, saying nothing.
     *
     * The fallback is deliberate rather than incidental: a page still
     * loading, a failed fetch and a deleted record all publish nothing, and
     * the type name is the honest answer for a record we cannot name. An
     * empty crumb would be a broken chain; a guessed one would be a lie.
     */
    crumbs.push({ label: entityLabel ?? contextual.label });
  } else if (child && child.href !== section.href) {
    crumbs.push({ label: child.label });
  }
  // A section's own landing surface adds nothing: naming it again after the
  // section reads as two levels where there is one.

  return (
    <nav className="adminnav__crumbs" aria-label="Breadcrumb">
      <ol>
        {crumbs.map((crumb, i) => {
          const isLast = i === crumbs.length - 1;
          return (
            <li key={`${crumb.label}-${i}`}>
              {crumb.href && !isLast ? (
                <Link href={crumb.href}>{crumb.label}</Link>
              ) : (
                <span aria-current={isLast ? "page" : undefined}>
                  {crumb.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * ADM-013 / ADM-034 — the honest label on a surface that is NOT platform-wide.
 *
 * Several pages under `/admin/*` resolve a workspace from the operator's own
 * active workspace and call a tenant API. They sit behind the PLATFORM_ADMIN
 * gate and are titled "Platform" / "Identity operations", so an operator
 * reasonably reads them as cross-tenant. They are not, and a page that shows
 * one workspace's sessions while implying it shows every workspace's is a worse
 * failure than a missing page.
 *
 * Do NOT delete this to tidy a page up — delete it when the page moves out of
 * `/admin/*`, or when it genuinely becomes cross-tenant and its registry entry
 * changes to `scope: "PLATFORM"`.
 */
export function AdminTenantScopeNotice({
  workspaceLabel,
}: {
  workspaceLabel?: string | null;
}) {
  return (
    <div role="note" className="adminnav__scope-notice" data-scope="WORKSPACE">
      <strong>Workspace-scoped surface.</strong> This page administers{" "}
      {workspaceLabel ? <strong>{workspaceLabel}</strong> : "your own active workspace"}{" "}
      — not the platform. Cross-tenant views live under Customers, Workspaces
      and Platform operations.
    </div>
  );
}

/**
 * The OTHER thing `?teamId=` can mean.
 *
 * A surface showing platform-wide data that records the operator's actions
 * against their active workspace. It used to share the workspace notice, which
 * told an operator triaging a failed job that the failure belonged to their own
 * tenant — and the queue route's own header says failed jobs "may originate
 * from a different workspace than the one the operator is currently active in".
 *
 * This says the true thing instead: everything, and here is where your actions
 * are recorded.
 */
export function AdminPlatformAuditScopeNotice({
  workspaceLabel,
}: {
  workspaceLabel?: string | null;
}) {
  return (
    <div
      role="note"
      className="adminnav__scope-notice"
      data-scope="PLATFORM_AUDIT"
    >
      <strong>Platform-wide surface.</strong> This page reads across every
      tenant. Actions you take here are recorded against{" "}
      {workspaceLabel ? <strong>{workspaceLabel}</strong> : "your active workspace"}{" "}
      as the audit scope — that workspace is not a filter on what you see.
    </div>
  );
}

/**
 * Is this path one of the workspace-scoped surfaces under `/admin/*`?
 *
 * Re-exported from the registry rather than reimplemented. This used to be a
 * second array of path strings matched independently of the nav list, and two
 * lists of paths drift: a page could be promoted in one and left in the other.
 */
export { isWorkspaceScopedAdminPath as isTenantScopedAdminPath } from "./adminNavigation";
