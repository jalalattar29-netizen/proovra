/**
 * Phase EVIDENCE-IA-REVIEW — Review tab.
 *
 * Human review workspace. Workflow status / case assignment / notes /
 * comments / annotations / reviewer actions / AI advisory.
 *
 * Phase 2 — NOT_STARTED structured empty state with suggested
 * actions (Assign reviewer / Add comment / Attach to case / Review
 * risk signals / Open report).
 *
 * Phase 6 — AI categorization card is hidden when the workspace has
 * no AI configured. The underlying card returns `status: "DISABLED"`
 * after a backend probe; we wrap it in a guard that fetches the same
 * endpoint once and hides the card outright when DISABLED, instead of
 * rendering the "AI categorization is not configured" placeholder
 * that wasted vertical space on every record.
 *
 * Phase 1 — "Workspace and record retention state" was duplicated
 * by the Integrity tab's "Verification & preservation" block (same
 * retention / Object Lock / legal-hold rows). The duplicate is
 * removed from Review; archive/trash controls stay here because
 * they're operational actions, not posture.
 */

"use client";

import { useEffect, useState } from "react";
import { ClipboardCheck } from "lucide-react";
import {
  KeyValueGrid,
  SectionHeading,
  type EvidenceDetailCtx,
} from "./_lib";
import { Button } from "../../../../../components/ui";
import { apiFetch } from "../../../../../lib/api";
import { formatUserDateTime } from "../../../../../lib/date";
import { ReviewerCommentsPanel } from "../../components/ReviewerCommentsPanel";
import { LegalNotesPanel } from "../../components/LegalNotesPanel";
import { AnnotationPanel } from "../../components/AnnotationPanel";
import { ComparisonPanel } from "../../components/ComparisonPanel";
import { DuplicateDetectionPanel } from "../../components/DuplicateDetectionPanel";
import { AiCategorizationPanel } from "../../components/AiCategorizationPanel";
import { EvidenceAiCategorizationCard } from "../../../../../components/hidden-feature-panels/HiddenFeaturePanels";
import { EvidenceRelationshipsSection } from "../components/EvidenceRelationshipsSection";
import { ReviewerWorkflowCard } from "../components/ReviewerWorkflowCard";
import { EvidenceReviewActionsPanel } from "../components/EvidenceReviewActionsPanel";
import { ReviewerAuditTrailSection } from "../components/ReviewerAuditTrailSection";

/**
 * Phase 6 — probe `/ai-categorization` once and hide the entire AI
 * card when the workspace has no AI configured. The underlying
 * `EvidenceAiCategorizationCard` was unconditionally mounted and
 * rendered a heading + "advisory" caveat + "AI categorization is not
 * configured for this workspace." for every record on every workspace
 * that hadn't enabled the feature. That wasted page real estate.
 */
function AiCategorizationCardWhenActive({ evidenceId }: { evidenceId: string }) {
  const [decision, setDecision] = useState<"loading" | "hidden" | "show">("loading");

  useEffect(() => {
    let cancelled = false;
    apiFetch(`/v1/evidence/${encodeURIComponent(evidenceId)}/ai-categorization`)
      .then((res: { categorization?: { status?: string } }) => {
        if (cancelled) return;
        const status = res?.categorization?.status;
        setDecision(status === "DISABLED" || status == null ? "hidden" : "show");
      })
      .catch(() => {
        if (cancelled) return;
        // 403 / 404 / any failure → treat as hidden. The endpoint
        // returns 403 for users without access; the card itself
        // would have shown a denial caveat. Cleaner to hide.
        setDecision("hidden");
      });
    return () => {
      cancelled = true;
    };
  }, [evidenceId]);

  if (decision !== "show") return null;
  return <EvidenceAiCategorizationCard evidenceId={evidenceId} />;
}

