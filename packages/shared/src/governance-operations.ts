/**
 * Phase 27.5 — Governance operationalization shared catalog.
 *
 * Browser-safe (no Prisma, no Node imports). Catalogs the operator-
 * facing identifiers that the workers, notification engine, export
 * snapshot service, and analytics surface emit. Extends Phase 27
 * `governance-lifecycle.ts` without duplicating anything.
 *
 * Hard invariants:
 *   - Every catalog below is exhaustive. New entries require a code
 *     change and a migration if a database column references them.
 *   - Notification dedupe keys are bounded. The notification engine
 *     refuses keys longer than DEDUPE_KEY_MAX_LEN.
 *   - Worker run kinds map 1:1 to a Prisma enum
 *     (`GovernanceReconciliationKind`). Do not invent values here that
 *     do not appear in the schema.
 */

import { z } from "zod";

// -----------------------------------------------------------------------------
// Reconciliation worker run kinds + trigger labels
// -----------------------------------------------------------------------------

export const GOVERNANCE_RECONCILIATION_KINDS = [
  "RETENTION",
  "IMMUTABLE_STORAGE",
  "LIFECYCLE_DRIFT",
  "DESTRUCTION_SWEEP",
] as const;
export type GovernanceReconciliationKind =
  (typeof GOVERNANCE_RECONCILIATION_KINDS)[number];

export const GOVERNANCE_RECONCILIATION_STATUSES = [
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "PARTIAL",
] as const;
export type GovernanceReconciliationStatus =
  (typeof GOVERNANCE_RECONCILIATION_STATUSES)[number];

export const GOVERNANCE_RECONCILIATION_TRIGGERS = [
  "cron",
  "startup",
  "manual",
  "operator_replay",
  "interval",
] as const;
export type GovernanceReconciliationTrigger =
  (typeof GOVERNANCE_RECONCILIATION_TRIGGERS)[number];

// -----------------------------------------------------------------------------
// Destruction execution phases
// -----------------------------------------------------------------------------

/**
 * Operator-readable phase string complementing the
 * `DestructionExecutionStatus` enum. The orchestrator updates the
 * phase on every boundary so the UI can render a meaningful progress
 * label even on terminal failure.
 */
export const DESTRUCTION_EXECUTION_PHASES = [
  "validating_inputs",
  "verifying_no_hold",
  "verifying_immutable_state",
  "verifying_storage_reconciliation",
  "creating_certificate",
  "writing_lineage",
  "deleting_storage",
  "tombstoning_evidence",
  "completing",
  "failed",
  "rolled_back",
] as const;
export type DestructionExecutionPhase =
  (typeof DESTRUCTION_EXECUTION_PHASES)[number];

export const DESTRUCTION_EXECUTION_STATUSES = [
  "PLANNED",
  "EXECUTING",
  "STORAGE_DELETED",
  "TOMBSTONED",
  "COMPLETED",
  "FAILED",
  "ROLLED_BACK",
] as const;
export type DestructionExecutionStatus =
  (typeof DESTRUCTION_EXECUTION_STATUSES)[number];

const DESTRUCTION_EXECUTION_TERMINAL_STATUSES: ReadonlySet<DestructionExecutionStatus> =
  new Set(["COMPLETED", "FAILED", "ROLLED_BACK"]);

export function isTerminalDestructionExecutionStatus(
  status: DestructionExecutionStatus,
): boolean {
  return DESTRUCTION_EXECUTION_TERMINAL_STATUSES.has(status);
}

// -----------------------------------------------------------------------------
// Immutable storage check outcomes
// -----------------------------------------------------------------------------

export const IMMUTABLE_STORAGE_CHECK_OUTCOMES = [
  "OK",
  "MISSING_LOCK",
  "RETENTION_MISMATCH",
  "LEGAL_HOLD_MISMATCH",
  "COMPLIANCE_MODE_MISMATCH",
  "STORAGE_UNAVAILABLE",
  "EVIDENCE_NOT_FOUND",
] as const;
export type ImmutableStorageCheckOutcome =
  (typeof IMMUTABLE_STORAGE_CHECK_OUTCOMES)[number];

/** Drift outcomes — the ones that should raise an incident + notify. */
export const IMMUTABLE_STORAGE_DRIFT_OUTCOMES: ReadonlySet<ImmutableStorageCheckOutcome> =
  new Set([
    "MISSING_LOCK",
    "RETENTION_MISMATCH",
    "LEGAL_HOLD_MISMATCH",
    "COMPLIANCE_MODE_MISMATCH",
  ]);

