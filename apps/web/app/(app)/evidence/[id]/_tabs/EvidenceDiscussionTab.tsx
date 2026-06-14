/**
 * Phase EVIDENCE-IA-DISCUSSION — Discussion tab.
 *
 * Thin wrapper over the existing `EvidenceDiscussionPanel` so the
 * page orchestrator's tab switch is uniform across all 7 tabs.
 * Backend capability gating (`discussionEnabled` / `discussionReadOnly`)
 * lives in the orchestrator's tab-visibility filter.
 */

"use client";

import { MessageSquare } from "lucide-react";
import { SectionHeading, type EvidenceDetailCtx } from "./_lib";
import EvidenceDiscussionPanel from "../components/EvidenceDiscussionPanel";

export function EvidenceDiscussionTab({ ctx }: { ctx: EvidenceDetailCtx }) {
  const { workspace, evidenceId, workspaceCaps, initialThreadId } = ctx;
  return (
    <section
      className="evidence-detail-section"
      data-evidence-discussion-section
    >
      <div className="evidence-detail-section-header">
        <SectionHeading
          kicker="Discussion"
          title="Operational evidence coordination"
          icon={MessageSquare}
        />
      </div>
      <EvidenceDiscussionPanel
        evidenceId={evidenceId}
        teamId={workspace.reviewWorkflow?.teamId ?? null}
        initialThreadId={initialThreadId}
        readOnly={workspaceCaps?.discussionReadOnly === true}
      />
    </section>
  );
}
