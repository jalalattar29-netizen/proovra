/**
 * Phase 25 — Stuck workflow detector.
 *
 * Pure deterministic detector that classifies a reviewer workflow as
 * "stuck" — i.e. operationally inert beyond what its policy permits.
 * The detector is consumed by:
 *   - the API's reviewer queue intelligence engine (priority scoring)
 *   - the periodic reviewer reconciliation worker (escalation
 *     generation + operational incident creation)
 *
 * Hard rules:
 *   - Pure: no Prisma, no Node, no I/O. Browser-safe.
 *   - Deterministic: identical inputs → identical output.
 *   - Bounded reason catalog so the UI can render explanations without
 *     a free-text leak.
 *   - The detector NEVER raises an incident — it only classifies. The
 *     escalation engine + incident service decide what to do with the
 *     classification.
 */

export const STUCK_REASON_CODES = [
  "submitted_never_assigned",
  "assigned_never_opened",
  "opened_no_action",
  "needs_info_no_response",
  "sla_overdue_no_escalation",
  "escalated_unacknowledged",
  "approved_export_blocked",
] as const;

export type StuckReasonCode = (typeof STUCK_REASON_CODES)[number];

export type StuckReason = {
  code: StuckReasonCode;
  /** Operator-readable, bounded vocabulary. Safe to render. */
  label: string;
  /** Severity hint — used by the reconciliation worker to decide
   *  whether to raise an escalation vs. a notification. */
  severity: "INFO" | "WARNING" | "HIGH" | "CRITICAL";
};

export type WorkflowReviewStatus =
  | "SUBMITTED"
  | "ASSIGNED"
  | "IN_REVIEW"
  | "NEEDS_INFO"
  | "APPROVED"
  | "REJECTED"
  | "PAUSED"
  | "COMPLETED"
  | "CANCELLED";

export type StuckWorkflowFacts = {
  nowEpochMs: number;
  status: WorkflowReviewStatus | string;
  /** When the workflow was first submitted (or created). */
  submittedAtEpochMs: number;
  /** When the workflow was assigned, if assigned. */
  assignedAtEpochMs: number | null;
  /** When the reviewer first opened the workflow, if opened. */
  firstOpenedAtEpochMs: number | null;
  /** Last reviewer activity timestamp (any state transition / comment). */
  lastReviewerTouchAtEpochMs: number | null;
  /** Contributor / external-intake response timestamp, if expected. */
  lastContributorResponseAtEpochMs: number | null;
  /** Workflow SLA status snapshot. */
  slaStatus: "ON_TRACK" | "DUE_SOON" | "BREACHED" | null;
  /** Whether an open escalation already exists for this workflow. */
  hasOpenEscalation: boolean;
  /** Whether an escalation has been acknowledged. */
  escalationAcknowledged: boolean;
  /** Whether the workflow has been approved but export/package gate
   *  still blocks. */
  approvedButExportBlocked: boolean;
};

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

// Bounded thresholds — operators can tune by replacing this module's
// exported constants in a future config-driven evolution.
export const STUCK_SUBMITTED_THRESHOLD_MS = 24 * ONE_HOUR_MS; // 24h
export const STUCK_ASSIGNED_NEVER_OPENED_THRESHOLD_MS = 24 * ONE_HOUR_MS;
export const STUCK_OPENED_NO_ACTION_THRESHOLD_MS = 3 * ONE_DAY_MS;
export const STUCK_NEEDS_INFO_THRESHOLD_MS = 5 * ONE_DAY_MS;
export const STUCK_ESCALATION_UNACK_THRESHOLD_MS = 8 * ONE_HOUR_MS;

export type StuckClassification = {
  isStuck: boolean;
  reasons: ReadonlyArray<StuckReason>;
  /** Highest-severity reason in the set, or "INFO" when not stuck. */
  topSeverity: "INFO" | "WARNING" | "HIGH" | "CRITICAL";
};

