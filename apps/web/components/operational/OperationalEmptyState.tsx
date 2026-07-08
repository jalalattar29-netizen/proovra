"use client";

/**
 * Phase 28-F (light-surface refresh, Phase 28-I).
 *
 * Enterprise operational empty state. Pages must NEVER look dead or
 * broken when data is absent. Each empty state explains:
 *   1. What this page shows.
 *   2. Why it may be empty.
 *   3. What action the operator can take.
 *   4. What system must run for data to appear.
 *   5. Links to relevant actions / pages (optional).
 *
 * Aesthetic rules:
 *   - Dense, professional, operational.
 *   - No marketing copy, no playful gradients, no decorative-only widgets.
 *   - Light-surface tokens via `./tokens.ts` — readable on light pages.
 *
 * Variants:
 *   - "neutral"  — no data is expected yet (e.g. fresh workspace).
 *   - "degraded" — backend reported degraded readiness; the page is
 *     reachable but consumers should treat the result as partial.
 *   - "unknown"  — backend snapshot couldn't be loaded; FAIL-CLOSED:
 *     never imply success.
 */

import Link from "next/link";

import { OPS_INK, OPS_SURFACE, OPS_TONES } from "./tokens";

export type OperationalEmptyStateVariant = "neutral" | "degraded" | "unknown";

export type OperationalEmptyStateAction = {
  label: string;
  href: string;
  /** Optional bounded description shown in a smaller line. */
  hint?: string;
};

/**
 * Wave 2 Phase 4 — Empty-state truth classification.
 *
 * Every Investigation surface MUST render ONE of these 10 codes
 * when its primary data set is empty. The classifier resolver in
 * apps/web/lib/empty-state/classifier.ts is the SOLE truth-source
 * that decides which code applies — pages MUST NOT hand-pick a code
 * from inline logic.
 */
export type EmptyStateClassification =
  | "TRUE_EMPTY"
  | "PIPELINE_PENDING"
  | "PIPELINE_FAILED"
  | "WORKER_UNAVAILABLE"
  | "CONFIG_DISABLED"
  | "PERMISSION_RESTRICTED"
  | "WRONG_SCOPE"
  | "API_ERROR"
  | "FEATURE_NOT_CONFIGURED"
  | "CAPABILITY_UNAVAILABLE";

/**
 * Wave 2 Phase 4 — bounded next-action affordance shape.
 *
 * `href` and `onClick` are mutually optional. When both are absent
 * the affordance is rendered as a plain label (no interactive
 * surface) so the operator still sees what the action would be.
 */
export type EmptyStateActionAffordance = {
  label: string;
  href?: string;
  onClick?: () => void;
};

/**
 * Wave 2 Phase 4 — classifier-driven empty-state copy.
 *
 * Each entry MUST be rendered verbatim. Pages MUST NEVER reinvent
 * the prose — the resolver picks an entry and the primitive renders
 * the canonical kicker + title for that code.
 */
export const CLASSIFICATION_COPY: Readonly<
  Record<
    EmptyStateClassification,
    { kicker: string; title: string; variant: OperationalEmptyStateVariant }
  >
> = Object.freeze({
  TRUE_EMPTY: {
    kicker: "No data yet",
    title: "No analyses for this workspace yet. Capture or link evidence to populate this view.",
    variant: "neutral",
  },
  PIPELINE_PENDING: {
    kicker: "Pipeline pending",
    title: "Background work is in flight — results will appear shortly.",
    variant: "neutral",
  },
  PIPELINE_FAILED: {
    kicker: "Pipeline failed",
    title: "A recent background job failed and no fresh results are available.",
    variant: "degraded",
  },
  WORKER_UNAVAILABLE: {
    kicker: "Worker unavailable",
    title: "The processing worker for this surface is offline.",
    variant: "degraded",
  },
  CONFIG_DISABLED: {
    kicker: "Disabled by configuration",
    title: "This capability is turned off for this workspace.",
    variant: "neutral",
  },
  PERMISSION_RESTRICTED: {
    kicker: "Permission restricted",
    title: "Your role does not include access to this data scope.",
    variant: "neutral",
  },
  WRONG_SCOPE: {
    kicker: "Wrong scope",
    title: "This page expects a different workspace or record context.",
    variant: "neutral",
  },
  API_ERROR: {
    kicker: "API error",
    title: "The backend service could not be reached for this surface.",
    variant: "unknown",
  },
  FEATURE_NOT_CONFIGURED: {
    kicker: "Feature not configured",
    title: "No provider is bound to this capability yet.",
    variant: "neutral",
  },
  CAPABILITY_UNAVAILABLE: {
    kicker: "Capability unavailable",
    title: "This view is not available in your current workspace configuration.",
    variant: "neutral",
  },
});

