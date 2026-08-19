"use client";

/**
 * Phase 6 — Source card + minimal review controls for evidence created
 * via external intake.
 *
 * Rendered on the authenticated evidence detail page. Returns null when the
 * evidence did not come from external intake (the common case), so the
 * existing evidence page is unaffected for every authenticated capture
 * record.
 *
 * Privacy contract:
 *   - The backend route /v1/evidence/:id/external-intake-summary returns
 *     only authenticated-safe metadata. No token, no token hash, no
 *     contributor IP, no raw user agent. See
 *     services/api/src/services/external-intake-source-summary.service.ts.
 *   - The card itself never reads from any public endpoint and never
 *     surfaces anything beyond what the authenticated summary returns.
 *   - Review controls call the EXISTING /v1/evidence/:id/reviewer-workflow
 *     PATCH endpoint (built before Phase 6). No new review surface was
 *     created; this UI is a thin client over what's already there.
 *
 * Language:
 *   - Reviewer status labels use legally-safe wording (e.g. "Accepted for
 *     internal review", "Needs additional context") rather than truth
 *     claims.
 */

import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import { useEffect, useMemo, useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import { formatUserDateTime } from "../../../../../lib/date";
import {
  REVIEWER_DECISION_ACTIONS,
  REVIEWER_STATUS_LABEL,
  REVIEWER_STATUS_PRIMARY_ACTIONS,
  REVIEWER_STATUS_DISCLAIMER,
} from "../../lib/reviewer-status";

type Summary = {
  source: "external_intake";
  intakeMode: string;
  isAnonymous: boolean;
  workflowTemplateSlug: string;
  workflowTemplateName: string;
  workflowTemplateVersion: number;
  caseId: string | null;
  link: {
    id: string;
    status: string;
    expiresAtUtc: string;
    usedCount: number;
    maxUses: number;
    createdAt: string;
    createdByUserId: string;
    recipientLabel: string | null;
    revokedAtUtc: string | null;
  };
  session: {
    id: string;
    status: string;
    submitterDisplayName: string | null;
    submitterEmail: string | null;
    pseudonym: string | null;
    openedAtUtc: string | null;
    uploadStartedAtUtc: string | null;
    uploadCompletedAtUtc: string | null;
    submittedAtUtc: string | null;
    consentAcceptedAtUtc: string | null;
    consentPolicyVersion: string | null;
  };
};

// P0 bugfix — the reviewer-workflow GET/PATCH endpoints return the
// shape produced by `toWorkflowSummary` in services/api/src/services/
// evidence-review/reviewer-workflow.service.ts:
//
//   { available: boolean; workflow: { id, status, priority, ... } | null }
//
// Before this fix the card read `review?.status` directly, which was
// always undefined (the actual status lives at `review.workflow.status`).
// That made every button appear inert: the PATCH ran successfully, but
// the local state used to drive the active-style + currentStatusLabel
// never updated, so the UI never visibly reflected the change.
type ReviewWorkflowDetails = {
  id?: string | null;
  status?: string | null;
  priority?: string | null;
  assignedTo?: { id?: string; displayName?: string | null } | null;
  note?: string | null;
  updatedAt?: string | null;
};
type ReviewSummary = {
  available: boolean;
  workflow: ReviewWorkflowDetails | null;
};

// Reviewer status labels + the actionable subset live in the shared
// reviewer-status helper so every surface (this card, the Reviewer
// Workflow card, the audit pins) reads the same map. See
// apps/web/app/(app)/evidence/lib/reviewer-status.ts.
const STATUS_LABEL = REVIEWER_STATUS_LABEL;
const ACTIONABLE_STATUSES = REVIEWER_STATUS_PRIMARY_ACTIONS;

export default function ExternalIntakeSourceCard({
  evidenceId,
}: {
  evidenceId: string;
}) {
  const [summary, setSummary] = useState<Summary | null | undefined>(undefined);
  const [review, setReview] = useState<ReviewSummary | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch(`/v1/evidence/${encodeURIComponent(evidenceId)}/external-intake-summary`, {
      method: "GET",
    })
      .then((res: { summary: Summary | null }) => {
        if (cancelled) return;
        setSummary(res?.summary ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setSummary(null);
      });
    return () => {
      cancelled = true;
    };
  }, [evidenceId]);

  // Only the PRESENCE of the intake summary gates this fetch, never its
  // identity — extracted so the dependency is statically checkable and the
  // reviewer-workflow read does not re-fire when an unrelated field changes.
  const hasIntakeSummary = summary !== undefined && summary !== null;
  useEffect(() => {
    if (!hasIntakeSummary) return;
    let cancelled = false;
    apiFetch(`/v1/evidence/${encodeURIComponent(evidenceId)}/reviewer-workflow`, {
      method: "GET",
    })
      .then((res: ReviewSummary) => {
        if (cancelled) return;
        setReview(res ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setReview(null);
      });
    return () => {
      cancelled = true;
    };
  }, [evidenceId, hasIntakeSummary]);

  // Read status from the nested workflow object — see the type comment
  // above for the response shape. Defaults to NOT_STARTED when no
  // workflow row exists yet (first click creates it via PATCH).
  const currentStatus = review?.workflow?.status ?? "NOT_STARTED";
  const currentStatusLabel = useMemo(() => {
    return STATUS_LABEL[currentStatus] ?? currentStatus;
  }, [currentStatus]);

  const [savedFlashStatus, setSavedFlashStatus] = useState<string | null>(null);

  /** Refresh the workflow projection after any server-side change. */
  async function reloadReview() {
    const res: ReviewSummary = await apiFetch(
      `/v1/evidence/${encodeURIComponent(evidenceId)}/reviewer-workflow`,
    );
    setReview(res);
  }

  /**
   * PHASE 12 POINT 4 PASS C1 — record a reviewer VERDICT.
   *
   * The browser names the DECISION, never the resulting status: the server
   * appends the immutable decision row and derives `workflow.status` from the
   * decision log in the same transaction. The workspace is derived from the
   * record server-side, so no tenant id is sent.
   */
  async function recordDecision(
    decision: (typeof REVIEWER_DECISION_ACTIONS)[number]["decision"],
    note?: string,
  ) {
    setReviewBusy(true);
    setReviewError(null);
    try {
      await apiFetch(
        `/v1/review-operations/evidence/${encodeURIComponent(evidenceId)}/decision`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision, note: note ?? null }),
        },
      );
      await reloadReview();
      setSavedFlashStatus(decision);
      setTimeout(() => setSavedFlashStatus(null), 2400);
    } catch (err) {
      const e = err as { message?: string };
      setReviewError(
        toSafeUserError(e, { message: "Could not record the review decision." })
          .message,
      );
    } finally {
      setReviewBusy(false);
    }
  }

  async function patchReviewStatus(nextStatus: string, note?: string) {
    setReviewBusy(true);
    setReviewError(null);
    try {
      const res: ReviewSummary = await apiFetch(
        `/v1/evidence/${encodeURIComponent(evidenceId)}/reviewer-workflow`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            status: nextStatus,
            note: note ?? null,
          }),
        },
      );
      setReview(res);
      // Brief success flash next to the active label. Independent of
      // the active-button style so a reviewer who clicked the same
      // status twice still gets a visible "saved" confirmation.
      setSavedFlashStatus(nextStatus);
      setTimeout(() => setSavedFlashStatus(null), 2400);
    } catch (err) {
      const e = err as { message?: string };
      setReviewError(toSafeUserError(e, { message: "Could not update review status." }).message);
    } finally {
      setReviewBusy(false);
    }
  }

  // Render nothing while still loading or when the evidence is not external.
  if (summary === undefined) return null;
  if (summary === null) return null;

  // Resolve a real contributor identity. Returns null when nothing
  // was collected — most intake-link workflows do not require name,
  // email, phone, or alias, and rendering "Contributor: Not provided"
  // creates confusion ("was something supposed to be collected?
  // did the upload fail?"). When null we hide the entire row.
  const contributorIdentity: string | null = (() => {
    if (summary.session.pseudonym) return `Pseudonym: ${summary.session.pseudonym}`;
    if (!summary.isAnonymous) {
      if (summary.session.submitterEmail) return summary.session.submitterEmail;
      if (summary.session.submitterDisplayName)
        return summary.session.submitterDisplayName;
    }
    return null;
  })();

  return (
    <section className="evd-panel" aria-label="External intake source">
      <header className="evd-header">
        <div>
          <p className="evd-muted">Source</p>
          <h3 className="evd-title">External intake</h3>
        </div>
        <span className="evd-badge">
          {summary.intakeMode.replace("EXTERNAL_", "").replace(/_/g, " ").toLowerCase()}
        </span>
      </header>

      <dl className="evd-grid">
        <Detail label="Workflow">
          {summary.workflowTemplateName} (v{summary.workflowTemplateVersion})
        </Detail>
        <Detail label="Submitted at">
          {summary.session.submittedAtUtc
            ? formatUserDateTime(summary.session.submittedAtUtc)
            : "—"}
        </Detail>
        {contributorIdentity ? (
          <Detail label="Contributor">{contributorIdentity}</Detail>
        ) : null}
        <Detail label="Upload Agreement">
          {summary.session.consentAcceptedAtUtc
            ? `Accepted ${formatUserDateTime(summary.session.consentAcceptedAtUtc)}` +
              (summary.session.consentPolicyVersion
                ? ` · v${summary.session.consentPolicyVersion}`
                : "")
            : "Not recorded"}
        </Detail>
        <Detail label="Session status">{summary.session.status}</Detail>
        <Detail label="Link status">
          {summary.link.status} (used {summary.link.usedCount}/{summary.link.maxUses})
        </Detail>
        {summary.caseId ? (
          <Detail label="Case / matter">{summary.caseId}</Detail>
        ) : null}
      </dl>

      <div className="evd-stack">
        <header className="evd-block--foot">
          <p className="evd-muted">Reviewer status</p>
          <h4
            className="evd-subtitle"
            data-evidence-reviewer-current-status={currentStatus}
          >
            {currentStatusLabel}
            {savedFlashStatus && savedFlashStatus === currentStatus ? (
              <span
                className="evd-flash"
                data-evidence-reviewer-saved-flash="true"
              >
                Saved
              </span>
            ) : null}
          </h4>
        </header>
        {reviewError ? <div className="evd-error">{reviewError}</div> : null}
        <div className="evd-actions">
          {ACTIONABLE_STATUSES.map((s) => {
            const active = currentStatus === s;
            return (
              <button
                key={s}
                type="button"
                className={
                  active
                    ? "app-secondary-action app-secondary-action--filled"
                    : "app-secondary-action"
                }
                disabled={reviewBusy}
                onClick={() => patchReviewStatus(s)}
                data-evidence-reviewer-status-btn={s}
                data-evidence-reviewer-status-active={active ? "true" : "false"}
                aria-pressed={active}
              >
                {reviewBusy && savedFlashStatus === null ? "…" : ""}
                {STATUS_LABEL[s] ?? s}
              </button>
            );
          })}
        </div>
        {/* Verdicts are recorded as DECISIONS; the status they produce is
            derived by the server from the immutable decision log. */}
        <div
          className="evd-actions evd-actions--top"
          data-evidence-reviewer-decisions="true"
        >
          {REVIEWER_DECISION_ACTIONS.map((action) => {
            const satisfied = currentStatus === action.resultingStatus;
            return (
              <button
                key={action.decision}
                type="button"
                className={
                  satisfied
                    ? "app-secondary-action app-secondary-action--filled"
                    : "app-secondary-action"
                }
                disabled={reviewBusy}
                onClick={() => recordDecision(action.decision)}
                data-evidence-reviewer-decision-btn={action.decision}
                data-evidence-reviewer-decision-active={
                  satisfied ? "true" : "false"
                }
                aria-pressed={satisfied}
              >
                {action.label}
              </button>
            );
          })}
        </div>
        <p
          className="evd-muted"
          data-evidence-reviewer-disclaimer="true"
        >
          {REVIEWER_STATUS_DISCLAIMER}
        </p>
      </div>
    </section>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="evd-field__label">{label}</dt>
      <dd className="evd-field__value">{children}</dd>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Styles — self-contained so this component does not depend on the existing
// evidence-detail.css. A future polish phase can move to the design system.
// -----------------------------------------------------------------------------
