"use client";

import type { EvidenceDetailCtx } from "./_lib";

/**
 * Phase 3 — "What needs attention" strip.
 *
 * Compact, action-oriented summary directly below the hero. Surfaces:
 *   - top 3 risk signals (read from the existing buildRiskSignals);
 *   - missing case assignment;
 *   - missing reviewer (workflow status NOT_STARTED or absent);
 *   - missing report (REPORTED status but artifact not available);
 *   - missing verification package (same gate).
 *
 * Renders nothing when there is nothing to act on — avoids visual
 * noise on clean records. Existing buttons / tabs are reachable
 * elsewhere; this strip is the high-altitude "have I done X yet?"
 * surface that users requested.
 */
export function WhatNeedsAttentionStrip({
  ctx,
  onAssignCase,
  onAssignReviewer,
  onGoToArtifacts,
  onGoToReview,
}: {
  ctx: EvidenceDetailCtx;
  onAssignCase: () => void;
  onAssignReviewer: () => void;
  onGoToArtifacts: () => void;
  onGoToReview: () => void;
}) {
  const { workspace, reviewSignals, canSeeReviewerOps } = ctx;

  const needsCase = !workspace.relationships.caseId && !workspace.relationships.caseName;
  // Phase EVIDENCE-REVIEW-VISIBILITY — only surface the
  // "Assign reviewer" prompt when the workspace exposes the
  // reviewer-ops surface. On a Personal Space / self-serve
  // context the user IS the reviewer; pestering them to
  // assign one is misleading.
  const needsReviewer =
    canSeeReviewerOps &&
    (!workspace.reviewWorkflow?.status ||
      workspace.reviewWorkflow.status === "NOT_STARTED");
  /*
   * COMMERCIAL + OUTPUT LIFECYCLE CLOSURE (2026-09-08) — "missing" is a
   * canonical STATE, not a plan flag beside an absence.
   *
   * This combined `reportsIncluded !== false` with `!available`, which said
   * "the plan allows it and there is no row" — so a Free record was excluded
   * only because the plan flag caught it, and every OTHER absence, including
   * one that is queued right now or one that terminally failed, read the same.
   * A reviewer summary is exactly where those must differ.
   */
  const missingReport =
    workspace.artifactStatus.outputs.report.state === "ELIGIBLE_NOT_GENERATED";
  const missingPackage =
    workspace.artifactStatus.outputs.verificationPackage.state ===
    "ELIGIBLE_NOT_GENERATED";

  const topRisks = reviewSignals.slice(0, 3);

  const hasAnything =
    needsCase ||
    needsReviewer ||
    missingReport ||
    missingPackage ||
    topRisks.length > 0;
  if (!hasAnything) return null;

  return (
    <section className="evidence-detail-attention" data-evidence-attention-strip>
      <strong className="evidence-detail-attention__title">
        What needs attention
      </strong>
      <div className="evidence-detail-attention__items">
        {topRisks.map((s) => (
          <span
            key={`${s.title}-${s.detail}`}
            className={`evidence-detail-pill ${
              s.severity === "danger"
                ? "danger"
                : s.severity === "warning"
                  ? "warning"
                  : // Phase EVIDENCE-RISK-TONE — "info" and "neutral"
                    // both render with the muted pill class so advisory
                    // notes don't shout from the attention strip.
                    "neutral"
            }`}
            data-evidence-attention-risk
            data-evidence-attention-risk-severity={s.severity}
            title={s.detail}
          >
            {s.title}
          </span>
        ))}
        {needsCase ? (
          <button
            type="button"
            data-evidence-attention-action="assign-case"
            onClick={onAssignCase}
            className="evidence-detail-attention__action"
          >
            No case assigned · Assign
          </button>
        ) : null}
        {needsReviewer ? (
          <button
            type="button"
            data-evidence-attention-action="assign-reviewer"
            onClick={onAssignReviewer}
            className="evidence-detail-attention__action"
          >
            Review not started · Start
          </button>
        ) : null}
        {missingReport ? (
          <button
            type="button"
            data-evidence-attention-action="missing-report"
            onClick={onGoToArtifacts}
            className="evidence-detail-attention__action"
          >
            Report not available · Artifacts
          </button>
        ) : null}
        {missingPackage ? (
          <button
            type="button"
            data-evidence-attention-action="missing-package"
            onClick={onGoToArtifacts}
            className="evidence-detail-attention__action"
          >
            Verification package not available · Artifacts
          </button>
        ) : null}
      </div>
      {topRisks.length === 0 && !needsCase && !needsReviewer ? (
        <button
          type="button"
          className="evidence-detail-attention__action"
          data-evidence-attention-action="open-review"
          onClick={onGoToReview}
        >
          Open review workspace
        </button>
      ) : null}
    </section>
  );
}
