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
import {
  computeIntakeStages,
  type IntakeStage,
} from "./captureIntakeStages";
import type { SessionItem } from "./types";

const STATUS_TONE: Record<
  IntakeStage["status"],
  { bg: string; ink: string; border: string; dot: string }
> = {
  complete: {
    bg: "rgba(34, 197, 94, 0.10)",
    ink: "#166534",
    border: "rgba(34, 197, 94, 0.4)",
    dot: "#16a34a",
  },
  active: {
    bg: "rgba(30, 64, 175, 0.10)",
    ink: "#1e40af",
    border: "rgba(30, 64, 175, 0.4)",
    dot: "#2563eb",
  },
  pending: {
    bg: "rgba(148, 163, 184, 0.06)",
    ink: "#475569",
    border: "rgba(148, 163, 184, 0.3)",
    dot: "#94a3b8",
  },
};

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
      data-capture-intake-rail
      data-capture-intake-rail-active-stage={
        stages.find((s) => s.status === "active")?.id ?? "finish"
      }
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 8,
        padding: "var(--proovra-density-padding, 10px 12px)",
        margin: "0 0 12px 0",
        borderRadius: 8,
        background: "rgba(148, 163, 184, 0.04)",
        border: "1px solid rgba(148, 163, 184, 0.18)",
      }}
    >
      <span
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 0.4,
          textTransform: "uppercase",
          color: "#475569",
          marginRight: 4,
        }}
      >
        Intake plan
      </span>
      <ol
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 4,
          margin: 0,
          padding: 0,
          listStyle: "none",
        }}
      >
        {stages.map((stage, idx) => {
          const tone = STATUS_TONE[stage.status];
          const isLast = idx === stages.length - 1;
          return (
            <li
              key={stage.id}
              data-capture-intake-stage={stage.id}
              data-capture-intake-stage-status={stage.status}
              aria-current={stage.status === "active" ? "step" : undefined}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding:
                    "var(--proovra-density-chip-padding, 3px 10px)",
                  borderRadius: 999,
                  background: tone.bg,
                  border: `1px solid ${tone.border}`,
                  color: tone.ink,
                  fontSize: "var(--proovra-density-font-size, 12px)",
                  fontWeight: stage.status === "active" ? 700 : 600,
                  whiteSpace: "nowrap",
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    display: "inline-block",
                    width: 7,
                    height: 7,
                    borderRadius: 7,
                    background: tone.dot,
                  }}
                />
                <span>
                  {idx + 1}. {stage.label}
                </span>
              </span>
              {!isLast ? (
                <span
                  aria-hidden="true"
                  style={{ color: "#cbd5e1", fontSize: 11 }}
                >
                  →
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
