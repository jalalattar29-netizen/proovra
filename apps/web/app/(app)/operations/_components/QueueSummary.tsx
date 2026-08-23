"use client";

/**
 * Operations workbench — the compact queue summary.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS NOT
 * ---------------------------------------------------------------------------
 * It is not a dashboard. Home owns the workspace cockpit; this is a triage
 * strip that answers one question — "which slice of the queue am I looking
 * at?" — and every card is a FILTER that changes the table below it. It is
 * deliberately one row of small cards above the work rather than a grid of
 * panels in front of it.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE NUMBERS COME FROM
 * ---------------------------------------------------------------------------
 * `GET /v1/ops/summary` — the SAME canonical authority Home reads, computed
 * from `OperationalIncident` in one scan. Not from the notification feed, not
 * from counting the rows currently in the table (which is one page of a keyset
 * collection and would disagree with itself on page two), and not from a
 * second query per card.
 *
 * ---------------------------------------------------------------------------
 * SINGLE-OPERATOR COMPOSITION
 * ---------------------------------------------------------------------------
 * "Assigned to me" and "Unassigned" are dropped where ownership is not a real
 * axis. That is not a Personal-Pro branch, and it is not the caller's own
 * assign capability either: it reads `showCollaborative`, which the
 * orchestrator derives from the server-projected count of eligible operators.
 *
 * A sole operator gets four cards and no invitation to partition work with
 * themselves. A read-only VIEWER in a shared workspace keeps both cards,
 * because "who is on this?" is precisely the question they are there to
 * answer and they will never hold OPERATIONS_ASSIGN.
 */

import * as React from "react";

import type { OperationsSummary } from "../_lib/types";
import {
  QUEUE_METRIC_ORDER,
  QUEUE_METRIC_OVERLAP_NOTE,
  QUEUE_METRIC_VOCABULARY,
  type QueueMetricKey,
} from "../_lib/vocabulary";

/**
 * A count, or an honest mark that it is missing.
 *
 * A metric card whose value is `undefined` renders its label and its note
 * above empty space — a caption for a number that is not there, which reads as
 * a rendering fault rather than as missing data. Falling back to `0` would be
 * worse: it is a confident FALSE statement about a field the server did not
 * send, on a surface whose entire job is not making those.
 */
function metricValue(raw: number | undefined): string {
  return typeof raw === "number" && Number.isFinite(raw) ? String(raw) : "—";
}

export function QueueSummary({
  summary,
  selected,
  onSelect,
  showCollaborative,
}: {
  summary: OperationsSummary;
  /** The metric currently driving the queue, or null for the default view. */
  selected: QueueMetricKey | null;
  onSelect: (key: QueueMetricKey) => void;
  showCollaborative: boolean;
}) {
  const noteId = React.useId();
  const keys = QUEUE_METRIC_ORDER.filter(
    (k) => showCollaborative || !QUEUE_METRIC_VOCABULARY[k].collaborative,
  );

  return (
    <section className="opsw-summary" aria-labelledby={`${noteId}-h`}>
      <h2 className="app-visually-hidden" id={`${noteId}-h`}>
        Queue summary
      </h2>
      <ul className="opsw-summary__grid" data-ops-summary aria-describedby={noteId}>
        {keys.map((key) => {
          const entry = QUEUE_METRIC_VOCABULARY[key];
          const isCurrent = selected === key;
          const descId = `${noteId}-${key}`;
          return (
            <li key={key}>
              <button
                type="button"
                // The CANONICAL metric card. This route contributes only the
                // tone hook, so Operations, Notifications and Intake Links
                // cannot drift into three metric-card designs.
                className="app-metric-card opsw-metric"
                data-opsw-tone={entry.tone}
                data-ops-metric={key}
                data-ops-metric-value={metricValue(summary[key])}
                data-ops-metric-active={isCurrent ? "true" : "false"}
                aria-pressed={isCurrent}
                aria-describedby={descId}
                onClick={() => onSelect(key)}
              >
                <span className="app-metric-card__value opsw-metric__value">
                  {metricValue(summary[key])}
                </span>
                <span className="app-metric-card__label opsw-metric__label">
                  {entry.label}
                </span>
                <span
                  className="app-metric-card__meta opsw-metric__meta"
                  id={descId}
                >
                  {entry.note}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="opsw-summary__note" id={noteId} data-ops-summary-overlap-note>
        {QUEUE_METRIC_OVERLAP_NOTE}
      </p>
    </section>
  );
}

export default QueueSummary;
