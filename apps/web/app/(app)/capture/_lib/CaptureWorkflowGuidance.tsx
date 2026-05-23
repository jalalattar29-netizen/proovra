"use client";

/**
 * PHASE 38.11 — Capture workflow guidance panel.
 *
 * Renders the workflow-aware helper copy, checklist, recommended
 * templates (subset, never replacement), and the canonical workflow
 * safety statement. Operates as a visible adaptation layer on top
 * of the capture page — capabilities + template availability are
 * unchanged.
 *
 * Hard rules pinned by Phase 38.11 source-contract tests:
 *
 *   1. The recommended-templates strip is a SUBSET, not a replacement.
 *      All templates remain reachable via the existing template
 *      selector elsewhere on the page.
 *   2. The workflow safety statement is always rendered.
 *   3. Operational tone — no legal guarantees, no marketing fluff.
 *   4. Dismissible — operators who don't need the guidance can hide it
 *      (localStorage-persisted, scoped per workflow code).
 */

import { useEffect, useState } from "react";

import type { WorkflowProfileCode } from "../../../../lib/platform-context";
import { WORKFLOW_SAFETY_STATEMENT } from "../../../../components/navigation/WorkflowSafetyNotice";
import { getCaptureWorkflowGuidance } from "./workflowGuidance";
import type { CollectionPlanTemplate } from "./types";

const DISMISS_KEY_PREFIX = "capture-workflow-guidance-dismissed:";

export function CaptureWorkflowGuidance({
  workflow,
  allTemplates,
  onSelectTemplate,
  selectedTemplateId,
}: {
  workflow: WorkflowProfileCode;
  allTemplates: ReadonlyArray<CollectionPlanTemplate>;
  onSelectTemplate?: (templateId: string) => void;
  selectedTemplateId?: string | null;
}) {
  const guidance = getCaptureWorkflowGuidance(workflow);
  const recommendedIds = new Set(guidance.recommendedTemplateIds);
  const recommended = allTemplates.filter((t) => recommendedIds.has(t.id));

  const dismissKey = `${DISMISS_KEY_PREFIX}${workflow}`;
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const stored = window.localStorage.getItem(dismissKey);
      if (stored === "true") setDismissed(true);
    } catch {
      /* localStorage unavailable — render the guidance. */
    }
  }, [dismissKey]);

  function dismiss() {
    setDismissed(true);
    try {
      window.localStorage.setItem(dismissKey, "true");
    } catch {
      /* ignore */
    }
  }

  if (dismissed) return null;

  return (
    <section
      data-capture-workflow-guidance
      data-capture-workflow-guidance-workflow={workflow}
      aria-label={`Workflow guidance: ${guidance.title}`}
      style={{
        marginBottom: 16,
        padding: "12px 16px",
        borderRadius: 8,
        background: "rgba(148, 163, 184, 0.08)",
        border: "1px solid rgba(148, 163, 184, 0.22)",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div>
          <h2
            data-capture-workflow-guidance-title
            style={{
              fontSize: 13,
              fontWeight: 700,
              letterSpacing: 0.4,
              textTransform: "uppercase",
              color: "#475569",
              margin: 0,
            }}
          >
            {guidance.title}
          </h2>
          <p
            data-capture-workflow-guidance-copy
            style={{
              margin: "4px 0 0 0",
              fontSize: 13,
              color: "#1e293b",
              lineHeight: 1.5,
            }}
          >
            {guidance.helperCopy}
          </p>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss workflow guidance"
          data-capture-workflow-guidance-dismiss
          style={{
            background: "transparent",
            border: "1px solid #cbd5e1",
            borderRadius: 4,
            padding: "2px 8px",
            fontSize: 11,
            color: "#475569",
            cursor: "pointer",
          }}
        >
          Hide
        </button>
      </header>

      {guidance.checklist.length > 0 ? (
        <ul
          data-capture-workflow-guidance-checklist
          style={{
            margin: "8px 0 0 18px",
            padding: 0,
            fontSize: 12,
            color: "#334155",
            lineHeight: 1.6,
          }}
        >
          {guidance.checklist.map((item, idx) => (
            <li key={idx}>{item}</li>
          ))}
        </ul>
      ) : null}

      {recommended.length > 0 ? (
        <div
          data-capture-workflow-guidance-recommended
          style={{
            marginTop: 10,
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 6,
          }}
        >
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: 0.3,
              textTransform: "uppercase",
              color: "#475569",
            }}
          >
            Recommended templates:
          </span>
          {recommended.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onSelectTemplate?.(t.id)}
              data-capture-workflow-guidance-recommended-id={t.id}
              data-active={
                selectedTemplateId === t.id ? "true" : undefined
              }
              style={{
                fontSize: 11,
                fontWeight: 600,
                padding: "2px 8px",
                borderRadius: 999,
                background:
                  selectedTemplateId === t.id ? "#1e293b" : "#fff",
                color:
                  selectedTemplateId === t.id ? "#f8fafc" : "#1e293b",
                border: "1px solid #cbd5e1",
                cursor: "pointer",
              }}
            >
              {t.name}
            </button>
          ))}
        </div>
      ) : null}

      <p
        data-capture-workflow-guidance-safety
        style={{
          margin: "10px 0 0 0",
          fontSize: 11,
          color: "#64748b",
          lineHeight: 1.5,
        }}
      >
        {WORKFLOW_SAFETY_STATEMENT}{" "}
        <span data-capture-workflow-guidance-all-templates-note>
          All templates remain available from the template selector
          below.
        </span>
      </p>
    </section>
  );
}
