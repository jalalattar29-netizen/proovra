"use client";

/**
 * Phase G1 (F.1) — Reusable lifecycle state badge.
 *
 * A small, deterministic operator chip rendering `EvidenceLifecycleState`.
 * The badge is intentionally compact — the verbose tooltip + the
 * "blocked actions" hint give operators the operational context
 * without dominating the surface.
 *
 * Hard rules:
 *   * Bounded vocabulary — only the seven states that exist in the
 *     `EvidenceLifecycleState` Prisma enum (Phase 27).
 *   * Operational language only. Never claims legal admissibility,
 *     evidentiary correctness, or compliance attestation.
 *   * No data fetching. The state is passed in by the caller; the
 *     badge is a pure render component.
 *   * Solo users see plain operator copy; enterprise governance
 *     context is added through the optional `inheritanceSource` and
 *     `policyName` props rather than overloading the badge.
 */

export type LifecycleState =
  | "ACTIVE"
  | "UNDER_REVIEW"
  | "ON_HOLD"
  | "RETENTION_LOCKED"
  | "PENDING_DESTRUCTION"
  | "DESTROYED"
  | "ARCHIVED";

const STATE_LABEL: Record<LifecycleState, string> = {
  ACTIVE: "Active",
  UNDER_REVIEW: "Under review",
  ON_HOLD: "Legal hold",
  RETENTION_LOCKED: "Retention locked",
  PENDING_DESTRUCTION: "Pending destruction",
  DESTROYED: "Destroyed",
  ARCHIVED: "Archived",
};

const STATE_EXPLANATION: Record<LifecycleState, string> = {
  ACTIVE:
    "Operational — evidence can be reviewed, linked to matters, and exported subject to workspace policy.",
  UNDER_REVIEW:
    "A reviewer is currently working through this evidence. Exports remain subject to review-gate policy.",
  ON_HOLD:
    "At least one legal hold is active. Destruction is blocked; exports follow workspace hold policy.",
  RETENTION_LOCKED:
    "Retention policy is immutable. Destruction cannot be requested while the policy is active.",
  PENDING_DESTRUCTION:
    "A destruction review is queued or in flight. Exports are blocked until the review is resolved.",
  DESTROYED:
    "Operational destruction has been executed. The evidence storage object is removed; the lifecycle ledger + destruction certificate persist.",
  ARCHIVED:
    "Operator-archived. Not destroyed; can be restored from the governance lifecycle surface.",
};

const STATE_BLOCKED: Record<LifecycleState, ReadonlyArray<string>> = {
  ACTIVE: [],
  UNDER_REVIEW: ["destruction"],
  ON_HOLD: ["destruction", "some exports"],
  RETENTION_LOCKED: ["destruction"],
  PENDING_DESTRUCTION: ["export", "report generation", "package generation"],
  DESTROYED: ["export", "report generation", "package generation", "public verify"],
  ARCHIVED: [],
};

const STATE_TONE: Record<
  LifecycleState,
  { bg: string; fg: string; border: string }
> = {
  ACTIVE: { bg: "#ecfdf5", fg: "#166534", border: "#bbf7d0" },
  UNDER_REVIEW: { bg: "#eff6ff", fg: "#1e3a8a", border: "#bfdbfe" },
  ON_HOLD: { bg: "#fef3c7", fg: "#78350f", border: "#fcd34d" },
  RETENTION_LOCKED: { bg: "#fef3c7", fg: "#78350f", border: "#fcd34d" },
  PENDING_DESTRUCTION: { bg: "#fee2e2", fg: "#7f1d1d", border: "#fca5a5" },
  DESTROYED: { bg: "#f1f5f9", fg: "#475569", border: "#cbd5e1" },
  ARCHIVED: { bg: "#f1f5f9", fg: "#475569", border: "#cbd5e1" },
};

export function LifecycleStateBadge({
  state,
  /**
   * Optional retention inheritance source — when provided, the badge's
   * tooltip surfaces the source so the operator sees both "Active" AND
   * "(inherited from organization)".
   */
  inheritanceSource,
  /** Optional policy name for the tooltip. */
  policyName,
  /** Inline render (default `true`) renders as a `<span>`; `false` renders as a block panel. */
  compact = true,
}: {
  state: LifecycleState;
  inheritanceSource?: "team_policy" | "org_policy_inherited" | "none";
  policyName?: string | null;
  compact?: boolean;
}) {
  const tone = STATE_TONE[state];
  const explanation = STATE_EXPLANATION[state];
  const blocked = STATE_BLOCKED[state];
  const blockedSummary =
    blocked.length === 0
      ? "All operator actions allowed (subject to policy)."
      : `Blocked: ${blocked.join(", ")}.`;

  const tooltipParts: string[] = [explanation, blockedSummary];
  if (inheritanceSource === "org_policy_inherited") {
    tooltipParts.push("Retention policy inherited from organization.");
  } else if (inheritanceSource === "team_policy" && policyName) {
    tooltipParts.push(`Retention policy: ${policyName}.`);
  }
  const tooltip = tooltipParts.join(" ");

  if (compact) {
    return (
      <span
        data-lifecycle-state-badge={state}
        data-lifecycle-blocked={blocked.length > 0 ? "true" : "false"}
        title={tooltip}
        aria-label={`Lifecycle state: ${STATE_LABEL[state]}. ${blockedSummary}`}
        style={{
          fontSize: 11,
          fontWeight: 600,
          padding: "2px 8px",
          borderRadius: 999,
          background: tone.bg,
          color: tone.fg,
          border: `1px solid ${tone.border}`,
          display: "inline-block",
        }}
      >
        {STATE_LABEL[state]}
      </span>
    );
  }

  return (
    <div
      data-lifecycle-state-badge={state}
      data-lifecycle-blocked={blocked.length > 0 ? "true" : "false"}
      style={{
        padding: "10px 12px",
        borderRadius: 8,
        background: tone.bg,
        color: tone.fg,
        border: `1px solid ${tone.border}`,
      }}
    >
      <strong style={{ display: "block", fontSize: 13 }}>
        {STATE_LABEL[state]}
      </strong>
      <p style={{ margin: "4px 0 0", fontSize: 12.5, lineHeight: 1.4 }}>
        {explanation}
      </p>
      {blocked.length > 0 ? (
        <p
          style={{
            margin: "4px 0 0",
            fontSize: 12,
            opacity: 0.85,
            fontWeight: 600,
          }}
        >
          {blockedSummary}
        </p>
      ) : null}
      {inheritanceSource === "org_policy_inherited" ? (
        <p style={{ margin: "4px 0 0", fontSize: 11.5, opacity: 0.85 }}>
          Retention policy inherited from organization.
        </p>
      ) : inheritanceSource === "team_policy" && policyName ? (
        <p style={{ margin: "4px 0 0", fontSize: 11.5, opacity: 0.85 }}>
          Retention policy: <code>{policyName}</code>
        </p>
      ) : null}
    </div>
  );
}

export function isLifecycleStateValue(
  value: string | null | undefined,
): value is LifecycleState {
  return (
    value === "ACTIVE" ||
    value === "UNDER_REVIEW" ||
    value === "ON_HOLD" ||
    value === "RETENTION_LOCKED" ||
    value === "PENDING_DESTRUCTION" ||
    value === "DESTROYED" ||
    value === "ARCHIVED"
  );
}