function NotStartedEmptyState({ ctx }: { ctx: EvidenceDetailCtx }) {
  const {
    workspace,
    canSeeReviewerOps,
    setAssignCaseOpen,
    setSelectedCaseId,
    setWorkflowOpen,
    routerPush,
  } = ctx;

  // Phase EVIDENCE-REVIEW-VISIBILITY — the suggested-action list +
  // the "Assign reviewer" button only render when the workspace
  // exposes the reviewer-ops surface. On a Personal Space or any
  // self-serve context the user IS the reviewer; there is no
  // assignment to make. We keep the heading + neutral copy so the
  // empty state still tells the user "nothing has happened here
  // yet"; the action set shrinks to the affordances that work
  // (attach to case, open report).
  const showReviewerActions = canSeeReviewerOps;

  return (
    <section
      className="evidence-detail-section"
      data-evidence-review-empty="NOT_STARTED"
      data-evidence-review-empty-reviewer-ops={showReviewerActions ? "true" : "false"}
    >
      <div className="evidence-detail-section-header">
        <SectionHeading
          kicker="Review"
          title="Review has not started yet"
          icon={ClipboardCheck}
        />
      </div>
      <p className="evidence-detail-muted" style={{ marginBottom: 10 }}>
        {showReviewerActions
          ? "The evidence record is preserved and verified. No reviewer has started a structured review yet. Common next steps:"
          : "The evidence record is preserved and verified. You can add a note or attach this record to a case below."}
      </p>
      <ul className="evidence-detail-flat-list" style={{ marginBottom: 12 }}>
        {showReviewerActions ? <li>Assign a reviewer</li> : null}
        <li>Add a comment or legal note</li>
        <li>Attach this record to a case</li>
        <li>Open the risk signals in the sidebar</li>
        <li>Download the report PDF or verification package</li>
      </ul>
      <div className="evidence-detail-inline-actions" data-evidence-review-empty-actions>
        <Button
          variant="secondary"
          onClick={() => {
            setSelectedCaseId(workspace.relationships.caseId || "");
            setAssignCaseOpen(true);
          }}
        >
          Attach to case
        </Button>
        {showReviewerActions ? (
          <Button variant="secondary" onClick={() => setWorkflowOpen(true)}>
            Assign reviewer
          </Button>
        ) : null}
        <Button
          variant="secondary"
          onClick={() => routerPush(`/evidence/${workspace.evidence.id}?tab=artifacts`)}
        >
          Open report
        </Button>
      </div>
    </section>
  );
}

