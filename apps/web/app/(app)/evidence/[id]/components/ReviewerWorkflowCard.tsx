"use client";

import {
  reviewAssigneeLabel,
  reviewPriorityLabel,
  summarizeReviewWorkflowEvents,
} from "@proovra/shared";

import {
  formatReviewerStatusLabel,
  REVIEWER_STATUS_DISCLAIMER,
} from "../../lib/reviewer-status";

type WorkflowActor = {
  id: string;
  email: string | null;
  displayName: string | null;
};

type WorkflowSummary = {
  available: boolean;
  status: string | null;
  priority: string | null;
  assignedTo: WorkflowActor | null;
  assignedBy?: WorkflowActor | null;
  dueAt: string | null;
  lastReviewedAt: string | null;
  note: string | null;
  viewerUserId?: string | null;
};

type WorkflowEvent = {
  id: string;
  eventType: string;
  note: string | null;
  previousValue: unknown;
  nextValue: unknown;
  createdAt: string;
  actor: WorkflowActor | null;
};

export function ReviewerWorkflowCard({
  workflow,
  events,
  eventsLoading,
  actionBusy,
  onRefreshEvents,
  onOpenEditor,
  formatDateTime,
}: {
  workflow: WorkflowSummary;
  events: WorkflowEvent[];
  eventsLoading: boolean;
  actionBusy: boolean;
  onRefreshEvents: () => void;
  onOpenEditor: () => void;
  formatDateTime: (value: string | null | undefined) => string;
}) {
  const viewerUserId = workflow.viewerUserId ?? null;
  // The stored events, read for a person: creation's automatic companions
  // folded into one entry, enum names in words, actors by name.
  const history = summarizeReviewWorkflowEvents(events, viewerUserId);
  return (
    <section id="workflow" className="evidence-detail-card">
      <div className="evidence-detail-card-header">
        <div>
          <p className="evidence-detail-kicker">Reviewer Workflow</p>
          <h2>Assignment and review state</h2>
        </div>
        <div className="evidence-detail-inline-actions">
          <button
            type="button"
            className="app-secondary-action"
            onClick={onRefreshEvents}
          >
            Refresh history
          </button>
          <button
            type="button"
            className="app-secondary-action app-secondary-action--filled"
            onClick={onOpenEditor}
            disabled={actionBusy}
          >
            {workflow.available ? "Update workflow" : "Create workflow"}
          </button>
        </div>
      </div>

      <div className="evidence-detail-data-grid">
        <div
          className="evidence-detail-data-cell"
          data-evidence-reviewer-status-cell
          data-evidence-reviewer-status={workflow.status ?? "NOT_STARTED"}
        >
          <span>Status</span>
          <strong>{formatReviewerStatusLabel(workflow.status)}</strong>
        </div>
        <div className="evidence-detail-data-cell">
          <span>Priority</span>
          <strong>{reviewPriorityLabel(workflow.priority)}</strong>
        </div>
        <div className="evidence-detail-data-cell" data-evidence-reviewer-assignee>
          <span>Reviewer</span>
          <strong>{reviewAssigneeLabel(workflow.assignedTo, viewerUserId)}</strong>
        </div>
        {/* OPTIONAL FACTS ARE STATED ONLY WHEN THEY EXIST (2026-10-23): a due
            date nobody set, a review nobody has done yet and an assigner for an
            unassigned review used to read "Not available" three times. */}
        {workflow.dueAt ? (
          <div className="evidence-detail-data-cell">
            <span>Due</span>
            <strong>{formatDateTime(workflow.dueAt)}</strong>
          </div>
        ) : null}
        {workflow.lastReviewedAt ? (
          <div className="evidence-detail-data-cell">
            <span>Last reviewed</span>
            <strong>{formatDateTime(workflow.lastReviewedAt)}</strong>
          </div>
        ) : null}
        {workflow.assignedTo && workflow.assignedBy ? (
          <div className="evidence-detail-data-cell">
            <span>Assigned by</span>
            <strong>{reviewAssigneeLabel(workflow.assignedBy, viewerUserId)}</strong>
          </div>
        ) : null}
      </div>

      <p className="evidence-detail-muted">
        {workflow.note || "Workflow state is recorded separately from forensic custody and does not alter the preserved evidence record."}
      </p>
      <p
        className="evd-muted evd-muted--small evd-block--tight"
        data-evidence-reviewer-disclaimer="true"
      >
        {REVIEWER_STATUS_DISCLAIMER}
      </p>

      <div className="evidence-detail-subsection">
        <div className="evidence-detail-subsection__header">
          <strong>Workflow event history</strong>
          <span>{history.length === 1 ? "1 entry" : `${history.length} entries`}</span>
        </div>
        <p className="evidence-detail-muted">
          Review history is separate from the evidence&apos;s custody record and does not change it.
        </p>
        {eventsLoading ? (
          <p className="evidence-detail-muted">Loading workflow history…</p>
        ) : history.length === 0 ? (
          <p className="evidence-detail-muted">No workflow history recorded yet.</p>
        ) : (
          <div className="evidence-detail-timeline evidence-detail-timeline--compact">
            {history.map((entry) => (
              <article
                key={entry.eventIds.join(":")}
                className="evidence-detail-timeline-item"
                data-evidence-workflow-entry={entry.origin}
                data-evidence-workflow-event-count={entry.eventIds.length}
              >
                <div className="evidence-detail-timeline-dot" aria-hidden="true" />
                <div>
                  <div className="evidence-detail-item-row">
                    <strong>{entry.label}</strong>
                    <span>{formatDateTime(entry.createdAt)}</span>
                  </div>
                  <p>
                    {entry.origin === "SYSTEM" ? "Automatic · PROOVRA" : entry.actorLabel}
                    {entry.note ? ` — ${entry.note}` : ""}
                  </p>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
