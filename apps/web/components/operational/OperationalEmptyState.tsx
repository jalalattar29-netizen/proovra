"use client";

/**
 * Phase 28-F — Enterprise operational empty state.
 *
 * Pages must NEVER look dead or broken when data is absent. Each
 * empty state explains:
 *   1. What this page shows.
 *   2. Why it may be empty.
 *   3. What action the operator can take.
 *   4. What system must run for data to appear.
 *   5. Links to relevant actions / pages (optional).
 *
 * Aesthetic rules:
 *   - Dense, professional, operational.
 *   - No marketing copy, no playful gradients, no decorative-only widgets.
 *   - Consistent with app-shell-v2 color tokens (neutral grays + thin borders).
 *
 * Variants:
 *   - "neutral"  — no data is expected yet (e.g. fresh workspace).
 *   - "degraded" — backend reported degraded readiness; the page is
 *     reachable but consumers should treat the result as partial.
 *   - "unknown"  — backend snapshot couldn't be loaded; FAIL-CLOSED:
 *     never imply success.
 */

import Link from "next/link";

export type OperationalEmptyStateVariant = "neutral" | "degraded" | "unknown";

export type OperationalEmptyStateAction = {
  label: string;
  href: string;
  /** Optional bounded description shown in a smaller line. */
  hint?: string;
};

export type OperationalEmptyStateProps = {
  /** Short kicker — what the page is about. */
  kicker: string;
  /** One-line headline. */
  title: string;
  /** Operator-readable explanation of why this is empty. */
  reason: string;
  /** What system must run for data to appear (optional). */
  runtimeDependency?: string;
  /** Suggested operator actions (links). */
  actions?: ReadonlyArray<OperationalEmptyStateAction>;
  /** Severity. Default "neutral". */
  variant?: OperationalEmptyStateVariant;
  /** Stable code used by metrics + telemetry (e.g. "no_escalations"). */
  emptyStateCode: string;
};

const VARIANT_TONE: Record<
  OperationalEmptyStateVariant,
  { border: string; bg: string; kickerColor: string }
> = {
  neutral: {
    border: "1px solid rgba(255,255,255,0.08)",
    bg: "rgba(255,255,255,0.02)",
    kickerColor: "rgba(255,255,255,0.5)",
  },
  degraded: {
    border: "1px solid rgba(245, 158, 11, 0.4)",
    bg: "rgba(245, 158, 11, 0.06)",
    kickerColor: "rgba(245, 158, 11, 0.9)",
  },
  unknown: {
    border: "1px solid rgba(239, 68, 68, 0.4)",
    bg: "rgba(239, 68, 68, 0.06)",
    kickerColor: "rgba(239, 68, 68, 0.9)",
  },
};

