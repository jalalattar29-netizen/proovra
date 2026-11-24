"use client";

/**
 * Evidence requests — the requests awaiting review (team remediation T-066,
 * stage D).
 *
 * The evidence-request review queue (`GET /v1/review/queue`, an EvidenceRequest
 * list, not review workflows) used to sit above the workflow table in the
 * review Inbox, ignoring the Inbox's view. It lives here, with the requests it
 * lists; each row opens the request's own page (`/evidence-requests/[id]`).
 * The panel keeps its stage F fixes (T-133): the "awaiting review" statuses
 * by default, the generation guard and the assignee display name.
 *
 * Gate: `workspace.evidence_requests` — reading requests is `evidence.read`,
 * the same permission the queue route asks.
 */

import { useRef } from "react";

import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { PageShell } from "../../../components/ui/PageShell";
import { PageHeader } from "../../../components/ui/PageShell";
import { useActiveSpaceId } from "../../../lib/platform-context";
import { EvidenceRequestReviewQueue } from "./_components/EvidenceRequestReviewQueue";

export default function EvidenceRequestsPage() {
  return (
    <PageRouteGate routeId="workspace.evidence_requests">
      <EvidenceRequestsInner />
    </PageRouteGate>
  );
}

function EvidenceRequestsInner() {
  const teamId = useActiveSpaceId();
  const activeTeamRef = useRef<string | null>(teamId);
  activeTeamRef.current = teamId;
  return (
    <PageShell
      data-evidence-requests-page
      header={
        <PageHeader
          title="Evidence requests"
          subtitle="Responses to your evidence requests that are waiting for review."
        />
      }
    >
      <EvidenceRequestReviewQueue teamId={teamId} activeTeamRef={activeTeamRef} />
    </PageShell>
  );
}
