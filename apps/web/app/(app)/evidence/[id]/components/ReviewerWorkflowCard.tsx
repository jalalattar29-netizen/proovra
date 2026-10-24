"use client";

import { useState } from "react";

import {
  groupReviewHistoryByRound,
  presentReviewOutcome,
  reviewAssigneeLabel,
  reviewPriorityLabel,
  summarizeReviewWorkflowEvents,
  type ReviewDecision,
  type ReviewHistoryRound,
  type ReviewWorkflowHistoryEntry,
} from "@proovra/shared";

import { formatUserDateTimeCompact } from "../../../../../lib/date";

type WorkflowActor = {
  id: string;
  email: string | null;
  displayName: string | null;
};

type WorkflowSummary = {
  available: boolean;
  status: string | null;
  /** The current round's decision, from the server (2026-10-24). */
  decision?: ReviewDecision | null;
  /** The current decision round, from the server: anchors the bounded history window. */
  decisionRound?: number | null;
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

/** Entries shown per round before "Show all". */
const ROUND_PREVIEW = 5;

/**
 * THE REVIEWER WORKFLOW CARD (2026-10-24) — compact, and never mixing the
 * workflow state with the decision.
 *
 * It used to be five tall summary tiles under a generic "Status" that read
 * "Not accepted" for a closed review, the boundary sentence three times, and
 * every stored event expanded with its full time zone. Now: a state badge and
 * one boundary line; Workflow · Decision · Reviewer · Priority · Last activity
 * in one compact list; and the history grouped by decision round — newest
 * round open, older rounds collapsed, five entries a round until "Show all".
 * The stored events are presented, never rewritten.
 */
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
  /** The exact viewer-timezone timestamp, for each row's accessible detail. */
  formatDateTime: (value: string | null | undefined) => string;
}) {
  const viewerUserId = workflow.viewerUserId ?? null;
  const outcome = presentReviewOutcome({ dbStatus: workflow.status, decision: workflow.decision ?? null });
  const history = summarizeReviewWorkflowEvents(events, viewerUserId, { currentRound: workflow.decisionRound ?? null });
  const rounds = groupReviewHistoryByRound(history);
  const lastActivity = history[0]?.createdAt ?? null;
  return (
    <section id="workflow" className="evidence-detail-card" data-evidence-review-card>
      <div className="evidence-detail-card-header">
        <div>
          <p className="evidence-detail-kicker">Reviewer workflow</p>
          <h2 className="evidence-detail-review-card__title">
            <span className="app-status-badge" data-tone="slate" data-evidence-review-state={outcome.workflowState}>
              {outcome.workflowStateLabel}
            </span>
          </h2>
          <p className="evidence-detail-muted" data-evidence-reviewer-disclaimer="true">
            Internal review only. It never changes the evidence, its integrity, its verification, reports or packages.
          </p>
        </div>
        <div className="evidence-detail-inline-actions">
          <button type="button" className="app-secondary-action" onClick={onRefreshEvents}>
            Refresh
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

      <dl className="evidence-detail-review-facts" data-evidence-review-facts>
        <div className="evidence-detail-rail-field" data-evidence-review-fact="workflow">
          <dt className="evidence-detail-rail-field__label">Workflow</dt>
          <dd className="evidence-detail-rail-field__value">{outcome.workflowStateLabel}</dd>
        </div>
        <div className="evidence-detail-rail-field" data-evidence-review-fact="decision" data-evidence-review-decision={outcome.decision}>
          <dt className="evidence-detail-rail-field__label">Decision</dt>
          <dd className="evidence-detail-rail-field__value">{outcome.decisionLabel}</dd>
        </div>
        <div className="evidence-detail-rail-field" data-evidence-reviewer-assignee>
          <dt className="evidence-detail-rail-field__label">Reviewer</dt>
          <dd className="evidence-detail-rail-field__value">{reviewAssigneeLabel(workflow.assignedTo, viewerUserId)}</dd>
        </div>
        <div className="evidence-detail-rail-field">
          <dt className="evidence-detail-rail-field__label">Priority</dt>
          <dd className="evidence-detail-rail-field__value">{reviewPriorityLabel(workflow.priority)}</dd>
        </div>
        {/* Optional facts are stated only when they exist. */}
        {workflow.dueAt ? (
          <div className="evidence-detail-rail-field">
            <dt className="evidence-detail-rail-field__label">Due</dt>
            <dd className="evidence-detail-rail-field__value">
              <Stamp iso={workflow.dueAt} exact={formatDateTime} />
            </dd>
          </div>
        ) : null}
        {lastActivity ? (
          <div className="evidence-detail-rail-field">
            <dt className="evidence-detail-rail-field__label">Last activity</dt>
            <dd className="evidence-detail-rail-field__value">
              <Stamp iso={lastActivity} exact={formatDateTime} />
            </dd>
          </div>
        ) : null}
      </dl>

      {workflow.note ? <p className="evidence-detail-muted">{workflow.note}</p> : null}

      <div className="evidence-detail-subsection">
        <div className="evidence-detail-subsection__header">
          <strong>History</strong>
          <span data-evidence-review-history-count>
            {history.length === 1 ? "1 entry" : `${history.length} entries`}
            {rounds.length > 1 ? ` · ${rounds.length} rounds` : ""}
          </span>
        </div>
        {eventsLoading ? (
          <p className="evidence-detail-muted">Loading history…</p>
        ) : history.length === 0 ? (
          <p className="evidence-detail-muted">No history recorded yet.</p>
        ) : (
          rounds.map((round) =>
            round.current ? (
              <RoundEntries key={round.round} round={round} showHeading={rounds.length > 1} exact={formatDateTime} />
            ) : (
              <details key={round.round} className="evidence-detail-raw-disclosure" data-evidence-review-round-disclosure={round.round}>
                <summary className="evidence-detail-raw-summary">
                  {round.label} · {round.entries.length === 1 ? "1 entry" : `${round.entries.length} entries`}
                </summary>
                <RoundEntries round={round} showHeading={false} exact={formatDateTime} />
              </details>
            ),
          )
        )}
      </div>
    </section>
  );
}

