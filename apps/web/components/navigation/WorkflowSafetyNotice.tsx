/**
 * PHASE 38.9 — Canonical workflow safety notice.
 *
 * Renders the single, bounded safety statement that workflow profiles
 * are UX-ONLY. Every surface that lets the user CHOOSE or SEE workflow
 * priority should mount this so users can never form the wrong mental
 * model.
 *
 * Bounded vocabulary — pinned by Phase 38.9 source-contract test:
 *
 *   "Workflow profiles personalize layout, defaults, and recommendations.
 *    They do not change permissions or remove tools."
 *
 * Do NOT vary the wording without updating the test.
 */

export const WORKFLOW_SAFETY_STATEMENT =
  "Workflow profiles personalize layout, defaults, and recommendations. They do not change permissions or remove tools.";

export function WorkflowSafetyNotice({
  variant = "block",
}: {
  variant?: "block" | "inline";
}) {
  if (variant === "inline") {
    return (
      <span
        data-workflow-safety-notice="inline"
        style={{ fontSize: 12, color: "rgba(244, 247, 245, 0.6)" }}
      >
        {WORKFLOW_SAFETY_STATEMENT}
      </span>
    );
  }
  return (
    <div
      data-workflow-safety-notice="block"
      style={{
        padding: "8px 12px",
        borderRadius: 6,
        background: "rgba(148, 163, 184, 0.08)",
        border: "1px solid rgba(148, 163, 184, 0.2)",
        color: "rgba(244, 247, 245, 0.7)",
        fontSize: 12,
        lineHeight: 1.5,
      }}
    >
      {WORKFLOW_SAFETY_STATEMENT}
    </div>
  );
}
