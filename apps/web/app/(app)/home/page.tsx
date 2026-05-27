/**
 * Phase 32.8C — /home renders the Enterprise Evidence Operations
 * Command Center.
 *
 * Phase A.1C extends this surface with an ACCOUNT-LEVEL operational
 * priorities banner rendered ABOVE the workspace-scoped command
 * center. The banner consumes `/v1/me/operational-priorities` — a
 * caller-scoped, identity-level signal source that the workspace-
 * anchored CommandCenter cannot see:
 *
 *   - pending org invites the caller is being asked to accept
 *   - org-admin governance hotspots (pending invites the caller can
 *     resend / revoke as an admin)
 *   - first-time onboarding signals (no organization, no email)
 *
 * The two surfaces compose:
 *
 *   <PageRouteGate>
 *     <AccountPrioritiesBanner />   ← above-workspace identity surface
 *     <CommandCenter />              ← workspace operational surface
 *   </PageRouteGate>
 *
 * The CommandCenter remains the operational hub for workspace state.
 * The banner is the missing layer that answers "what do I need to
 * pay attention to RIGHT NOW that has nothing to do with my current
 * workspace?"
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
 * Phase A.1C additional rules:
 *   - The banner is permission-scoped server-side. Frontend does no
 *     RBAC; it renders what the API returned.
 *   - The banner degrades to a small "unavailable" line, never a
 *     blank gap.
 *   - The banner is hidden (renders a minimal empty marker) when the
 *     caller has zero priority items AND is fully onboarded — /home
 *     should remain the workspace surface, not pile decoration above
 *     it.
 *
 * Phase 38.8 — wrapped in canonical PageRouteGate.
 */

import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { CommandCenter } from "../../../components/command-center/CommandCenter";
import { AccountPrioritiesBanner } from "../../../components/command-center/AccountPrioritiesBanner";

export default function HomePage() {
  return (
    <PageRouteGate routeId="workspace.home">
      <div data-home-page data-phase-a-1c-home>
        <AccountPrioritiesBanner />
        <CommandCenter />
      </div>
    </PageRouteGate>
  );
}