export type OperationalEmptyStateProps = {
  /** Short kicker — what the page is about. */
  kicker?: string;
  /** One-line headline. */
  title?: string;
  /** Operator-readable explanation of why this is empty. */
  reason: string;
  /** What system must run for data to appear (optional). */
  runtimeDependency?: string;
  /** Suggested operator actions (links). */
  actions?: ReadonlyArray<OperationalEmptyStateAction>;
  /** Severity. Default "neutral". */
  variant?: OperationalEmptyStateVariant;
  /** Stable code used by metrics + telemetry (e.g. "no_escalations"). */
  emptyStateCode?: string;
  // ---------------------------------------------------------------------------
  // Wave 2 Phase 4 — classifier-driven props. ADDITIVE — every legacy caller
  // continues to work because `classification` is optional.
  // ---------------------------------------------------------------------------
  /**
   * One of the 10 canonical empty-state classifications. When set, the
   * primitive looks up CLASSIFICATION_COPY for the kicker + title and
   * uses the classifier-resolved reason verbatim.
   */
  classification?: EmptyStateClassification;
  /** Primary operator-facing affordance (always rendered if present). */
  nextAction?: EmptyStateActionAffordance;
  /**
   * Admin-only affordance. Rendered only when isAdmin === true so a
   * regular reviewer sees the operator-facing next action but is not
   * confused by an unreachable admin link.
   */
  adminAction?: EmptyStateActionAffordance;
  /**
   * Deep-link into /v1/investigation/diagnostics (or a UI surface
   * backed by it). Rendered only when isAdmin === true.
   */
  diagnosticsLink?: string;
  /** True when the current operator has admin/diagnostics access. */
  isAdmin?: boolean;
};

function toneFor(variant: OperationalEmptyStateVariant) {
  if (variant === "degraded") return OPS_TONES.degraded;
  if (variant === "unknown") return OPS_TONES.unknown;
  return OPS_TONES.neutral;
}

