/**
 * Phase EVIDENCE-IA-DISCUSSION — Discussion tab.
 *
 * Orchestrates the live `EvidenceDiscussionPanel`. Backend capability gating
 * (`discussionEnabled` / `discussionReadOnly`) lives in the page
 * orchestrator's tab-visibility filter; the read-only flag is passed through
 * so the panel replaces its composer rather than merely disabling it.
 *
 * Phase EVIDENCE-DETAIL-REDESIGN — presentation only. The intro moves to the
 * page ground in the accepted Evidence Detail hierarchy, and the boundary the
 * panel already communicated ("workspace-scoped and audit-visible; use this
 * instead of external chat") is stated once, here, where a reader meets the
 * tab — rather than as a muted line inside the panel header.
 *
 * TRUTHFULNESS. The boundary says what the backend actually does: a thread is
 * workspace-scoped and audit-visible. It does NOT claim that posting changes
 * integrity, custody or public verification, because it does not — discussion
 * is a separate collaboration surface and the note says so explicitly.
 */

"use client";

import { MessageSquare } from "lucide-react";
import { type EvidenceDetailCtx } from "./_lib";
import EvidenceDiscussionPanel from "../components/EvidenceDiscussionPanel";

export function EvidenceDiscussionTab({ ctx }: { ctx: EvidenceDetailCtx }) {
  const { workspace, evidenceId, workspaceCaps, initialThreadId } = ctx;

  return (
    <section
      className="evidence-detail-discussion"
      data-evidence-discussion-section
    >
      <div className="evidence-discussion-intro">
        <span className="evidence-discussion-intro__icon" aria-hidden="true">
          <MessageSquare size={20} strokeWidth={2} />
        </span>
        <div className="evidence-discussion-intro__copy">
          <h2 className="evidence-discussion-intro__title">Discussion</h2>
          <p className="evidence-discussion-intro__description">
            Operational coordination attached to this evidence. Threads are
            workspace-scoped and audit-visible — use this surface instead of
            external chat tools to preserve traceability.
          </p>
        </div>
      </div>

      <div className="evidence-detail-boundary-note">
        <span className="evidence-detail-boundary-note__title">Boundary</span>
        <p className="evidence-detail-boundary-note__body">
          Workspace discussion is a collaboration record, not part of the
          forensic custody chain, the recorded integrity state, public
          verification, or the verification package. Posting a message does not
          change what was preserved about this evidence.
        </p>
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
