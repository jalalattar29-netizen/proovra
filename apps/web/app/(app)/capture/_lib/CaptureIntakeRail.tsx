"use client";

/**
 * PHASE 38.16 — Capture intake progress rail.
 *
 * Horizontal 5-stage operational progression rendered at the top of
 * the capture surface. Reacts to actual session state via the pure
 * `computeIntakeStages` helper.
 *
 * Hard rules pinned by Phase 38.16 source-contract tests:
 *
 *   1. Informational + non-blocking. The rail NEVER prevents the
 *      operator from finalizing — it is a soft progression signal.
 *   2. Bounded vocabulary. Stage ids + labels come from the closed
 *      catalog in `captureIntakeStages.ts`.
 *   3. A11y: rendered as a `<nav>` landmark with `aria-label`; the
 *      active stage carries `aria-current="step"`.
 *   4. No legal / forensic claims. Operational tone only.
 */

import { useMemo } from "react";

import type { CaptureReadinessSummary } from "./captureReadiness";
import { computeIntakeStages } from "./captureIntakeStages";
import type { SessionItem } from "./types";


export function CaptureIntakeRail({
  items,
  collectionPlanSelected,
  readiness,
}: {
  items: ReadonlyArray<SessionItem>;
  collectionPlanSelected: boolean;
  readiness: CaptureReadinessSummary;
}) {
  const stages = useMemo(
    () =>
      computeIntakeStages({
        items,
        collectionPlanSelected,
        readiness,
      }),
    [items, collectionPlanSelected, readiness],
  );

  return (
    <nav
      aria-label="Capture intake progression"
      className="capture-intake-plan"
      data-capture-intake-rail
      data-capture-intake-rail-active-stage={
        stages.find((s) => s.status === "active")?.id ?? "finish"
      }
    >
      <span className="capture-intake-plan__label">Intake plan</span>

      {/* Presentation moved from inline styles to classes so the stylesheet
          can render the band as the numbered progression the workflow is,
          rather than as five chips. The state each stage is in is unchanged
          and still comes from `computeIntakeStages`; `STATUS_TONE` is gone
          because the same three states are now expressed by
          `data-capture-intake-stage-status`, which was already emitted here
          and which tests and styles can both read. */}
      <ol className="capture-intake-plan__stages">
        {stages.map((stage, idx) => {
          const isLast = idx === stages.length - 1;
          return (
            <li
              key={stage.id}
              className="capture-intake-plan__stage"
              data-capture-intake-stage={stage.id}
              data-capture-intake-stage-status={stage.status}
              aria-current={stage.status === "active" ? "step" : undefined}
            >
              <span className="capture-intake-plan__marker" aria-hidden="true">
                {idx + 1}
              </span>
              <span className="capture-intake-plan__text">{stage.label}</span>
              {!isLast ? (
                <span
                  aria-hidden="true"
                  className="capture-intake-plan__line"
                  data-capture-intake-line={
                    stage.status === "complete" ? "complete" : "pending"
                  }
                />
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
