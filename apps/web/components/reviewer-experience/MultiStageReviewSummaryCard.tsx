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

  return (
    <section
      className="cc-section"
      data-reviewer-section="multi-stage-review-summary"
      data-multi-stage-state={state.kind}
    >
      <header className="cc-section-header">
        <h2 className="cc-section-title">Multi-stage review summary</h2>
      </header>
      <p
        className="cc-section-note"
        style={{ fontSize: 12, opacity: 0.85, marginTop: 0, marginBottom: 8 }}
      >
        Workflow counts by derived multi-stage review state across the last{" "}
        {state.kind === "ready" ? state.data.summary.windowDays : 90} days.
        Items in the “Conflict” bucket are gated to team OWNER/ADMIN for
        adjudication (Phase B.2).
      </p>

      {state.kind === "loading" ? (
        <div
          data-multi-stage-state-loading
          style={{ fontSize: 13, opacity: 0.7 }}
        >
          Loading multi-stage review state…
        </div>
      ) : null}

      {state.kind === "error" ? (
        <div
          role="alert"
          data-multi-stage-state-error
          style={{
            padding: "0.45rem 0.6rem",
            border: "1px dashed rgba(127,127,127,0.4)",
            borderRadius: 4,
            fontSize: 12,
          }}
        >
          Multi-stage review summary unavailable
          {state.status ? ` (HTTP ${state.status})` : ""}.
          <button
            type="button"
            onClick={() => void load()}
            data-multi-stage-retry
            style={{
              marginLeft: 6,
              fontSize: 12,
              padding: "0.15rem 0.45rem",
              border: "1px solid currentColor",
              borderRadius: 4,
              background: "transparent",
              cursor: "pointer",
            }}
          >
            Retry
          </button>
        </div>
      ) : null}

      {state.kind === "ready" ? (
        <div
          data-multi-stage-summary-tiles
          data-multi-stage-workflows-in-window={
            state.data.summary.workflowsInWindow
          }
          style={{
            display: "grid",
            gap: 8,
            gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          }}
        >
          {stateChips.map((chip) => {
            const count = state.data.summary.byState[chip.key];
            const preview = state.data.preview[chip.key];
            const toneStyle =
              chip.tone === "high"
                ? {
                    border: "1px solid rgba(239,68,68,0.55)",
                    background: "rgba(239,68,68,0.08)",
                  }
                : chip.tone === "warning"
                  ? {
                      border: "1px solid rgba(245,158,11,0.55)",
                      background: "rgba(245,158,11,0.08)",
                    }
                  : chip.tone === "success"
                    ? {
                        border: "1px solid rgba(34,197,94,0.45)",
                        background: "rgba(34,197,94,0.06)",
                      }
                    : {
                        border: "1px solid rgba(99,102,241,0.45)",
                        background: "rgba(99,102,241,0.06)",
                      };
            return (
              <div
                key={chip.key}
                data-multi-stage-summary-tile={chip.key}
                data-multi-stage-summary-tile-count={count}
                data-multi-stage-summary-tile-tone={chip.tone}
                style={{
                  padding: "0.55rem 0.7rem",
                  borderRadius: 6,
                  ...toneStyle,
                }}
              >
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: 0.4,
                    textTransform: "uppercase",
                    opacity: 0.85,
                  }}
                >
                  {chip.label}
                </div>
                <div style={{ fontSize: 22, fontWeight: 700, marginTop: 2 }}>
                  {count}
                </div>
                {preview.length > 0 ? (
                  <ul
                    data-multi-stage-summary-preview={chip.key}
                    style={{
                      listStyle: "none",
                      padding: 0,
                      margin: "6px 0 0",
                      fontSize: 11,
                      display: "grid",
                      gap: 2,
                    }}
                  >
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
    </section>
  );
}
