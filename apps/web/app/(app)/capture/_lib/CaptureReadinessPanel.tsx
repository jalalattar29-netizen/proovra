"use client";

/**
 * PHASE 38.14 — Capture readiness panel.
 *
 * Renders the bounded operational readiness summary computed by
 * `computeCaptureReadiness`. Workflow-aware criteria + completeness
 * signal. NEVER blocks; only informs. Operator-actionable copy only.
 *
 * Hard rules pinned by Phase 38.14 source-contract tests:
 *
 *   1. The panel is informational + non-blocking. It NEVER prevents
 *      the operator from finalizing.
 *   2. No legal / forensic overclaim labels. The bounded vocabulary
 *      is operational completeness only ("draft" / "developing" /
 *      "ready") — not an admissibility or authenticity assertion.
 *   3. Dismissible per workflow code (localStorage-persisted).
 *   4. A11y: role="region" + aria-label; the dismiss button is
 *      labelled.
 */

import { useEffect, useMemo, useState } from "react";

import type { WorkflowProfileCode } from "../../../../lib/platform-context";
import {
  computeCaptureReadiness,
  type CaptureReadinessSummary,
} from "./captureReadiness";
import type { SessionItem } from "./types";

const DISMISS_KEY_PREFIX = "capture-readiness-dismissed:";

const LEVEL_LABEL: Record<CaptureReadinessSummary["level"], string> = {
  draft: "Draft intake",
  developing: "Developing intake",
  ready: "Operationally ready",
};

const LEVEL_TONE: Record<
  CaptureReadinessSummary["level"],
  { bg: string; border: string; ink: string }
> = {
  draft: {
    bg: "rgba(148, 163, 184, 0.08)",
    border: "rgba(148, 163, 184, 0.4)",
    ink: "#475569",
  },
  developing: {
    bg: "rgba(245, 158, 11, 0.10)",
    border: "rgba(245, 158, 11, 0.4)",
    ink: "#92400e",
  },
  ready: {
    bg: "rgba(34, 197, 94, 0.10)",
    border: "rgba(34, 197, 94, 0.4)",
    ink: "#166534",
  },
};

export function CaptureReadinessPanel({
  items,
  workflow,
}: {
  items: ReadonlyArray<SessionItem>;
  workflow: WorkflowProfileCode;
}) {
  const summary = useMemo(
    () => computeCaptureReadiness({ items, workflow }),
    [items, workflow],
  );

  const dismissKey = `${DISMISS_KEY_PREFIX}${workflow}`;
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const stored = window.localStorage.getItem(dismissKey);
      if (stored === "true") setDismissed(true);
    } catch {
      /* ignore */
    }
  }, [dismissKey]);

  // Hide the panel entirely when there are zero items — the
  // operator hasn't started the intake yet, so a readiness panel
  // would be noise.
  if (items.length === 0) return null;
  if (dismissed) return null;

  const tone = LEVEL_TONE[summary.level];

  function dismiss() {
    setDismissed(true);
    try {
      window.localStorage.setItem(dismissKey, "true");
    } catch {
      /* ignore */
    }
  }

  return (
    <section
      role="region"
      aria-label={`Capture readiness: ${LEVEL_LABEL[summary.level]}`}
      data-capture-readiness
      data-capture-readiness-level={summary.level}
      data-capture-readiness-workflow={workflow}
      data-capture-readiness-score={`${summary.score.satisfied}/${summary.score.total}`}
      style={{
        marginTop: 12,
        padding: "12px 16px",
        borderRadius: 8,
        background: tone.bg,
        border: `1px solid ${tone.border}`,
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 0.4,
              textTransform: "uppercase",
              color: tone.ink,
            }}
          >
            Capture readiness · {LEVEL_LABEL[summary.level]}
          </div>
          <div
            data-capture-readiness-progress
            style={{
              marginTop: 4,
              fontSize: 12,
              color: tone.ink,
            }}
          >
            {summary.score.satisfied} of {summary.score.total} workflow criteria
            satisfied
          </div>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss capture readiness panel"
          data-capture-readiness-dismiss
          style={{
            background: "transparent",
            border: `1px solid ${tone.border}`,
            borderRadius: 4,
            padding: "2px 8px",
            fontSize: 11,
            color: tone.ink,
            cursor: "pointer",
          }}
        >
          Hide
        </button>
      </header>

      <ul
        data-capture-readiness-criteria
        style={{
          margin: "8px 0 0 0",
          padding: 0,
          listStyle: "none",
          fontSize: 12,
        }}
      >
        {summary.criteria.map((c) => (
          <li
            key={c.id}
            data-capture-readiness-criterion={c.id}
            data-capture-readiness-criterion-satisfied={
              c.satisfied ? "true" : "false"
            }
            style={{
              padding: "3px 0",
              display: "flex",
              alignItems: "flex-start",
              gap: 6,
              color: tone.ink,
            }}
          >
            <span
              aria-hidden="true"
              style={{
                display: "inline-block",
                width: 14,
                textAlign: "center",
                color: c.satisfied ? "#166534" : "#94a3b8",
                fontWeight: 700,
              }}
            >
              {c.satisfied ? "✓" : "•"}
            </span>
            <span>
              <strong style={{ fontWeight: 600 }}>{c.label}</strong>
              <span style={{ display: "block", color: tone.ink, opacity: 0.8 }}>
                {c.description}
              </span>
            </span>
          </li>
        ))}
      </ul>

      <p
        data-capture-readiness-footnote
        style={{
          margin: "10px 0 0 0",
          fontSize: 11,
          color: tone.ink,
          opacity: 0.8,
          lineHeight: 1.5,
        }}
      >
        Operational readiness only. The capture pipeline (hashing, custody,
        finalization) is governed by the upload flow itself — this panel never
        blocks finalization.
      </p>
    </section>
  );
}
