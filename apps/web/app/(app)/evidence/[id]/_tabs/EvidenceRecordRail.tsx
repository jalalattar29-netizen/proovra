/**
 * Evidence Record — shared right rail.
 *
 * ONE authority for every tab. It is rendered once by the route orchestrator
 * beside the active tab panel, so Overview, Integrity, Custody and every later
 * tab receive the same structure; no tab may grow a rail of its own.
 *
 * It lives in its own file rather than inline in page.tsx because the
 * orchestrator is held under a byte-size guard whose purpose is to stop
 * presentation accumulating in the route file.
 *
 * GROUPING. Four semantic sections: Risk Signals, Review Workflow,
 * Attributes, Public Verification. `Case` and `Due date` previously sat inside
 * Review Workflow, which read as if they described the workflow rather than
 * the record; they are record attributes and now have their own section. This
 * is a grouping and heading correction only — the same values come from the
 * same projections, no field was added and no capability rule changed.
 */

"use client";

// The rail's states are LABELLED FACTS in a key/value column, not states a
// dense row is scanned by — so they are text, and the label beside them is
// what tells the reader which fact they are.
import { AppStatusText } from "../../../../../components/app-primitives";
import { formatUserDateTime } from "../../../../../lib/date";
import {
  getPriorityTone,
  getPublicVerificationTone,
  getWorkflowStatusTone,
} from "./_lib";
import type { ReviewWorkspaceResponse } from "../review-workspace-types";

export type EvidenceRailSignal = {
  title: string;
  detail: string;
  severity: string;
};

export function EvidenceRecordRail({
  workspace,
  signals,
  publicVerificationLabel,
  publicVerificationDetail,
  shareUrl,
}: {
  workspace: ReviewWorkspaceResponse;
  signals: EvidenceRailSignal[];
  publicVerificationLabel: string;
  publicVerificationDetail: string;
  shareUrl: string | null;
}) {
  return (
    <aside
      className="evidence-detail-sidebar"
      data-evidence-sidebar="status-and-next-action"
    >
      <section
        className="evidence-detail-side-block"
        data-evidence-side="risk-signals"
      >
        <h2 className="evidence-detail-rail-heading">Risk Signals</h2>
        {signals.length === 0 ? (
          <p className="evidence-detail-muted evidence-detail-rail-note">
            No advisory risk signals in the current response.
          </p>
        ) : (
          <div className="evidence-detail-signal-list">
            {signals.slice(0, 4).map((signal) => (
              <article
                key={`${signal.title}-${signal.detail}`}
                className={`evidence-detail-signal-card ${signal.severity}`}
              >
                <strong>{signal.title}</strong>
                <p>{signal.detail}</p>
              </article>
            ))}
          </div>
        )}
      </section>

      <section
        className="evidence-detail-side-block"
        data-evidence-side="operational-summary"
      >
        <h2 className="evidence-detail-rail-heading">Review Workflow</h2>
        <p className="evidence-detail-rail-lede">Operational summary</p>
        <AppStatusText
          tone={getWorkflowStatusTone(workspace.reviewWorkflow.status)}
        >
          {workspace.reviewWorkflow.status
            ? workspace.reviewWorkflow.status.replace(/_/g, " ")
            : "Not started"}
        </AppStatusText>
        <div className="evidence-detail-rail-field">
          <span className="evidence-detail-rail-field__label">Priority</span>
          <span
            className="evidence-detail-rail-field__value"
            data-evidence-rail-priority
          >
            <span
              className="evidence-detail-rail-dot"
              data-tone={getPriorityTone(workspace.reviewWorkflow.priority)}
              aria-hidden="true"
            />
            {workspace.reviewWorkflow.priority || "Not configured"}
          </span>
        </div>
      </section>

      <section
        className="evidence-detail-side-block"
        data-evidence-side="attributes"
      >
        <h2 className="evidence-detail-rail-heading">Attributes</h2>
        <div className="evidence-detail-rail-field">
          <span className="evidence-detail-rail-field__label">Case</span>
          <span className="evidence-detail-rail-field__value">
            {workspace.relationships.caseName || "Unassigned"}
          </span>
        </div>
        <div className="evidence-detail-rail-field">
          <span className="evidence-detail-rail-field__label">Due date</span>
          <span className="evidence-detail-rail-field__value">
            {formatUserDateTime(workspace.reviewWorkflow.dueAt) ?? "Not available"}
          </span>
        </div>
      </section>

      {/* Phase CAPTURE-CLOSURE Part C — compact public-verification
          shortcut. The rail only carries the publication-state chip + a
          shortcut link (no full detail duplication); the detail counts
          live in the Artifacts tab. */}
      <section
        className="evidence-detail-side-block"
        data-evidence-side="public-verification-shortcut"
      >
        <div className="evidence-detail-rail-heading-row">
          <h2 className="evidence-detail-rail-heading">Public Verification</h2>
          <AppStatusText
            tone={getPublicVerificationTone(
              workspace.publicVerificationSummary.state,
            )}
          >
            {publicVerificationLabel}
          </AppStatusText>
        </div>
        {shareUrl ? (
          <a
            href={shareUrl}
            className="evidence-detail-inline-link"
            target="_blank"
            rel="noreferrer"
            data-evidence-side-publish-link
          >
            Open verification surface
          </a>
        ) : (
          <p className="evidence-detail-muted evidence-detail-rail-note">
            {publicVerificationDetail}
          </p>
        )}
      </section>
    </aside>
  );
}
