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
 */

import { ReviewerCommandConsole } from "../../../components/reviewer-experience/ReviewerCommandConsole";

export default function ReviewerOpsPage() {
  return <ReviewerCommandConsole />;
}