export function isDriftOutcome(o: ImmutableStorageCheckOutcome): boolean {
  return IMMUTABLE_STORAGE_DRIFT_OUTCOMES.has(o);
}

// -----------------------------------------------------------------------------
// Governance notification catalog
// -----------------------------------------------------------------------------

export const GOVERNANCE_NOTIFICATION_KINDS = [
  "DESTRUCTION_PENDING",
  "DESTRUCTION_APPROVED",
  "DESTRUCTION_EXECUTED",
  "DESTRUCTION_BLOCKED",
  "LEGAL_HOLD_PLACED",
  "LEGAL_HOLD_RELEASED",
  "RETENTION_CONFLICT",
  "RETENTION_EXTENSION_APPLIED",
  "LIFECYCLE_DRIFT",
  "IMMUTABLE_RECONCILIATION_FAILURE",
  "GOVERNANCE_INCIDENT_RAISED",
  "EXPORT_BLOCKED",
  "POLICY_OVERRIDE",
  "REVIEW_OVERDUE",
] as const;
export type GovernanceNotificationKind =
  (typeof GOVERNANCE_NOTIFICATION_KINDS)[number];

export const GOVERNANCE_NOTIFICATION_SEVERITIES = [
  "INFO",
  "WARNING",
  "HIGH",
  "CRITICAL",
] as const;
export type GovernanceNotificationSeverity =
  (typeof GOVERNANCE_NOTIFICATION_SEVERITIES)[number];

export const GOVERNANCE_NOTIFICATION_DELIVERY_STATUSES = [
  "PENDING",
  "SENT",
  "SUPPRESSED",
  "FAILED",
] as const;
export type GovernanceNotificationDeliveryStatus =
  (typeof GOVERNANCE_NOTIFICATION_DELIVERY_STATUSES)[number];

export const GOVERNANCE_NOTIFICATION_CHANNELS = [
  "in_app",
  "email",
  "webhook",
] as const;
export type GovernanceNotificationChannel =
  (typeof GOVERNANCE_NOTIFICATION_CHANNELS)[number];

/**
 * Catalog-bound default channel routing by severity. The notification
 * service consults this when an organization has not set an explicit
 * preference for the (kind, severity) tuple.
 */
export const DEFAULT_NOTIFICATION_CHANNELS: Record<
  GovernanceNotificationSeverity,
  ReadonlyArray<GovernanceNotificationChannel>
> = {
  INFO: ["in_app"],
  WARNING: ["in_app"],
  HIGH: ["in_app", "email"],
  CRITICAL: ["in_app", "email", "webhook"],
};

/**
 * Severity → incident severity (Phase 21) mapping for notifications
 * that fan out to the operational incident center.
 */
export const NOTIFICATION_TO_INCIDENT_SEVERITY: Record<
  GovernanceNotificationSeverity,
  "INFO" | "WARNING" | "HIGH" | "CRITICAL"
> = {
  INFO: "INFO",
  WARNING: "WARNING",
  HIGH: "HIGH",
  CRITICAL: "CRITICAL",
};

export const DEDUPE_KEY_MAX_LEN = 180;
export const NOTIFICATION_TITLE_MAX_LEN = 200;
export const NOTIFICATION_SUMMARY_MAX_LEN = 1000;

/**
 * Throttle window per (teamId, kind, severity). The notification
 * service refuses to re-emit a fresh delivery on a notification row
 * that has been delivered within this window — the row's
 * `occurrenceCount` still increments, the delivery does not refire.
 */
export const NOTIFICATION_THROTTLE_SECONDS: Record<
  GovernanceNotificationSeverity,
  number
> = {
  INFO: 3600, // 1h
  WARNING: 900, // 15m
  HIGH: 300, // 5m
  CRITICAL: 60, // 1m
};

export function isValidDedupeKey(key: string): boolean {
  if (typeof key !== "string") return false;
  const trimmed = key.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length > DEDUPE_KEY_MAX_LEN) return false;
  // Bounded charset: catalog-friendly, no whitespace or control chars.
  return /^[A-Za-z0-9_:.\-/]+$/.test(trimmed);
}

// -----------------------------------------------------------------------------
// Compliance export snapshot
// -----------------------------------------------------------------------------

