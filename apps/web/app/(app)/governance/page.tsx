/**
 * Phase 32.8E — Governance Control Plane.
 *
 * Delegates to the new `GovernanceControlPlane` component, sourced
 * from `/v1/governance/control-plane` (read-only aggregator, no
 * audit emission).
 *
 * The bounded per-domain governance pages (/governance/policy,
 * /governance/retention, /governance/destruction, /governance/lifecycle,
 * /governance/notifications, /governance/analytics) remain unchanged
 * and continue to host the audited mutation flows.
 *
 * Phase 38.8 — wrapped in canonical PageRouteGate. Governance is
 * organization-only; the gate renders the structured "Create or switch
 * organization" panel for personal-space users.
 */

import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { GovernanceControlPlane } from "../../../components/governance-experience/GovernanceControlPlane";
import { HubQuickActionsBar } from "../../../components/hubs/HubQuickActionsBar";

export default function GovernancePage() {
  // R6 — Governance Center hub bar (bounded title + subtitle +
  // ≤4 quick actions + mode-aware help) above the existing
  // GovernanceControlPlane. No content duplication; the bar is the
  // canonical hub HEADER.
  return (
    <PageRouteGate routeId="governance.hub">
      <div data-hub-page data-hub-page-id="governance">
        <HubQuickActionsBar hubId="governance" />
        <GovernanceControlPlane />
      </div>
    </PageRouteGate>
  );
}
