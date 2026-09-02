"use client";

/**
 * THE `/admin/*` shell.
 *
 * FOUR THINGS ARE MOUNTED HERE, FOR THE SAME REASON.
 *
 * 1. THE GATE (Phase Final-PageGate-Closure).
 *    Every page under `/admin/*` is gated by the canonical `platform.admin`
 *    route gate at the layout level, so the root admin page and every sub-page
 *    inherit it and no future page can be added without one.
 *
 *      `platform.admin` (routeRegistry) → requiredCapabilities ["PLATFORM_ADMIN"],
 *      requiredActiveSpace "PLATFORM_ADMIN", fallbackBehavior
 *      HIDDEN_IF_NO_CAPABILITY — a non-admin caller sees nothing rather than a
 *      403 toast storm against the chrome.
 *
 *    Backend RBAC on every `/v1/admin/*` route remains the authoritative
 *    security boundary. This gate is the UX layer.
 *
 * 2. THE NAVIGATION (ADM-025, rebuilt ADM-013 PHASE 11).
 *    Moved here from the individual pages for exactly the argument above.
 *    Nineteen of the thirty-nine admin pages rendered no console nav, so
 *    arriving on one from the command palette left no route back except the
 *    browser Back button — and every one of those omissions looked like an
 *    oversight rather than a decision, because nothing structural prevented it.
 *    Rendering it once, above the page boundary, makes the omission
 *    unrepresentable.
 *
 * 3. THE BREADCRUMB (ADM-013 PHASE 11).
 *    Here for the same reason, and it is the RETURN PATH. An operator who
 *    reached `/admin/customers/<id>` from the command palette or from search
 *    previously had the browser Back button and nothing else — the page named
 *    no list to go back to. The breadcrumb resolves through the same registry
 *    the navigation does, so a detail page cannot be reachable and orphaned at
 *    the same time.
 *
 * 4. THE SCOPE NOTICE (ADM-013).
 *    Several surfaces under `/admin/*` are workspace-scoped: they resolve a
 *    workspace from the operator's own active workspace and call a tenant API,
 *    while sitting behind the PLATFORM_ADMIN gate and being titled "Platform"
 *    or "Identity operations". An operator reasonably reads them as
 *    cross-tenant. They are not. Which ones is now a `scope` FIELD on each
 *    registry entry rather than a second list of path strings, so the notice
 *    and the navigation cannot disagree about which surfaces are which.
 */

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

import "../../../components/admin/admin-console.css";

import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import AdminConsoleNav, {
  AdminBreadcrumb,
  AdminTenantScopeNotice,
  AdminPlatformAuditScopeNotice,
} from "../../../components/admin/AdminConsoleNav";
import {
  isWorkspaceScopedAdminPath,
  isPlatformAuditScopedAdminPath,
} from "../../../components/admin/adminNavigation";

export default function AdminLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const workspaceScoped = isWorkspaceScopedAdminPath(pathname);
  // Mutually exclusive by construction — a surface has ONE scope — but read
  // separately so a future third state cannot silently fall through to the
  // workspace wording.
  const platformAuditScoped = isPlatformAuditScopedAdminPath(pathname);

  return (
    <PageRouteGate routeId="platform.admin">
      <div className="admin-premium-shell">
        <AdminConsoleNav />
        <AdminBreadcrumb />
        {workspaceScoped ? <AdminTenantScopeNotice /> : null}
        {platformAuditScoped ? <AdminPlatformAuditScopeNotice /> : null}
        {children}
      </div>
    </PageRouteGate>
  );
}
