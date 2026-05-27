"use client";

/**
 * Phase C3 — Intake Completion Progress.
 *
 * Renders a deterministic progress bar plus a required/optional
 * breakdown driven by the backend's `completion` summary on the public
 * intake projection (see `projectRequestForExternalView`).
 *
 * Hard rules:
 *   * NEVER fakes a percentage — the number comes from the backend.
 *   * Optional items COUNT TOWARD overall percent but NEVER toward
 *     "review readiness". The chip says "Review-ready" only when all
 *     required deliverables are FULFILLED or WAIVED.
 *   * No marketing language. The labels are bounded.
 */

export type IntakeCompletion = {
  requiredTotal: number;
  requiredFulfilled: number;
  optionalTotal: number;
  optionalFulfilled: number;
  completionPercent: number;
  reviewReady: boolean;
  needsMoreInfo: boolean;
};

export function IntakeCompletionProgress({
  completion,
}: {
  completion: IntakeCompletion;
}) {
  const percent = Math.max(0, Math.min(100, completion.completionPercent));
  const barTone = completion.reviewReady
    ? "#16a34a"
    : completion.needsMoreInfo
      ? "#dc2626"
      : "#2563eb";

  return (
    <section
      data-intake-completion
      data-intake-percent={percent}
      data-intake-review-ready={completion.reviewReady ? "true" : "false"}
      data-intake-needs-more-info={completion.needsMoreInfo ? "true" : "false"}
      style={{
        marginBottom: 16,
        padding: "12px 14px",
        border: "1px solid #e2e8f0",
        borderRadius: 8,
        background: "#fff",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 8,
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <strong style={{ fontSize: 14 }}>Completion</strong>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <span
            data-intake-chip="percent"
            style={{
              fontSize: 12,
              padding: "2px 8px",
              borderRadius: 999,
              background: "#f1f5f9",
              color: "#0f172a",
              fontWeight: 600,
            }}
          >
            {percent}%
          </span>
          {completion.reviewReady ? (
            <span
              data-intake-chip="review-ready"
              style={{
                fontSize: 12,
                padding: "2px 8px",
                borderRadius: 999,
                background: "#dcfce7",
                color: "#166534",
                fontWeight: 600,
                border: "1px solid #bbf7d0",
              }}
            >
              Review-ready
            </span>
          ) : (
            <span
              data-intake-chip="not-ready"
              style={{
                fontSize: 12,
                padding: "2px 8px",
                borderRadius: 999,
                background: "#fef3c7",
                color: "#78350f",
                fontWeight: 600,
                border: "1px solid #fcd34d",
              }}
            >
              Required items remaining
            </span>
          )}
        </div>
      </div>

      {/* Bar */}
      <div
        aria-hidden="true"
        style={{
          width: "100%",
          height: 8,
          background: "#f1f5f9",
          borderRadius: 999,
          overflow: "hidden",
        }}
      >
        <div
          data-intake-progress-bar
          style={{
            width: `${percent}%`,
            height: "100%",
            background: barTone,
            transition: "width 200ms ease",
          }}
        />
      </div>

      {/* Counts */}
      <div
        style={{
          marginTop: 8,
          display: "flex",
          gap: 16,
          flexWrap: "wrap",
          fontSize: 13,
          color: "#475569",
        }}
      >
        <span data-intake-required-counts>
          Required: <strong>{completion.requiredFulfilled}</strong> /{" "}
          {completion.requiredTotal}
        </span>
        <span data-intake-optional-counts>
          Optional: <strong>{completion.optionalFulfilled}</strong> /{" "}
          {completion.optionalTotal}
        </span>
      </div>
    </section>
  );
}
