/**
 * Phase 32.8C — /home renders the Enterprise Evidence Operations
 * Command Center.
 *
 * Phase IA-self-serve-simplification — the enterprise CommandCenter
 * is now gated on plan/role. Self-serve users (FREE / PAYG / PRO /
 * TEAM) see the simplified `SelfServeHomeDashboard`. Enterprise
 * workspaces, `plan === "ENTERPRISE"` accounts, and platform admins
 * continue to see the existing operational dashboard with the
 * AccountPrioritiesBanner above it.
 *
 * The split happens at /home (not in CommandCenter) so the existing
 * enterprise dashboard surface is preserved verbatim for eligible
 * users while self-serve users get a product that matches the public
 * pricing brief.
 *
 * Hard rules carried from Phase 32.8C (still in force):
 *   - The CommandCenter is data-driven (every section is backed by
 *     real backend state).
 *   - It is workspace-aware (personal vs team behavior).
 *   - It is role-aware (mutation CTAs filtered by role).
 *   - It degrades gracefully (per-section status; one degraded
 *     subsystem does not poison the whole dashboard).
 *   - It never invents metrics, fake charts, or marketing copy.
 *
 * Phase 38.8 — wrapped in canonical PageRouteGate.
 */
"use client";

import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { CommandCenter } from "../../../components/command-center/CommandCenter";
import { AccountPrioritiesBanner } from "../../../components/command-center/AccountPrioritiesBanner";
import { SelfServeHomeDashboard } from "../../../components/home-experience/SelfServeHomeDashboard";
import { useSurfaceUserContext } from "../../../lib/surface/useSurfaceUserContext";

function isSelfServePlan(plan: ReturnType<typeof useSurfaceUserContext>["plan"]): boolean {
  // The four self-serve plans per the public pricing page.
  return plan === "FREE" || plan === "PAYG" || plan === "PRO" || plan === "TEAM";
}

export default function HomePage() {
  const surfaceUserCtx = useSurfaceUserContext();

  // Enterprise workspace flag OR platform admin OR a future
  // `plan === "ENTERPRISE"` keeps the existing operational dashboard.
  // All four self-serve plans see the simplified self-serve home.
  const isEnterprise =
    surfaceUserCtx.isPlatformAdmin ||
    surfaceUserCtx.isEnterpriseWorkspace ||
    (surfaceUserCtx.plan as string | null) === "ENTERPRISE";
  const showSelfServe = !isEnterprise && isSelfServePlan(surfaceUserCtx.plan);

  return (
    <PageRouteGate routeId="workspace.home">
      {showSelfServe ? (
        <div data-home-page data-self-serve-home>
          <SelfServeHomeDashboard />
        </div>
      ) : (
        <div data-home-page data-phase-a-1c-home>
          <AccountPrioritiesBanner />
          <CommandCenter />
        </div>
      )}
    </PageRouteGate>
  );
}
