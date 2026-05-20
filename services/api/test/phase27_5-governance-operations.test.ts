/**
 * Phase 27.5 — Governance operationalization regression tests.
 *
 * No DB. Source-text + pure-helper + projection tests in the same
 * style as Phase 26.75 / 27.
 *
 * Coverage:
 *   - Catalog completeness: reconciliation kinds, destruction execution
 *     phases / statuses, immutable check outcomes, notification kinds /
 *     severities / channels, snapshot kinds, analytics metrics.
 *   - Throttle / dedupe helpers (isValidDedupeKey, analytics window).
 *   - SecurityEvent + metrics + step-up catalog wiring for Phase 27.5.
 *   - Worker source wiring: hold-aware retention scan, hold + immutable
 *     checks in destruction orchestrator, drift detection in immutable
 *     reconciliation, idempotency / lock contention helpers.
 *   - Route wiring: server registers Phase 27.5 routes; routes expose
 *     analytics, notifications, snapshots, reconciliation, executions.
 *   - Service wiring: notification dedupe by unique key, snapshot hash
 *     verification, analytics catalog completeness.
 *   - Migration safety: idempotent guards, all five tables present.
 *   - Wording sweep on Phase 27.5 UI surfaces.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ANALYTICS_WINDOWS,
  DEDUPE_KEY_MAX_LEN,
  DEFAULT_NOTIFICATION_CHANNELS,
  DESTRUCTION_EXECUTION_PHASES,
  DESTRUCTION_EXECUTION_STATUSES,
  DESTRUCTION_EXECUTION_STATUS_LABELS,
  GOVERNANCE_ANALYTICS_METRICS,
  GOVERNANCE_EXPORT_SNAPSHOT_KINDS,
  GOVERNANCE_NOTIFICATION_CHANNELS,
  GOVERNANCE_NOTIFICATION_DELIVERY_STATUSES,
  GOVERNANCE_NOTIFICATION_KINDS,
  GOVERNANCE_NOTIFICATION_KIND_LABELS,
  GOVERNANCE_NOTIFICATION_SEVERITIES,
  GOVERNANCE_RECONCILIATION_KINDS,
  GOVERNANCE_RECONCILIATION_STATUSES,
  GOVERNANCE_RECONCILIATION_TRIGGERS,
  GovernanceExportSnapshotInputSchema,
  IMMUTABLE_STORAGE_CHECK_OUTCOMES,
  IMMUTABLE_STORAGE_DRIFT_OUTCOMES,
  IMMUTABLE_STORAGE_OUTCOME_LABELS,
  NOTIFICATION_SUMMARY_MAX_LEN,
  NOTIFICATION_THROTTLE_SECONDS,
  NOTIFICATION_TITLE_MAX_LEN,
  NOTIFICATION_TO_INCIDENT_SEVERITY,
  SECURITY_EVENT_TYPES,
  analyticsWindowToMilliseconds,
  isDriftOutcome,
  isTerminalDestructionExecutionStatus,
  isValidDedupeKey,
} from "@proovra/shared";

function readSource(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(rel, import.meta.url)),
    "utf8",
  );
}

// -----------------------------------------------------------------------------
// Catalog completeness
// -----------------------------------------------------------------------------

describe("Phase 27.5 — Reconciliation worker catalog", () => {
  it("declares exactly four reconciliation kinds", () => {
    expect(GOVERNANCE_RECONCILIATION_KINDS).toEqual([
      "RETENTION",
      "IMMUTABLE_STORAGE",
      "LIFECYCLE_DRIFT",
      "DESTRUCTION_SWEEP",
    ]);
  });

  it("declares four canonical statuses + bounded trigger labels", () => {
    expect(GOVERNANCE_RECONCILIATION_STATUSES).toEqual([
      "RUNNING",
      "SUCCEEDED",
      "FAILED",
      "PARTIAL",
    ]);
    expect(GOVERNANCE_RECONCILIATION_TRIGGERS).toContain("cron");
    expect(GOVERNANCE_RECONCILIATION_TRIGGERS).toContain("startup");
    expect(GOVERNANCE_RECONCILIATION_TRIGGERS).toContain("manual");
  });
});

describe("Phase 27.5 — Destruction execution catalog", () => {
  it("declares the documented status set", () => {
    expect(DESTRUCTION_EXECUTION_STATUSES).toEqual([
      "PLANNED",
      "EXECUTING",
      "STORAGE_DELETED",
      "TOMBSTONED",
      "COMPLETED",
      "FAILED",
      "ROLLED_BACK",
    ]);
  });

  it("treats COMPLETED, FAILED, ROLLED_BACK as terminal", () => {
    expect(isTerminalDestructionExecutionStatus("COMPLETED")).toBe(true);
    expect(isTerminalDestructionExecutionStatus("FAILED")).toBe(true);
    expect(isTerminalDestructionExecutionStatus("ROLLED_BACK")).toBe(true);
    expect(isTerminalDestructionExecutionStatus("EXECUTING")).toBe(false);
  });

  it("phase strings cover the destruction plan", () => {
    for (const phase of [
      "validating_inputs",
      "verifying_no_hold",
      "verifying_immutable_state",
      "creating_certificate",
      "deleting_storage",
      "tombstoning_evidence",
      "completing",
      "failed",
    ]) {
      expect(DESTRUCTION_EXECUTION_PHASES).toContain(phase);
    }
  });

  it("status labels map 1:1", () => {
    for (const s of DESTRUCTION_EXECUTION_STATUSES) {
      expect(DESTRUCTION_EXECUTION_STATUS_LABELS[s]).toBeDefined();
    }
  });
});

describe("Phase 27.5 — Immutable storage check catalog", () => {
  it("declares the documented outcome set", () => {
    expect(IMMUTABLE_STORAGE_CHECK_OUTCOMES).toEqual([
      "OK",
      "MISSING_LOCK",
      "RETENTION_MISMATCH",
      "LEGAL_HOLD_MISMATCH",
      "COMPLIANCE_MODE_MISMATCH",
      "STORAGE_UNAVAILABLE",
      "EVIDENCE_NOT_FOUND",
    ]);
  });

  it("classifies drift outcomes correctly", () => {
    expect(isDriftOutcome("MISSING_LOCK")).toBe(true);
    expect(isDriftOutcome("RETENTION_MISMATCH")).toBe(true);
    expect(isDriftOutcome("LEGAL_HOLD_MISMATCH")).toBe(true);
    expect(isDriftOutcome("COMPLIANCE_MODE_MISMATCH")).toBe(true);
    expect(isDriftOutcome("OK")).toBe(false);
    expect(isDriftOutcome("STORAGE_UNAVAILABLE")).toBe(false);
    expect(IMMUTABLE_STORAGE_DRIFT_OUTCOMES.size).toBe(4);
  });

  it("outcome labels map 1:1", () => {
    for (const o of IMMUTABLE_STORAGE_CHECK_OUTCOMES) {
      expect(IMMUTABLE_STORAGE_OUTCOME_LABELS[o]).toBeDefined();
    }
  });
});

describe("Phase 27.5 — Notification catalog", () => {
  it("declares the documented kind set", () => {
    expect(GOVERNANCE_NOTIFICATION_KINDS).toContain("DESTRUCTION_PENDING");
    expect(GOVERNANCE_NOTIFICATION_KINDS).toContain("DESTRUCTION_BLOCKED");
    expect(GOVERNANCE_NOTIFICATION_KINDS).toContain("DESTRUCTION_EXECUTED");
    expect(GOVERNANCE_NOTIFICATION_KINDS).toContain("LIFECYCLE_DRIFT");
    expect(GOVERNANCE_NOTIFICATION_KINDS).toContain(
      "IMMUTABLE_RECONCILIATION_FAILURE",
    );
    expect(GOVERNANCE_NOTIFICATION_KINDS).toContain("EXPORT_BLOCKED");
    expect(GOVERNANCE_NOTIFICATION_KINDS.length).toBeGreaterThanOrEqual(14);
  });

  it("severity → default channels routing escalates correctly", () => {
    expect(DEFAULT_NOTIFICATION_CHANNELS.INFO).toEqual(["in_app"]);
    expect(DEFAULT_NOTIFICATION_CHANNELS.WARNING).toEqual(["in_app"]);
    expect(DEFAULT_NOTIFICATION_CHANNELS.HIGH).toEqual(["in_app", "email"]);
    expect(DEFAULT_NOTIFICATION_CHANNELS.CRITICAL).toEqual([
      "in_app",
      "email",
      "webhook",
    ]);
  });

  it("throttle windows compress with rising severity", () => {
    expect(NOTIFICATION_THROTTLE_SECONDS.INFO).toBeGreaterThan(
      NOTIFICATION_THROTTLE_SECONDS.WARNING,
    );
    expect(NOTIFICATION_THROTTLE_SECONDS.WARNING).toBeGreaterThan(
      NOTIFICATION_THROTTLE_SECONDS.HIGH,
    );
    expect(NOTIFICATION_THROTTLE_SECONDS.HIGH).toBeGreaterThan(
      NOTIFICATION_THROTTLE_SECONDS.CRITICAL,
    );
  });

  it("dedupe key validator is bounded + bounded charset", () => {
    expect(isValidDedupeKey("destruction_pending:abc-123")).toBe(true);
    expect(isValidDedupeKey("a".repeat(DEDUPE_KEY_MAX_LEN))).toBe(true);
    expect(isValidDedupeKey("a".repeat(DEDUPE_KEY_MAX_LEN + 1))).toBe(false);
    expect(isValidDedupeKey("")).toBe(false);
    expect(isValidDedupeKey("contains space")).toBe(false);
    expect(isValidDedupeKey("contains/legal/value")).toBe(true);
  });

  it("notification severity → incident severity mapping is 1:1", () => {
    for (const s of GOVERNANCE_NOTIFICATION_SEVERITIES) {
      expect(NOTIFICATION_TO_INCIDENT_SEVERITY[s]).toBe(s);
    }
  });

  it("delivery statuses + channels are bounded", () => {
    expect(GOVERNANCE_NOTIFICATION_DELIVERY_STATUSES).toEqual([
      "PENDING",
      "SENT",
      "SUPPRESSED",
      "FAILED",
    ]);
    expect(GOVERNANCE_NOTIFICATION_CHANNELS).toEqual([
      "in_app",
      "email",
      "webhook",
    ]);
  });

  it("title + summary limits are sane", () => {
    expect(NOTIFICATION_TITLE_MAX_LEN).toBeGreaterThan(100);
    expect(NOTIFICATION_SUMMARY_MAX_LEN).toBeGreaterThan(NOTIFICATION_TITLE_MAX_LEN);
  });

  it("notification kind labels map 1:1", () => {
    for (const k of GOVERNANCE_NOTIFICATION_KINDS) {
      expect(GOVERNANCE_NOTIFICATION_KIND_LABELS[k]).toBeDefined();
    }
  });
});

describe("Phase 27.5 — Snapshot + analytics catalogs", () => {
  it("snapshot kinds bound the export classifier", () => {
    expect(GOVERNANCE_EXPORT_SNAPSHOT_KINDS).toEqual([
      "EVIDENCE_PACKAGE",
      "CASE_EXPORT",
      "AUDIT_EXPORT",
      "COMPLIANCE_BUNDLE",
    ]);
  });

  it("snapshot input schema rejects unknown kinds", () => {
    const bad = GovernanceExportSnapshotInputSchema.safeParse({
      teamId: "11111111-1111-4111-8111-111111111111",
      snapshotKind: "BOGUS",
    });
    expect(bad.success).toBe(false);
  });

  it("analytics metrics + windows bounded", () => {
    expect(GOVERNANCE_ANALYTICS_METRICS.length).toBeGreaterThanOrEqual(12);
    expect(ANALYTICS_WINDOWS).toEqual(["1h", "24h", "7d", "30d"]);
    expect(analyticsWindowToMilliseconds("1h")).toBe(60 * 60 * 1000);
    expect(analyticsWindowToMilliseconds("24h")).toBe(24 * 60 * 60 * 1000);
    expect(analyticsWindowToMilliseconds("7d")).toBe(7 * 24 * 60 * 60 * 1000);
    expect(analyticsWindowToMilliseconds("30d")).toBe(30 * 24 * 60 * 60 * 1000);
  });
});

// -----------------------------------------------------------------------------
// SecurityEvent + metrics wiring
// -----------------------------------------------------------------------------

describe("Phase 27.5 — SecurityEvent + metrics + step-up wiring", () => {
  it("SecurityEvent types include Phase 27.5 reconciliation + notification + snapshot signals", () => {
    for (const t of [
      "governance_reconciliation_started",
      "governance_reconciliation_finished",
      "governance_reconciliation_failed",
      "destruction_execution_planned",
      "destruction_execution_started",
      "destruction_execution_storage_deleted",
      "destruction_execution_tombstoned",
      "destruction_execution_completed",
      "destruction_execution_failed",
      "destruction_execution_rolled_back",
      "immutable_storage_drift",
      "immutable_storage_reconciliation_failure",
      "governance_notification_emitted",
      "governance_notification_throttled",
      "governance_notification_delivery_failed",
      "governance_export_snapshot_created",
      "governance_lifecycle_drift_detected",
    ]) {
      expect(SECURITY_EVENT_TYPES).toContain(t);
    }
  });

  it("metrics catalog includes Phase 27.5 counters + gauges", () => {
    const src = readSource("../../../packages/shared-runtime/src/ops/metrics.service.ts");
    for (const c of [
      "governance_reconciliation_runs_total",
      "governance_reconciliation_run_failed_total",
      "governance_reconciliation_run_partial_total",
      "governance_reconciliation_lock_contention_total",
      "retention_reconciliation_scanned_total",
      "destruction_orchestrator_planned_total",
      "destruction_orchestrator_executed_total",
      "destruction_orchestrator_rolled_back_total",
      "immutable_storage_check_total",
      "immutable_storage_drift_total",
      "governance_notification_emitted_total",
      "governance_notification_deduped_total",
      "governance_notification_throttled_total",
      "governance_export_snapshot_created_total",
    ]) {
      expect(src).toContain(`"${c}"`);
    }
    for (const g of [
      "governance_reconciliation_runs_inflight",
      "destruction_executions_inflight",
      "immutable_storage_drift_open",
      "governance_notifications_pending",
      "governance_notifications_failed",
      "governance_overdue_reviews",
    ]) {
      expect(src).toContain(`"${g}"`);
    }
  });
});

// -----------------------------------------------------------------------------
// Service-source wiring
// -----------------------------------------------------------------------------

describe("Phase 27.5 — Service source wiring", () => {
  it("notification service dedupes by (teamId, kind, dedupeKey) with throttle gating", () => {
    const src = readSource(
      "../src/services/governance-lifecycle/governance-notification.service.ts",
    );
    expect(src).toContain("teamId_kind_dedupeKey");
    expect(src).toContain("isValidDedupeKey");
    expect(src).toContain("NOTIFICATION_THROTTLE_SECONDS");
    expect(src).toContain("occurrenceCount");
    expect(src).toContain("DEFAULT_NOTIFICATION_CHANNELS");
    // HIGH+ fan out to operational incidents.
    expect(src).toContain("recordIncident");
    expect(src).toContain('category: "GOVERNANCE"');
  });

  it("export-lineage service captures bounded payload + hashes canonical JSON", () => {
    const src = readSource(
      "../src/services/governance-lifecycle/export-lineage.service.ts",
    );
    expect(src).toContain("snapshotHash");
    expect(src).toContain("canonicalJson");
    expect(src).toContain("sha256Hex");
    expect(src).toContain("checkExportEligibility");
    // Privileged legal text exclusion is a documented rule.
    expect(src).toContain("NEVER carries privileged legal text");
    // Hash verification helper.
    expect(src).toContain("verifyExportSnapshotHash");
  });

  it("analytics service is read-only and bounded by the metric catalog", () => {
    const src = readSource(
      "../src/services/governance-lifecycle/governance-analytics.service.ts",
    );
    expect(src).toContain("GOVERNANCE_ANALYTICS_METRICS");
    expect(src).toContain("analyticsWindowToMilliseconds");
    expect(src).toContain("immutableStorageCheck.count");
    expect(src).toContain("governanceReconciliationRun.findMany");
  });
});

// -----------------------------------------------------------------------------
// Worker wiring
// -----------------------------------------------------------------------------

describe("Phase 27.5 — Worker wiring", () => {
  const retentionSrc = readSource(
    "../../worker/src/governance/retention-reconciliation.worker.ts",
  );
  const destructionSrc = readSource(
    "../../worker/src/governance/destruction-orchestrator.worker.ts",
  );
  const immutableSrc = readSource(
    "../../worker/src/governance/immutable-storage-reconciliation.worker.ts",
  );
  const runLockSrc = readSource(
    "../../worker/src/governance/reconciliation-run.ts",
  );
  const workerIndexSrc = readSource("../../worker/src/index.ts");

  it("run-lock helper records every invocation in a GovernanceReconciliationRun row", () => {
    expect(runLockSrc).toContain("governanceReconciliationRun.create");
    expect(runLockSrc).toContain("governanceReconciliationRun.update");
    expect(runLockSrc).toContain("GovernanceReconciliationStatus");
    expect(runLockSrc).toContain("lockKey");
    expect(runLockSrc).toContain("stale_run_force_failed_after_lock_timeout");
  });

  it("retention worker is hold-aware + immutable-aware + auto-extends", () => {
    expect(retentionSrc).toContain("LegalHoldStatus.ACTIVE");
    expect(retentionSrc).toContain("CaseLegalHoldStatus.ACTIVE");
    expect(retentionSrc).toContain("immutable");
    expect(retentionSrc).toContain("autoExtensionEnabled");
    expect(retentionSrc).toContain("autoExtensionDays");
    // Idempotency check inside the tx.
    expect(retentionSrc).toContain("destructionReview.findFirst");
    expect(retentionSrc).toContain("activeDestructionReviewId");
    // Drift detection.
    expect(retentionSrc).toContain("PENDING_DESTRUCTION");
    expect(retentionSrc).toContain("Lifecycle drift detected");
  });

  it("destruction orchestrator validates hold + immutable + emits certificate", () => {
    // Phase X — the worker now routes its hold/immutable decision
    // through the canonical shared formula instead of inlining a
    // private helper. The fact-gatherer + canonical formula together
    // replace the old isHold/isImmutable helpers.
    expect(destructionSrc).toContain("gatherDestructionFacts");
    expect(destructionSrc).toContain("canonicalEvaluateLifecycleTransition");
    expect(destructionSrc).toContain("certificateHash");
    expect(destructionSrc).toContain("lineageHash");
    expect(destructionSrc).toContain("destruction_executed");
    expect(destructionSrc).toContain("PENDING_DESTRUCTION");
    expect(destructionSrc).toContain("DESTROYED");
    // Idempotency + rollback support.
    expect(destructionSrc).toContain("destructionExecution.findFirst");
    expect(destructionSrc).toContain("attemptCount: { increment: 1 }");
    expect(destructionSrc).toContain("ROLLED_BACK");
    // Hold check is re-run at execution time.
    expect(destructionSrc).toContain("BLOCKED_BY_HOLD");
    expect(destructionSrc).toContain("BLOCKED_BY_IMMUTABLE");
  });

  it("immutable storage worker raises governance incidents on drift", () => {
    // Phase X.1 — the worker now routes its incident raising through
    // the canonical recordWorkerIncident emitter (incident-emitter.ts)
    // instead of inlining `prisma.operationalIncident.upsert`. The
    // emitter applies the GOVERNANCE category internally.
    expect(immutableSrc).toContain("ImmutableStorageCheckOutcome");
    expect(immutableSrc).toContain("MISSING_LOCK");
    expect(immutableSrc).toContain("RETENTION_MISMATCH");
    expect(immutableSrc).toContain("LEGAL_HOLD_MISMATCH");
    expect(immutableSrc).toContain("COMPLIANCE_MODE_MISMATCH");
    expect(immutableSrc).toContain("STORAGE_UNAVAILABLE");
    expect(immutableSrc).toContain("recordWorkerIncident");
    expect(immutableSrc).toContain('category: "GOVERNANCE"');
    expect(immutableSrc).toContain("IMMUTABLE_RECONCILIATION_FAILURE");
  });

  it("worker entrypoint wires all three governance schedulers + shutdown hooks", () => {
    expect(workerIndexSrc).toContain("startRetentionReconciliationScheduler");
    expect(workerIndexSrc).toContain("startDestructionOrchestratorScheduler");
    expect(workerIndexSrc).toContain("startImmutableStorageReconciliationScheduler");
    expect(workerIndexSrc).toContain("stopRetentionReconciliationScheduler");
    expect(workerIndexSrc).toContain("stopDestructionOrchestratorScheduler");
    expect(workerIndexSrc).toContain("stopImmutableStorageReconciliationScheduler");
    expect(workerIndexSrc).toContain("RETENTION_RECONCILIATION_ENABLED");
    expect(workerIndexSrc).toContain("DESTRUCTION_ORCHESTRATOR_ENABLED");
    expect(workerIndexSrc).toContain("IMMUTABLE_STORAGE_RECONCILIATION_ENABLED");
  });
});

// -----------------------------------------------------------------------------
// Route wiring
// -----------------------------------------------------------------------------

describe("Phase 27.5 — Route wiring", () => {
  const routesSrc = readSource(
    "../src/routes/governance-operations.routes.ts",
  );
  const serverSrc = readSource("../src/server.ts");

  it("server registers Phase 27.5 operations routes", () => {
    expect(serverSrc).toContain("governanceOperationsRoutes");
    expect(serverSrc).toMatch(/app\.register\(governanceOperationsRoutes\)/);
  });

  it("routes expose analytics + notifications + snapshots + reconciliation", () => {
    expect(routesSrc).toContain('"/v1/governance/analytics"');
    expect(routesSrc).toContain('"/v1/governance/notifications"');
    expect(routesSrc).toContain(
      '"/v1/governance/notifications/:id/acknowledge"',
    );
    expect(routesSrc).toContain('"/v1/governance/export-snapshots"');
    expect(routesSrc).toContain('"/v1/governance/export-snapshots/:id"');
    expect(routesSrc).toContain(
      '"/v1/governance/export-snapshots/:id/verify"',
    );
    expect(routesSrc).toContain('"/v1/governance/reconciliation-runs"');
    expect(routesSrc).toContain('"/v1/governance/destruction-executions"');
    expect(routesSrc).toContain('"/v1/governance/immutable-storage-checks"');
  });

  it("non-member fall-through never reveals workspace data", () => {
    expect(routesSrc).toContain("if (!ok) return");
  });
});

// -----------------------------------------------------------------------------
// Migration safety
// -----------------------------------------------------------------------------

describe("Phase 27.5 — Migration safety", () => {
  const migrationSrc = readSource(
    "../prisma/migrations/20260613100000_phase27_5_governance_operationalization/migration.sql",
  );

  it("creates Phase 27.5 enums idempotently", () => {
    for (const e of [
      "GovernanceReconciliationKind",
      "GovernanceReconciliationStatus",
      "DestructionExecutionStatus",
      "ImmutableStorageCheckOutcome",
      "GovernanceNotificationKind",
      "GovernanceNotificationSeverity",
      "GovernanceNotificationDeliveryStatus",
      "GovernanceExportSnapshotKind",
    ]) {
      expect(migrationSrc).toContain(`"${e}"`);
    }
    expect(migrationSrc).toContain("IF NOT EXISTS (SELECT 1 FROM pg_type");
  });

  it("creates all five Phase 27.5 tables idempotently", () => {
    for (const t of [
      "governance_reconciliation_runs",
      "destruction_executions",
      "immutable_storage_checks",
      "governance_notifications",
      "governance_export_snapshots",
    ]) {
      expect(migrationSrc).toContain(t);
    }
    expect(migrationSrc).toContain("CREATE TABLE IF NOT EXISTS");
  });

  it("guards every FK with DO $$ pg_constraint $$ block (idempotent)", () => {
    expect(migrationSrc).toContain("DO $$");
    expect(migrationSrc).toContain("pg_constraint");
  });

  it("enforces (team_id, kind, dedupe_key) unique constraint", () => {
    expect(migrationSrc).toContain(
      "governance_notifications_team_kind_dedupe_unique",
    );
  });
});

// -----------------------------------------------------------------------------
// UI wording sweep
// -----------------------------------------------------------------------------

describe("Phase 27.5 — UI wording sweep", () => {
  const playful = ["oops", "yay", "let's go", "awesome", "🎉", "🚀", "love it"];
  const truthClaims = [
    "guaranteed",
    "tamper-proof",
    "100% authentic",
    "legally admissible",
    "court-ready",
  ];

  function assertCleanOf(rel: string) {
    const src = readSource(rel);
    const lower = src.toLowerCase();
    for (const p of playful) expect(lower).not.toContain(p);
    for (const p of truthClaims) expect(lower).not.toContain(p);
  }

  it("analytics page wording is enterprise-grade", () => {
    assertCleanOf(
      "../../../apps/web/app/(app)/governance/analytics/page.tsx",
    );
  });

  it("notifications page wording is enterprise-grade", () => {
    assertCleanOf(
      "../../../apps/web/app/(app)/governance/notifications/page.tsx",
    );
  });

  it("LifecycleIndicators component is enterprise-grade", () => {
    assertCleanOf(
      "../../../apps/web/components/governance/LifecycleIndicators.tsx",
    );
  });
});