export function OperationalEmptyState(props: OperationalEmptyStateProps) {
  // Wave 2 Phase 4 — classification-driven path. When `classification`
  // is supplied, the primitive resolves the kicker/title/variant from
  // CLASSIFICATION_COPY so the page can never invent off-vocabulary
  // prose. Explicit props still win (legacy callers, custom presets).
  const copy = props.classification
    ? CLASSIFICATION_COPY[props.classification]
    : null;
  const kicker = props.kicker ?? copy?.kicker ?? "Status";
  const title = props.title ?? copy?.title ?? "No data.";
  const variant = props.variant ?? copy?.variant ?? "neutral";
  const reason = props.reason;
  const runtimeDependency = props.runtimeDependency;
  const actions = props.actions;
  const emptyStateCode =
    props.emptyStateCode ??
    (props.classification ? props.classification.toLowerCase() : undefined);
  const nextAction = props.nextAction;
  const adminAction = props.adminAction;
  const diagnosticsLink = props.diagnosticsLink;
  const isAdmin = Boolean(props.isAdmin);
  const tone = toneFor(variant);
  // The 4 required surfaces from the brief:
  //   1. actual reason          → `reason` prop, rendered as the body.
  //   2. plain-language title   → `title` (from CLASSIFICATION_COPY).
  //   3. next action            → `nextAction` (always rendered if set).
  //   4. admin action + diag    → `adminAction` + `diagnosticsLink`
  //                               (rendered ONLY when isAdmin === true).
  return (
    <div
      role="status"
      data-empty-state-code={emptyStateCode}
      data-empty-state-variant={variant}
      data-empty-state-classification={props.classification ?? undefined}
      style={{
        border: `1px solid ${tone.border}`,
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
          color: tone.kicker,
          fontWeight: 700,
        }}
      >
        {kicker}
      </div>
      <div
        style={{
          fontSize: 16,
          fontWeight: 600,
          color: tone.ink,
          lineHeight: 1.35,
        }}
      >
        {title}
      </div>
      <div
        style={{
          fontSize: 13,
          color: tone.inkMuted,
          lineHeight: 1.5,
        }}
        data-empty-state-reason
      >
        {reason}
      </div>
      {runtimeDependency ? (
        <div
          style={{
            fontSize: 12,
            color: tone.inkMuted,
            borderTop: `1px solid ${tone.border}`,
            paddingTop: 10,
            lineHeight: 1.5,
          }}
        >
          <strong style={{ color: tone.ink, fontWeight: 600 }}>
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
                color: tone.link,
                textDecoration: "underline",
                textUnderlineOffset: 3,
                fontWeight: 600,
              }}
            >
              → {a.label}
              {a.hint ? (
                <span
                  style={{
                    color: tone.inkMuted,
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
      {nextAction ? (
        <EmptyStateActionButton
          affordance={nextAction}
          tone={tone}
          dataAttr="data-empty-state-next-action"
          primary
        />
      ) : null}
      {isAdmin && adminAction ? (
        <EmptyStateActionButton
          affordance={adminAction}
          tone={tone}
          dataAttr="data-empty-state-admin-action"
        />
      ) : null}
      {isAdmin && diagnosticsLink ? (
        <Link
          href={diagnosticsLink}
          data-empty-state-diagnostics-link
          style={{
            fontSize: 12,
            color: tone.link,
            textDecoration: "underline",
            textUnderlineOffset: 3,
            fontWeight: 600,
          }}
        >
          → Open diagnostics
        </Link>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Wave 2 Phase 4 — bounded affordance renderer. Renders as a Link when
// `href` is set, a button when `onClick` is set, or a plain label
// otherwise. Never throws if both are absent.
// ---------------------------------------------------------------------------

function EmptyStateActionButton({
  affordance,
  tone,
  dataAttr,
  primary = false,
}: {
  affordance: EmptyStateActionAffordance;
  tone: ReturnType<typeof toneFor>;
  dataAttr: string;
  primary?: boolean;
}) {
  const baseStyle: React.CSSProperties = {
    fontSize: 13,
    fontWeight: 600,
    color: primary ? tone.ink : tone.link,
    textDecoration: primary ? "none" : "underline",
    textUnderlineOffset: 3,
    background: primary ? tone.bg : "transparent",
    border: primary ? `1px solid ${tone.border}` : "none",
    borderRadius: primary ? 6 : 0,
    padding: primary ? "5px 12px" : 0,
    cursor: affordance.onClick || affordance.href ? "pointer" : "default",
    alignSelf: "flex-start",
  };
  const attrs: Record<string, string> = {};
  attrs[dataAttr] = "true";
  if (affordance.href) {
    return (
      <Link href={affordance.href} style={baseStyle} {...attrs}>
        → {affordance.label}
      </Link>
    );
  }
  if (affordance.onClick) {
    return (
      <button
        type="button"
        onClick={affordance.onClick}
        style={baseStyle}
        {...attrs}
      >
        → {affordance.label}
      </button>
    );
  }
  return (
    <span style={baseStyle} {...attrs}>
      {affordance.label}
    </span>
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
        { label: "Open observability dashboard", href: "/operations/observability" },
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
        { label: "Open Operations Center", href: "/operations" },
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
        { label: "Open Operations Center", href: "/operations" },
        { label: "View runbooks", href: "/operations/runbooks" },
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
      actions={[{ label: "View SLA policy", href: "/reviewer-ops/policy" }]}
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
        { label: "Open Observability dashboard", href: "/operations/observability" },
        { label: "Review runbooks", href: "/operations/runbooks" },
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
          ? [
              {
                label: `Reference request ${requestId.slice(0, 12)}`,
                href: "/operations/observability",
              },
            ]
          : [{ label: "Open Observability dashboard", href: "/operations/observability" }]
      }
    />
  );
}

// Token re-exports for downstream consumers (kept in this file so the
// barrel doesn't need to also export them separately).
export { OPS_INK, OPS_SURFACE };