export function OperationalEmptyState({
  kicker,
  title,
  reason,
  runtimeDependency,
  actions,
  variant = "neutral",
  emptyStateCode,
}: OperationalEmptyStateProps) {
  const tone = VARIANT_TONE[variant];
  return (
    <div
      role="status"
      data-empty-state-code={emptyStateCode}
      data-empty-state-variant={variant}
      style={{
        border: tone.border,
        background: tone.bg,
        borderRadius: 8,
        padding: 20,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div
        style={{
          fontSize: 11,
          letterSpacing: 0.6,
          textTransform: "uppercase",
          color: tone.kickerColor,
          fontWeight: 600,
        }}
      >
        {kicker}
      </div>
      <div
        style={{
          fontSize: 16,
          fontWeight: 600,
          color: "rgba(255,255,255,0.92)",
          lineHeight: 1.35,
        }}
      >
        {title}
      </div>
      <div
        style={{
          fontSize: 13,
          color: "rgba(255,255,255,0.65)",
          lineHeight: 1.5,
        }}
      >
        {reason}
      </div>
      {runtimeDependency ? (
        <div
          style={{
            fontSize: 12,
            color: "rgba(255,255,255,0.5)",
            borderTop: "1px solid rgba(255,255,255,0.06)",
            paddingTop: 10,
            lineHeight: 1.5,
          }}
        >
          <strong style={{ color: "rgba(255,255,255,0.7)", fontWeight: 600 }}>
            Runtime dependency:
          </strong>{" "}
          {runtimeDependency}
        </div>
      ) : null}
      {actions && actions.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {actions.map((a) => (
            <Link
              key={a.href}
              href={a.href}
              style={{
                fontSize: 13,
                color: "rgba(96, 165, 250, 0.9)",
                textDecoration: "none",
                fontWeight: 500,
              }}
            >
              → {a.label}
              {a.hint ? (
                <span
                  style={{
                    color: "rgba(255,255,255,0.4)",
                    fontWeight: 400,
                    marginLeft: 6,
                  }}
                >
                  {a.hint}
                </span>
              ) : null}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Convenience presets — bounded catalog of operator-recognized empty states.
// -----------------------------------------------------------------------------

export function NoEscalationsEmptyState() {
  return (
    <OperationalEmptyState
      kicker="Reviewer Ops"
      emptyStateCode="no_escalations"
      title="No escalations open."
      reason="No reviews are currently overdue or otherwise flagged for operator attention. New escalations appear here automatically when the reviewer-reconciliation worker flips a workflow to BREACHED."
      runtimeDependency="Reviewer reconciliation worker (interval default 5 min). Reviewer SLA policy must be configured for SLA-driven escalations to fire."
      actions={[
        { label: "Check reviewer ops queue", href: "/reviewer-ops" },
        { label: "View SLA policy", href: "/reviewer-ops/policy" },
        { label: "Open observability dashboard", href: "/ops/observability" },
      ]}
    />
  );
}

export function NoWorkloadSnapshotsEmptyState() {
  return (
    <OperationalEmptyState
      kicker="Reviewer Ops"
      emptyStateCode="no_workload_snapshots"
      title="No workload snapshots yet."
      reason="Workload snapshots are written by the reviewer reconciliation worker on each pass. If no reviewers are assigned to any active workflow, the snapshot row count stays at zero."
      runtimeDependency="Reviewer reconciliation worker. Assignments via /reviewer-ops/reviews/:id/assign."
      actions={[
        { label: "Assign reviewers", href: "/reviewer-ops" },
        { label: "Trigger reconcile (operator)", href: "/ops/observability" },
      ]}
    />
  );
}

export function NoGovernanceIncidentsEmptyState() {
  return (
    <OperationalEmptyState
      kicker="Governance"
      emptyStateCode="no_governance_incidents"
      title="No governance incidents open."
      reason="No drift, hold conflict, retention conflict, or escalation storm has been detected. New incidents appear here automatically when the canonical engines flag them."
      runtimeDependency="Immutable-storage reconciliation worker + reviewer reconciliation worker. Both write incidents on detected conflicts."
      actions={[
        { label: "Check runtime readiness", href: "/ops/observability" },
        { label: "View runbooks", href: "/docs/runbooks" },
      ]}
    />
  );
}

export function NoSlaBreachesEmptyState() {
  return (
    <OperationalEmptyState
      kicker="SLA"
      emptyStateCode="no_sla_breaches"
      title="No SLA breaches detected."
      reason="All active reviewer workflows are within their configured SLA window. Breached workflows appear here once the next reconcile pass flips them."
      runtimeDependency="Reviewer reconciliation worker. Workspace SLA policy must be configured."
      actions={[
        { label: "View SLA policy", href: "/reviewer-ops/policy" },
      ]}
    />
  );
}

export function NoOperationalTimelineEmptyState() {
  return (
    <OperationalEmptyState
      kicker="Activity"
      emptyStateCode="no_operational_timeline"
      title="No operational activity recorded."
      reason="The platform writes a timeline entry on every lifecycle transition, reviewer action, and incident. New entries will appear here as activity occurs."
      runtimeDependency="EvidenceLifecycleEvent + EvidenceReviewWorkflowEvent + OperationalIncident tables."
    />
  );
}

// -----------------------------------------------------------------------------
// Degraded / unknown variants — fail-closed UI when backend state is partial.
// -----------------------------------------------------------------------------

export function RuntimeDegradedNotice({
  failingSubsystems,
}: {
  failingSubsystems: ReadonlyArray<string>;
}) {
  return (
    <OperationalEmptyState
      kicker="Runtime"
      emptyStateCode="runtime_degraded"
      title="Runtime is in degraded mode."
      reason={`${failingSubsystems.length} subsystem(s) reported a non-healthy state. The data on this page may be partial or stale. The platform continues to operate but operator attention is recommended.`}
      runtimeDependency={`Failing subsystems: ${failingSubsystems.join(", ")}.`}
      variant="degraded"
      actions={[
        { label: "Open runtime readiness", href: "/ops/observability" },
        { label: "Review runbooks", href: "/docs/runbooks" },
      ]}
    />
  );
}

export function GovernanceSnapshotUnavailableNotice({
  requestId,
}: {
  requestId?: string;
}) {
  return (
    <OperationalEmptyState
      kicker="Governance"
      emptyStateCode="governance_snapshot_unavailable"
      title="Governance state could not be loaded."
      reason="Export and package eligibility for this record cannot be confirmed right now. The platform is failing closed — treat as blocked until the snapshot is available."
      runtimeDependency="Database connectivity + canonical governance helpers."
      variant="unknown"
      actions={
        requestId
          ? [{ label: `Reference request ${requestId.slice(0, 12)}`, href: "/ops/observability" }]
          : [{ label: "Check runtime readiness", href: "/ops/observability" }]
      }
    />
  );
}
