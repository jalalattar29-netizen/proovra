/**
 * Phase 32.8E — Reviewer Orchestration + Escalation Command.
 *
 * Delegates to the new `ReviewerCommandConsole` component, sourced
 * from `/v1/reviewer-ops/command` (read-only aggregator, no audit
 * emission).
 *
 * The per-workflow inspector + mutation surfaces remain at
 * /reviewer-ops/[reviewId]; the SLA workspace, escalations console,
 * and SLA-policy editor remain at their canonical paths.
 *
 * Phase 38.8 — wrapped in canonical PageRouteGate. ReviewerOps is
 * organization-only; the gate renders the structured "Create or switch
 * organization" panel for personal-space users.
 */

import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { ReviewerCommandConsole } from "../../../components/reviewer-experience/ReviewerCommandConsole";

export default function ReviewerOpsPage() {
  return (
    <PageRouteGate routeId="review.queue">
      <ReviewerCommandConsole />
    </PageRouteGate>
  );
}
