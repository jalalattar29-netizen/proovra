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
  queueMetricVocabulary,
  type QueueMetricKey,
} from "../_lib/vocabulary";
import { fillOperationsCopy, useOpsCopy, useOpsNumber } from "../_lib/copy";

/**
 * WHAT ONE CARD CAN HONESTLY SAY (D4, 2026-10-12).
 *
 *   unknown  the summary could not be read (every count null,
 *            `incompleteReason: "SOURCE_FAILED"`). The card says
 *            "Unavailable" — never 0, which would be the confident claim that
 *            nothing is wrong about a workspace nobody could read.
 *   floor    the summary scan reached its bound (`complete: false` with
 *            counts). The card says "at least N".
 *   exact    everything else.
 *
 * `resolved` is its own COUNT, not part of the bounded unresolved scan, so it
 * is never shown as a floor; it is unknown only when it is itself null.
 */
type MetricDisplay =
  | { kind: "unknown" }
  | { kind: "floor"; value: number }
  | { kind: "exact"; value: number };

export function metricDisplay(
  summary: OperationsSummary,
  key: QueueMetricKey,
): MetricDisplay {
  const raw = summary[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) return { kind: "unknown" };
  const floor =
    key !== "resolved" &&
    summary.complete === false &&
    summary.incompleteReason === "SCAN_BOUND_REACHED";
  return floor ? { kind: "floor", value: raw } : { kind: "exact", value: raw };
}

/** True when the summary itself could not be read: every count is unknown. */
export function summaryUnknown(summary: OperationsSummary): boolean {
  return summary.open === null || summary.incompleteReason === "SOURCE_FAILED";
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
  const copy = useOpsCopy();
  const fmt = useOpsNumber();
  const vocabulary = queueMetricVocabulary(copy);
  const keys = QUEUE_METRIC_ORDER.filter(
    (k) => showCollaborative || !vocabulary[k].collaborative,
  );
  const unknown = summaryUnknown(summary);
  const floor =
    !unknown &&
    summary.complete === false &&
    summary.incompleteReason === "SCAN_BOUND_REACHED";

  const valueText = (d: MetricDisplay): string =>
    d.kind === "unknown"
      ? "—"
      : d.kind === "floor"
        ? fillOperationsCopy(copy.metricAtLeast, { n: fmt(d.value) })
        : fmt(d.value);

  return (
    <section
      className="opsw-summary"
      aria-labelledby={`${noteId}-h`}
      data-ops-summary-state={unknown ? "unknown" : floor ? "floor" : "exact"}
    >
      <h2 className="app-visually-hidden" id={`${noteId}-h`}>
        {copy.metricsHeading}
      </h2>
      {unknown ? (
        <p className="opsw-summary__note" role="status" data-ops-summary-unavailable>
          {copy.metricsUnavailableNote}
        </p>
      ) : floor ? (
        <p className="opsw-summary__note" role="status" data-ops-summary-floor>
          {copy.metricsFloorNote}
        </p>
      ) : null}
      <ul className="opsw-summary__grid" data-ops-summary aria-describedby={noteId}>
        {keys.map((key) => {
          const entry = vocabulary[key];
          const isCurrent = selected === key;
          const descId = `${noteId}-${key}`;
          const display = metricDisplay(summary, key);
          const text = valueText(display);
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
                data-ops-metric-value={text}
                data-ops-metric-kind={display.kind}
                data-ops-metric-active={isCurrent ? "true" : "false"}
                aria-pressed={isCurrent}
                aria-describedby={descId}
                onClick={() => onSelect(key)}
              >
                <span className="app-metric-card__value opsw-metric__value">
                  {text}
                </span>
                <span className="app-metric-card__label opsw-metric__label">
                  {entry.label}
                </span>
                <span
                  className="app-metric-card__meta opsw-metric__meta"
                  id={descId}
                >
                  {display.kind === "unknown" ? `${copy.metricUnavailable} · ${entry.note}` : entry.note}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="opsw-summary__note" id={noteId} data-ops-summary-overlap-note>
        {copy.metricsOverlapNote}
      </p>
    </section>
  );
}

export default QueueSummary;
