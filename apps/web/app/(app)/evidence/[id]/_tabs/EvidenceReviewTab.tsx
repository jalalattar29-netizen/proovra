/**
 * Phase EVIDENCE-IA-REVIEW — Review tab.
 *
 * Human review workspace. Workflow status / case assignment / notes /
 * comments / annotations / reviewer actions / AI advisory.
 *
 * Phase REVIEW-TAB-STABILITY (this pass) — the Review tab now renders
 * the SAME sections in the SAME order regardless of reviewer status.
 * Previously, NOT_STARTED swapped the entire layout for a giant
 * empty-state card with a non-clickable suggested-action bullet list
 * (comments/legal-notes hints, risk-signal hints, report/package
 * download hints). Those bullets looked like buttons but weren't, and
 * the layout jump between statuses was disorienting. New shape:
 *   1. Review Workflow     — workflow card (or status box) + disclaimer
 *   2. Review Actions      — Attach to case + Open report (always wired)
 *   3. Case & Relationships
 *   4. Notes & annotations
 *   5. Audit / record actions
 * Reviewer status changes only swap the status badge/label — not the
 * page layout.
 *
 * Phase EVIDENCE-AI-CONSOLIDATION — there is ONE canonical AI
 * categorization surface: <AiCategorizationPanel>. The prior on-mount
 * wrapper card + duplicate hidden-feature panel mount are gone.
 *
 * Phase 1 — "Workspace and record retention state" was duplicated by
 * the Integrity tab's "Verification & preservation" block; the
 * duplicate is removed from Review. Archive/trash controls stay here
 * because they're operational actions, not posture.
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
import {
  ARCHIVE_AS_ALTERNATIVE_COPY,
  getEvidenceDeletionEligibility,
} from "../../lib/evidence-delete-eligibility";
import { canManageEvidenceRelationships } from "../../lib/evidence-relationships-visibility";
import {
  formatReviewerStatusLabel,
  REVIEWER_STATUS_DISCLAIMER,
} from "../../lib/reviewer-status";
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
import { EvidenceCopilotPanel } from "../../../../../components/ai-copilot/EvidenceCopilotPanel";

export function EvidenceReviewTab({ ctx }: { ctx: EvidenceDetailCtx }) {
  const {
    workspace,
    evidence,
    evidenceId,
    canSeeReviewerOps,
    canSeeInvestigation,
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

  // Phase EVIDENCE-RELATIONSHIPS-GATE — hide the Manage button and the
  // per-row Remove buttons on Personal / non-investigation workspaces.
  // Items still render read-only when present.
  const relationshipsVisibility = canManageEvidenceRelationships({
    canSeeInvestigation,
    existingRelationshipCount: workspace.relationships.items.length,
  });

  // Phase REVIEW-TAB-STABILITY — surfaced for tests and for ops
  // tooling. NOT_STARTED no longer causes the layout to swap; only
  // the badge label flips.
  const reviewerStatus = workspace.reviewWorkflow?.status ?? "NOT_STARTED";

  return (
    <>
      {/* Phase P4 — Evidence Copilot: advisory operational summary for THIS
          record (missing context, integrity/custody/TSA/OTS explanations,
          report/package readiness). Never a truth/authenticity verdict. */}
      <EvidenceCopilotPanel
        evidenceId={evidenceId}
        evidenceVersion={(evidence as { verificationPackageVersion?: number | null })?.verificationPackageVersion ?? 0}
      />

      {/* (1) Review Workflow — stable header always rendered. The
          body inside is the enterprise workflow card when reviewer
          ops are available, or a compact status row otherwise. */}
      {canSeeReviewerOps ? (
        <ReviewerWorkflowCard
          workflow={workspace.reviewWorkflow}
          events={workflowEvents}
          eventsLoading={workflowEventsLoading}
          actionBusy={actionBusy}
          onRefreshEvents={() => void loadWorkflowEvents()}
          onOpenEditor={() => setWorkflowOpen(true)}
          formatDateTime={formatUserDateTime}
        />
      ) : (
        <section
          className="evidence-detail-section"
          data-evidence-section="review-status"
          data-evidence-reviewer-status={reviewerStatus}
        >
          <div className="evidence-detail-section-header">
            <SectionHeading
              kicker="Review"
              title="Review status"
              icon={ClipboardCheck}
            />
          </div>
          <p>
            <strong>{formatReviewerStatusLabel(reviewerStatus)}</strong>
          </p>
          <p
            className="evidence-detail-muted"
            data-evidence-reviewer-disclaimer="true"
            style={{ fontSize: 12, marginTop: 4 }}
          >
            {REVIEWER_STATUS_DISCLAIMER}
          </p>
        </section>
      )}

      {/* (2) Review Actions — always rendered, only wired actions.
          Attach to case + Open report (artifacts tab) are present
          for every workspace. Reviewer-ops users additionally get
          Assign reviewer to open the workflow editor. We deliberately
          do NOT render unwired affordances — the four pseudo-action
          bullets that used to live in the retired empty-state card
          (comments hint, case-attach hint, risk-signal hint, report
          download hint) are gone; the wired buttons stand alone. */}
      <section
        className="evidence-detail-section"
        data-evidence-section="review-actions"
      >
        <div className="evidence-detail-section-header">
          <SectionHeading
            kicker="Review"
            title="Review actions"
            icon={ClipboardCheck}
          />
        </div>
        <div
          className="evidence-detail-inline-actions"
          data-evidence-review-actions
        >
          <Button
            variant="secondary"
            onClick={() => {
              setSelectedCaseId(workspace.relationships.caseId || "");
              setAssignCaseOpen(true);
            }}
          >
            Attach to case
          </Button>
          {canSeeReviewerOps ? (
            <Button variant="secondary" onClick={() => setWorkflowOpen(true)}>
              Assign reviewer
            </Button>
          ) : null}
          <Button
            variant="secondary"
            onClick={() =>
              routerPush(`/evidence/${workspace.evidence.id}?tab=artifacts`)
            }
          >
            Open report
          </Button>
        </div>
      </section>

      <EvidenceRelationshipsSection
        caseName={workspace.relationships.caseName}
        relatedEvidenceCount={workspace.relationships.relatedEvidenceCount}
        multipart={workspace.relationships.multipart}
        itemCount={workspace.relationships.itemCount}
        note={workspace.relationships.note}
        items={workspace.relationships.items}
        actionBusy={actionBusy}
        canManageRelationships={relationshipsVisibility.canManage}
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
        <EvidenceReviewActionsPanel
          evidenceId={evidenceId}
          teamId={workspace.reviewWorkflow?.teamId ?? null}
          currentStatus={workspace.reviewWorkflow.status ?? null}
          assignedToUserId={workspace.reviewWorkflow.assignedTo?.id ?? null}
          currentUserId={null}
          onChanged={() => void loadWorkflowEvents()}
        />
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
        {/* Phase EVIDENCE-DELETE-ELIGIBILITY — gate Move to trash on
            the canonical helper so the button is disabled BEFORE the
            user clicks rather than failing with a 409 toast. Archive
            stays the recommended alternative; the helper text below
            the disabled trash button says so. */}
        {(() => {
          const eligibility = getEvidenceDeletionEligibility(evidence);
          const trashDisabled = !eligibility.canMoveToTrash;
          const archiveDisabled =
            evidence.deletedAt != null || evidence.archivedAt != null;
          // When trash is blocked by retention and archive IS
          // available, the spec asks us to make Archive visually
          // recommended. We use the existing primary `variant`
          // (default) for Archive in that case; otherwise keep the
          // status quo secondary styling.
          const archiveIsRecommended = trashDisabled && !archiveDisabled;
          return (
            <>
              <div
                className="evidence-detail-inline-actions"
                data-evidence-record-actions
              >
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
                    variant={archiveIsRecommended ? "primary" : "secondary"}
                    onClick={() => setArchiveOpen(true)}
                    disabled={archiveDisabled}
                    data-evidence-action="archive"
                    data-archive-recommended={archiveIsRecommended ? "true" : "false"}
                  >
                    Archive evidence
                  </Button>
                )}

                {evidence.deletedAt ? (
                  <Button variant="secondary" onClick={() => void restoreTrash()}>
                    Restore from trash
                  </Button>
                ) : (
                  // Spec: keep the disabled control visible (consistent
                  // affordance) but never let the click reach
                  // setTrashOpen — that's exactly the "modal opens then
                  // fails" UX we're killing.
                  <span
                    data-evidence-trash-wrapper
                    data-evidence-trash-disabled={trashDisabled ? "true" : "false"}
                    title={trashDisabled ? eligibility.message : undefined}
                  >
                    <Button
                      variant="secondary"
                      onClick={() => {
                        if (trashDisabled) return;
                        setTrashOpen(true);
                      }}
                      disabled={trashDisabled}
                      aria-disabled={trashDisabled}
                      aria-describedby={
                        trashDisabled ? "evidence-trash-helper" : undefined
                      }
                      data-evidence-action="trash"
                      data-evidence-trash-reason={
                        eligibility.reasonCode ?? "ELIGIBLE"
                      }
                    >
                      Move to trash
                    </Button>
                  </span>
                )}
              </div>

              {trashDisabled && !evidence.deletedAt ? (
                <div
                  id="evidence-trash-helper"
                  className="evidence-detail-note-box"
                  data-evidence-trash-helper
                  data-evidence-trash-reason={eligibility.reasonCode ?? "UNKNOWN"}
                  style={{ marginTop: 10 }}
                >
                  <strong>Move to trash is unavailable</strong>
                  <p>{eligibility.message}</p>
                  {!archiveDisabled ? (
                    <p style={{ marginTop: 4 }}>{ARCHIVE_AS_ALTERNATIVE_COPY}</p>
                  ) : null}
                </div>
              ) : null}
            </>
          );
        })()}
      </section>
    </>
  );
}

function formatValueDate(iso: string | null | undefined): string {
  if (!iso) return "Not recorded";
  return formatUserDateTime(iso);
}
