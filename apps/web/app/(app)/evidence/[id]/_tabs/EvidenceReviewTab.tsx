/**
 * Phase EVIDENCE-IA-REVIEW — Review tab.
 *
 * Human review workspace. Workflow status / case assignment / notes /
 * comments / annotations / reviewer actions / AI advisory.
 *
 * Phase EVIDENCE-AI-CONSOLIDATION (this pass) — there is now ONE
 * canonical AI categorization surface: <AiCategorizationPanel>.
 * The prior on-mount wrapper card + the duplicate hidden-feature
 * panel mount are gone. Same backend endpoint, same data, ONE
 * disclaimer, ONE component mount. Disabled state collapses
 * inside the single panel — no large inactive section.
 *
 * Phase 1 — "Workspace and record retention state" was duplicated
 * by the Integrity tab's "Verification & preservation" block (same
 * retention / Object Lock / legal-hold rows). The duplicate is
 * removed from Review; archive/trash controls stay here because
 * they're operational actions, not posture.
 */

"use client";

import { ClipboardCheck } from "lucide-react";
import {
  KeyValueGrid,
  SectionHeading,
  type EvidenceDetailCtx,
} from "./_lib";
import { Button } from "../../../../../components/ui";
import { formatUserDateTime } from "../../../../../lib/date";
import { ReviewerCommentsPanel } from "../../components/ReviewerCommentsPanel";
import { LegalNotesPanel } from "../../components/LegalNotesPanel";
import { AnnotationPanel } from "../../components/AnnotationPanel";
import { ComparisonPanel } from "../../components/ComparisonPanel";
import { DuplicateDetectionPanel } from "../../components/DuplicateDetectionPanel";
import { AiCategorizationPanel } from "../../components/AiCategorizationPanel";
import { EvidenceRelationshipsSection } from "../components/EvidenceRelationshipsSection";
import { ReviewerWorkflowCard } from "../components/ReviewerWorkflowCard";
import { EvidenceReviewActionsPanel } from "../components/EvidenceReviewActionsPanel";
import { ReviewerAuditTrailSection } from "../components/ReviewerAuditTrailSection";

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

        {/* Phase EVIDENCE-LIBRARY-ENTERPRISE-GATE (FIX 6) — the
            governance note describes the reviewer/legal/annotation
            posture for the three enterprise panels below. When those
            panels are hidden for non-reviewer-ops workspaces, this
            note has nothing to describe and is hidden with them. */}
        {workspace.governance && canSeeReviewerOps ? (
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

        {/* Phase EVIDENCE-LIBRARY-ENTERPRISE-GATE (FIX 6) — Reviewer
            Comments, Legal Notes, and Annotations are enterprise /
            collaboration / reviewer-ops features. Personal Space and
            small-business workspaces without reviewer ops hide them
            entirely. Backend authorization is unchanged — this is a
            visibility cleanup only. The empty enterprise-only mounts
            were noise on self-serve. */}
        {canSeeReviewerOps ? (
          <div
            className="evidence-detail-embedded-panels"
            data-evidence-review-enterprise-panels
          >
            <ReviewerCommentsPanel evidenceId={evidence.id} />
            <LegalNotesPanel evidenceId={evidence.id} />
            <AnnotationPanel evidenceId={evidence.id} defaultPartId={workspace.parts[0]?.id ?? null} />
            {/* Phase EVIDENCE-AI-CONSOLIDATION — AI categorization is
                now rendered ONCE as <AiCategorizationPanel> below in
                the Advanced review tools row. The duplicate
                hidden-feature mount that used to live here is gone. */}
          </div>
        ) : null}
      </section>

      {/* Phase EVIDENCE-IA — comparison / duplicate / AI advisory
          panels. These are operational tools the reviewer uses inline;
          they stay on the Review tab. AI categorization renders ONCE
          here (was previously also mounted as a separate card above —
          consolidated to a single panel with one disclaimer). */}
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
