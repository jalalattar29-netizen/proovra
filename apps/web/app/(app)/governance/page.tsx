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
import { PageShell } from "../../../components/ui";
import { GovernanceControlPlane } from "../../../components/governance-experience/GovernanceControlPlane";
import { HubQuickActionsBar } from "../../../components/hubs/HubQuickActionsBar";

export default function GovernancePage() {
  // R6 — Governance Center hub bar (bounded title + subtitle +
  // ≤4 quick actions + mode-aware help) above the existing
  // GovernanceControlPlane. No content duplication; the bar is the
  // canonical hub HEADER.
  //
  // Phase 7C — migrate PAGE-LEVEL chrome to the shared design system.
  // The bespoke inline `<div style={...}>` frame is replaced by the
  // canonical `PageShell`, which owns the shared page rhythm (max-width
  // clamp to `--page-max-w` + consistent `--page-pad-x/-y` and
  // `--section-gap`) so this surface lines up with its migrated siblings.
  //
  // NO PageHeader is rendered here on purpose: the page already carries
  // TWO canonical headers — the R6 `HubQuickActionsBar` (the canonical
  // hub HEADER, `data-hub-title` <h1>) and the `GovernanceControlPlane`
  // hero (`cc-page-header` <h1>). Injecting a PageHeader `title` would
  // create a THIRD, duplicate <h1>. Per the migration contract we wrap
  // WITHOUT a duplicate title and let the control-plane body follow.
  //
  // The GovernanceControlPlane is untouched: it still renders through
  // the mature, density-aware `cc-page` enterprise design system baked
  // into the frozen app-shell-v2 stylesheet (page hero, tokenised tiles,
  // `app-tabs`) and carries its ~30 load-bearing `data-governance-*`
  // contract attributes + 6-tab state. The `data-hub-page*` contract
  // attributes are preserved on the PageShell frame.
  return (
    <PageRouteGate routeId="governance.hub">
      <PageShell data-hub-page data-hub-page-id="governance">
        <HubQuickActionsBar hubId="governance" />
        <GovernanceControlPlane />
      </PageShell>
    </PageRouteGate>
  );
}