export const GOVERNANCE_EXPORT_SNAPSHOT_KINDS = [
  "EVIDENCE_PACKAGE",
  "CASE_EXPORT",
  "AUDIT_EXPORT",
  "COMPLIANCE_BUNDLE",
] as const;
export type GovernanceExportSnapshotKind =
  (typeof GOVERNANCE_EXPORT_SNAPSHOT_KINDS)[number];

export const GovernanceExportSnapshotInputSchema = z
  .object({
    teamId: z.string().uuid(),
    evidenceId: z.string().uuid().nullable().optional(),
    snapshotKind: z.enum(GOVERNANCE_EXPORT_SNAPSHOT_KINDS),
    createdByUserId: z.string().uuid().nullable().optional(),
  })
  .strict();
export type GovernanceExportSnapshotInput = z.infer<
  typeof GovernanceExportSnapshotInputSchema
>;

// -----------------------------------------------------------------------------
// Analytics
// -----------------------------------------------------------------------------

/**
 * Bounded set of analytics buckets the dashboard renders. Adding a new
 * bucket is a code change — operators cannot request ad-hoc buckets
 * from the API.
 */
export const GOVERNANCE_ANALYTICS_METRICS = [
  "destruction_queue_depth",
  "destruction_blocked_count",
  "destruction_executed_count",
  "retention_conflicts",
  "retention_expiration_velocity",
  "hold_pressure",
  "lifecycle_transitions",
  "lifecycle_blocked_transitions",
  "governance_incident_open",
  "immutable_drift_count",
  "export_blocks",
  "review_overdue",
] as const;
export type GovernanceAnalyticsMetric =
  (typeof GOVERNANCE_ANALYTICS_METRICS)[number];

export const ANALYTICS_WINDOWS = ["1h", "24h", "7d", "30d"] as const;
export type AnalyticsWindow = (typeof ANALYTICS_WINDOWS)[number];

export function analyticsWindowToMilliseconds(window: AnalyticsWindow): number {
  switch (window) {
    case "1h":
      return 60 * 60 * 1000;
    case "24h":
      return 24 * 60 * 60 * 1000;
    case "7d":
      return 7 * 24 * 60 * 60 * 1000;
    case "30d":
      return 30 * 24 * 60 * 60 * 1000;
  }
}

// -----------------------------------------------------------------------------
// Operator-readable labels (UI never composes free-form).
// -----------------------------------------------------------------------------

export const GOVERNANCE_NOTIFICATION_KIND_LABELS: Record<
  GovernanceNotificationKind,
  string
> = {
  DESTRUCTION_PENDING: "Destruction review pending",
  DESTRUCTION_APPROVED: "Destruction approved",
  DESTRUCTION_EXECUTED: "Destruction executed",
  DESTRUCTION_BLOCKED: "Destruction blocked",
  LEGAL_HOLD_PLACED: "Legal hold placed",
  LEGAL_HOLD_RELEASED: "Legal hold released",
  RETENTION_CONFLICT: "Retention policy conflict",
  RETENTION_EXTENSION_APPLIED: "Retention extension applied",
  LIFECYCLE_DRIFT: "Lifecycle state drift",
  IMMUTABLE_RECONCILIATION_FAILURE: "Immutable storage drift",
  GOVERNANCE_INCIDENT_RAISED: "Governance incident raised",
  EXPORT_BLOCKED: "Export blocked",
  POLICY_OVERRIDE: "Policy override",
  REVIEW_OVERDUE: "Review overdue",
};

export const IMMUTABLE_STORAGE_OUTCOME_LABELS: Record<
  ImmutableStorageCheckOutcome,
  string
> = {
  OK: "Object lock verified",
  MISSING_LOCK: "Object lock missing",
  RETENTION_MISMATCH: "Retention date mismatch",
  LEGAL_HOLD_MISMATCH: "Legal hold flag mismatch",
  COMPLIANCE_MODE_MISMATCH: "Compliance mode mismatch",
  STORAGE_UNAVAILABLE: "Storage unavailable",
  EVIDENCE_NOT_FOUND: "Evidence record missing",
};

export const DESTRUCTION_EXECUTION_STATUS_LABELS: Record<
  DestructionExecutionStatus,
  string
> = {
  PLANNED: "Planned",
  EXECUTING: "Executing",
  STORAGE_DELETED: "Storage deleted",
  TOMBSTONED: "Tombstoned",
  COMPLETED: "Completed",
  FAILED: "Failed",
  ROLLED_BACK: "Rolled back",
};
