"use client";

/**
 * Phase Final-PageGate-Closure — every page under `/admin/*` is gated
 * at the layout level by the canonical `platform.admin` route gate.
 *
 * Why layout, not per-page:
 *   - One mount-point covers the root admin page AND all 11 admin
 *     sub-pages (`/admin/dashboard`, `/admin/audit`, `/admin/identity/*`,
 *     `/admin/demo-requests`, ...). No risk of a sub-page being added
 *     in the future without the gate.
 *   - Hook order on each page is unchanged — the gate decision happens
 *     above the page render boundary.
 *   - Identical to the way `/security-center/sso/*` sub-routes inherit
 *     the parent security-center gate via their host pages.
 *
 * What `platform.admin` does (see `routeRegistry.ts:986`):
 *   - `requiredCapabilities: ["PLATFORM_ADMIN"]`
 *   - `requiredActiveSpace: "PLATFORM_ADMIN"`
 *   - `fallbackBehavior: "HIDDEN_IF_NO_CAPABILITY"` — non-admin
 *     callers see a structured "PLATFORM_ADMIN_ONLY" panel (or are
 *     redirected back to /home depending on resolver behaviour),
 *     NOT a 401/403 toast storm against the chrome.
 *
 * Backend RBAC on every `/v1/admin/*` route remains the authoritative
 * security boundary. This gate is the UX layer.
 */

import type { ReactNode } from "react";

import { PageRouteGate } from "../../../components/navigation/PageRouteGate";

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <PageRouteGate routeId="platform.admin">
      <div className="admin-premium-shell">{children}</div>
    </PageRouteGate>
  );
}
