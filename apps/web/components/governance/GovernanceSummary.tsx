"use client";

/**
 * Phase G1 (F.2) — Governance summary panel.
 *
 * One small, deterministic, operator-facing summary that aggregates:
 *
 *   * Lifecycle state (via the LifecycleStateBadge)
 *   * Retention source (via the existing
 *     `RetentionInheritanceSummary` shape — fetched lazily)
 *   * Export eligibility outcome (via the existing
 *     `GovernedExportAction` eligibility query)
 *
 * Mounted on:
 *   - Matter Workspace Overview tab (matter-level summary)
 *   - Evidence detail (evidence-level summary)
 *
 * Hard rules:
 *   * Pure render component — all data comes from props, the caller
 *     decides which signals are relevant.
 *   * Vocabulary discipline — operational language only. Never claims
 *     legal admissibility / authenticity / compliance attestation.
 *   * Solo-user safe — when no organization or retention policy is
 *     in play, the summary degrades quietly to the lifecycle line
 *     only.
 */

import type { LifecycleState } from "./LifecycleStateBadge";
import { LifecycleStateBadge } from "./LifecycleStateBadge";

export type GovernanceSummaryProps = {
  /** When omitted, the lifecycle line is suppressed. */
  lifecycleState?: LifecycleState | null;
  /** Retention source label. */
  retentionSource?: "team_policy" | "org_policy_inherited" | "none";
  /** Operator-readable retention policy name (when source is team_policy). */
  retentionPolicyName?: string | null;
  /** Number of active legal holds on the entity. */
  activeHoldCount?: number;
  /** Whether destruction is currently in flight. */
  hasActiveDestructionReview?: boolean;
  /** Export-eligibility outcome (bounded). */
  exportEligibility?:
    | "ALLOWED"
    | "BLOCKED_BY_HOLD"
    | "BLOCKED_BY_LIFECYCLE"
    | "BLOCKED_BY_REVIEW_GATE"
    | "BLOCKED_BY_POLICY"
    | null;
  /**
   * Conflict codes from the retention engine. Each is operator-readable
   * via the bounded `RETENTION_CONFLICT_LABELS` mapping.
   */
  retentionConflicts?: ReadonlyArray<{
    code:
      | "duplicate_same_scope"
      | "workspace_weaker_than_inherited"
      | "workspace_overrides_immutable";
    detail: string;
  }>;
  /** Display variant. `evidence` is compact; `matter` is full. */
  variant?: "evidence" | "matter";
};

const RETENTION_SOURCE_LABEL = {
  team_policy: "Local workspace policy",
  org_policy_inherited: "Inherited from organization",
  none: "No retention policy",
} as const;

const EXPORT_LABEL = {
  ALLOWED: "Exports allowed",
  BLOCKED_BY_HOLD: "Exports blocked by legal hold",
  BLOCKED_BY_LIFECYCLE: "Exports blocked by lifecycle state",
  BLOCKED_BY_REVIEW_GATE: "Exports blocked by destruction review",
  BLOCKED_BY_POLICY: "Exports blocked by workspace policy",
} as const;

const CONFLICT_LABEL: Record<string, string> = {
  duplicate_same_scope: "Duplicate active policies at the same scope",
  workspace_weaker_than_inherited:
    "Workspace retention is shorter than inherited organization template",
  workspace_overrides_immutable:
    "Workspace overrides an immutable organization template",
};

