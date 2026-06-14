/**
 * Phase EVIDENCE-IA-CUSTODY — Custody tab.
 *
 * Phase 1 — Custody is now the SINGLE home for forensic + access
 * event lists. The Integrity tab no longer renders forensic event
 * counts (moved to the Technical Appendix in detail; Custody is the
 * canonical timeline).
 *
 * Phase 2 — default view is grouped-by-day to avoid dumping hundreds
 * of identical "REPORT_DOWNLOADED" rows. The raw event list is still
 * available behind "Show raw events" inside each grouped section.
 */

"use client";

import { Globe, History } from "lucide-react";
import { GroupedEventTimeline, type EvidenceDetailCtx } from "./_lib";
import { OperationalTimelinePanel } from "../../../../../components/operational";

export function EvidenceCustodyTab({ ctx }: { ctx: EvidenceDetailCtx }) {
  const { workspace, evidenceId, canSeeReviewerOps } = ctx;

  return (
    <>
      <GroupedEventTimeline
        title="Forensic custody"
        subtitle="Integrity-relevant lifecycle chronology — grouped by day"
        events={workspace.custodyLifecycle.forensicEvents}
        icon={History}
      />

      <GroupedEventTimeline
        title="Access activity"
        subtitle="Viewing, download, and verification access — grouped by day"
        events={workspace.custodyLifecycle.accessEvents}
        icon={Globe}
      />

      {canSeeReviewerOps && workspace.reviewWorkflow?.teamId ? (
        <OperationalTimelinePanel
          evidenceId={evidenceId}
          teamId={workspace.reviewWorkflow.teamId}
        />
      ) : null}
    </>
  );
}
