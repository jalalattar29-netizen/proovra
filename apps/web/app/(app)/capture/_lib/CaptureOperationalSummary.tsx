"use client";

/**
 * PHASE 38.18 — Capture operational summary band.
 *
 * A compact INTEGRATED summary that combines the workflow-aware
 * readiness state and the highest-priority unsatisfied suggestion in
 * a single horizontal band. Positioned close to the finalize controls
 * so the operator sees "where am I + what's the next concrete action"
 * just before signing off — without scrolling back to the top of the
 * page to check the layered panels.
 *
 * This is NOT another standalone panel. It is the operational
 * integration of the existing readiness + suggestions layers into
 * one inline view at the point of operator action.
 *
 * Hard rules pinned by Phase 38.18 source-contract tests:
 *
 *   1. Informational + non-blocking. Renders nothing if no items
 *      are staged.
 *   2. Derives ALL state from the existing pure helpers
 *      (computeCaptureReadiness + computeCaptureSuggestions). No new
 *      data sources, no API calls, no AI inference.
 *   3. A11y: rendered as a `<section>` with role="status" so screen
 *      readers announce changes to the readiness signal as the
 *      operator stages items.
 *   4. Density-aware via the canonical CSS variables.
 *   5. Bounded vocabulary inherited from upstream catalogs — no
 *      legal / forensic overclaim labels.
 */

import { useMemo } from "react";

import type { WorkflowProfileCode } from "../../../../lib/platform-context";
import {
  computeCaptureReadiness,
  type CaptureReadinessSummary,
} from "./captureReadiness";
import { computeCaptureSuggestions } from "./captureSuggestions";
import type { SessionItem } from "./types";

const LEVEL_TONE: Record<
  CaptureReadinessSummary["level"],
  { bg: string; border: string; ink: string; pillBg: string }
> = {
  draft: {
    bg: "rgba(148, 163, 184, 0.06)",
    border: "rgba(148, 163, 184, 0.4)",
    ink: "#475569",
    pillBg: "rgba(148, 163, 184, 0.2)",
  },
  developing: {
    bg: "rgba(245, 158, 11, 0.06)",
    border: "rgba(245, 158, 11, 0.4)",
    ink: "#92400e",
    pillBg: "rgba(245, 158, 11, 0.2)",
  },
  ready: {
    bg: "rgba(34, 197, 94, 0.06)",
    border: "rgba(34, 197, 94, 0.4)",
    ink: "#166534",
    pillBg: "rgba(34, 197, 94, 0.2)",
  },
};

const LEVEL_LABEL: Record<CaptureReadinessSummary["level"], string> = {
  draft: "Draft",
  developing: "Developing",
  ready: "Ready",
};

export function CaptureOperationalSummary({
  workflow,
  items,
}: {
  workflow: WorkflowProfileCode;
  items: ReadonlyArray<SessionItem>;
}) {
  const readiness = useMemo(
    () => computeCaptureReadiness({ items, workflow }),
    [items, workflow],
  );
  const suggestions = useMemo(
    () =>
      computeCaptureSuggestions({
        workflow,
        readiness,
        maxSuggestions: 1,
      }),
    [workflow, readiness],
  );

  // Hide entirely if no items staged — the panel band would be noise.
  if (items.length === 0) return null;

  const tone = LEVEL_TONE[readiness.level];
  const topSuggestion = suggestions[0] ?? null;

  return (
    <section
      role="status"
      aria-label={`Capture operational summary — readiness ${LEVEL_LABEL[readiness.level]}`}
      data-capture-operational-summary
      data-capture-operational-summary-level={readiness.level}
      data-capture-operational-summary-workflow={workflow}
      data-capture-operational-summary-score={`${readiness.score.satisfied}/${readiness.score.total}`}
      data-capture-operational-summary-top-suggestion={
        topSuggestion?.id ?? "none"
      }
      style={{
        marginTop: 12,
        padding: "var(--proovra-density-panel-padding, 10px 14px)",
        borderRadius: 8,
        background: tone.bg,
        border: `1px solid ${tone.border}`,
        color: tone.ink,
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 12,
      }}
    >
      <span
        data-capture-operational-summary-readiness-pill
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding:
            "var(--proovra-density-chip-padding, 3px 10px)",
          borderRadius: 999,
          background: tone.pillBg,
          border: `1px solid ${tone.border}`,
          fontSize: "var(--proovra-density-panel-font-size, 12px)",
          fontWeight: 700,
          letterSpacing: 0.3,
          textTransform: "uppercase",
        }}
      >
        Readiness · {LEVEL_LABEL[readiness.level]} · {readiness.score.satisfied}/
        {readiness.score.total}
      </span>

      {topSuggestion ? (
        <span
          data-capture-operational-summary-suggestion
          style={{
            flex: 1,
            fontSize: "var(--proovra-density-panel-font-size, 12px)",
            lineHeight: 1.4,
          }}
        >
          <strong style={{ fontWeight: 700 }}>Next: </strong>
          {topSuggestion.title}
          <span style={{ opacity: 0.75 }}> — {topSuggestion.body}</span>
        </span>
      ) : (
        <span
          data-capture-operational-summary-complete
          style={{
            flex: 1,
            fontSize: "var(--proovra-density-panel-font-size, 12px)",
          }}
        >
          All workflow criteria satisfied for this intake. Finalize when ready.
        </span>
      )}

      <span
        data-capture-operational-summary-footnote
        style={{
          fontSize: 11,
          opacity: 0.8,
        }}
      >
        Informational only — finalization is governed by the upload flow.
      </span>
    </section>
  );
}
