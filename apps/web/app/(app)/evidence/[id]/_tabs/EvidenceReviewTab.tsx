/**
 * Phase EVIDENCE-IA-REVIEW — Review tab.
 *
 * Human review workspace. Workflow status / case assignment / notes /
 * comments / annotations / reviewer actions / AI advisory.
 *
 * Phase REVIEW-TAB-STABILITY — the Review tab renders the SAME sections in
 * the SAME order regardless of reviewer status. Reviewer status changes only
 * swap the hero's title and badge — never the page layout.
 *
 * Phase EVIDENCE-AI-CONSOLIDATION — there is ONE canonical AI categorization
 * surface: <AiCategorizationPanel>.
 *
 * Phase EVIDENCE-DETAIL-REDESIGN — presentation only. Review owns its own
 * hero, section heads, notes boundary and lifecycle card rather than
 * borrowing the generic SectionHeading/KeyValueGrid/note-box set, so a change
 * here cannot ripple into the other six tabs. Every capability gate,
 * eligibility check, disabled reason, confirmation and API call below is the
 * one the previous build used.
 *
 * TRUTHFULNESS. The hero states in its own copy that reviewer status is an
 * internal workflow marker: it does not change integrity results, public
 * verification, authenticity, legal admissibility or factual truth. Lifecycle
 * actions never present optimistically — Move to trash stays disabled with
 * the server's own reason whenever retention or a legal hold blocks it, and
 * the amber notice explains what Archive does WITHOUT claiming deletion.
 */

"use client";

import type { ReactNode } from "react";
import { BadgeCheck, Trash2 } from "lucide-react";
import type { EvidenceDetailCtx } from "./_lib";
import { AppStatusBadge } from "../../../../../components/app-primitives";
import { formatUserDateTime } from "../../../../../lib/date";
import {
  ARCHIVE_AS_ALTERNATIVE_COPY,
  getEvidenceLifecycle,
  getRetentionPosture,
  getEvidenceDeletionEligibility,
} from "../../lib/evidence-delete-eligibility";
import { canManageEvidenceRelationships } from "../../lib/evidence-relationships-visibility";
import {
  formatReviewerStatusLabel,
  REVIEWER_STATUS_DISCLAIMER,
} from "../../lib/reviewer-status";
import { getWorkflowStatusTone } from "./_lib";
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

/** Section head: an uppercase label at the logical start, actions at the end. */
function ReviewSectionHead({
  title,
  actions,
  ...rest
}: {
  title: string;
  actions?: ReactNode;
} & Record<`data-${string}`, string | undefined>) {
  return (
    <div className="evidence-detail-review-head" {...rest}>
      <h2 className="evidence-detail-review-head__title">{title}</h2>
      {actions ? (
        <div className="evidence-detail-review-head__actions">{actions}</div>
      ) : null}
    </div>
  );
}

