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
 */

import { GovernanceControlPlane } from "../../../components/governance-experience/GovernanceControlPlane";

export default function GovernancePage() {
  return <GovernanceControlPlane />;
}
