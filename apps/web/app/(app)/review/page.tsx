/**
 * Review hub — the Inbox (team remediation stage D, T-065).
 *
 * `/review` is the one review Inbox: views (`?view=`) over the reviewer-ops
 * queue slices replace the "My reviews" console and the separate Queues page
 * (`/review/queues` redirects here, keeping its queue as the view). The
 * Review page `/reviewer-ops/[reviewId]` is the only decision door; its focus
 * mode replaced the Reviewer Workspace.
 *
 * Gate: `review.queue` — PERSONAL_OR_ORG + `reviewerOperationsIncluded`, so a
 * Team-entitled Personal Workspace opens it (TEAM-SPEC R1).
 */

"use client";

import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { ReviewInbox } from "../../../components/reviewer-experience/ReviewInbox";
// PHASE 7 §10.5 — owning-context banner.
import { WorkspaceContextBanner } from "../../../lib/platform-context/WorkspaceContextBanner";

export default function ReviewPage() {
  return (
    <PageRouteGate routeId="review.queue">
      <WorkspaceContextBanner action="Reviewing evidence in" />
      <ReviewInbox />
    </PageRouteGate>
  );
}