/** A concise row date; the exact instant and zone in the accessible detail. */
function Stamp({ iso, exact }: { iso: string; exact: (value: string | null | undefined) => string }) {
  const full = exact(iso);
  return (
    <time dateTime={iso} title={full} aria-label={full}>
      {formatUserDateTimeCompact(iso)}
    </time>
  );
}

function RoundEntries({
  round,
  showHeading,
  exact,
}: {
  round: ReviewHistoryRound;
  showHeading: boolean;
  exact: (value: string | null | undefined) => string;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? round.entries : round.entries.slice(0, ROUND_PREVIEW);
  return (
    <div data-evidence-review-round={round.round} data-evidence-review-round-current={round.current ? "true" : "false"}>
      {showHeading ? <p className="evidence-detail-muted">{round.label} (current)</p> : null}
      <ol className="evidence-detail-timeline evidence-detail-timeline--compact">
        {shown.map((entry) => (
          <HistoryEntry key={entry.eventIds.join(":")} entry={entry} exact={exact} />
        ))}
      </ol>
      {round.entries.length > ROUND_PREVIEW ? (
        <button
          type="button"
          className="app-ghost-action"
          aria-expanded={all}
          onClick={() => setAll((v) => !v)}
          data-evidence-review-show-all
        >
          {all ? "Show less" : `Show all ${round.entries.length} entries`}
        </button>
      ) : null}
    </div>
  );
}

function HistoryEntry({ entry, exact }: { entry: ReviewWorkflowHistoryEntry; exact: (value: string | null | undefined) => string }) {
  return (
    <li
      className="evidence-detail-timeline-item"
      data-evidence-workflow-entry={entry.origin}
      data-evidence-workflow-code={entry.code}
      data-evidence-workflow-event-count={entry.eventIds.length}
    >
      <div className="evidence-detail-timeline-dot" aria-hidden="true" />
      <div>
        <div className="evidence-detail-item-row">
          <strong>{entry.label}</strong>
          <Stamp iso={entry.createdAt} exact={exact} />
        </div>
        <p>
          {entry.origin === "SYSTEM" ? "Automatic · PROOVRA" : entry.actorLabel}
          {entry.note ? ` — ${entry.note}` : ""}
        </p>
      </div>
    </li>
  );
}