export function EvidenceReviewTab({ ctx }: { ctx: EvidenceDetailCtx }) {
  const {
    workspace,
    evidence,
    evidenceId,
    canSeeReviewerOps,
    actionBusy,
    workflowEvents,
    workflowEventsLoading,
    loadWorkflowEvents,
    removeCase,
    handleRemoveRelationship,
    setSelectedCaseId,
    setAssignCaseOpen,
    setRelationshipOpen,
    setWorkflowOpen,
    routerPush,
    runRecordAction,
    restoreTrash,
    setArchiveOpen,
    setTrashOpen,
  } = ctx;

  // Phase 2 — show the NOT_STARTED empty state when nobody has
  // started a structured review yet. Once a reviewer sets any
  // status the regular workflow block takes over.
  const showEmptyState =
    !workspace.reviewWorkflow?.status ||
    workspace.reviewWorkflow.status === "NOT_STARTED";

  return (
    <>
      {showEmptyState ? <NotStartedEmptyState ctx={ctx} /> : null}

      <EvidenceRelationshipsSection
        caseName={workspace.relationships.caseName}
        relatedEvidenceCount={workspace.relationships.relatedEvidenceCount}
        multipart={workspace.relationships.multipart}
        itemCount={workspace.relationships.itemCount}
        note={workspace.relationships.note}
        items={workspace.relationships.items}
        actionBusy={actionBusy}
        onAssignCase={() => {
          setSelectedCaseId(workspace.relationships.caseId || "");
          setAssignCaseOpen(true);
        }}
        onRemoveCase={workspace.relationships.caseId ? () => void removeCase() : null}
        onOpenRelationshipEditor={() => setRelationshipOpen(true)}
        onOpenLinkedEvidence={(id) => routerPush(`/evidence/${id}`)}
        onRemoveRelationship={handleRemoveRelationship}
      />

      {canSeeReviewerOps ? (
        <>
          <ReviewerWorkflowCard
            workflow={workspace.reviewWorkflow}
            events={workflowEvents}
            eventsLoading={workflowEventsLoading}
            actionBusy={actionBusy}
            onRefreshEvents={() => void loadWorkflowEvents()}
            onOpenEditor={() => setWorkflowOpen(true)}
            formatDateTime={formatUserDateTime}
          />

          <EvidenceReviewActionsPanel
            evidenceId={evidenceId}
            teamId={workspace.reviewWorkflow?.teamId ?? null}
            currentStatus={workspace.reviewWorkflow.status ?? null}
            assignedToUserId={workspace.reviewWorkflow.assignedTo?.id ?? null}
            currentUserId={null}
            onChanged={() => void loadWorkflowEvents()}
          />
        </>
      ) : !showEmptyState ? (
        <section
          className="evidence-detail-section"
          data-self-serve-review-status
        >
          <div className="evidence-detail-section-header">
            <SectionHeading
              kicker="Review"
              title="Review status"
              icon={ClipboardCheck}
            />
          </div>
          <p className="evidence-detail-muted">
            {workspace.reviewWorkflow?.status
              ? `Current status: ${workspace.reviewWorkflow.status}`
              : "No review status set."}
          </p>
        </section>
      ) : null}

      <section className="evidence-detail-section">
        <div className="evidence-detail-section-header">
          <SectionHeading
            kicker="Notes"
            title="Private notes &amp; annotations"
            icon={ClipboardCheck}
          />
        </div>

        <div className="evidence-detail-note-box">
          <strong>Boundary</strong>
          <p>
            Private review notes are not included in public verification or external packages unless
            explicitly exported.
          </p>
        </div>

        {workspace.governance ? (
          <div className="evidence-detail-note-box">
            <strong>Governance</strong>
            <p>
              {workspace.governance.reviewerComments.label},{" "}
              {workspace.governance.legalNotes.label}, and{" "}
              {workspace.governance.annotations.label} are internal workspace materials. They are not
              included in public verification, the fixed PDF report, or the verification package.
            </p>
          </div>
        ) : null}

        {evidence.internalNotes ? (
          <div className="evidence-detail-note-box">
            <strong>Private session note</strong>
            <p>{evidence.internalNotes}</p>
          </div>
        ) : null}

        <div className="evidence-detail-embedded-panels">
          <ReviewerCommentsPanel evidenceId={evidence.id} />
          <LegalNotesPanel evidenceId={evidence.id} />
          <AnnotationPanel evidenceId={evidence.id} defaultPartId={workspace.parts[0]?.id ?? null} />
          {/* Phase 6 — only mount the AI card when AI is actually
              configured for this workspace. Avoids the "AI
              categorization is not configured" placeholder that
              wasted page real estate on every record. */}
          <AiCategorizationCardWhenActive evidenceId={evidence.id} />
        </div>
      </section>

      {/* Phase EVIDENCE-IA — comparison / duplicate / AI advisory
          panels. These are operational tools the reviewer uses inline;
          they stay on the Review tab. */}
      <ComparisonPanel evidenceId={evidence.id} />
      <DuplicateDetectionPanel evidenceId={evidence.id} />
      <AiCategorizationPanel evidenceId={evidence.id} />

      <ReviewerAuditTrailSection
        items={workspace.reviewerAudit ?? []}
        formatDateTime={formatUserDateTime}
      />

      {/* Phase 1 — kept ONLY the operational archive/trash actions
          here; the full retention/object-lock detail moved to the
          Integrity tab (single source of preservation posture). */}
      <section
        className="evidence-detail-section"
        data-evidence-section="record-actions"
      >
        <div className="evidence-detail-section-header">
          <SectionHeading
            kicker="Record actions"
            title="Archive, restore, or move to trash"
            icon={ClipboardCheck}
          />
        </div>
        <KeyValueGrid
          items={[
            { label: "Locked at", value: formatValueDate(evidence.lockedAt) },
            { label: "Archived at", value: formatValueDate(evidence.archivedAt) },
            { label: "Deleted at", value: formatValueDate(evidence.deletedAt) },
            {
              label: "Delete scheduled for",
              value: formatValueDate(evidence.deleteScheduledForUtc),
            },
          ]}
        />
        <div className="evidence-detail-inline-actions">
          {evidence.archivedAt ? (
            <Button
              variant="secondary"
              onClick={() =>
                void runRecordAction(
                  `/v1/evidence/${evidence.id}/unarchive`,
                  "Evidence restored from archive",
                )
              }
            >
              Restore archive
            </Button>
          ) : (
            <Button
              variant="secondary"
              onClick={() => setArchiveOpen(true)}
              disabled={evidence.deletedAt != null}
            >
              Archive
            </Button>
          )}

          {evidence.deletedAt ? (
            <Button variant="secondary" onClick={() => void restoreTrash()}>
              Restore from trash
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => setTrashOpen(true)}>
              Move to trash
            </Button>
          )}
        </div>
      </section>
    </>
  );
}

function formatValueDate(iso: string | null | undefined): string {
  if (!iso) return "Not recorded";
  return formatUserDateTime(iso);
}
