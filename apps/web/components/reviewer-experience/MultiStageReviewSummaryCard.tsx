"use client";

/**
 * Phase B.3 — Multi-stage review summary card.
 *
 * Reads `GET /v1/reviewer-ops/decisions/summary?teamId=<uuid>` and
 * renders 4 state count tiles with a bounded top-3 preview per state.
 *
 * Phase 12 Point 4 — extracted from the unmounted
 * `ReviewerCommandConsole` onto the canonical `/review` console so the
 * capability keeps a real product surface. Behaviour is unchanged:
 * same endpoint, same states, same `data-multi-stage-*` markers.
 *
 * Hooks are declared at the top of the function and are never called
 * conditionally.
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../lib/api";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";

type ReviewSummaryEnvelope = {
  teamId: string;
  generatedAt: string;
  summary: {
    windowDays: number;
    workflowsInWindow: number;
    byState: {
      first_required: number;
      second_required: number;
      conflict_detected: number;
      resolved: number;
    };
  };
  preview: {
    first_required: Array<{ workflowId: string; priority: string }>;
    second_required: Array<{ workflowId: string; priority: string }>;
    conflict_detected: Array<{ workflowId: string; priority: string }>;
    resolved: Array<{ workflowId: string; priority: string }>;
  };
};

export function MultiStageReviewSummaryCard({ teamId }: { teamId: string }) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; data: ReviewSummaryEnvelope }
    | { kind: "error"; status: number; message: string }
  >({ kind: "loading" });

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const data = (await apiFetch(
        `/v1/reviewer-ops/decisions/summary?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      )) as ReviewSummaryEnvelope;
      setState({ kind: "ready", data });
    } catch (err: unknown) {
      const status =
        typeof (err as { statusCode?: number }).statusCode === "number"
          ? (err as { statusCode: number }).statusCode
          : 0;
      const message = toSafeUserError(err, {
        message: "Could not load review summary.",
      }).message;
      setState({ kind: "error", status, message });
    }
  }, [teamId]);

  useEffect(() => {
    void load();
  }, [load]);

  const stateChips: Array<{
    key: keyof ReviewSummaryEnvelope["summary"]["byState"];
    label: string;
    tone: "info" | "warning" | "high" | "success";
  }> = [
    { key: "first_required", label: "Awaiting first review", tone: "info" },
    { key: "second_required", label: "Awaiting second review", tone: "warning" },
    {
      key: "conflict_detected",
      label: "Conflict — adjudication required",
      tone: "high",
    },
    { key: "resolved", label: "Resolved (recent)", tone: "success" },
  ];

  // TEAM-UI-SPEC §1 — an app-panel with canonical metric cards; the tone is
  // the shared metric tone (never an inline palette), Retry is secondary.
  const METRIC_TONE: Record<(typeof stateChips)[number]["tone"], string> = {
    info: "info",
    warning: "warning",
    high: "danger",
    success: "success",
  };
  return (
    <section
      className="app-panel"
      data-reviewer-section="multi-stage-review-summary"
      data-multi-stage-state={state.kind}
      aria-labelledby="multi-stage-summary-title"
    >
      <div className="app-panel__head">
        <h2 className="app-panel__title" id="multi-stage-summary-title">
          Multi-stage review summary
        </h2>
      </div>
      <div className="app-panel__body review-panel-stack">
        <p className="app-field-help">
          Workflow counts by derived multi-stage review state across the last{" "}
          {state.kind === "ready" ? state.data.summary.windowDays : 90} days.
          Items in the “Conflict” bucket need a workspace Owner or Admin to
          adjudicate them.
        </p>

        {state.kind === "loading" ? (
          <p className="app-field-help" data-multi-stage-state-loading>
            Loading multi-stage review state…
          </p>
        ) : null}

        {state.kind === "error" ? (
          <div className="app-alert app-alert--warn" role="alert" data-multi-stage-state-error>
            Multi-stage review summary unavailable.{" "}
            <button
              type="button"
              className="app-secondary-action"
              onClick={() => void load()}
              data-multi-stage-retry
            >
              Retry
            </button>
          </div>
        ) : null}

        {state.kind === "ready" ? (
          <div
            className="review-metric-grid"
            data-multi-stage-summary-tiles
            data-multi-stage-workflows-in-window={state.data.summary.workflowsInWindow}
          >
            {stateChips.map((chip) => {
              const count = state.data.summary.byState[chip.key];
              const preview = state.data.preview[chip.key];
              return (
                <div
                  key={chip.key}
                  className="app-metric-card"
                  data-app-metric-tone={METRIC_TONE[chip.tone]}
                  data-multi-stage-summary-tile={chip.key}
                  data-multi-stage-summary-tile-count={count}
                  data-multi-stage-summary-tile-tone={chip.tone}
                >
                  <div className="app-metric-card__value">{count}</div>
                  <div className="app-metric-card__label">{chip.label}</div>
                  {preview.length > 0 ? (
                    <ul className="app-metric-card__meta review-tools" data-multi-stage-summary-preview={chip.key}>
                      {preview.slice(0, 3).map((p) => (
                        <li key={p.workflowId}>
                          <Link
                            href={`/reviewer-ops/${encodeURIComponent(p.workflowId)}`}
                            data-multi-stage-preview-workflow={p.workflowId}
                          >
                            {p.workflowId.slice(0, 8)}… · {p.priority}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </section>
  );
}
