"use client";

/**
 * THE `/admin/*` shell.
 *
 * TWO THINGS ARE MOUNTED HERE, FOR THE SAME REASON.
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
 * 2. THE NAVIGATION (ADM-025, 2026-08-27).
 *    Moved here from the individual pages for exactly the argument above.
 *    Nineteen of the thirty-nine admin pages rendered no console nav, so
 *    arriving on one from the command palette left no route back except the
 *    browser Back button — and every one of those omissions looked like an
 *    oversight rather than a decision, because nothing structural prevented it.
 *    Rendering it once, above the page boundary, makes the omission
 *    unrepresentable.
 *
 * 3. THE SCOPE NOTICE (ADM-013).
 *    Several surfaces under `/admin/*` are workspace-scoped: they resolve a
 *    `teamId` from the operator's own active workspace and call a tenant API,
 *    while sitting behind the PLATFORM_ADMIN gate and being titled "Platform" or
 *    "Identity operations". An operator reasonably reads them as cross-tenant.
 *    They are not. Until they are re-homed out of `/admin/*`, this layout says
 *    so plainly on exactly those paths.
 */

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import AdminConsoleNav, {
  AdminTenantScopeNotice,
  isTenantScopedAdminPath,
} from "../../../components/admin/AdminConsoleNav";

export default function AdminLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const tenantScoped = isTenantScopedAdminPath(pathname);

  return (
    <PageRouteGate routeId="platform.admin">
      <div className="admin-premium-shell">
        <AdminConsoleNav />
        {tenantScoped ? <AdminTenantScopeNotice /> : null}
        {children}
      </div>
    </PageRouteGate>
  );
}