export function GovernanceSummary({
  lifecycleState,
  retentionSource,
  retentionPolicyName,
  activeHoldCount = 0,
  hasActiveDestructionReview = false,
  exportEligibility,
  retentionConflicts = [],
  variant = "evidence",
}: GovernanceSummaryProps) {
  return (
    <section
      data-governance-summary
      data-governance-variant={variant}
      data-governance-has-conflicts={retentionConflicts.length > 0 ? "true" : "false"}
      style={{
        border: "1px solid #e2e8f0",
        borderRadius: 8,
        background: "#fff",
        padding: "0.85rem 1rem",
      }}
    >
      <header style={{ marginBottom: 8 }}>
        <strong style={{ fontSize: 13 }}>Governance summary</strong>
        <p style={{ ...mutedStyle, margin: "2px 0 0" }}>
          Operational governance posture. Not a legal admissibility statement.
        </p>
      </header>

      <ul
        data-governance-summary-rows
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "flex",
          flexDirection: "column",
          gap: 6,
          fontSize: 13,
          color: "#0f172a",
        }}
      >
        {lifecycleState ? (
          <li
            data-governance-row="lifecycle"
            style={{ display: "flex", alignItems: "center", gap: 8 }}
          >
            <span style={labelStyle}>Lifecycle</span>
            <LifecycleStateBadge
              state={lifecycleState}
              inheritanceSource={retentionSource}
              policyName={retentionPolicyName}
            />
          </li>
        ) : null}

        {retentionSource ? (
          <li
            data-governance-row="retention"
            style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}
          >
            <span style={labelStyle}>Retention</span>
            <span>{RETENTION_SOURCE_LABEL[retentionSource]}</span>
            {retentionSource === "team_policy" && retentionPolicyName ? (
              <code style={{ fontSize: 12 }}>{retentionPolicyName}</code>
            ) : null}
          </li>
        ) : null}

        <li
          data-governance-row="holds"
          style={{ display: "flex", alignItems: "center", gap: 8 }}
        >
          <span style={labelStyle}>Legal holds</span>
          {activeHoldCount > 0 ? (
            <span
              data-governance-holds-count={activeHoldCount}
              style={{
                fontSize: 12,
                padding: "2px 8px",
                background: "#fef3c7",
                color: "#78350f",
                borderRadius: 999,
                fontWeight: 600,
                border: "1px solid #fcd34d",
              }}
            >
              {activeHoldCount} active
            </span>
          ) : (
            <span style={mutedStyle}>None active</span>
          )}
        </li>

        {hasActiveDestructionReview ? (
          <li
            data-governance-row="destruction"
            style={{ display: "flex", alignItems: "center", gap: 8 }}
          >
            <span style={labelStyle}>Destruction</span>
            <span
              style={{
                fontSize: 12,
                padding: "2px 8px",
                background: "#fee2e2",
                color: "#7f1d1d",
                borderRadius: 999,
                fontWeight: 600,
                border: "1px solid #fca5a5",
              }}
            >
              Review in flight
            </span>
          </li>
        ) : null}

        {exportEligibility ? (
          <li
            data-governance-row="export"
            data-governance-export-outcome={exportEligibility}
            style={{ display: "flex", alignItems: "center", gap: 8 }}
          >
            <span style={labelStyle}>Exports</span>
            <span>{EXPORT_LABEL[exportEligibility]}</span>
          </li>
        ) : null}

        {retentionConflicts.length > 0 ? (
          <li
            data-governance-row="conflicts"
            style={{
              padding: "6px 8px",
              background: "#fef3c7",
              border: "1px solid #fcd34d",
              borderRadius: 6,
              color: "#78350f",
              fontSize: 12.5,
            }}
          >
            <strong style={{ display: "block", marginBottom: 4 }}>
              Retention conflicts ({retentionConflicts.length})
            </strong>
            <ul
              data-governance-conflict-list
              style={{ margin: 0, paddingLeft: 16 }}
            >
              {retentionConflicts.map((c, idx) => (
                <li
                  key={`${c.code}:${idx}`}
                  data-governance-conflict={c.code}
                >
                  <strong>{CONFLICT_LABEL[c.code] ?? c.code}.</strong>{" "}
                  {c.detail}
                </li>
              ))}
            </ul>
          </li>
        ) : null}
      </ul>
    </section>
  );
}

const labelStyle = {
  fontSize: 11,
  textTransform: "uppercase" as const,
  letterSpacing: 0.4,
  color: "#64748b",
  minWidth: 80,
};

const mutedStyle = {
  fontSize: 12,
  color: "#94a3b8",
};
