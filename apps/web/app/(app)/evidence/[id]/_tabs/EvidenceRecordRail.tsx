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
import { reviewPriorityLabel, reviewStatusLabel } from "@proovra/shared";

import { AppStatusText } from "../../../../../components/app-primitives";
import { formatUserDateTime } from "../../../../../lib/date";
import {
  getPriorityTone,
  getWorkflowStatusTone,
  type VerificationPageState,
} from "./_lib";
import type { ReviewWorkspaceResponse } from "../review-workspace-types";

/** Whether a case is expected — the shared policy, said in words. */
const CASE_POLICY_LABEL: Readonly<Record<"OPTIONAL" | "RECOMMENDED" | "REQUIRED", string>> = {
  OPTIONAL: "Optional",
  RECOMMENDED: "Recommended",
  REQUIRED: "Required",
};

export function EvidenceRecordRail({
  workspace,
  verificationPage,
  shareUrl,
}: {
  workspace: ReviewWorkspaceResponse;
  /** The verification page's access + disclosure, from describeVerificationPageState. */
  verificationPage: VerificationPageState | null;
  shareUrl: string | null;
}) {
  const attention = workspace.attention;
  const signals = (attention?.items ?? []).filter((i) => i.placement === "SIGNAL");
  const requiredAbove = (attention?.items ?? []).some((i) => i.category === "ACTION_REQUIRED");
  const caseAssignment = attention?.caseAssignment;
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
        {/* ADVISORY SIGNALS ONLY (2026-10-23), from the server's
            classification: a positive state is not a risk, provenance lives
            in the provenance context, and an item that needs action is in the
            strip above — never repeated here as a large card. */}
        {!attention ? (
          // No classification is not "no risk" (audit F14).
          <p className="evidence-detail-muted evidence-detail-rail-note" data-evidence-risk-unavailable>
            Risk signals could not be read.
          </p>
        ) : signals.length === 0 ? (
          <p className="evidence-detail-muted evidence-detail-rail-note" data-evidence-risk-empty>
            {requiredAbove
              ? "Issues that need action are listed under What needs attention."
              : "No current risk signals."}
          </p>
        ) : (
          <ul className="evidence-detail-rail-signals">
            {signals.map((signal) => (
              <li key={signal.code} data-evidence-risk-code={signal.code} data-tone={signal.tone}>
                <span className="evidence-detail-rail-signals__kind">Advisory</span>
                <strong>{signal.label}</strong>
                <span className="evidence-detail-muted">{signal.detail}</span>
              </li>
            ))}
          </ul>
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
          {reviewStatusLabel(workspace.reviewWorkflow.status)}
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
            {reviewPriorityLabel(workspace.reviewWorkflow.priority)}
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
          <span className="evidence-detail-rail-field__value" data-evidence-rail-case>
            {workspace.relationships.caseName
              ? workspace.relationships.caseName
              : caseAssignment?.restricted
                ? "Linked to a case you cannot open"
                : `None · ${CASE_POLICY_LABEL[caseAssignment?.policy ?? "OPTIONAL"]}`}
          </span>
        </div>
        {/* A due date is stated when one is SET. "Not available" for a date
            nobody was asked to set read as missing data. */}
        {workspace.reviewWorkflow.dueAt ? (
          <div className="evidence-detail-rail-field">
            <span className="evidence-detail-rail-field__label">Review due</span>
            <span className="evidence-detail-rail-field__value">
              {formatUserDateTime(workspace.reviewWorkflow.dueAt)}
            </span>
          </div>
        ) : null}
      </section>

      {/* Phase CAPTURE-CLOSURE Part C — compact verification-page shortcut.
          The rail carries the page's state (access · disclosure) and a
          shortcut link; the controls live in the Artifacts tab. */}
      <section
        className="evidence-detail-side-block"
        data-evidence-side="public-verification-shortcut"
      >
        <div className="evidence-detail-rail-heading-row">
          <h2 className="evidence-detail-rail-heading">Verification page</h2>
          <AppStatusText tone={verificationPage?.tone ?? "slate"}>
            {verificationPage?.label ?? "State unavailable"}
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
            {verificationPage?.detail ?? "The verification page's state is not available."}
          </p>
        )}
      </section>
    </aside>
  );
}
