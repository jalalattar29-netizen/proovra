/**
 * Phase 32.8C — /home renders the Enterprise Evidence Operations
 * Command Center for enterprise users.
 *
 * Phase IA-home-fork — the /home surface decision is a single,
 * unit-tested pure function (`resolveHomeSurface`).
 *
 * Track 1A (surface-tier removal, 2026-07-28) — the decision inputs are
 * now SERVER-projected booleans only (platform.isPlatformAdmin +
 * flags.isEnterpriseWorkspace + "has the envelope resolved a plan").
 * The client never branches on a raw plan name:
 *
 *   - "command-center" → ONLY platform admin / enterprise workspace.
 *     CommandCenter is never a fallback.
 *   - "loading"        → envelope unresolved. Render a skeleton, NEVER
 *     CommandCenter.
 *   - "self-serve"     → every resolved non-enterprise user. The
 *     single Home V2.
 *
 * Hard rules carried from Phase 32.8C (still in force for the
 * enterprise CommandCenter branch):
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
import { SelfServeHomeDashboard } from "../../../components/home-experience/SelfServeHomeDashboard";
import { HomeSkeleton } from "../../../components/home-experience/HomeSections";
import { resolveHomeSurface } from "../../../components/home-experience/resolveHomeSurface";
import {
  useActiveSpace,
  usePlatformContext,
} from "../../../lib/platform-context";

/**
 * ATTENTION ARCHITECTURE PHASE 7 (2026-08-22) — the account-priorities
 * banner was REMOVED from this page.
 *
 * It was a SECOND general attention authority on Home, fed by a dedicated
 * account-priorities endpoint, computing "what needs your attention right
 * now" from its own reads of org invites, org-admin governance and
 * onboarding state.
 *
 * Every one of those signals already had a canonical home, which is what
 * made it duplication rather than coverage:
 *
 *   pending org invites  ->  org_invite notifications (ORGANIZATION scope,
 *                            addressed to the person by email; Phase 2.4
 *                            stopped workspace narrowing from hiding them)
 *   org-admin backlog    ->  org_admin notifications
 *   onboarding           ->  GUIDANCE, which Phase 1.6 removed from the
 *                            attention workload entirely
 *
 * The content did not disappear; its second computation did. Home consumes
 * the canonical Operations summary, links to /notifications and
 * /operations, and holds no attention authority of its own.
 */
export default function HomePage() {
  const { envelope } = usePlatformContext();
  const activeSpace = useActiveSpace();

  // "Has the envelope resolved a plan for the ACTIVE context?" — a null-check
  // only (loading heuristic), never a plan-name branch.
  //
  // PHASE 12 — POINT 7: read the server-resolved plan of the active space
  // directly. The previous three-branch chain ended in `?? account.accountPlan`,
  // which is an owner-plan fallback: it reported "resolved" for a workspace
  // that had resolved nothing, on the strength of the account that owns it.
  const resolvedPlan = activeSpace?.plan ?? null;

  const decision = resolveHomeSurface({
    isPlatformAdmin: envelope?.platform?.isPlatformAdmin === true,
    isEnterpriseWorkspace: envelope?.flags?.isEnterpriseWorkspace === true,
    planResolved: resolvedPlan !== null,
  });

  return (
    <PageRouteGate routeId="workspace.home">
      {decision === "command-center" ? (
        // Enterprise ONLY (platform admin / enterprise workspace).
        // Never reached by self-serve or unresolved users.
        <div data-home-page data-phase-a-1c-home>
          <CommandCenter />
        </div>
      ) : decision === "loading" ? (
        // Plan unresolved (loading or no entitlement). Skeleton only —
        // never the enterprise dashboard.
        <div data-home-page data-home-loading>
          <HomeSkeleton />
        </div>
      ) : (
        // Default for every resolved self-serve user (FREE/PAYG/PRO/TEAM).
        <div data-home-page data-self-serve-home>
          <SelfServeHomeDashboard />
        </div>
      )}
    </PageRouteGate>
  );
}