const SEVERITY_RANK: Record<StuckReason["severity"], number> = {
  INFO: 0,
  WARNING: 1,
  HIGH: 2,
  CRITICAL: 3,
};

export function detectStuckWorkflow(
  facts: StuckWorkflowFacts,
): StuckClassification {
  const reasons: StuckReason[] = [];
  const now = facts.nowEpochMs;

  // 1) Submitted but never assigned — most common SLA failure.
  if (
    facts.status === "SUBMITTED" &&
    facts.assignedAtEpochMs == null &&
    now - facts.submittedAtEpochMs > STUCK_SUBMITTED_THRESHOLD_MS
  ) {
    reasons.push({
      code: "submitted_never_assigned",
      label: "Submitted but never assigned to a reviewer",
      severity: "HIGH",
    });
  }

  // 2) Assigned but never opened.
  if (
    facts.status === "ASSIGNED" &&
    facts.assignedAtEpochMs != null &&
    facts.firstOpenedAtEpochMs == null &&
    now - facts.assignedAtEpochMs > STUCK_ASSIGNED_NEVER_OPENED_THRESHOLD_MS
  ) {
    reasons.push({
      code: "assigned_never_opened",
      label: "Assigned but never opened by the reviewer",
      severity: "WARNING",
    });
  }

  // 3) Opened but no action.
  if (
    (facts.status === "IN_REVIEW" || facts.status === "ASSIGNED") &&
    facts.firstOpenedAtEpochMs != null &&
    facts.lastReviewerTouchAtEpochMs != null &&
    now - facts.lastReviewerTouchAtEpochMs >
      STUCK_OPENED_NO_ACTION_THRESHOLD_MS
  ) {
    reasons.push({
      code: "opened_no_action",
      label: "Opened but no reviewer action in 3+ days",
      severity: "WARNING",
    });
  }

  // 4) Needs-info but no response.
  if (
    facts.status === "NEEDS_INFO" &&
    facts.lastContributorResponseAtEpochMs == null
  ) {
    // Use the workflow's last reviewer touch as the "needs-info
    // requested at" anchor.
    const anchor =
      facts.lastReviewerTouchAtEpochMs ?? facts.submittedAtEpochMs;
    if (now - anchor > STUCK_NEEDS_INFO_THRESHOLD_MS) {
      reasons.push({
        code: "needs_info_no_response",
        label: "Reviewer requested info; no contributor response in 5+ days",
        severity: "HIGH",
      });
    }
  }

  // 5) SLA overdue without escalation.
  if (facts.slaStatus === "BREACHED" && !facts.hasOpenEscalation) {
    reasons.push({
      code: "sla_overdue_no_escalation",
      label: "Reviewer SLA breached but no escalation has been raised",
      severity: "CRITICAL",
    });
  }

  // 6) Escalated but unacknowledged.
  if (
    facts.hasOpenEscalation &&
    !facts.escalationAcknowledged &&
    facts.lastReviewerTouchAtEpochMs != null &&
    now - facts.lastReviewerTouchAtEpochMs >
      STUCK_ESCALATION_UNACK_THRESHOLD_MS
  ) {
    reasons.push({
      code: "escalated_unacknowledged",
      label: "Escalation raised but not acknowledged within 8h",
      severity: "HIGH",
    });
  }

  // 7) Approved but export/package still blocked.
  if (facts.status === "APPROVED" && facts.approvedButExportBlocked) {
    reasons.push({
      code: "approved_export_blocked",
      label: "Review approved but export / package gate still blocks",
      severity: "WARNING",
    });
  }

  const topSeverity: StuckClassification["topSeverity"] =
    reasons.reduce<StuckClassification["topSeverity"]>(
      (max, r) =>
        SEVERITY_RANK[r.severity] > SEVERITY_RANK[max] ? r.severity : max,
      "INFO",
    );

  // Sort reasons by severity descending so the UI can render the top
  // driver without re-sorting.
  reasons.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);

  return {
    isStuck: reasons.length > 0,
    reasons,
    topSeverity,
  };
}