function formatValueDate(iso: string | null | undefined): string {
  if (!iso) return "Not recorded";
  return formatUserDateTime(iso) ?? "Not recorded";
}

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

  const reviewerStatus = workspace.reviewWorkflow?.status ?? "NOT_STARTED";

  // "Open report" is offered only when a report artifact truthfully exists.
  // Without one the control is disabled and says why, rather than routing the
  // reviewer to a tab that has nothing to open.
  const reportAvailable = workspace.artifactStatus.report.available === true;
  const reportPending = workspace.artifactStatus.report.pending === true;

  // EVIDENCE LIFECYCLE CONVERGENCE (2026-08-24) — ONE read of the canonical
  // projection. `archiveDisabled` used to be re-derived here from two
  // timestamps, which made this component a fifth place that decided lifecycle
  // availability; the projection answers it.
  const lifecycle = getEvidenceLifecycle(evidence);
  const eligibility = getEvidenceDeletionEligibility(evidence);
  const retention = getRetentionPosture(evidence);
  const trashDisabled = !eligibility.canMoveToTrash;
  const productState = lifecycle?.productState ?? "ACTIVE";
  const productStateLabel =
    productState === "TRASHED"
      ? "In trash"
      : productState === "ARCHIVED"
        ? "Archived"
        : productState === "DESTROYED"
          ? "Destroyed"
          : "Active";

  return (
    <>
      {/* Phase P4 — Evidence Copilot: advisory operational summary for THIS
          record (missing context, integrity/custody/TSA/OTS explanations,
          report/package readiness). Never a truth/authenticity verdict. */}
      <EvidenceCopilotPanel
        evidenceId={evidenceId}
        // THE CONCURRENCY AUTHORITY, carried opaquely.
        //
        // This was a cast to a field the declared type already had, then
        // `?? 0` — which told the route that a record with no verification
        // package was at package version zero. The route collapsed the same
        // way, so nothing broke; it just meant the guard answered a question
        // about a package counter while the panel shows fourteen fields.
        analysisRevision={evidence.analysisRevision ?? undefined}
      />

      {/* (1) Review hero — the reviewer state, its boundary, and the two
          wired actions. The layout is identical for every status. */}
      <section
        className="evidence-detail-review-hero"
        data-evidence-section="review-status"
        data-evidence-reviewer-status={reviewerStatus}
      >
        <span className="evidence-detail-review-hero__icon" aria-hidden="true">
          <BadgeCheck size={22} strokeWidth={2} />
        </span>
        <div className="evidence-detail-review-hero__copy">
          <div className="evidence-detail-review-hero__titles">
            <h2 className="evidence-detail-review-hero__title">
              {formatReviewerStatusLabel(reviewerStatus)}
            </h2>
            <AppStatusBadge tone={getWorkflowStatusTone(reviewerStatus)}>
              {reviewerStatus.replace(/_/g, " ")}
            </AppStatusBadge>
          </div>
          <p
            className="evidence-detail-review-hero__note"
            data-evidence-reviewer-disclaimer="true"
          >
            {REVIEWER_STATUS_DISCLAIMER}
          </p>
        </div>
        <div
          className="evidence-detail-review-hero__actions"
          data-evidence-review-actions
        >
          <button
            type="button"
            className="app-primary-action"
            onClick={() => {
              setSelectedCaseId(workspace.relationships.caseId || "");
              setAssignCaseOpen(true);
            }}
            data-evidence-action="attach-to-case"
          >
            Attach to case
          </button>
          {canSeeReviewerOps ? (
            <button
              type="button"
              className="app-secondary-action"
              onClick={() => setWorkflowOpen(true)}
              data-evidence-action="assign-reviewer"
            >
              Assign reviewer
            </button>
          ) : null}
          <button
            type="button"
            className="app-secondary-action"
            onClick={() =>
              routerPush(`/evidence/${workspace.evidence.id}?tab=artifacts`)
            }
            disabled={!reportAvailable}
            aria-disabled={!reportAvailable}
            title={
              reportAvailable
                ? undefined
                : reportPending
                  ? "The report is still being generated."
                  : "No report has been generated for this record yet."
            }
            data-evidence-action="open-report"
            data-evidence-report-available={reportAvailable ? "true" : "false"}
          >
            Open report
          </button>
        </div>
      </section>

      {/* (2) The enterprise workflow card keeps its own controls; it renders
          only where reviewer ops are reachable. */}
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
      ) : null}

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

      <section
        className="evidence-detail-review-section"
        data-evidence-section="private-notes"
      >
        <ReviewSectionHead title="Private notes &amp; annotations" />

        <div className="evidence-detail-boundary-callout" role="note">
          <span className="evidence-detail-boundary-callout__title">Boundary</span>
          <p className="evidence-detail-boundary-callout__body">
            Private review notes are not included in public verification or
            external packages unless explicitly exported.
          </p>
        </div>

        {/* Phase EVIDENCE-LIBRARY-ENTERPRISE-GATE (FIX 6) — the governance
            note describes the reviewer/legal/annotation posture for the three
            enterprise panels below. When those panels are hidden for
            non-reviewer-ops workspaces, this note has nothing to describe and
            is hidden with them. */}
        {workspace.governance && canSeeReviewerOps ? (
          <div className="evidence-detail-boundary-note">
            <span className="evidence-detail-boundary-note__title">Governance</span>
            <p className="evidence-detail-boundary-note__body">
              {workspace.governance.reviewerComments.label},{" "}
              {workspace.governance.legalNotes.label}, and{" "}
              {workspace.governance.annotations.label} are internal workspace
              materials. They are not included in public verification, the fixed
              PDF report, or the verification package.
            </p>
          </div>
        ) : null}

        {evidence.internalNotes ? (
          <div className="evidence-detail-boundary-note">
            <span className="evidence-detail-boundary-note__title">
              Private session note
            </span>
            <p className="evidence-detail-boundary-note__body">
              {evidence.internalNotes}
            </p>
          </div>
        ) : null}

        {/* Phase EVIDENCE-LIBRARY-ENTERPRISE-GATE (FIX 6) — Reviewer Comments,
            Legal Notes and Annotations are enterprise / collaboration /
            reviewer-ops features. Personal Space and small-business
            workspaces without reviewer ops hide them entirely. Backend
            authorization is unchanged — this is a visibility gate only. */}
        {canSeeReviewerOps ? (
          <div
            className="evidence-detail-embedded-panels"
            data-evidence-review-enterprise-panels
          >
            <ReviewerCommentsPanel evidenceId={evidence.id} />
            <LegalNotesPanel evidenceId={evidence.id} />
            <AnnotationPanel
              evidenceId={evidence.id}
              defaultPartId={workspace.parts[0]?.id ?? null}
            />
          </div>
        ) : null}
      </section>

      {/* Phase EVIDENCE-IA — comparison / duplicate / AI advisory tools. Each
          owns its own canonical disclosure; AI categorization renders ONCE. */}
      <div className="evidence-detail-review-tools" data-evidence-review-tools>
        <ComparisonPanel evidenceId={evidence.id} />
        <DuplicateDetectionPanel evidenceId={evidence.id} />
        <AiCategorizationPanel evidenceId={evidence.id} />
      </div>

      <ReviewerAuditTrailSection
        items={workspace.reviewerAudit ?? []}
        formatDateTime={formatUserDateTime}
      />

      {/* Lifecycle management. EVIDENCE LIFECYCLE CONVERGENCE (2026-08-24):
          every control below is offered or withheld by the canonical
          `evidence.lifecycle` projection, which the server computes from the
          same authority the write path calls. This component decides nothing.

          RETENTION IS REPORTED SEPARATELY, and that separation is the fix. The
          previous version could only ever describe retention as the reason an
          action was missing — it rendered "This record is protected by
          compliance retention until Jun 14, 2034. It cannot be moved to trash
          before that date" over a disabled button, for an operation that
          deletes nothing. Retention now states what it actually constrains
          (physical destruction) as a fact about the record, and the buttons
          state their own availability. */}
      <section
        className="evidence-detail-lifecycle"
        data-evidence-section="record-actions"
      >
        <div className="evidence-detail-lifecycle__head">
          <span className="evidence-detail-lifecycle__icon" aria-hidden="true">
            <Trash2 size={18} strokeWidth={2} />
          </span>
          <h2 className="evidence-detail-lifecycle__title">Lifecycle management</h2>
        </div>

        <div className="evidence-detail-lifecycle__body">
          <div className="evidence-detail-facts-grid" data-evidence-facts-grid>
            {[
              { label: "State", value: productStateLabel },
              { label: "Locked at", value: formatValueDate(evidence.lockedAt) },
              { label: "Archived at", value: formatValueDate(evidence.archivedAt) },
              // "Deleted at" / "Scheduled deletion" were both untrue. Nothing
              // was deleted, and the scheduled date was never a deletion date —
              // it is when the record stops being recoverable by an ordinary
              // user and becomes a destruction CANDIDATE.
              { label: "Moved to trash", value: formatValueDate(evidence.deletedAt) },
              {
                label: "Recoverable until",
                value: formatValueDate(evidence.deleteScheduledForUtc),
              },
            ].map((fact) => (
              <div key={fact.label} className="evidence-detail-fact">
                <span className="evidence-detail-fact__label">{fact.label}</span>
                <span className="evidence-detail-fact__value">{fact.value}</span>
              </div>
            ))}
          </div>

          {/* Retention posture — INDEPENDENT of action availability. Compact:
              at most three short lines, and absent entirely when nothing
              retains the record. */}
          {retention.retainedUntilLabel ||
          retention.objectLockLabel ||
          retention.legalHold ? (
            <div
              className="evidence-detail-lifecycle__retention"
              data-evidence-retention-posture
            >
              {retention.retainedUntilLabel ? (
                <p data-evidence-retained-until>{retention.retainedUntilLabel}</p>
              ) : null}
              {retention.objectLockLabel ? (
                <p data-evidence-object-lock>{retention.objectLockLabel}</p>
              ) : null}
              {retention.legalHold ? (
                <p data-evidence-legal-hold>Legal hold: active</p>
              ) : null}
              {retention.destructionNote ? (
                <p data-evidence-destruction-note>{retention.destructionNote}</p>
              ) : null}
            </div>
          ) : null}

          {productState === "DESTROYED" ? (
            /* A tombstone. The record's content is gone and verified gone; what
               remains is the governance fact that it existed and was destroyed.
               No mutable action is offered because none exists — this is the
               one terminal state. */
            <div
              className="app-alert evidence-detail-lifecycle__blocked"
              role="status"
              data-evidence-tombstone
            >
              <strong>This record has been destroyed</strong>
              <p>
                Its content was permanently removed from storage and the removal
                was verified. The record is retained as a tombstone so the
                destruction remains auditable.
              </p>
            </div>
          ) : (
            <>
              <div
                className="evidence-detail-lifecycle__actions"
                data-evidence-record-actions
              >
                {lifecycle?.canUnarchive ? (
                  <button
                    type="button"
                    className="app-secondary-action app-secondary-action--filled"
                    onClick={() =>
                      void runRecordAction(
                        `/v1/evidence/${evidence.id}/unarchive`,
                        "Evidence restored to active",
                      )
                    }
                    data-evidence-action="restore-archive"
                  >
                    Restore to active
                  </button>
                ) : null}

                {lifecycle?.canArchive ? (
                  <button
                    type="button"
                    className="app-secondary-action app-secondary-action--filled"
                    onClick={() => setArchiveOpen(true)}
                    data-evidence-action="archive"
                    data-archive-recommended={
                      trashDisabled ? "true" : "false"
                    }
                  >
                    Archive evidence
                  </button>
                ) : null}

                {lifecycle?.canRestoreFromTrash ? (
                  <button
                    type="button"
                    className="app-secondary-action"
                    onClick={() => void restoreTrash()}
                    data-evidence-action="restore-trash"
                  >
                    Restore from trash
                  </button>
                ) : productState !== "TRASHED" ? (
                  // Kept visible when disabled so the affordance is stable, but
                  // the click can never reach setTrashOpen — that is exactly the
                  // "modal opens, then 409s" behaviour this replaces.
                  <span
                    data-evidence-trash-wrapper
                    data-evidence-trash-disabled={trashDisabled ? "true" : "false"}
                    title={trashDisabled ? eligibility.message : undefined}
                  >
                    <button
                      type="button"
                      className="app-secondary-action"
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
                    </button>
                  </span>
                ) : null}
              </div>

              {trashDisabled && productState !== "TRASHED" ? (
                <div
                  id="evidence-trash-helper"
                  className="app-alert app-alert--warn evidence-detail-lifecycle__blocked"
                  role="status"
                  data-evidence-trash-helper
                  data-evidence-trash-reason={eligibility.reasonCode ?? "UNKNOWN"}
                >
                  <strong>Move to trash is unavailable</strong>
                  <p>{eligibility.message}</p>
                  {lifecycle?.canArchive ? (
                    <p>{ARCHIVE_AS_ALTERNATIVE_COPY}</p>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </div>
      </section>
    </>
  );
}
