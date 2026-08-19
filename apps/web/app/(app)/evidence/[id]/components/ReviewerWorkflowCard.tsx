"use client";

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

function formatActor(actor: WorkflowActor | null) {
  return actor?.displayName || actor?.email || "Unassigned";
}

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
          <strong>{workflow.priority ? workflow.priority.replace(/_/g, " ") : "Not configured"}</strong>
        </div>
        <div className="evidence-detail-data-cell">
          <span>Assigned reviewer</span>
          <strong>{formatActor(workflow.assignedTo)}</strong>
        </div>
        <div className="evidence-detail-data-cell">
          <span>Due date</span>
          <strong>{formatDateTime(workflow.dueAt)}</strong>
        </div>
        <div className="evidence-detail-data-cell">
          <span>Last reviewed</span>
          <strong>{formatDateTime(workflow.lastReviewedAt)}</strong>
        </div>
        <div className="evidence-detail-data-cell">
          <span>Assigned by</span>
          <strong>{formatActor(workflow.assignedBy ?? null)}</strong>
        </div>
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
          <span>{events.length} recorded events</span>
        </div>
        {eventsLoading ? (
          <p className="evidence-detail-muted">Loading workflow history…</p>
        ) : events.length === 0 ? (
          <p className="evidence-detail-muted">No workflow history recorded yet.</p>
        ) : (
          <div className="evidence-detail-timeline evidence-detail-timeline--compact">
            {events.map((event) => (
              <article key={event.id} className="evidence-detail-timeline-item">
                <div className="evidence-detail-timeline-dot" aria-hidden="true" />
                <div>
                  <div className="evidence-detail-item-row">
                    <strong>{event.eventType.replace(/_/g, " ")}</strong>
                    <span>{formatDateTime(event.createdAt)}</span>
                  </div>
                  <p>
                    {event.actor?.displayName || event.actor?.email || "Workspace user"}
                    {event.note ? ` — ${event.note}` : ""}
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
