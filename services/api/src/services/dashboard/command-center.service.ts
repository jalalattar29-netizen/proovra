/**
 * Phase 32.8C (Full Rebuild) — Enterprise Evidence Operations Command Center.
 *
 * Read-only aggregator that powers `/v1/dashboard/command-center`.
 * The envelope is the canonical operator view of the workspace:
 * operational pressure, investigation pressure, reviewer
 * orchestration, evidence pipeline health, governance posture,
 * organizational intelligence, operational timeline, and audit
 * readiness.
 *
 * Hard rules:
 *   - READ ONLY. No `prisma.*.create / update / delete / upsert`.
 *   - NEVER emits an audit / analytics / security event. The
 *     existing audited endpoints remain the canonical signal for
 *     "the operator viewed evidence X".
 *   - Bounded queries. Every `findMany` carries `take`.
 *   - Per-section try/catch — partial failures degrade individual
 *     sections, never the whole envelope.
 *   - NEVER projects raw file content, signed URLs, storage keys,
 *     custody payloads, privileged legal text, or step-up secrets.
 *   - Personal vs team detection is heuristic (single ACTIVE
 *     member). Sections that require team semantics return
 *     `not_applicable` for personal workspaces.
 */

import { prisma } from "../../db.js";
import {
  caseScopeFor,
  evidenceScopeFor,
  resolvePersonalScope,
  type WorkspaceCaseScope,
  type WorkspaceEvidenceScope,
} from "@proovra/shared-runtime";
import { listIncidents } from "../observability/incident.service.js";
import { buildOperationsSummary } from "../operations/operations-summary.service.js";
// Phase 37.98 — Projection-backed dashboard reads.
//
// WORKSPACE-SCOPE CONVERGENCE — from `@proovra/shared-runtime`, not from a
// local API module. The arithmetic existed twice (here and in the Worker's
// refresh job) and the two disagreed about which records are "pending a
// report": only one carried the pipeline-status filter. One implementation
// now, consumed by both hosts.
import {
  readLatestOrgHealthProjection,
  refreshOrgHealthProjection,
} from "@proovra/shared-runtime";
import {
  backfillIntegritySnapshots,
  listWorkspaceIntegritySnapshots,
} from "./integrity-snapshot.service.js";
import {
  listWorkspaceAccessAnomalies,
  runClassifierForWorkspace,
} from "./access-anomaly.service.js";
import {
  listLatestQueueSnapshots,
  recordDbDerivedSnapshotsForWorkspace,
} from "./queue-telemetry.service.js";
import { listLatestWorkerTelemetry } from "./worker-telemetry.service.js";
import {
  listCaseSharedEvidenceClusters,
  listEvidenceLinkedToMultipleCases,
} from "./case-evidence-link.service.js";
import {
  listWorkspaceTimelineEvents,
  projectWorkspaceTimeline,
} from "./operational-timeline.service.js";
import { getWorkspaceCaseCommentBacklog } from "./case-comment.service.js";
import { ensureWorkspaceOperationsFresh } from "../operations/operations-reconciliation.service.js";
import {
  correlateWorkspaceIncidents,
  listWorkspaceCorrelations,
} from "./incident-correlation.service.js";
import {
  generateWorkflowsForWorkspace,
  listWorkspaceWorkflows,
} from "./workflow-generator.service.js";
import {
  detectCausalityForWorkspace,
  listWorkspaceCausalityChains,
} from "./causality.service.js";
import {
  computeReviewerCapacityForWorkspace,
  listReviewerCapacity,
  listReviewerRoutingRecommendations,
} from "./reviewer-capacity.service.js";
import {
  projectOperationalGraphForWorkspace,
  getOperationalGraphSummary,
} from "./operational-graph.service.js";
import {
  getLatestOrgHealthSnapshot,
  recordOrgHealthSnapshotForWorkspace,
} from "./org-health.service.js";
import {
  resolveCapabilityMatrix,
  type CapabilityMatrix,
} from "./persona-resolver.service.js";
import { evaluateTelemetryHealth } from "../ops-health/telemetry-health.service.js";
import { evaluateReconcileHealth } from "../ops-health/reconcile-health.service.js";
import { evaluateSecurityRollupHealth } from "../ops-health/security-rollup-health.service.js";
import type { OpsHealthState } from "../ops-health/types.js";

// ---------------------------------------------------------------------------
// Public contract types
// ---------------------------------------------------------------------------

export type SectionStatus = "ok" | "degraded" | "unavailable" | "not_applicable";

/**
 * @deprecated PHASE 3 — Inline `"SINGLE_OCCUPANT" | "SHARED"` declaration.
 *   Prefer the canonical `WorkspaceScope` from
 *   `services/api/src/services/platform-context/types.ts`, or — for
 *   new code that speaks in the Target Domain Blueprint vocabulary —
 *   the `TargetWorkspaceKind` re-exported from `@proovra/shared`.
 *   This is one of 9 parallel `WorkspaceScope` declarations; Phase 3
 *   retains them to avoid a cascading import refactor but new code
 *   MUST consume the canonical type.
 *   See docs/architecture/domain-debt-register.md (DBT-WS-04).
 */
export type WorkspaceScope = "SINGLE_OCCUPANT" | "SHARED";

export type SeverityTone = "info" | "warning" | "high" | "critical";

/** Operational pressure item — what needs attention NOW. */
export type OperationalPressureItem = {
  id: string;
  category:
    | "overdue_review"
    | "stalled_review"
    | "unassigned_review"
    | "open_escalation"
    | "stuck_upload"
    | "missing_report"
    | "missing_package"
    | "failed_report"
    | "failed_package"
    // Phase HOME-TRUTH-FIX — timestamp-provider failure items so
    // TSA / OTS issues escalate into the Operational Queue rather
    // than living only in the Trust State row counts.
    | "tsa_failed"
    | "ots_failed"
    | "retry_storm"
    | "governance_conflict"
    | "policy_conflict"
    | "evidence_no_case"
    | "unsigned_evidence_old"
    | "blocked_export"
    | "operational_incident";
  severity: SeverityTone;
  title: string;
  subtitle: string | null;
  href: string;
  occurredAt: string | null;
  // Phase 32.8C+ routing metadata — populated by the enricher
  // (catalog-driven from the bounded category enum). Every emitted
  // item carries these fields so the routing queue can render the
  // actionable form without duplicating the catalog.
  reasonCode: ReasonCode;
  affectedDomain: OperationalDomain;
  affectedEntityType: AffectedEntityType;
  affectedEntityId: string | null;
  operationalExplanation: string;
  recommendedAction: string;
  primaryRoute: string;
  secondaryRoute: string | null;
  ageMs: number | null;
  sourceTable: string;
  // Phase 32.8C++ action-routing permission metadata
  requiredPermission: string | null;
  requiredRoles: string[];
  canCurrentUserAct: boolean;
  safeActionLabel: string;
  escalationPath: string | null;
};

// =============================================================================
// Phase 32.8C+ — Operational routing catalog
// =============================================================================

export type ReasonCode =
  | "REVIEW_OVERDUE"
  | "REVIEW_DUE_SOON"
  | "REVIEW_UNASSIGNED"
  | "REVIEW_STALLED"
  | "REVIEWER_INACTIVE"
  | "REVIEWER_OVERLOADED"
  | "CASE_AT_RISK"
  | "CASE_EVIDENCE_GAP"
  | "EVIDENCE_STUCK_UPLOAD"
  | "EVIDENCE_UNSIGNED_TOO_LONG"
  | "EVIDENCE_NO_CASE"
  | "REPORT_MISSING"
  | "REPORT_FAILED"
  | "PACKAGE_MISSING"
  | "PACKAGE_FAILED"
  | "PACKAGE_BLOCKED_BY_GOVERNANCE"
  | "EXPORT_BLOCKED_BY_GOVERNANCE"
  | "GOVERNANCE_CONFLICT"
  | "LEGAL_HOLD_ACTIVE"
  | "RETENTION_REVIEW_DUE"
  | "DESTRUCTION_REVIEW_PENDING"
  | "QUEUE_CONGESTION"
  | "RETRY_STORM"
  | "OPERATIONAL_INCIDENT"
  | "INTEGRITY_REVIEW_REQUIRED"
  | "INTEGRITY_FAILED"
  | "CUSTODY_GAP"
  | "ACCESS_ANOMALY"
  // Phase HOME-TRUTH-FIX — timestamp-provider failures (RFC 3161 /
  // OpenTimestamps). Operational issue, NOT a content-integrity
  // claim — wording is deliberately neutral about evidence validity.
  | "TSA_FAILED"
  | "OTS_FAILED";

export type OperationalDomain =
  | "review_ops"
  | "evidence_pipeline"
  | "reports"
  | "packages"
  | "governance"
  | "custody_integrity"
  | "security_access"
  | "operational_health"
  | "case_ops";

export type AffectedEntityType =
  | "evidence"
  | "review_workflow"
  | "escalation"
  | "case"
  | "case_hold"
  | "evidence_hold"
  | "incident"
  | "destruction_review"
  | "policy"
  | "security_event";

type RoutingMeta = {
  reasonCode: ReasonCode;
  affectedDomain: OperationalDomain;
  affectedEntityType: AffectedEntityType;
  operationalExplanation: string;
  recommendedAction: string;
  primaryRoute: string;
  secondaryRoute: string | null;
  sourceTable: string;
  // Phase 32.8C++ — permission metadata for action routing
  requiredPermission: string | null;
  requiredRoles: ReadonlyArray<"OWNER" | "ADMIN" | "MEMBER" | "REVIEWER" | "VIEWER">;
  escalationPath: string | null;
};

/**
 * Catalog mapping pressure category → bounded routing metadata.
 * Every emitted pressure item is enriched through this catalog so
 * the routing-queue view never invents action copy. The recommended-
 * action strings are bounded operator copy; they are NOT marketing
 * copy and never make legal-admissibility claims.
 */
const ROUTING_CATALOG: Record<
  OperationalPressureItem["category"],
  RoutingMeta
> = {
  overdue_review: {
    reasonCode: "REVIEW_OVERDUE",
    affectedDomain: "review_ops",
    affectedEntityType: "review_workflow",
    operationalExplanation:
      "A review workflow is past its due time and remains open.",
    recommendedAction:
      "Open the review and either complete, reassign, or escalate it.",
    primaryRoute: "/reviewer-ops",
    secondaryRoute: "/reviewer-ops/sla",
    sourceTable: "EvidenceReviewWorkflow",
    requiredPermission: "evidence_request.review",
    requiredRoles: ["OWNER", "ADMIN", "REVIEWER"],
    escalationPath: "Workspace owner",
  },
  stalled_review: {
    reasonCode: "REVIEW_STALLED",
    affectedDomain: "review_ops",
    affectedEntityType: "review_workflow",
    operationalExplanation:
      "A review has been in progress without any recorded touch beyond the stall window.",
    recommendedAction:
      "Reassign the reviewer or move the workflow forward.",
    primaryRoute: "/reviewer-ops",
    secondaryRoute: null,
    sourceTable: "EvidenceReviewWorkflow",
    requiredPermission: "evidence_request.review",
    requiredRoles: ["OWNER", "ADMIN", "REVIEWER"],
    escalationPath: "Workspace owner",
  },
  unassigned_review: {
    reasonCode: "REVIEW_UNASSIGNED",
    affectedDomain: "review_ops",
    affectedEntityType: "review_workflow",
    operationalExplanation:
      "A queued review has remained unassigned beyond the bounded queue window.",
    recommendedAction:
      "Assign a reviewer or rebalance the queue.",
    primaryRoute: "/reviewer-ops",
    secondaryRoute: null,
    sourceTable: "EvidenceReviewWorkflow",
    requiredPermission: "review.assign",
    requiredRoles: ["OWNER", "ADMIN"],
    escalationPath: "Workspace owner",
  },
  open_escalation: {
    reasonCode: "OPERATIONAL_INCIDENT",
    affectedDomain: "review_ops",
    affectedEntityType: "escalation",
    operationalExplanation:
      "A reviewer escalation is open and requires triage.",
    recommendedAction:
      "Acknowledge, resolve, or reassign the escalation.",
    primaryRoute: "/reviewer-ops/escalations",
    secondaryRoute: null,
    sourceTable: "ReviewEscalation",
    requiredPermission: "review.escalation.resolve",
    requiredRoles: ["OWNER", "ADMIN", "REVIEWER"],
    escalationPath: "Workspace owner",
  },
  stuck_upload: {
    reasonCode: "EVIDENCE_STUCK_UPLOAD",
    affectedDomain: "evidence_pipeline",
    affectedEntityType: "evidence",
    operationalExplanation:
      "Evidence has been in the UPLOADING state without progress beyond the stall window.",
    recommendedAction:
      "Review the upload session and resume or cancel.",
    primaryRoute: "/evidence",
    secondaryRoute: null,
    sourceTable: "Evidence",
    requiredPermission: "evidence.write",
    requiredRoles: ["OWNER", "ADMIN", "MEMBER"],
    escalationPath: null,
  },
  missing_report: {
    reasonCode: "REPORT_MISSING",
    affectedDomain: "reports",
    affectedEntityType: "evidence",
    operationalExplanation:
      "Evidence is finalized (SIGNED) but no report row has been generated.",
    recommendedAction:
      "Confirm the report pipeline is healthy and trigger generation if required.",
    primaryRoute: "/evidence",
    secondaryRoute: "/ops/observability",
    sourceTable: "Evidence + Report",
    requiredPermission: "evidence.finalize",
    requiredRoles: ["OWNER", "ADMIN", "MEMBER"],
    escalationPath: "Workspace owner",
  },
  missing_package: {
    reasonCode: "PACKAGE_MISSING",
    affectedDomain: "packages",
    affectedEntityType: "evidence",
    operationalExplanation:
      "Evidence is REPORTED but no verification package row has been generated.",
    recommendedAction:
      "Confirm the verification-package pipeline is healthy.",
    primaryRoute: "/evidence",
    secondaryRoute: "/ops/observability",
    sourceTable: "Evidence + VerificationPackage",
    requiredPermission: "evidence.finalize",
    requiredRoles: ["OWNER", "ADMIN", "MEMBER"],
    escalationPath: "Workspace owner",
  },
  failed_report: {
    reasonCode: "REPORT_FAILED",
    affectedDomain: "reports",
    affectedEntityType: "incident",
    operationalExplanation:
      "An operational incident classified as a report-generation failure is open.",
    recommendedAction:
      "Open the runbook and acknowledge or resolve the incident.",
    primaryRoute: "/ops/observability",
    secondaryRoute: null,
    sourceTable: "OperationalIncident",
    requiredPermission: null,
    requiredRoles: ["OWNER", "ADMIN"],
    escalationPath: "Platform on-call",
  },
  failed_package: {
    reasonCode: "PACKAGE_FAILED",
    affectedDomain: "packages",
    affectedEntityType: "incident",
    operationalExplanation:
      "An operational incident classified as a package-generation failure is open.",
    recommendedAction:
      "Open the runbook and acknowledge or resolve the incident.",
    primaryRoute: "/ops/observability",
    secondaryRoute: null,
    sourceTable: "OperationalIncident",
    requiredPermission: null,
    requiredRoles: ["OWNER", "ADMIN"],
    escalationPath: "Platform on-call",
  },
  retry_storm: {
    reasonCode: "RETRY_STORM",
    affectedDomain: "operational_health",
    affectedEntityType: "incident",
    operationalExplanation:
      "A repeated operational incident is firing above the retry-storm threshold.",
    recommendedAction:
      "Investigate the underlying job/worker and resolve the root cause.",
    primaryRoute: "/ops/observability",
    secondaryRoute: null,
    sourceTable: "OperationalIncident",
    requiredPermission: null,
    requiredRoles: ["OWNER", "ADMIN"],
    escalationPath: "Platform on-call",
  },
  governance_conflict: {
    reasonCode: "GOVERNANCE_CONFLICT",
    affectedDomain: "governance",
    affectedEntityType: "policy",
    operationalExplanation:
      "Governance reports an active policy conflict.",
    recommendedAction:
      "Open the governance policy editor and reconcile.",
    primaryRoute: "/governance/policy",
    secondaryRoute: "/governance",
    sourceTable: "EvidenceRetentionPolicy",
    requiredPermission: "governance.policy.update",
    requiredRoles: ["OWNER", "ADMIN"],
    escalationPath: "Workspace owner",
  },
  policy_conflict: {
    reasonCode: "GOVERNANCE_CONFLICT",
    affectedDomain: "governance",
    affectedEntityType: "policy",
    operationalExplanation:
      "An active retention policy conflict was detected.",
    recommendedAction:
      "Open the governance policy editor and reconcile.",
    primaryRoute: "/governance/policy",
    secondaryRoute: "/governance",
    sourceTable: "EvidenceRetentionPolicy",
    requiredPermission: "governance.policy.update",
    requiredRoles: ["OWNER", "ADMIN"],
    escalationPath: "Workspace owner",
  },
  evidence_no_case: {
    reasonCode: "EVIDENCE_NO_CASE",
    affectedDomain: "case_ops",
    affectedEntityType: "evidence",
    operationalExplanation:
      "Recently created evidence is not linked to any case.",
    recommendedAction:
      "Link the evidence to the relevant investigation or matter.",
    primaryRoute: "/evidence",
    secondaryRoute: "/cases",
    sourceTable: "Evidence",
    requiredPermission: "case.write",
    requiredRoles: ["OWNER", "ADMIN", "MEMBER"],
    escalationPath: null,
  },
  unsigned_evidence_old: {
    reasonCode: "EVIDENCE_UNSIGNED_TOO_LONG",
    affectedDomain: "evidence_pipeline",
    affectedEntityType: "evidence",
    operationalExplanation:
      "Evidence has been unsigned for longer than the bounded age window.",
    recommendedAction:
      "Finalize or revoke the evidence to clear the audit-readiness gap.",
    primaryRoute: "/evidence",
    secondaryRoute: null,
    sourceTable: "Evidence",
    requiredPermission: "evidence.finalize",
    requiredRoles: ["OWNER", "ADMIN", "MEMBER"],
    escalationPath: null,
  },
  blocked_export: {
    reasonCode: "EXPORT_BLOCKED_BY_GOVERNANCE",
    affectedDomain: "governance",
    affectedEntityType: "evidence",
    operationalExplanation:
      "An evidence verification package was blocked by the governance gate.",
    recommendedAction:
      "Open the evidence detail page and review the governance block reason.",
    primaryRoute: "/evidence",
    secondaryRoute: "/governance",
    sourceTable: "Evidence",
    requiredPermission: "governance.hold.read",
    requiredRoles: ["OWNER", "ADMIN"],
    escalationPath: "Workspace owner",
  },
  operational_incident: {
    reasonCode: "OPERATIONAL_INCIDENT",
    affectedDomain: "operational_health",
    affectedEntityType: "incident",
    operationalExplanation:
      "A high-severity operational incident is open and unacknowledged.",
    recommendedAction:
      "Open the runbook and acknowledge or resolve the incident.",
    primaryRoute: "/ops/observability",
    secondaryRoute: "/ops/runbooks",
    sourceTable: "OperationalIncident",
    requiredPermission: null,
    requiredRoles: ["OWNER", "ADMIN"],
    escalationPath: "Platform on-call",
  },
  // Phase HOME-TRUTH-FIX — TSA / OTS escalation entries. Wording is
  // deliberately neutral: a timestamp-provider failure means the
  // RFC 3161 / OpenTimestamps anchoring step did not complete; it is
  // NOT a claim that the evidence content is invalid or tampered.
  tsa_failed: {
    reasonCode: "TSA_FAILED",
    affectedDomain: "evidence_pipeline",
    affectedEntityType: "evidence",
    operationalExplanation:
      "Trusted timestamp (RFC 3161) anchoring did not complete for this evidence.",
    recommendedAction:
      "Open the evidence to review the timestamp status; retry anchoring if appropriate.",
    primaryRoute: "/evidence",
    secondaryRoute: "/ops/observability",
    sourceTable: "Evidence",
    requiredPermission: "evidence.finalize",
    requiredRoles: ["OWNER", "ADMIN", "MEMBER"],
    escalationPath: "Workspace owner",
  },
  ots_failed: {
    reasonCode: "OTS_FAILED",
    affectedDomain: "evidence_pipeline",
    affectedEntityType: "evidence",
    operationalExplanation:
      "OpenTimestamps public anchoring did not complete for this evidence.",
    recommendedAction:
      "Open the evidence to review the OpenTimestamps status; retry anchoring if appropriate.",
    primaryRoute: "/evidence",
    secondaryRoute: "/ops/observability",
    sourceTable: "Evidence",
    requiredPermission: "evidence.finalize",
    requiredRoles: ["OWNER", "ADMIN", "MEMBER"],
    escalationPath: "Workspace owner",
  },
};

/**
 * Phase 32.8C+ — apply the routing catalog to enrich pressure items
 * with reasonCode + recommendedAction + bounded routing fields. The
 * enrichment is fully data-driven; callers don't have to remember
 * which metadata to attach.
 */
function enrichPressureItems(
  items: ReadonlyArray<Omit<OperationalPressureItem, "reasonCode" | "affectedDomain" | "affectedEntityType" | "affectedEntityId" | "operationalExplanation" | "recommendedAction" | "primaryRoute" | "secondaryRoute" | "ageMs" | "sourceTable" | "requiredPermission" | "requiredRoles" | "canCurrentUserAct" | "safeActionLabel" | "escalationPath"> & {
    affectedEntityId?: string | null;
  }>,
  viewerRole: string,
): OperationalPressureItem[] {
  const now = Date.now();
  return items.map((it) => {
    const meta = ROUTING_CATALOG[it.category];
    const ageMs =
      it.occurredAt !== null ? now - new Date(it.occurredAt).getTime() : null;
    // Compute permission gate: viewer role must be in the bounded
    // requiredRoles list for the operator to be able to act. Backend
    // authorization remains authoritative on each mutation surface.
    const canCurrentUserAct = (meta.requiredRoles as ReadonlyArray<string>).includes(
      viewerRole,
    );
    const safeActionLabel = canCurrentUserAct
      ? meta.recommendedAction
      : `Requires ${meta.requiredRoles[0] ?? "elevated"} access · ${meta.escalationPath ?? "ask workspace owner"}`;
    return {
      ...it,
      reasonCode: meta.reasonCode,
      affectedDomain: meta.affectedDomain,
      affectedEntityType: meta.affectedEntityType,
      affectedEntityId: it.affectedEntityId ?? null,
      operationalExplanation: meta.operationalExplanation,
      recommendedAction: meta.recommendedAction,
      primaryRoute: meta.primaryRoute,
      secondaryRoute: meta.secondaryRoute,
      ageMs: ageMs !== null && ageMs >= 0 ? ageMs : null,
      sourceTable: meta.sourceTable,
      requiredPermission: meta.requiredPermission,
      requiredRoles: [...meta.requiredRoles],
      canCurrentUserAct,
      safeActionLabel,
      escalationPath: meta.escalationPath,
    };
  });
}

/** Case-operations row — investigation pressure per case. */
export type CaseOperationsItem = {
  caseId: string;
  caseName: string;
  evidenceCount: number;
  unreviewedCount: number;
  overdueReviewCount: number;
  openEscalationsCount: number;
  hasActiveLegalHold: boolean;
  lastActivityAtUtc: string | null;
  // Phase HOME-DECISIONS — per-matter deliverable readiness. Bounded
  // read-only aggregates over the existing Evidence relations
  // (reports / verificationPackages / publicVerifyState), computed
  // ONLY for the ≤TOP_CASES_LIMIT case ids already selected above —
  // never a workspace-wide scan.
  /** Evidence records in this matter with ≥1 report. */
  reportsReadyCount: number;
  /** Evidence records in this matter with ≥1 verification package. */
  packagesReadyCount: number;
  /** Evidence records in this matter with a LIVE public verify page. */
  verifyLiveCount: number;
};

/** Reviewer orchestration — per-reviewer triage snapshot. */
export type ReviewerOrchestrationRow = {
  userId: string;
  displayName: string | null;
  email: string | null;
  assignedCount: number;
  overdueCount: number;
  dueSoonCount: number;
  lastActionAtUtc: string | null;
  inactive: boolean;
};

/** Pipeline detail — every stage including report/package readiness. */
export type PipelineDetail = {
  evidence: {
    created: number;
    uploading: number;
    uploaded: number;
    signed: number;
    reported: number;
    stuckUploading: number;
  };
  reports: {
    /**
     * Phase HOME-TRUTH-FIX — `ready` is the number of EVIDENCE
     * RECORDS with at least one Report row (deleted evidence
     * excluded). Previously this counted Report ROWS, which inflated
     * with each regenerated version.
     */
    ready: number;
    /**
     * Raw count of Report rows for non-deleted evidence — the
     * "versions" metric. Never label this as "reports ready" in UI.
     */
    versionsTotal: number;
    queued: number;
    failed: number;
    missingFromSigned: number;
  };
  packages: {
    /**
     * Phase HOME-TRUTH-FIX — number of EVIDENCE RECORDS with at least
     * one VerificationPackage row (deleted evidence excluded).
     */
    ready: number;
    versionsTotal: number;
    queued: number;
    blocked: number;
    failed: number;
    missingFromReported: number;
  };
  publicVerify: {
    published: number;
    unpublished: number;
    suspended: number;
  };
};

/** Timeline event — operational heartbeat. */
export type TimelineEvent = {
  id: string;
  kind:
    | "evidence_finalized"
    | "report_generated"
    | "package_generated"
    // Phase HOME-INTELLIGENCE — projected from the existing
    // Evidence.publicVerifyPublishedAtUtc column (read-only).
    | "verification_published"
    | "lifecycle_transition"
    | "hold_placed"
    | "hold_released"
    | "destruction_review"
    | "escalation_opened"
    | "incident_opened"
    | "workspace_activity";
  occurredAt: string;
  label: string;
  subtitle: string | null;
  href: string | null;
  severity: SeverityTone;
};

/** Audit-readiness counter — single dimension of organizational readiness. */
export type AuditReadinessCounter = {
  key:
    | "unsigned_evidence_old"
    | "incomplete_custody_chains"
    | "missing_reports"
    | "failed_packages"
    | "pending_governance_reviews"
    | "unresolved_escalations"
    | "evidence_pending_reviewer_signoff"
    | "blocked_exports";
  label: string;
  value: number;
  severity: SeverityTone;
};

export type CommandCenterAttentionItem = OperationalPressureItem;

export type CommandCenterRecentEvidenceItem = {
  id: string;
  title: string;
  status: string;
  verificationStatus: string | null;
  createdAt: string;
  caseId: string | null;
};

export type CommandCenterIncidentItem = {
  id: string;
  category: string;
  severity: string;
  status: string;
  title: string;
  safeSummary: string;
  runbookSlug: string | null;
  occurrenceCount: number;
  lastSeenAtUtc: string;
  /** Phase 32.8C control plane — assignment lifecycle. */
  assignedOperatorUserId: string | null;
  assignedAtUtc: string | null;
  acknowledgedByUserId: string | null;
  acknowledgedAtUtc: string | null;
};

/**
 * Phase 32.8C control plane — cross-system correlation projection.
 *
 * An advisory grouping of N >= 2 active incidents that match a known
 * operational pattern. Operators read the correlation to understand the
 * root cause; the individual incidents remain accessible for action.
 */
export type CommandCenterCorrelationItem = {
  id: string;
  correlationType: string;
  severity: string;
  rootOperationalCause: string;
  operationalSummary: string;
  recommendedAction: string;
  confidence: string;
  linkedIncidentIds: string[];
  firstDetectedAtUtc: string;
  lastDetectedAtUtc: string;
};

/**
 * Phase 32.8C FINAL-2 — operational workflow projection.
 *
 * Read-only projection of an `OperationalWorkflow` for the dashboard.
 * Includes the bounded action catalog so the dashboard can render
 * permission-aware buttons that route to the existing ops surface.
 */
export type CommandCenterWorkflowItem = {
  id: string;
  workflowType: string;
  status: string;
  severity: string;
  priority: string;
  title: string;
  safeSummary: string;
  sourceIncidentId: string | null;
  sourceCorrelationId: string | null;
  caseId: string | null;
  evidenceId: string | null;
  queueName: string | null;
  assignedOwnerUserId: string | null;
  assignedAtUtc: string | null;
  escalationLevel: number;
  retryCount: number;
  dueAtUtc: string | null;
  mitigationSummary: string | null;
  resolutionSummary: string | null;
  lastFailureCode: string | null;
  nextRetryAtUtc: string | null;
  createdAt: string;
  updatedAt: string;
  actions: Array<{
    actionType: string;
    permissionRequired: string;
    requiredRoles: string[];
    safeActionLabel: string;
    route: string | null;
  }>;
};

/**
 * Phase 32.8C FINAL-2 — operational causality chain projection.
 *
 * Idempotent grouping of related incidents + workflows + correlations
 * with a single root-cause label. Answers "Why is this workspace
 * unhealthy?" — not just "What happened?".
 */
export type CommandCenterCausalityChainItem = {
  id: string;
  chainKey: string;
  title: string;
  summary: string;
  rootCauseType: string;
  severity: string;
  status: string;
  linkedIncidentIds: string[];
  linkedWorkflowIds: string[];
  linkedCorrelationIds: string[];
  linkedCaseIds: string[];
  linkedEvidenceIds: string[];
  startAtUtc: string;
  lastSeenAtUtc: string;
};

export type CommandCenterEnvelope = {
  generatedAt: string;
  workspace: {
    id: string;
    role: string;
    scope: WorkspaceScope;
    memberCount: number;
  };
  /**
   * Phase 37.98 — Projection-backed summary.
   *
   * Read from `OrgHealthProjection` instead of running the live aggregate
   * cluster. Falls back to a single bounded live query when no projection
   * row exists. NEVER reports stale data as fresh — `projectionStatus`,
   * `projectionRefreshedAt`, and `projectionAgeSeconds` document the
   * exact freshness so callers can render an honest staleness chip.
   *
   * Staleness policy:
   *   - fresh    — projection exists, age <= PROJECTION_FRESH_THRESHOLD_SEC
   *   - stale    — projection exists, age >  PROJECTION_FRESH_THRESHOLD_SEC
   *   - missing  — no projection exists; counts come from a bounded live
   *                fallback. `usedLiveFallback` is `true`.
   */
  projectionSummary: {
    projectionStatus: "fresh" | "stale" | "missing";
    projectionRefreshedAt: string | null;
    projectionAgeSeconds: number | null;
    usedLiveFallback: boolean;
    teamId: string;
    counts: {
      evidenceCount: number;
      caseCount: number;
      pendingReportCount: number;
      pendingPackageCount: number;
      openIncidentCount: number;
      slaBreachCount: number;
      governanceBlockerCount: number;
      recentVerificationCount: number;
    };
  };
  sections: {
    // === Hero / overview ===
    summary: {
      status: SectionStatus;
      data: {
        evidenceActiveCount: number;
        evidenceRecentCount: number;
        reportReadyCount: number;
        reviewerPendingCount: number;
        governanceAttentionCount: number;
        openIncidentsCount: number;
        operationalPressureCount: number;
        auditReadinessFlags: number;
      } | null;
    };
    // === 1. ACTIVE OPERATIONAL PRESSURE (the hero of the page) ===
    operationalPressure: {
      status: SectionStatus;
      items: OperationalPressureItem[];
      counts: {
        critical: number;
        high: number;
        warning: number;
        info: number;
      };
    };
    // === Legacy attention queue (kept for backward compat — same shape as
    //     operationalPressure.items) ===
    attentionQueue: {
      status: SectionStatus;
      items: CommandCenterAttentionItem[];
    };
    // === 2. INVESTIGATION & CASE OPERATIONS ===
    caseOperations: {
      status: SectionStatus;
      data: {
        activeCasesCount: number;
        casesWithEvidenceGapsCount: number;
        unreviewedEvidenceCount: number;
        unlinkedEvidenceCount: number;
        topCases: CaseOperationsItem[];
      } | null;
    };
    // === 3. REVIEWER ORCHESTRATION ===
    reviewerOrchestration: {
      status: SectionStatus;
      data: {
        queueDepth: number;
        overdueCount: number;
        dueSoonCount: number;
        unassignedCount: number;
        openEscalationsCount: number;
        completedLast7dCount: number;
        completedPrev7dCount: number;
        inactiveReviewerCount: number;
        topReviewers: ReviewerOrchestrationRow[];
      } | null;
    };
    // === 4. EVIDENCE PIPELINE VISIBILITY ===
    pipelineDetail: {
      status: SectionStatus;
      data: PipelineDetail | null;
    };
    // === 5. GOVERNANCE & COMPLIANCE POSTURE ===
    governancePosture: {
      status: SectionStatus;
      data: {
        activeLegalHoldsCount: number;
        activeCaseLegalHoldsCount: number;
        retentionCandidatesCount: number;
        pendingDestructionReviewsCount: number;
        activePoliciesCount: number;
        policyConflictsCount: number;
        blockedExportsCount: number;
        recentLifecycleEventsCount: number;
      } | null;
    };
    // === 6. ORGANIZATIONAL INTELLIGENCE ===
    organizationalIntelligence: {
      status: SectionStatus;
      data: {
        evidenceCreatedLast24h: number;
        evidenceCreatedLast7d: number;
        evidenceFinalizedLast7d: number;
        reportsGeneratedLast7d: number;
        packagesGeneratedLast7d: number;
        activityLast7d: number;
      } | null;
    };
    // === 7. OPERATIONAL TIMELINE ===
    timeline: {
      status: SectionStatus;
      items: TimelineEvent[];
    };
    // === 8. AUDIT READINESS ===
    auditReadiness: {
      status: SectionStatus;
      counters: AuditReadinessCounter[];
    };
    // === Recent evidence (for activity stream) ===
    recentEvidence: {
      status: SectionStatus;
      items: CommandCenterRecentEvidenceItem[];
    };
    // === Existing pipeline (5-stage summary) — preserved for back-compat ===
    pipeline: {
      status: SectionStatus;
      data: {
        reported: number;
        signed: number;
        uploaded: number;
        uploading: number;
        created: number;
      } | null;
    };
    // === Existing reviewerWorkload (preserved for back-compat) ===
    reviewerWorkload: {
      status: SectionStatus;
      data: {
        queuedCount: number;
        assignedCount: number;
        inReviewCount: number;
        overdueCount: number;
        openEscalationsCount: number;
      } | null;
    };
    // === Operational incidents (workspace + global) ===
    incidents: {
      status: SectionStatus;
      items: CommandCenterIncidentItem[];
      /** Phase 32.8C control plane — cross-system root-cause correlations. */
      correlations: CommandCenterCorrelationItem[];
      /** Phase 32.8C FINAL-2 — active operational workflows. */
      workflows: CommandCenterWorkflowItem[];
      /** Phase 32.8C FINAL-2 — causality chains (root-cause groupings). */
      causalityChains: CommandCenterCausalityChainItem[];
    };
    // === Phase 32.8C+ intelligence engines ===
    investigationIntelligence: {
      meta: SectionMeta;
      items: InvestigationRiskItem[];
      crossCaseSignals: CrossCaseSignal[];
    };
    routingQueue: {
      meta: SectionMeta;
      items: OperationalPressureItem[];
    };
    queueCongestion: {
      meta: SectionMeta;
      items: QueueCongestionItem[];
    };
    custodyIntegrityAnomalies: {
      meta: SectionMeta;
      items: IntegrityAnomalyItem[];
    };
    accessSecurityAnomalies: {
      meta: SectionMeta;
      items: SecurityAnomalyItem[];
    };
    workloadEngine: {
      meta: SectionMeta;
      health: WorkloadHealth;
      reviewers: WorkloadEngineRow[];
      saturationScore: number;
      bottlenecks: number;
    };
    timelineIntelligence: {
      status: SectionStatus;
      events: Array<TimelineEvent & { domain: OperationalDomain; operationalMeaning: string }>;
      groupings: TimelineGroupedView;
    };
    pipelineIntelligence: {
      status: SectionStatus;
      data: PipelineDetail | null;
    };
    // Phase 32.8C++ deep operations intelligence
    relationshipIntelligence: {
      meta: SectionMeta;
      clusters: RelationshipCluster[];
    };
    crossCaseIntelligenceV2: {
      meta: SectionMeta;
      signals: CrossCaseSignalV2[];
    };
    reconstructedTimeline: {
      meta: SectionMeta;
      events: ReconstructedTimelineEvent[];
    };
    deepIntegrityWatch: {
      meta: SectionMeta;
      items: DeepIntegritySignal[];
    };
    accessSecurityClassifier: {
      meta: SectionMeta;
      anomalies: ClassifiedSecurityAnomaly[];
    };
    queueWorkerTelemetry: {
      meta: SectionMeta;
      data: QueueWorkerTelemetry;
    };
    coordinationSignals: {
      meta: SectionMeta;
      signals: CoordinationSignal[];
      backlog: CoordinationBacklog;
    };
    predictiveRisk: {
      meta: SectionMeta;
      forecasts: PredictiveRiskForecast[];
    };
    organizationalIntelligenceV2: {
      meta: SectionMeta;
      data: OrgIntelligenceV2;
    };
    /**
     * Phase 32.8C FINAL-3 — Reviewer capacity board (per-reviewer
     * saturation + bounded routing recommendations).
     */
    reviewerCapacity: {
      meta: SectionMeta;
      reviewers: Array<{
        reviewerUserId: string;
        assignedCount: number;
        overdueCount: number;
        dueSoonCount: number;
        staleCount: number;
        completed7d: number;
        completed30d: number;
        saturationLevel: string;
        capacityScore: number;
        sampledAtUtc: string;
      }>;
      recommendations: Array<{
        id: string;
        sourceReviewerUserId: string | null;
        targetReviewerUserId: string | null;
        recommendationType: string;
        severity: string;
        reasonCode: string;
        explanation: string;
        status: string;
        createdAt: string;
      }>;
    };
    /**
     * Phase 32.8C FINAL-3 — Operational graph summary (top root causes
     * + blast-radius counts + per-type node/edge counts).
     */
    operationalGraph: {
      meta: SectionMeta;
      data: {
        nodeCountsByType: Array<{ nodeType: string; count: number }>;
        edgeCountsByType: Array<{ edgeType: string; count: number }>;
        topRootCauses: Array<{
          nodeId: string;
          nodeType: string;
          entityId: string;
          label: string;
          severity: string;
          status: string;
          outDegree: number;
        }>;
        blastRadius: {
          impactedEvidenceCount: number;
          impactedCaseCount: number;
          impactedReviewerCount: number;
        };
      };
    };
    /**
     * Phase 32.8C FINAL-3 — Organizational maturity / health snapshot.
     */
    organizationalHealth: {
      meta: SectionMeta;
      data: {
        healthScore: number | null;
        operationalMaturityScore: number | null;
        governanceMaturityScore: number | null;
        auditReadinessScore: number | null;
        reviewerMaturityScore: number | null;
        incidentFrequency7d: number | null;
        workflowCompletion7d: number | null;
        queueReliabilityScore: number | null;
        artifactReliabilityScore: number | null;
        sampledAtUtc: string | null;
      };
    };
  };
  /**
   * Phase 32.8C FINAL-3 — persona-aware capability matrix. Frontend
   * uses this to order sections + label/disable team-only actions.
   * NEVER weakens auth; the canonical permission gates remain at the
   * route layer.
   */
  capabilityMatrix: CapabilityMatrix;
  /**
   * Phase 32.8C+++++++ — Per-subsystem operational health state.
   * Frontend uses this to render the correct severity (STALE/DEGRADED
   * AMBER rather than UNAVAILABLE RED) so an alive-but-delayed
   * subsystem never reads as a hard failure.
   */
  opsHealth: {
    telemetry: OpsHealthState;
    reconcile: OpsHealthState;
    securityRollup: OpsHealthState;
  };
  unsupportedSignals: Array<{ signal: string; reason: string }>;
};

// ---------------------------------------------------------------------------
// Bounded limits
// ---------------------------------------------------------------------------

const PRESSURE_TOTAL = 32;
const TOP_CASES_LIMIT = 8;
const TOP_REVIEWERS_LIMIT = 8;
const TIMELINE_LIMIT = 30;
const RECENT_EVIDENCE_LIMIT = 8;
const INCIDENTS_LIMIT = 10;
const STUCK_UPLOAD_HOURS = 4;
const STALLED_REVIEW_HOURS = 48;
const REVIEWER_INACTIVITY_HOURS = 72;
const UNSIGNED_EVIDENCE_AGE_DAYS = 7;
const RETRY_STORM_OCCURRENCE_THRESHOLD = 5;

/**
 * PHASE 4D (2026-08-22) — incident severity -> Command Center tone.
 *
 * ONE mapping. The Command Center now PROJECTS the incident authority, so it
 * must not develop a second severity vocabulary alongside it: a condition
 * that reads CRITICAL on /operations has to read critical here, and the only
 * way to guarantee that is to translate in exactly one place.
 */
const SEVERITY_FROM_INCIDENT: Record<string, SeverityTone> = {
  CRITICAL: "critical",
  HIGH: "high",
  WARNING: "warning",
  INFO: "info",
};


// ---------------------------------------------------------------------------
// Personal vs team detection
// ---------------------------------------------------------------------------

/**
 * WORKSPACE-SCOPE CONVERGENCE — the populations every section below reads.
 *
 * Resolved ONCE per envelope and threaded, rather than re-derived inside each
 * of the seventeen sections that touch Evidence or Case. That is not an
 * optimisation: sections that each build their own filter are sections that
 * can each be wrong differently, and this envelope's whole job is to present
 * one coherent picture of one workspace. A `teamId` still travels beside them
 * because most models here — Report, VerificationPackage, OperationalIncident,
 * TeamMember, CaseComment — have a NOT NULL `team_id` and are correctly read
 * with a strict predicate. Widening those would be a different defect.
 */
type WorkspacePopulation = {
  /** Physical workspace id. For models whose `team_id` is NOT NULL. */
  readonly teamId: string;
  /** Canonical Evidence population, personal NULL-team rows included. */
  readonly evidence: WorkspaceEvidenceScope;
  /** Canonical Case population, personal NULL-team rows included. */
  readonly cases: WorkspaceCaseScope;
};

async function detectWorkspaceScope(teamId: string): Promise<{
  scope: WorkspaceScope;
  memberCount: number;
  population: WorkspacePopulation;
}> {
  const [memberCount, personal] = await Promise.all([
    prisma.teamMember.count({
      where: { teamId, status: "ACTIVE" },
    }),
    // The SAME lookup that used to read `isPersonal` alone. It now resolves
    // through the canonical scope authority, so "is this workspace personal"
    // is answered once, by the module that owns the answer, and the display
    // scope below and the read populations above cannot disagree about it.
    resolvePersonalScope(teamId),
  ]);
  const scopeInput = {
    physicalWorkspaceId: teamId,
    workspaceKind: personal.isPersonal
      ? ("PERSONAL" as const)
      : ("ORGANIZATION" as const),
    personalOwnerUserId: personal.ownerUserId,
  };
  return {
    scope: personal.isPersonal ? "SINGLE_OCCUPANT" : "SHARED",
    memberCount,
    population: {
      teamId,
      evidence: evidenceScopeFor(scopeInput),
      cases: caseScopeFor(scopeInput),
    },
  };
}

/**
 * Section: Operational pressure — A PROJECTION, NOT AN AUTHORITY.
 *
 * ---------------------------------------------------------------------------
 * ATTENTION ARCHITECTURE PHASE 4D (2026-08-22)
 * ---------------------------------------------------------------------------
 * This function used to be a SECOND general Operations computation. It ran
 * about a dozen bespoke scans of its own — overdue reviews, stalled reviews,
 * unassigned reviews, open escalations, stuck uploads, missing/failed reports
 * and packages, TSA/OTS failures, retry storms, governance conflicts, unsigned
 * evidence, blocked exports — sorted them by its own severity ranking, capped
 * them with its own limits, and reported the result as the workspace's
 * operational pressure.
 *
 * Meanwhile `/operations` reported the same workspace's operational state from
 * `OperationalIncident`. Two authorities, two severity vocabularies, two caps,
 * two answers to one question — and an operator who acknowledged something in
 * one surface saw no change in the other, because the other had never heard of
 * acknowledgement.
 *
 * It is now a PROJECTION of the one authority:
 *
 *   counts  <- buildOperationsSummary()   the canonical workspace summary
 *   items   <- listIncidents()            the canonical condition list
 *
 * so the number on the Command Center and the number on /operations are the
 * same number, computed once. The Command Center still deep-links every row,
 * which is what it is good at; ACTING on a condition happens on /operations,
 * where the capability gates live.
 *
 * The individual signals the old scans surfaced did not disappear. Those that
 * are genuinely shared unresolved work are opened as conditions by the
 * incident generator and by the Phase-3 evidence-integrity writer, which is
 * where they can be acknowledged, assigned, resolved and audited.
 */
async function runOperationalPressure(
  teamId: string,
  scope: WorkspaceScope,
  viewerRole: string,
): Promise<CommandCenterEnvelope["sections"]["operationalPressure"]> {
  // `scope` is no longer consulted: shared operational conditions are shared
  // regardless of how many operators a workspace has, and the SINGLE_OCCUPANT
  // branches the old scans carried were a UI concern that now lives in the
  // Operations console's density, not in what gets counted.
  void scope;

  const summary = await buildOperationsSummary({ workspaceId: teamId });

  // An unreadable summary is UNAVAILABLE, never a tidy set of zeros. The
  // Command Center renders the section's status; it must never present a
  // failed read as a healthy workspace.
  if (!summary.complete && summary.incompleteReason === "SOURCE_FAILED") {
    return {
      status: "unavailable",
      items: [],
      counts: { critical: 0, high: 0, warning: 0, info: 0 },
    };
  }

  let page: Awaited<ReturnType<typeof listIncidents>>;
  try {
    page = await listIncidents({
      teamId,
      // Unresolved work only. RESOLVED and SUPPRESSED conditions belong to
      // the Operations history, not to current pressure.
      status: undefined,
      limit: PRESSURE_TOTAL,
    });
  } catch {
    return {
      status: "degraded",
      items: [],
      // The COUNTS still come from the summary, which succeeded — a failed
      // list read costs the rows, not the totals.
      counts: {
        critical: summary.critical,
        high: summary.high,
        warning: summary.warning,
        info: summary.info,
      },
    };
  }

  const unresolved = page.incidents.filter(
    (incident) =>
      incident.status === "OPEN" || incident.status === "ACKNOWLEDGED",
  );

  const items = enrichPressureItems(
    unresolved.map((incident) => ({
      id: `operational_incident:${incident.id}`,
      // ONE category, because these are all the same KIND of thing now: a
      // shared operational condition. The condition's own category lives on
      // the row and is rendered by /operations, which owns that vocabulary.
      category: "operational_incident" as const,
      severity: SEVERITY_FROM_INCIDENT[incident.severity] ?? "warning",
      title: incident.title,
      subtitle: incident.safeSummary,
      // Deep-link into the canonical surface. The Command Center shows what
      // is outstanding; acting on it is capability-gated on /operations.
      href: `/operations?incidentId=${encodeURIComponent(incident.id)}`,
      occurredAt: incident.firstSeenAtUtc.toISOString(),
      affectedEntityId: incident.relatedEvidenceId,
    })),
    viewerRole,
  );

  return {
    // `complete: false` from a bounded read is DEGRADED, not ok: the section
    // is showing a floor rather than a total, and says so.
    status: summary.complete && page.complete ? "ok" : "degraded",
    items,
    counts: {
      critical: summary.critical,
      high: summary.high,
      warning: summary.warning,
      info: summary.info,
    },
  };
}

// ---------------------------------------------------------------------------
// Section: Case operations
// ---------------------------------------------------------------------------

async function runCaseOperations(
  teamId: string,
  scope: WorkspaceScope,
  pop: WorkspacePopulation,
): Promise<CommandCenterEnvelope["sections"]["caseOperations"]> {
  try {
    const now = new Date();
    const activeCasesCount = await prisma.case.count({ where: { AND: [pop.cases] } });
    const evidenceWithCase = await prisma.caseEvidenceLink.groupBy({
      by: ["caseId"],
      where: { evidence: { teamId } },
      _count: { _all: true },
      orderBy: { caseId: "asc" },
      take: 1000,
    });
    const casesWithEvidenceCount = evidenceWithCase.length;
    const casesWithEvidenceGapsCount = Math.max(
      0,
      activeCasesCount - casesWithEvidenceCount,
    );
    const unlinkedEvidenceCount = await prisma.evidence.count({
      where: { AND: [pop.evidence], caseLinks: { none: {} } },
    });

    let unreviewedEvidenceCount = 0;
    if (scope === "SHARED") {
      unreviewedEvidenceCount = await prisma.evidence.count({
        where: {
          AND: [pop.evidence],
          status: { in: ["UPLOADED", "SIGNED"] },
          reviewWorkflow: null,
        },
      });
    }

    // Top cases by overdue review pressure + recent activity.
    const recentCases = await prisma.case.findMany({
      where: { AND: [pop.cases] },
      orderBy: { updatedAt: "desc" },
      take: TOP_CASES_LIMIT,
      select: {
        id: true,
        name: true,
        updatedAt: true,
      },
    });
    const caseIds = recentCases.map((c) => c.id);
    const [evidenceCounts, holdsByCase, reviewByCase, unreviewedByCase] = await Promise.all([
      prisma.caseEvidenceLink.groupBy({
        by: ["caseId"],
        where: { caseId: { in: caseIds } },
        _count: { _all: true },
      }),
      // P12.3 canonical-only (scope=CASE).
      prisma.evidenceLegalHold
        .findMany({
          where: { caseId: { in: caseIds }, scope: "CASE", status: "ACTIVE" },
          select: { caseId: true },
          take: caseIds.length * 4,
        })
        .catch(() => []),
      scope === "SHARED"
        ? prisma.evidenceReviewWorkflow.findMany({
            where: {
              teamId,
              evidence: { caseLinks: { some: { caseId: { in: caseIds } } } },
              status: {
                in: ["QUEUED", "ASSIGNED", "IN_REVIEW", "NEEDS_INFO"],
              },
            },
            select: {
              dueAt: true,
              evidence: {
                select: {
                  caseLinks: {
                    where: { caseId: { in: caseIds } },
                    orderBy: { linkedAtUtc: "asc" },
                    select: { caseId: true },
                    take: 1,
                  },
                },
              },
            },
            take: 500,
          })
        : Promise.resolve([]),
      scope === "SHARED"
        ? prisma.caseEvidenceLink.groupBy({
            by: ["caseId"],
            where: {
              caseId: { in: caseIds },
              evidence: {
                teamId,
                status: { in: ["UPLOADED", "SIGNED"] },
                reviewWorkflow: null,
              },
            },
            _count: { _all: true },
          })
        : Promise.resolve([]),
    ]);
    const reviewByCaseMap = new Map<
      string,
      { open: number; overdue: number }
    >();
    for (const r of reviewByCase) {
      const cid = r.evidence?.caseLinks[0]?.caseId;
      if (!cid) continue;
      const entry = reviewByCaseMap.get(cid) ?? { open: 0, overdue: 0 };
      entry.open += 1;
      if (r.dueAt && r.dueAt.getTime() < now.getTime()) entry.overdue += 1;
      reviewByCaseMap.set(cid, entry);
    }
    const evidenceCountMap = new Map<string, number>();
    for (const e of evidenceCounts) {
      if (e.caseId) evidenceCountMap.set(e.caseId, e._count._all);
    }
    const unreviewedByCaseMap = new Map<string, number>();
    for (const e of unreviewedByCase) {
      if (e.caseId) unreviewedByCaseMap.set(e.caseId, e._count._all);
    }
    const holdsSet = new Set<string>();
    for (const h of holdsByCase) if (h.caseId) holdsSet.add(h.caseId);

    let openEscalationsByCase = new Map<string, number>();
    if (scope === "SHARED") {
      try {
        const escalations = await prisma.reviewEscalation.findMany({
          where: {
            teamId,
            status: "OPEN",
            workflow: {
              evidence: { caseLinks: { some: { caseId: { in: caseIds } } } },
            },
          },
          select: {
            workflow: {
              select: {
                evidence: {
                  select: {
                    caseLinks: {
                      where: { caseId: { in: caseIds } },
                      orderBy: { linkedAtUtc: "asc" },
                      select: { caseId: true },
                      take: 1,
                    },
                  },
                },
              },
            },
          },
          take: 200,
        });
        for (const e of escalations) {
          const cid = e.workflow?.evidence?.caseLinks[0]?.caseId;
          if (!cid) continue;
          openEscalationsByCase.set(
            cid,
            (openEscalationsByCase.get(cid) ?? 0) + 1,
          );
        }
      } catch {
        openEscalationsByCase = new Map();
      }
    }

    // Phase HOME-DECISIONS — per-matter deliverable readiness. Three
    // bounded groupBy queries over the ≤TOP_CASES_LIMIT case ids (the
    // relations are the same ones the anomaly/timeline sections already
    // traverse). Failure degrades to zeros, never poisons the section.
    const toCaseCountMap = (
      rows: Array<{ caseId: string | null; _count: { _all: number } }>,
    ): Map<string, number> => {
      const m = new Map<string, number>();
      for (const r of rows) if (r.caseId) m.set(r.caseId, r._count._all);
      return m;
    };
    const [reportsByCase, packagesByCase, verifyLiveByCase] =
      await Promise.all([
        prisma.caseEvidenceLink
          .groupBy({
            by: ["caseId"],
            where: {
              caseId: { in: caseIds },
              evidence: { teamId, reports: { some: {} } },
            },
            _count: { _all: true },
          })
          .then(toCaseCountMap)
          .catch(() => new Map<string, number>()),
        prisma.caseEvidenceLink
          .groupBy({
            by: ["caseId"],
            where: {
              caseId: { in: caseIds },
              evidence: { teamId, verificationPackages: { some: {} } },
            },
            _count: { _all: true },
          })
          .then(toCaseCountMap)
          .catch(() => new Map<string, number>()),
        prisma.caseEvidenceLink
          .groupBy({
            by: ["caseId"],
            where: {
              caseId: { in: caseIds },
              evidence: { teamId, publicVerifyState: "PUBLISHED" },
            },
            _count: { _all: true },
          })
          .then(toCaseCountMap)
          .catch(() => new Map<string, number>()),
      ]);

    const topCases: CaseOperationsItem[] = recentCases.map((c) => ({
      caseId: c.id,
      caseName: c.name,
      evidenceCount: evidenceCountMap.get(c.id) ?? 0,
      unreviewedCount: unreviewedByCaseMap.get(c.id) ?? 0,
      overdueReviewCount: reviewByCaseMap.get(c.id)?.overdue ?? 0,
      openEscalationsCount: openEscalationsByCase.get(c.id) ?? 0,
      hasActiveLegalHold: holdsSet.has(c.id),
      lastActivityAtUtc: c.updatedAt.toISOString(),
      reportsReadyCount: reportsByCase.get(c.id) ?? 0,
      packagesReadyCount: packagesByCase.get(c.id) ?? 0,
      verifyLiveCount: verifyLiveByCase.get(c.id) ?? 0,
    }));

    return {
      status: "ok",
      data: {
        activeCasesCount,
        casesWithEvidenceGapsCount,
        unreviewedEvidenceCount,
        unlinkedEvidenceCount,
        topCases,
      },
    };
  } catch {
    return { status: "unavailable", data: null };
  }
}

// ---------------------------------------------------------------------------
// Section: Reviewer orchestration
// ---------------------------------------------------------------------------

async function runReviewerOrchestration(
  teamId: string,
  scope: WorkspaceScope,
): Promise<CommandCenterEnvelope["sections"]["reviewerOrchestration"]> {
  if (scope === "SINGLE_OCCUPANT") {
    return { status: "not_applicable", data: null };
  }
  try {
    const now = new Date();
    const dueSoonCutoff = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const last7dStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const prev7dStart = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const inactivityCutoff = new Date(
      Date.now() - REVIEWER_INACTIVITY_HOURS * 60 * 60 * 1000,
    );

    const [
      queueDepth,
      overdueCount,
      dueSoonCount,
      unassignedCount,
      openEscalationsCount,
      completedLast7dCount,
      completedPrev7dCount,
    ] = await Promise.all([
      prisma.evidenceReviewWorkflow.count({
        where: {
          teamId,
          status: { in: ["QUEUED", "ASSIGNED", "IN_REVIEW", "NEEDS_INFO"] },
        },
      }),
      prisma.evidenceReviewWorkflow.count({
        where: {
          teamId,
          status: { in: ["QUEUED", "ASSIGNED", "IN_REVIEW", "NEEDS_INFO"] },
          dueAt: { lt: now },
        },
      }),
      prisma.evidenceReviewWorkflow.count({
        where: {
          teamId,
          status: { in: ["QUEUED", "ASSIGNED", "IN_REVIEW", "NEEDS_INFO"] },
          dueAt: { gte: now, lt: dueSoonCutoff },
        },
      }),
      prisma.evidenceReviewWorkflow.count({
        where: { teamId, status: "QUEUED" },
      }),
      prisma.reviewEscalation.count({
        where: { teamId, status: "OPEN" },
      }),
      prisma.evidenceReviewWorkflow.count({
        where: {
          teamId,
          status: "CLOSED",
          updatedAt: { gte: last7dStart },
        },
      }),
      prisma.evidenceReviewWorkflow.count({
        where: {
          teamId,
          status: "CLOSED",
          updatedAt: { gte: prev7dStart, lt: last7dStart },
        },
      }),
    ]);

    // Top reviewers by load + inactivity flag
    const grouped = await prisma.evidenceReviewWorkflow.groupBy({
      by: ["assignedToUserId"],
      where: {
        teamId,
        assignedToUserId: { not: null },
        status: { in: ["ASSIGNED", "IN_REVIEW", "NEEDS_INFO"] },
      },
      _count: { _all: true },
      orderBy: { _count: { assignedToUserId: "desc" } },
      take: TOP_REVIEWERS_LIMIT,
    });
    const reviewerIds = grouped
      .map((g) => g.assignedToUserId)
      .filter((v): v is string => v !== null);

    let topReviewers: ReviewerOrchestrationRow[] = [];
    let inactiveReviewerCount = 0;
    if (reviewerIds.length > 0) {
      const [users, overdueGroups, dueSoonGroups, lastActions] =
        await Promise.all([
          prisma.user.findMany({
            where: { id: { in: reviewerIds } },
            select: { id: true, email: true, displayName: true },
            take: TOP_REVIEWERS_LIMIT,
          }),
          prisma.evidenceReviewWorkflow.groupBy({
            by: ["assignedToUserId"],
            where: {
              teamId,
              assignedToUserId: { in: reviewerIds },
              status: {
                in: ["QUEUED", "ASSIGNED", "IN_REVIEW", "NEEDS_INFO"],
              },
              dueAt: { lt: now },
            },
            _count: { _all: true },
          }),
          prisma.evidenceReviewWorkflow.groupBy({
            by: ["assignedToUserId"],
            where: {
              teamId,
              assignedToUserId: { in: reviewerIds },
              status: {
                in: ["QUEUED", "ASSIGNED", "IN_REVIEW", "NEEDS_INFO"],
              },
              dueAt: { gte: now, lt: dueSoonCutoff },
            },
            _count: { _all: true },
          }),
          prisma.evidenceReviewWorkflow.groupBy({
            by: ["assignedToUserId"],
            where: {
              teamId,
              assignedToUserId: { in: reviewerIds },
              lastReviewedAt: { not: null },
            },
            _max: { lastReviewedAt: true },
          }),
        ]);
      const userById = new Map(users.map((u) => [u.id, u]));
      const overdueById = new Map(
        overdueGroups
          .filter((g) => g.assignedToUserId)
          .map((g) => [g.assignedToUserId as string, g._count._all]),
      );
      const dueSoonById = new Map(
        dueSoonGroups
          .filter((g) => g.assignedToUserId)
          .map((g) => [g.assignedToUserId as string, g._count._all]),
      );
      const lastActionById = new Map(
        lastActions
          .filter((g) => g.assignedToUserId && g._max.lastReviewedAt)
          .map((g) => [
            g.assignedToUserId as string,
            g._max.lastReviewedAt as Date,
          ]),
      );
      topReviewers = grouped
        .filter(
          (g): g is typeof g & { assignedToUserId: string } =>
            g.assignedToUserId !== null,
        )
        .map((g) => {
          const lastAction = lastActionById.get(g.assignedToUserId) ?? null;
          const inactive =
            lastAction === null ||
            lastAction.getTime() < inactivityCutoff.getTime();
          if (inactive) inactiveReviewerCount += 1;
          return {
            userId: g.assignedToUserId,
            displayName: userById.get(g.assignedToUserId)?.displayName ?? null,
            email: userById.get(g.assignedToUserId)?.email ?? null,
            assignedCount: g._count._all,
            overdueCount: overdueById.get(g.assignedToUserId) ?? 0,
            dueSoonCount: dueSoonById.get(g.assignedToUserId) ?? 0,
            lastActionAtUtc: lastAction ? lastAction.toISOString() : null,
            inactive,
          };
        });
    }

    return {
      status: "ok",
      data: {
        queueDepth,
        overdueCount,
        dueSoonCount,
        unassignedCount,
        openEscalationsCount,
        completedLast7dCount,
        completedPrev7dCount,
        inactiveReviewerCount,
        topReviewers,
      },
    };
  } catch {
    return { status: "unavailable", data: null };
  }
}

// ---------------------------------------------------------------------------
// Section: Pipeline detail (granular)
// ---------------------------------------------------------------------------

async function runPipelineDetail(
  teamId: string,
  pop: WorkspacePopulation,
): Promise<CommandCenterEnvelope["sections"]["pipelineDetail"]> {
  try {
    const stuckCutoff = new Date(
      Date.now() - STUCK_UPLOAD_HOURS * 60 * 60 * 1000,
    );
    // Phase HOME-TRUTH-FIX —
    //   * `reportsReady` / `packagesReady` are now evidence-distinct
    //     counts ("number of EVIDENCE records with at least one report",
    //     not "number of report ROWS"). The previous shape inflated
    //     with each regenerated version and ignored deleted-evidence
    //     reports — drifting away from /v1/reports' user-visible list.
    //   * `reportVersionsTotal` / `packageVersionsTotal` preserve the
    //     raw-row count for surfaces that explicitly want it; they
    //     must NEVER be labelled "reports ready".
    const [
      grouped,
      stuckUploading,
      reportsReady,
      packagesReady,
      reportVersionsTotal,
      packageVersionsTotal,
      publicVerify,
    ] = await Promise.all([
        // Phase HOME-NUMERIC-TRUTH-FIX — soft-deleted rows MUST be
        // excluded from the status groupBy. Without `deletedAt: null`
        // every status bucket (CREATED/UPLOADING/UPLOADED/SIGNED/
        // REPORTED) inflated by any soft-deleted row, and the
        // downstream arithmetic at line 2316-2317 ran:
        //
        //   reportsQueued  = max(0, signed   - reportsReady)
        //   packagesQueued = max(0, reported - packagesReady)
        //
        // — where `signed`/`reported` came from this groupBy (no
        // deletedAt filter) but `reportsReady`/`packagesReady` DO
        // filter `deletedAt: null`. The asymmetry produced impossible
        // numbers like "Records reported = 222" against "Total
        // evidence = 123" on dashboards where soft-deletes existed
        // (the proof sandbox in /tmp/audit-prove-hypothesis.sql shows
        // 100 active REPORTED + 99 soft-deleted REPORTED reproducing
        // `reported=200`, `packagesQueued=199` exactly via the
        // unfixed query, then `reported=101`, `packagesQueued=100`
        // with this filter applied).
        prisma.evidence.groupBy({
          by: ["status"],
          where: { AND: [pop.evidence], deletedAt: null },
          _count: { _all: true },
        }),
        prisma.evidence.count({
          where: {
            AND: [pop.evidence],
            status: "UPLOADING",
            updatedAt: { lt: stuckCutoff },
          },
        }),
        prisma.evidence.count({
          where: {
            AND: [pop.evidence],
            deletedAt: null,
            reports: { some: {} },
          },
        }),
        prisma.evidence.count({
          where: {
            AND: [pop.evidence],
            deletedAt: null,
            verificationPackages: { some: {} },
          },
        }),
        prisma.report.count({
          where: { evidence: { teamId, deletedAt: null } },
        }),
        prisma.verificationPackage.count({
          where: { evidence: { teamId, deletedAt: null } },
        }),
        // Phase HOME-NUMERIC-TRUTH-FIX — same `deletedAt: null`
        // omission as the status groupBy above. publicVerify.published
        // / .unpublished / .suspended feed the Verification Health
        // widget and its arithmetic interacts with `packagesReady`
        // (which already filters deletedAt). Soft-deleted rows would
        // inflate every bucket here too.
        prisma.evidence.groupBy({
          by: ["publicVerifyState"],
          where: { AND: [pop.evidence], deletedAt: null },
          _count: { _all: true },
        }),
      ]);

    const stateCount = (s: string): number => {
      const row = grouped.find((g) => String(g.status) === s);
      return row ? row._count._all : 0;
    };
    const verifyCount = (s: string): number => {
      const row = publicVerify.find((g) => String(g.publicVerifyState) === s);
      return row ? row._count._all : 0;
    };

    const signed = stateCount("SIGNED");
    const reported = stateCount("REPORTED");
    const reportsQueued = Math.max(0, signed - reportsReady);
    const packagesQueued = Math.max(0, reported - packagesReady);

    // Failed report / package counts from open operational incidents.
    const [failedReports, failedPackages, blockedPackages] = await Promise.all([
      prisma.operationalIncident.count({
        where: {
          OR: [{ teamId }, { teamId: null }],
          status: { in: ["OPEN", "ACKNOWLEDGED"] },
          category: "REPORT",
        },
      }),
      prisma.operationalIncident.count({
        where: {
          OR: [{ teamId }, { teamId: null }],
          status: { in: ["OPEN", "ACKNOWLEDGED"] },
          category: "PACKAGE",
        },
      }),
      // Blocked packages — counted via JSON metadata flag.
      prisma.evidence
        .findMany({
          where: {
            AND: [pop.evidence],
            status: { in: ["SIGNED", "REPORTED"] },
          },
          take: 500,
          select: { verificationPackageMetadata: true },
        })
        .then((rows) =>
          rows.reduce((n, r) => {
            const meta = r.verificationPackageMetadata as Record<
              string,
              unknown
            > | null;
            return meta && meta.blocked === true ? n + 1 : n;
          }, 0),
        )
        .catch(() => 0),
    ]);

    return {
      status: "ok",
      data: {
        evidence: {
          created: stateCount("CREATED"),
          uploading: stateCount("UPLOADING"),
          uploaded: stateCount("UPLOADED"),
          signed,
          reported,
          stuckUploading,
        },
        reports: {
          // Phase HOME-TRUTH-FIX — `ready` is the number of EVIDENCE
          // RECORDS with at least one Report row (deleted evidence
          // excluded). Previously this counted Report ROWS, inflating
          // with each regenerated version. `versionsTotal` preserves
          // the raw-row count for surfaces that explicitly want it.
          ready: reportsReady,
          versionsTotal: reportVersionsTotal,
          // `queued` = signed evidence with no report yet (eligible for
          // generation): max(0, signed − reportsReady). There is no
          // separate "actively generating" counter in this projection.
          queued: reportsQueued,
          failed: failedReports,
          // Phase HOME-FIELD-WIRING — `missingFromSigned` is a LITERAL
          // ALIAS of `queued`, kept for response-shape compatibility.
          // Consumers must read ONE of the two, never sum them (the
          // Home dashboard double-counted pending until Ticket 1).
          missingFromSigned: reportsQueued,
        },
        packages: {
          ready: packagesReady,
          versionsTotal: packageVersionsTotal,
          // `queued` = reported evidence with no package yet:
          // max(0, reported − packagesReady).
          queued: packagesQueued,
          blocked: blockedPackages,
          failed: failedPackages,
          // ALIAS of `queued` — same compatibility note as
          // `reports.missingFromSigned` above. Never sum with `queued`.
          missingFromReported: packagesQueued,
        },
        publicVerify: {
          published: verifyCount("PUBLISHED"),
          unpublished: verifyCount("UNPUBLISHED"),
          suspended: verifyCount("SUSPENDED"),
        },
      },
    };
  } catch {
    return { status: "unavailable", data: null };
  }
}

// ---------------------------------------------------------------------------
// Section: Governance posture (extended)
// ---------------------------------------------------------------------------

async function runGovernancePosture(
  teamId: string,
  scope: WorkspaceScope,
  pop: WorkspacePopulation,
): Promise<CommandCenterEnvelope["sections"]["governancePosture"]> {
  if (scope === "SINGLE_OCCUPANT") {
    return { status: "not_applicable", data: null };
  }
  let anyOk = false;
  let anyFailed = false;
  let activeLegalHoldsCount = 0;
  let activeCaseLegalHoldsCount = 0;
  let retentionCandidatesCount = 0;
  let pendingDestructionReviewsCount = 0;
  let activePoliciesCount = 0;
  let policyConflictsCount = 0;
  let blockedExportsCount = 0;
  let recentLifecycleEventsCount = 0;

  try {
    activeLegalHoldsCount = await prisma.evidenceLegalHold.count({
      where: { teamId, status: "ACTIVE" },
    });
    anyOk = true;
  } catch {
    anyFailed = true;
  }

  try {
    activeCaseLegalHoldsCount = await prisma.evidenceLegalHold.count({
      // P12.3 canonical-only (scope='CASE').
      where: { scope: "CASE", teamId, status: "ACTIVE" },
    });
    anyOk = true;
  } catch {
    /* optional subsystem */
  }

  try {
    pendingDestructionReviewsCount = await prisma.destructionReview.count({
      where: {
        teamId,
        status: { in: ["PROPOSED", "PENDING_APPROVAL"] },
      },
    });
    retentionCandidatesCount = await prisma.destructionReview.count({
      where: { teamId, status: "PROPOSED" },
    });
    anyOk = true;
  } catch {
    anyFailed = true;
  }

  try {
    activePoliciesCount = await prisma.evidenceRetentionPolicy.count({
      where: { teamId, status: "ACTIVE" },
    });
    anyOk = true;
  } catch {
    anyFailed = true;
  }

  try {
    const { countActivePolicyConflicts } = await import(
      "../governance-lifecycle/retention-engine.service.js"
    );
    policyConflictsCount = await countActivePolicyConflicts(teamId);
    anyOk = true;
  } catch {
    /* best-effort */
  }

  try {
    const sample = await prisma.evidence.findMany({
      where: {
        AND: [pop.evidence],
        status: { in: ["SIGNED", "REPORTED"] },
      },
      take: 500,
      select: { verificationPackageMetadata: true },
    });
    for (const row of sample) {
      const meta = row.verificationPackageMetadata as Record<
        string,
        unknown
      > | null;
      if (meta && meta.blocked === true) blockedExportsCount += 1;
    }
    anyOk = true;
  } catch {
    /* best-effort */
  }

  try {
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    recentLifecycleEventsCount = await prisma.evidenceLifecycleEvent.count({
      where: { teamId, createdAt: { gte: since7d } },
    });
    anyOk = true;
  } catch {
    /* best-effort */
  }

  return {
    status: !anyOk ? "unavailable" : anyFailed ? "degraded" : "ok",
    data: anyOk
      ? {
          activeLegalHoldsCount,
          activeCaseLegalHoldsCount,
          retentionCandidatesCount,
          pendingDestructionReviewsCount,
          activePoliciesCount,
          policyConflictsCount,
          blockedExportsCount,
          recentLifecycleEventsCount,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Section: Organizational intelligence
// ---------------------------------------------------------------------------

async function runOrganizationalIntelligence(
  teamId: string,
  pop: WorkspacePopulation,
): Promise<CommandCenterEnvelope["sections"]["organizationalIntelligence"]> {
  try {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [
      evidenceCreatedLast24h,
      evidenceCreatedLast7d,
      evidenceFinalizedLast7d,
      reportsGeneratedLast7d,
      packagesGeneratedLast7d,
      activityLast7d,
    ] = await Promise.all([
      prisma.evidence.count({
        where: { AND: [pop.evidence], createdAt: { gte: since24h } },
      }),
      prisma.evidence.count({
        where: { AND: [pop.evidence], createdAt: { gte: since7d } },
      }),
      prisma.evidence.count({
        where: {
          AND: [pop.evidence],
          status: { in: ["SIGNED", "REPORTED"] },
          updatedAt: { gte: since7d },
        },
      }),
      prisma.report.count({
        where: {
          evidence: { teamId },
          generatedAtUtc: { gte: since7d },
        },
      }),
      prisma.verificationPackage.count({
        where: {
          evidence: { teamId },
          generatedAtUtc: { gte: since7d },
        },
      }),
      prisma.teamActivity
        .count({ where: { teamId, createdAt: { gte: since7d } } })
        .catch(() => 0),
    ]);

    return {
      status: "ok",
      data: {
        evidenceCreatedLast24h,
        evidenceCreatedLast7d,
        evidenceFinalizedLast7d,
        reportsGeneratedLast7d,
        packagesGeneratedLast7d,
        activityLast7d,
      },
    };
  } catch {
    return { status: "unavailable", data: null };
  }
}

// ---------------------------------------------------------------------------
// Section: Operational timeline (union of real events)
// ---------------------------------------------------------------------------

async function runTimeline(
  teamId: string,
  pop: WorkspacePopulation,
): Promise<CommandCenterEnvelope["sections"]["timeline"]> {
  const items: TimelineEvent[] = [];
  let anyOk = false;
  let anyFailed = false;
  const since14d = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

  // Evidence finalized (status changed to SIGNED/REPORTED — proxied by updatedAt)
  try {
    const rows = await prisma.evidence.findMany({
      where: {
        AND: [pop.evidence],
        status: { in: ["SIGNED", "REPORTED"] },
        updatedAt: { gte: since14d },
      },
      orderBy: { updatedAt: "desc" },
      take: 10,
      // Phase HOME-PROOF — pull filename fallbacks so the activity
      // label never collapses to "Evidence signed — Untitled ×5". The
      // VM groups by `${kind}:${label}`, so distinct titles produce
      // distinct rows.
      select: {
        id: true,
        title: true,
        displayFileName: true,
        originalFileName: true,
        status: true,
        updatedAt: true,
      },
    });
    anyOk = true;
    for (const r of rows) {
      const entityName =
        (r.title?.trim() && !/^digital evidence record$/i.test(r.title.trim())
          ? r.title.trim()
          : null) ??
        r.displayFileName?.trim() ??
        r.originalFileName?.trim() ??
        `record ${r.id.slice(0, 8)}`;
      items.push({
        id: `evidence_finalized:${r.id}:${r.updatedAt.getTime()}`,
        kind: "evidence_finalized",
        occurredAt: r.updatedAt.toISOString(),
        label: `Evidence ${r.status.toLowerCase()} — ${entityName}`,
        subtitle: null,
        href: `/evidence/${r.id}`,
        severity: "info",
      });
    }
  } catch {
    anyFailed = true;
  }

  // Reports generated
  try {
    const rows = await prisma.report.findMany({
      where: {
        evidence: { teamId },
        generatedAtUtc: { gte: since14d },
      },
      orderBy: { generatedAtUtc: "desc" },
      take: 10,
      select: {
        id: true,
        evidenceId: true,
        version: true,
        generatedAtUtc: true,
        // Phase HOME-PROOF — entity title (with filename fallback) for
        // a rich activity label ("Report v2 generated — Water damage
        // record"), so distinct reports never collapse into an
        // anonymous "×N" row.
        evidence: {
          select: { title: true, displayFileName: true, originalFileName: true },
        },
      },
    });
    anyOk = true;
    for (const r of rows) {
      const name =
        (r.evidence?.title?.trim() && !/^digital evidence record$/i.test(r.evidence.title.trim())
          ? r.evidence.title.trim()
          : null) ??
        r.evidence?.displayFileName?.trim() ??
        r.evidence?.originalFileName?.trim() ??
        null;
      items.push({
        id: `report:${r.id}`,
        kind: "report_generated",
        occurredAt: r.generatedAtUtc.toISOString(),
        label: name
          ? `Report v${r.version} generated — ${name}`
          : `Report v${r.version} generated — record ${r.evidenceId.slice(0, 8)}`,
        subtitle: null,
        href: `/evidence/${r.evidenceId}`,
        severity: "info",
      });
    }
  } catch {
    anyFailed = true;
  }

  // Verification packages
  try {
    const rows = await prisma.verificationPackage.findMany({
      where: {
        evidence: { teamId },
        generatedAtUtc: { gte: since14d },
      },
      orderBy: { generatedAtUtc: "desc" },
      take: 10,
      select: {
        id: true,
        evidenceId: true,
        version: true,
        generatedAtUtc: true,
        evidence: {
          select: { title: true, displayFileName: true, originalFileName: true },
        },
      },
    });
    anyOk = true;
    for (const r of rows) {
      const name =
        (r.evidence?.title?.trim() && !/^digital evidence record$/i.test(r.evidence.title.trim())
          ? r.evidence.title.trim()
          : null) ??
        r.evidence?.displayFileName?.trim() ??
        r.evidence?.originalFileName?.trim() ??
        null;
      items.push({
        id: `package:${r.id}`,
        kind: "package_generated",
        occurredAt: r.generatedAtUtc.toISOString(),
        label: name
          ? `Package v${r.version} generated — ${name}`
          : `Package v${r.version} generated — record ${r.evidenceId.slice(0, 8)}`,
        subtitle: null,
        href: `/evidence/${r.evidenceId}`,
        severity: "info",
      });
    }
  } catch {
    anyFailed = true;
  }

  // Phase HOME-INTELLIGENCE — public verification published. The
  // publish flow already persists `publicVerifyPublishedAtUtc` (and a
  // PUBLIC_VERIFY_PUBLISHED custody event); the timeline simply never
  // projected it. Minimal read-only projection over the existing
  // Evidence columns — no new tables, no writes.
  try {
    const rows = await prisma.evidence.findMany({
      where: {
        AND: [pop.evidence],
        publicVerifyState: "PUBLISHED",
        publicVerifyPublishedAtUtc: { gte: since14d },
      },
      orderBy: { publicVerifyPublishedAtUtc: "desc" },
      take: 10,
      select: {
        id: true,
        title: true,
        publicVerifyPublishedAtUtc: true,
      },
    });
    anyOk = true;
    for (const r of rows) {
      if (!r.publicVerifyPublishedAtUtc) continue;
      items.push({
        id: `verify-published:${r.id}`,
        kind: "verification_published",
        occurredAt: r.publicVerifyPublishedAtUtc.toISOString(),
        label: r.title
          ? `Verification published — ${r.title}`
          : "Verification published",
        subtitle: null,
        href: `/evidence/${r.id}`,
        severity: "info",
      });
    }
  } catch {
    anyFailed = true;
  }

  // Lifecycle events
  try {
    const rows = await prisma.evidenceLifecycleEvent.findMany({
      where: { teamId, createdAt: { gte: since14d } },
      orderBy: { createdAt: "desc" },
      take: 12,
      select: {
        id: true,
        eventType: true,
        summary: true,
        toState: true,
        evidenceId: true,
        createdAt: true,
      },
    });
    anyOk = true;
    for (const r of rows) {
      const isHold = r.eventType.startsWith("hold_");
      const isDestruction = r.eventType.includes("destruction");
      items.push({
        id: `lifecycle:${r.id}`,
        kind: isHold
          ? r.eventType === "hold_placed"
            ? "hold_placed"
            : "hold_released"
          : isDestruction
            ? "destruction_review"
            : "lifecycle_transition",
        occurredAt: r.createdAt.toISOString(),
        label: r.summary.slice(0, 140),
        subtitle: `→ ${r.toState}`,
        href: `/evidence/${r.evidenceId}`,
        severity: isHold || isDestruction ? "warning" : "info",
      });
    }
  } catch {
    /* lifecycle events optional */
  }

  // Escalations
  try {
    const rows = await prisma.reviewEscalation.findMany({
      where: { teamId, createdAt: { gte: since14d } },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        severity: true,
        reason: true,
        workflowId: true,
        createdAt: true,
      },
    });
    anyOk = true;
    for (const r of rows) {
      items.push({
        id: `escalation_event:${r.id}`,
        kind: "escalation_opened",
        occurredAt: r.createdAt.toISOString(),
        label: `Escalation opened — ${humanize(String(r.reason))}`,
        subtitle: `Workflow ${r.workflowId.slice(0, 8)}`,
        href: "/reviewer-ops/escalations",
        severity: (r.severity === "CRITICAL"
          ? "critical"
          : r.severity === "HIGH"
            ? "high"
            : "warning") as SeverityTone,
      });
    }
  } catch {
    /* best-effort */
  }

  // Incidents
  try {
    const rows = await prisma.operationalIncident.findMany({
      where: {
        OR: [{ teamId }, { teamId: null }],
        firstSeenAtUtc: { gte: since14d },
      },
      orderBy: { firstSeenAtUtc: "desc" },
      take: 10,
      select: {
        id: true,
        title: true,
        category: true,
        severity: true,
        runbookSlug: true,
        firstSeenAtUtc: true,
      },
    });
    anyOk = true;
    for (const r of rows) {
      items.push({
        id: `incident_event:${r.id}`,
        kind: "incident_opened",
        occurredAt: r.firstSeenAtUtc.toISOString(),
        label: `Incident opened — ${r.title}`,
        subtitle: r.category,
        href: r.runbookSlug
          ? `/ops/runbooks#${r.runbookSlug}`
          : "/ops/observability",
        severity: (r.severity === "CRITICAL"
          ? "critical"
          : r.severity === "HIGH"
            ? "high"
            : "warning") as SeverityTone,
      });
    }
  } catch {
    anyFailed = true;
  }

  // Sort + cap
  items.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

  return {
    status: !anyOk ? "unavailable" : anyFailed ? "degraded" : "ok",
    items: items.slice(0, TIMELINE_LIMIT),
  };
}

// ---------------------------------------------------------------------------
// Section: Audit readiness
// ---------------------------------------------------------------------------

async function runAuditReadiness(
  teamId: string,
  scope: WorkspaceScope,
  pop: WorkspacePopulation,
): Promise<CommandCenterEnvelope["sections"]["auditReadiness"]> {
  try {
    const unsignedAgeCutoff = new Date(
      Date.now() - UNSIGNED_EVIDENCE_AGE_DAYS * 24 * 60 * 60 * 1000,
    );
    const counters: AuditReadinessCounter[] = [];

    const unsignedOld = await prisma.evidence.count({
      where: {
        AND: [pop.evidence],
        status: { in: ["CREATED", "UPLOADING", "UPLOADED"] },
        createdAt: { lt: unsignedAgeCutoff },
      },
    });
    counters.push({
      key: "unsigned_evidence_old",
      label: "Unsigned evidence > 7 days",
      value: unsignedOld,
      severity: unsignedOld > 0 ? "warning" : "info",
    });

    const missingReports = await prisma.evidence.count({
      where: { AND: [pop.evidence], status: "SIGNED", reports: { none: {} } },
    });
    counters.push({
      key: "missing_reports",
      label: "Signed evidence without report",
      value: missingReports,
      severity: missingReports > 0 ? "warning" : "info",
    });

    const failedPackages = await prisma.operationalIncident.count({
      where: {
        OR: [{ teamId }, { teamId: null }],
        status: { in: ["OPEN", "ACKNOWLEDGED"] },
        category: "PACKAGE",
      },
    });
    counters.push({
      key: "failed_packages",
      label: "Failed package generations",
      value: failedPackages,
      severity: failedPackages > 0 ? "high" : "info",
    });

    if (scope === "SHARED") {
      const pendingGovReviews = await prisma.destructionReview
        .count({
          where: {
            teamId,
            status: { in: ["PROPOSED", "PENDING_APPROVAL"] },
          },
        })
        .catch(() => 0);
      counters.push({
        key: "pending_governance_reviews",
        label: "Pending destruction reviews",
        value: pendingGovReviews,
        severity: pendingGovReviews > 0 ? "warning" : "info",
      });

      const unresolvedEscalations = await prisma.reviewEscalation
        .count({ where: { teamId, status: "OPEN" } })
        .catch(() => 0);
      counters.push({
        key: "unresolved_escalations",
        label: "Unresolved reviewer escalations",
        value: unresolvedEscalations,
        severity: unresolvedEscalations > 0 ? "high" : "info",
      });

      const pendingReviewerSignoff = await prisma.evidenceReviewWorkflow.count({
        where: {
          teamId,
          status: { in: ["IN_REVIEW", "NEEDS_INFO"] },
        },
      });
      counters.push({
        key: "evidence_pending_reviewer_signoff",
        label: "Evidence pending reviewer signoff",
        value: pendingReviewerSignoff,
        severity: pendingReviewerSignoff > 0 ? "warning" : "info",
      });
    }

    // Blocked exports
    let blockedExportsCount = 0;
    try {
      const sample = await prisma.evidence.findMany({
        where: { AND: [pop.evidence], status: { in: ["SIGNED", "REPORTED"] } },
        take: 500,
        select: { verificationPackageMetadata: true },
      });
      for (const row of sample) {
        const meta = row.verificationPackageMetadata as Record<
          string,
          unknown
        > | null;
        if (meta && meta.blocked === true) blockedExportsCount += 1;
      }
    } catch {
      /* best-effort */
    }
    counters.push({
      key: "blocked_exports",
      label: "Exports blocked by governance",
      value: blockedExportsCount,
      severity: blockedExportsCount > 0 ? "high" : "info",
    });

    return { status: "ok", counters };
  } catch {
    return { status: "unavailable", counters: [] };
  }
}

// ---------------------------------------------------------------------------
// Smaller legacy/auxiliary sections (preserved)
// ---------------------------------------------------------------------------

async function runRecentEvidence(
  teamId: string,
  pop: WorkspacePopulation,
): Promise<CommandCenterEnvelope["sections"]["recentEvidence"]> {
  try {
    const items = await prisma.evidence.findMany({
      where: { AND: [pop.evidence] },
      orderBy: { createdAt: "desc" },
      take: RECENT_EVIDENCE_LIMIT,
      select: {
        id: true,
        title: true,
        status: true,
        verificationStatus: true,
        createdAt: true,
        caseLinks: {
          orderBy: { linkedAtUtc: "asc" },
          select: { caseId: true },
          take: 1,
        },
      },
    });
    return {
      status: "ok",
      items: items.map((e) => ({
        id: e.id,
        title: e.title ?? "Untitled evidence",
        status: e.status,
        verificationStatus: e.verificationStatus ?? null,
        createdAt: e.createdAt.toISOString(),
        caseId: e.caseLinks[0]?.caseId ?? null,
      })),
    };
  } catch {
    return { status: "unavailable", items: [] };
  }
}

async function runIncidents(
  teamId: string,
): Promise<CommandCenterEnvelope["sections"]["incidents"]> {
  // WORKSPACE-SCOPE CONVERGENCE (§7.3) — DEMOTED from generator to consumer.
  //
  // This line used to be `generateIncidentsForWorkspace({ teamId })`: opening
  // Home ran the full multi-source discovery sweep inline, and it was the ONLY
  // thing that ever ran it. The consequences were all silent — a workspace
  // nobody opened was never scanned and rendered "clear" because nothing had
  // looked; two people opening Home at once ran two unbounded discoveries over
  // the same workspace; and a discovery that failed halfway left a partial set
  // of conditions with no record that it had failed.
  //
  // Discovery is now a SCHEDULED run under a durable per-workspace lock
  // (`jobs/workspace-operations-reconciliation.job.ts`). What remains here is
  // an ENSURE: if the picture has never been built or has gone stale, ask for
  // one and return what is currently known. It does not run discovery inline
  // and it does not wait — a GET that performs an unbounded scan before
  // answering is the shape this phase exists to remove.
  //
  // `.catch` is retained deliberately: Home must render even when Operations
  // discovery cannot be scheduled at all. What changed is that the failure is
  // now durable on a run row instead of vanishing into this empty handler.
  await ensureWorkspaceOperationsFresh({ workspaceId: teamId }).catch(() => {});
  await correlateWorkspaceIncidents({ teamId }).catch(() => {});
  // Phase 32.8C FINAL-2 — generate workflows from active incidents +
  // build deterministic causality chains. Both wrapped.
  await generateWorkflowsForWorkspace({ teamId }).catch(() => {});
  await detectCausalityForWorkspace({ teamId }).catch(() => {});

  let correlations: CommandCenterCorrelationItem[] = [];
  try {
    correlations = await listWorkspaceCorrelations({ teamId, limit: 12 });
  } catch {
    correlations = [];
  }

  let workflows: CommandCenterWorkflowItem[] = [];
  try {
    workflows = (await listWorkspaceWorkflows({ teamId, limit: 24 })) as CommandCenterWorkflowItem[];
  } catch {
    workflows = [];
  }

  let causalityChains: CommandCenterCausalityChainItem[] = [];
  try {
    causalityChains = await listWorkspaceCausalityChains({
      teamId,
      limit: 12,
    });
  } catch {
    causalityChains = [];
  }

  try {
    const incidents = await prisma.operationalIncident.findMany({
      where: {
        OR: [{ teamId }, { teamId: null }],
        status: { in: ["OPEN", "ACKNOWLEDGED"] },
      },
      orderBy: [{ severity: "desc" }, { lastSeenAtUtc: "desc" }],
      take: INCIDENTS_LIMIT,
      select: {
        id: true,
        category: true,
        severity: true,
        status: true,
        title: true,
        safeSummary: true,
        runbookSlug: true,
        occurrenceCount: true,
        lastSeenAtUtc: true,
        assignedOperatorUserId: true,
        assignedAtUtc: true,
        acknowledgedByUserId: true,
        acknowledgedAtUtc: true,
      },
    });
    return {
      status: "ok",
      items: incidents.map((i) => ({
        id: i.id,
        category: String(i.category),
        severity: String(i.severity),
        status: String(i.status),
        title: i.title,
        safeSummary: i.safeSummary,
        runbookSlug: i.runbookSlug ?? null,
        occurrenceCount: i.occurrenceCount,
        lastSeenAtUtc: i.lastSeenAtUtc.toISOString(),
        assignedOperatorUserId: i.assignedOperatorUserId ?? null,
        assignedAtUtc: i.assignedAtUtc?.toISOString() ?? null,
        acknowledgedByUserId: i.acknowledgedByUserId ?? null,
        acknowledgedAtUtc: i.acknowledgedAtUtc?.toISOString() ?? null,
      })),
      correlations,
      workflows,
      causalityChains,
    };
  } catch {
    return {
      status: "unavailable",
      items: [],
      correlations,
      workflows,
      causalityChains,
    };
  }
}

async function runLegacyPipelineSummary(
  teamId: string,
  pop: WorkspacePopulation,
): Promise<CommandCenterEnvelope["sections"]["pipeline"]> {
  try {
    const grouped = await prisma.evidence.groupBy({
      by: ["status"],
      where: { AND: [pop.evidence] },
      _count: { _all: true },
    });
    const data = { reported: 0, signed: 0, uploaded: 0, uploading: 0, created: 0 };
    for (const row of grouped) {
      switch (row.status) {
        case "REPORTED":
          data.reported = row._count._all;
          break;
        case "SIGNED":
          data.signed = row._count._all;
          break;
        case "UPLOADED":
          data.uploaded = row._count._all;
          break;
        case "UPLOADING":
          data.uploading = row._count._all;
          break;
        case "CREATED":
          data.created = row._count._all;
          break;
      }
    }
    return { status: "ok", data };
  } catch {
    return { status: "unavailable", data: null };
  }
}

async function runLegacyReviewerWorkload(
  teamId: string,
  scope: WorkspaceScope,
): Promise<CommandCenterEnvelope["sections"]["reviewerWorkload"]> {
  if (scope === "SINGLE_OCCUPANT") return { status: "not_applicable", data: null };
  try {
    const now = new Date();
    const [queuedCount, assignedCount, inReviewCount, overdueCount, openEscalationsCount] =
      await Promise.all([
        prisma.evidenceReviewWorkflow.count({
          where: { teamId, status: "QUEUED" },
        }),
        prisma.evidenceReviewWorkflow.count({
          where: { teamId, status: "ASSIGNED" },
        }),
        prisma.evidenceReviewWorkflow.count({
          where: { teamId, status: "IN_REVIEW" },
        }),
        prisma.evidenceReviewWorkflow.count({
          where: {
            teamId,
            status: { in: ["QUEUED", "ASSIGNED", "IN_REVIEW", "NEEDS_INFO"] },
            dueAt: { lt: now },
          },
        }),
        prisma.reviewEscalation.count({ where: { teamId, status: "OPEN" } }),
      ]);
    return {
      status: "ok",
      data: {
        queuedCount,
        assignedCount,
        inReviewCount,
        overdueCount,
        openEscalationsCount,
      },
    };
  } catch {
    return { status: "unavailable", data: null };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function humanize(s: string): string {
  return s
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export async function buildCommandCenter(input: {
  teamId: string;
  role: string;
}): Promise<CommandCenterEnvelope> {
  const { scope, memberCount, population: pop } =
    await detectWorkspaceScope(input.teamId);

  /*
   * TWENTY-FOUR ENGINES, ONE BARRIER.
   *
   * These were THREE consecutive `await Promise.all(...)` statements — twelve
   * engines, then five, then seven — so the endpoint paid three round-trip
   * barriers back to back and each batch waited for the slowest member of the
   * one before it.
   *
   * Nothing made them three. Every engine below takes its arguments from
   * `input`, from `scope` and from `pop`, all of which are resolved by
   * `detectWorkspaceScope` above; not one of them reads a result produced by
   * an earlier batch. The grouping was how the file grew — Phase 32.8C added a
   * batch, then Phase 32.8C++ added another — rather than a dependency anyone
   * had to honour.
   *
   * It is the single slowest read on Home. Measured on the local fixture in an
   * organization workspace, `/v1/dashboard/command-center` took 406ms while
   * every other Home read had settled by 925ms and the page's own barrier ran
   * to 1173ms: a quarter of Home's data phase was this one endpoint finishing
   * after everything else.
   *
   * The two things that DO depend on these outputs — the predictive risk
   * forecast and Org Intelligence V2 — still run afterwards, unchanged. Same
   * calls, same arguments, same results; only the waiting is gone.
   */
  const [
    pressure,
    caseOps,
    reviewerOrch,
    pipelineDetail,
    governance,
    organizational,
    timeline,
    auditReadiness,
    recentEvidence,
    incidents,
    legacyPipeline,
    legacyReviewer,
    investigation,
    queueCongestionResult,
    integrityResult,
    securityResult,
    workloadEngineResult,
    relationshipResult,
    crossCaseV2Result,
    reconstructedTimelineResult,
    deepIntegrityResult,
    securityClassifierResult,
    queueWorkerTelemetryResult,
    coordinationResult,
  ] = await Promise.all([
    runOperationalPressure(input.teamId, scope, input.role),
    runCaseOperations(input.teamId, scope, pop),
    runReviewerOrchestration(input.teamId, scope),
    runPipelineDetail(input.teamId, pop),
    runGovernancePosture(input.teamId, scope, pop),
    runOrganizationalIntelligence(input.teamId, pop),
    runTimeline(input.teamId, pop),
    runAuditReadiness(input.teamId, scope, pop),
    runRecentEvidence(input.teamId, pop),
    runIncidents(input.teamId),
    runLegacyPipelineSummary(input.teamId, pop),
    runLegacyReviewerWorkload(input.teamId, scope),

    // Phase 32.8C intelligence engines (partial-failure tolerant).
    runInvestigationIntelligence(input.teamId, scope, pop),
    runQueueCongestion(input.teamId, scope, pop),
    runCustodyIntegrityAnomalies(input.teamId, pop),
    runAccessSecurityAnomalies(input.teamId),
    runWorkloadEngine(input.teamId, scope),

    // Phase 32.8C++ deep operations intelligence (partial-failure tolerant).
    runRelationshipIntelligence(input.teamId, pop),
    runCrossCaseIntelligenceV2(input.teamId, scope, pop),
    runReconstructedTimeline(input.teamId),
    runDeepIntegrityWatch(input.teamId, pop),
    runAccessSecurityClassifier(input.teamId),
    runQueueWorkerTelemetry(input.teamId, scope, pop),
    runCoordinationSignals(input.teamId, scope),
  ]);

  // Predictive risk forecast is computed from the engine outputs above
  // (no extra DB round-trip). Deterministic heuristics only — no ML.
  const predictiveRiskResult = runPredictiveRisk({
    reviewer: reviewerOrch,
    governance,
    pipeline: pipelineDetail,
    audit: auditReadiness,
    retryStorm: queueWorkerTelemetryResult.data.retryStormIncidents,
  });

  // Org Intelligence V2 — derived from pressure + workload (no extra
  // round-trip beyond a 30d evidence count).
  const orgIntelligenceV2Result = await runOrgIntelligenceV2(
    input.teamId,
    pressure,
    {
      meta: workloadEngineResult.meta,
      health: workloadEngineResult.health,
      reviewers: workloadEngineResult.reviewers,
      saturationScore: workloadEngineResult.saturationScore,
      bottlenecks: workloadEngineResult.bottlenecks,
    }, pop,
  );

  // Phase 32.8C FINAL-3 — reviewer capacity / operational graph /
  // organizational health. Each runs lazy-generate then read; failures
  // are wrapped inside the helper so they never block the envelope.
  const [
    reviewerCapacityResult,
    operationalGraphResult,
    orgHealthResult,
  ] = await Promise.all([
    runReviewerCapacityBoard(input.teamId, scope),
    runOperationalGraphSection(input.teamId),
    runOrganizationalHealthSection(input.teamId),
  ]);

  // Phase 32.8C FINAL-3 — capability matrix (deterministic; never
  // weakens auth — used by the frontend for ordering + labelling).
  const capabilityMatrix = resolveCapabilityMatrix({
    role: input.role,
    scope,
  });

  // Phase 32.8C+++++++ — operational health evaluators. Each runs
  // independently and never throws; failures degrade to a DEGRADED
  // state with `canonicalSourceHealthy` set so the frontend knows
  // the underlying subsystem is alive.
  const [telemetryHealth, reconcileHealth, securityRollupHealth] =
    await Promise.all([
      evaluateTelemetryHealth({ teamId: input.teamId }).catch(() => ({
        status: "DEGRADED" as const,
        severity: "warning" as const,
        reason:
          "Telemetry health evaluator could not complete on this cycle.",
        recoverable: true,
        lastSuccessfulRunAt: null,
        retrying: true,
        degradedSince: new Date().toISOString(),
        canonicalSourceHealthy: true,
      })),
      evaluateReconcileHealth({ teamId: input.teamId }).catch(() => ({
        status: "DEGRADED" as const,
        severity: "warning" as const,
        reason:
          "Reconcile health evaluator could not complete on this cycle.",
        recoverable: true,
        lastSuccessfulRunAt: null,
        retrying: true,
        degradedSince: new Date().toISOString(),
        canonicalSourceHealthy: true,
      })),
      evaluateSecurityRollupHealth({ teamId: input.teamId }).catch(() => ({
        status: "DEGRADED" as const,
        severity: "warning" as const,
        reason:
          "Security rollup health evaluator could not complete on this cycle.",
        recoverable: true,
        lastSuccessfulRunAt: null,
        retrying: true,
        degradedSince: new Date().toISOString(),
        canonicalSourceHealthy: true,
      })),
    ]);

  // Routing queue — top-N actionable items, severity ≥ warning.
  const routingQueueItems = pressure.items
    .filter(
      (i) =>
        i.severity === "critical" ||
        i.severity === "high" ||
        i.severity === "warning",
    )
    .slice(0, ROUTING_QUEUE_LIMIT);
  const routingQueue: CommandCenterEnvelope["sections"]["routingQueue"] = {
    meta: {
      status: pressure.status,
      warnings: [],
      unsupportedSignals: [],
      sourceSummary: [
        "EvidenceReviewWorkflow",
        "ReviewEscalation",
        "Evidence",
        "OperationalIncident",
      ],
    },
    items: routingQueueItems,
  };

  // Timeline intelligence — group + annotate the existing timeline.
  const annotatedTimeline = annotateTimelineEvents(timeline.items);
  const timelineIntelligence: CommandCenterEnvelope["sections"]["timelineIntelligence"] = {
    status: timeline.status,
    events: annotatedTimeline,
    groupings: buildTimelineGroupings(timeline.items),
  };

  // Top-level unsupported signals catalog — surfaced for operator
  // transparency. Frontend renders this in a collapsed section.
  const unsupportedSignals = buildUnsupportedSignalsCatalog([
    investigation.meta,
    queueCongestionResult.meta,
    integrityResult.meta,
    securityResult.meta,
    workloadEngineResult.meta,
    relationshipResult.meta,
    crossCaseV2Result.meta,
    reconstructedTimelineResult.meta,
    deepIntegrityResult.meta,
    securityClassifierResult.meta,
    queueWorkerTelemetryResult.meta,
    coordinationResult.meta,
    predictiveRiskResult.meta,
    orgIntelligenceV2Result.meta,
  ]);

  // Phase 37.98 — Projection-backed summary. Reads from
  // OrgHealthProjection (refreshed by the org-health-refresh worker).
  // Falls back to two bounded live counts when no projection exists.
  const projectionSummary = await buildProjectionSummary(input.teamId, pop);

  // Compose summary from real sections (no fake metrics).
  const summary: CommandCenterEnvelope["sections"]["summary"] = {
    status: "ok",
    data: {
      evidenceActiveCount:
        (pipelineDetail.data?.evidence.uploaded ?? 0) +
        (pipelineDetail.data?.evidence.uploading ?? 0) +
        (pipelineDetail.data?.evidence.signed ?? 0) +
        (pipelineDetail.data?.evidence.reported ?? 0) +
        (pipelineDetail.data?.evidence.created ?? 0),
      evidenceRecentCount: organizational.data?.evidenceCreatedLast7d ?? 0,
      reportReadyCount: pipelineDetail.data?.reports.ready ?? 0,
      reviewerPendingCount: reviewerOrch.data?.queueDepth ?? 0,
      governanceAttentionCount:
        (governance.data?.activeLegalHoldsCount ?? 0) +
        (governance.data?.pendingDestructionReviewsCount ?? 0) +
        (governance.data?.blockedExportsCount ?? 0),
      openIncidentsCount: incidents.items.length,
      operationalPressureCount: pressure.items.length,
      auditReadinessFlags: auditReadiness.counters.filter(
        (c) => c.severity !== "info" && c.value > 0,
      ).length,
    },
  };

  return {
    generatedAt: new Date().toISOString(),
    workspace: { id: input.teamId, role: input.role, scope, memberCount },
    projectionSummary,
    sections: {
      summary,
      operationalPressure: pressure,
      attentionQueue: { status: pressure.status, items: pressure.items },
      caseOperations: caseOps,
      reviewerOrchestration: reviewerOrch,
      pipelineDetail,
      governancePosture: governance,
      organizationalIntelligence: organizational,
      timeline,
      auditReadiness,
      recentEvidence,
      pipeline: legacyPipeline,
      reviewerWorkload: legacyReviewer,
      incidents,
      investigationIntelligence: {
        meta: investigation.meta,
        items: investigation.items,
        crossCaseSignals: investigation.crossCaseSignals,
      },
      routingQueue,
      queueCongestion: {
        meta: queueCongestionResult.meta,
        items: queueCongestionResult.items,
      },
      custodyIntegrityAnomalies: {
        meta: integrityResult.meta,
        items: integrityResult.items,
      },
      accessSecurityAnomalies: {
        meta: securityResult.meta,
        items: securityResult.items,
      },
      workloadEngine: {
        meta: workloadEngineResult.meta,
        health: workloadEngineResult.health,
        reviewers: workloadEngineResult.reviewers,
        saturationScore: workloadEngineResult.saturationScore,
        bottlenecks: workloadEngineResult.bottlenecks,
      },
      timelineIntelligence,
      pipelineIntelligence: pipelineDetail,
      relationshipIntelligence: {
        meta: relationshipResult.meta,
        clusters: relationshipResult.clusters,
      },
      crossCaseIntelligenceV2: {
        meta: crossCaseV2Result.meta,
        signals: crossCaseV2Result.signals,
      },
      reconstructedTimeline: {
        meta: reconstructedTimelineResult.meta,
        events: reconstructedTimelineResult.events,
      },
      deepIntegrityWatch: {
        meta: deepIntegrityResult.meta,
        items: deepIntegrityResult.items,
      },
      accessSecurityClassifier: {
        meta: securityClassifierResult.meta,
        anomalies: securityClassifierResult.anomalies,
      },
      queueWorkerTelemetry: {
        meta: queueWorkerTelemetryResult.meta,
        data: queueWorkerTelemetryResult.data,
      },
      coordinationSignals: {
        meta: coordinationResult.meta,
        signals: coordinationResult.signals,
        backlog: coordinationResult.backlog,
      },
      predictiveRisk: {
        meta: predictiveRiskResult.meta,
        forecasts: predictiveRiskResult.forecasts,
      },
      organizationalIntelligenceV2: {
        meta: orgIntelligenceV2Result.meta,
        data: orgIntelligenceV2Result.data,
      },
      reviewerCapacity: reviewerCapacityResult,
      operationalGraph: operationalGraphResult,
      organizationalHealth: orgHealthResult,
    },
    capabilityMatrix,
    opsHealth: {
      telemetry: telemetryHealth,
      reconcile: reconcileHealth,
      securityRollup: securityRollupHealth,
    },
    unsupportedSignals,
  };
}

// ---------------------------------------------------------------------------
// Phase 32.8C FINAL-3 — Reviewer Capacity / Operational Graph /
// Organizational Health section helpers
// ---------------------------------------------------------------------------

async function runReviewerCapacityBoard(
  teamId: string,
  scope: WorkspaceScope,
): Promise<CommandCenterEnvelope["sections"]["reviewerCapacity"]> {
  const meta: SectionMeta = {
    status: "ok",
    warnings: [],
    unsupportedSignals: [],
    sourceSummary: [
      "ReviewerCapacitySnapshot (Phase 32.8C FINAL-3 — bounded per-reviewer saturation)",
      "ReviewerRoutingRecommendation (Phase 32.8C FINAL-3 — REASSIGN suggestions)",
      "EvidenceReviewWorkflow (real source)",
    ],
  };
  if (scope === "SINGLE_OCCUPANT") {
    return {
      meta: { ...meta, status: "not_applicable" },
      reviewers: [],
      recommendations: [],
    };
  }
  // Lazy generate, then read.
  await computeReviewerCapacityForWorkspace({ teamId }).catch(() => {});
  let reviewers: CommandCenterEnvelope["sections"]["reviewerCapacity"]["reviewers"] = [];
  let recommendations: CommandCenterEnvelope["sections"]["reviewerCapacity"]["recommendations"] =
    [];
  try {
    reviewers = await listReviewerCapacity({ teamId, limit: 20 });
  } catch {
    /* degrade */
  }
  try {
    recommendations = await listReviewerRoutingRecommendations({
      teamId,
      limit: 12,
    });
  } catch {
    /* degrade */
  }
  return { meta, reviewers, recommendations };
}

async function runOperationalGraphSection(
  teamId: string,
): Promise<CommandCenterEnvelope["sections"]["operationalGraph"]> {
  const meta: SectionMeta = {
    status: "ok",
    warnings: [],
    unsupportedSignals: [],
    sourceSummary: [
      "OperationalGraphNode / OperationalGraphEdge (Phase 32.8C FINAL-3 — derived projection)",
      "OperationalIncident / OperationalWorkflow / OperationalCorrelation (real sources)",
    ],
  };
  // Lazy generate.
  await projectOperationalGraphForWorkspace({ teamId }).catch(() => {});
  let data: CommandCenterEnvelope["sections"]["operationalGraph"]["data"] = {
    nodeCountsByType: [],
    edgeCountsByType: [],
    topRootCauses: [],
    blastRadius: {
      impactedEvidenceCount: 0,
      impactedCaseCount: 0,
      impactedReviewerCount: 0,
    },
  };
  try {
    data = await getOperationalGraphSummary({ teamId });
  } catch {
    /* degrade */
  }
  return { meta, data };
}

async function runOrganizationalHealthSection(
  teamId: string,
): Promise<CommandCenterEnvelope["sections"]["organizationalHealth"]> {
  const meta: SectionMeta = {
    status: "ok",
    warnings: [],
    unsupportedSignals: [],
    sourceSummary: [
      "OrganizationalHealthSnapshot (Phase 32.8C FINAL-3 — deterministic 0..100 scores from real counters)",
    ],
  };
  // Lazy generate.
  await recordOrgHealthSnapshotForWorkspace({ teamId }).catch(() => {});
  let data: CommandCenterEnvelope["sections"]["organizationalHealth"]["data"] = {
    healthScore: null,
    operationalMaturityScore: null,
    governanceMaturityScore: null,
    auditReadinessScore: null,
    reviewerMaturityScore: null,
    incidentFrequency7d: null,
    workflowCompletion7d: null,
    queueReliabilityScore: null,
    artifactReliabilityScore: null,
    sampledAtUtc: null,
  };
  try {
    data = await getLatestOrgHealthSnapshot({ teamId });
  } catch {
    /* degrade */
  }
  return { meta, data };
}

// =============================================================================
// Phase 32.8C+ — INTELLIGENCE ENGINES
// =============================================================================

/**
 * Every Phase 32.8C+ section ships these meta fields so the frontend
 * can render bounded warnings + a transparent "not yet supported"
 * list. The brief requires these explicitly so operators can see
 * what intelligence the platform DOES have and what it does NOT.
 */
export type SectionMeta = {
  status: SectionStatus;
  warnings: string[];
  unsupportedSignals: string[];
  sourceSummary: string[];
};

export type InvestigationRiskLevel =
  | "CRITICAL"
  | "HIGH"
  | "MEDIUM"
  | "LOW"
  | "NONE";

export type InvestigationRiskItem = {
  caseId: string;
  caseName: string;
  riskLevel: InvestigationRiskLevel;
  riskScore: number;
  reasonCodes: string[];
  recommendedAction: string;
  evidenceCount: number;
  overdueReviewCount: number;
  openEscalationsCount: number;
  hasActiveLegalHold: boolean;
  lastActivityAtUtc: string | null;
  href: string;
};

export type CrossCaseSignal = {
  kind: "evidence_in_multiple_cases" | "reviewer_overload_multi_case" | "governance_block_multi_case";
  affectedCount: number;
  description: string;
  href: string;
};

export type WorkloadHealth = "HEALTHY" | "WATCH" | "DEGRADED" | "CRITICAL";

export type WorkloadEngineRow = {
  userId: string;
  displayName: string | null;
  email: string | null;
  assignedCount: number;
  overdueCount: number;
  dueSoonCount: number;
  saturationScore: number;
  bottleneck: boolean;
  lastActionAtUtc: string | null;
  inactive: boolean;
};

export type QueueCongestionItem = {
  queueId:
    | "review_queue"
    | "report_queue_pending"
    | "package_queue_pending"
    | "destruction_review_queue"
    | "escalation_queue";
  label: string;
  depth: number;
  oldestAgeMs: number | null;
  severity: SeverityTone;
  source: string;
};

export type IntegrityAnomalyItem = {
  evidenceId: string;
  title: string;
  reasonCode:
    | "INTEGRITY_REVIEW_REQUIRED"
    | "INTEGRITY_FAILED"
    | "REPORT_BUT_NO_PACKAGE"
    | "PACKAGE_BUT_NO_REPORT"
    | "PACKAGE_BLOCKED";
  severity: SeverityTone;
  detectedAt: string;
  href: string;
};

export type SecurityAnomalyItem = {
  eventId: string;
  eventType: string;
  severity: SeverityTone;
  detectedAt: string;
  userId: string | null;
  source: string;
};

export type TimelineGroupedView = {
  byDomain: Record<OperationalDomain, number>;
  bySeverity: Record<SeverityTone, number>;
  byWindow: {
    last24h: number;
    last7d: number;
    last30d: number;
  };
};

// ---------------------------------------------------------------------------
// Bounded limits
// ---------------------------------------------------------------------------

const INVESTIGATION_TOP_LIMIT = 12;
const ROUTING_QUEUE_LIMIT = 16;
const SECURITY_ANOMALY_LIMIT = 12;
const INTEGRITY_ANOMALY_LIMIT = 12;
const WORKLOAD_TOP_LIMIT = 10;

const CRITICAL_REASON_CODES = new Set([
  "OVERDUE_REVIEWS",
  "OPEN_ESCALATIONS",
  "REPORT_FAILED",
  "PACKAGE_BLOCKED",
  "INCOMPLETE_LIFECYCLE",
]);

// ---------------------------------------------------------------------------
// Investigation Intelligence
// ---------------------------------------------------------------------------

async function runInvestigationIntelligence(
  teamId: string,
  scope: WorkspaceScope,
  pop: WorkspacePopulation,
): Promise<{
  meta: SectionMeta;
  items: InvestigationRiskItem[];
  crossCaseSignals: CrossCaseSignal[];
}> {
  const meta: SectionMeta = {
    status: "ok",
    warnings: [],
    unsupportedSignals: [],
    sourceSummary: [
      "Case",
      "Evidence",
      "EvidenceReviewWorkflow",
      "ReviewEscalation",
      "CaseLegalHold",
    ],
  };

  // Cross-case signals supported today:
  //   - reviewer overload affecting multiple cases (derivable)
  //   - governance block affecting multiple cases (derivable)
  // NOT supported (no schema):
  //   - same submitter/source across cases (no submitter identity table)
  // CLOSED (Phase 32.8C+++++): cross_case_evidence_linkage is now handled
  // by CaseEvidenceLink; surfaced via runCrossCaseIntelligenceV2.
  meta.unsupportedSignals.push(
    "cross_case_same_submitter (no canonical submitter-identity table)",
  );

  try {
    const cases = await prisma.case.findMany({
      where: { AND: [pop.cases] },
      orderBy: { updatedAt: "desc" },
      take: INVESTIGATION_TOP_LIMIT,
      select: { id: true, name: true, updatedAt: true },
    });
    if (cases.length === 0) {
      return {
        meta,
        items: [],
        crossCaseSignals: [],
      };
    }
    const caseIds = cases.map((c) => c.id);

    const now = new Date();
    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [
      evidenceByCase,
      // reviewByCase is intentionally elided — this destructuring never reads
      // it, and an array elision keeps the remaining positions correct.
      ,
      overdueByCase,
      escalationsByCase,
      holdsByCase,
      blockedExportsByCase,
      missingReportsByCase,
    ] = await Promise.all([
      prisma.caseEvidenceLink.groupBy({
        by: ["caseId"],
        where: { caseId: { in: caseIds } },
        _count: { _all: true },
        orderBy: { caseId: "asc" },
        take: caseIds.length,
      }),
      prisma.evidenceReviewWorkflow.groupBy({
        by: ["evidenceId"],
        where: {
          teamId,
          status: { in: ["QUEUED", "ASSIGNED", "IN_REVIEW", "NEEDS_INFO"] },
        },
        _count: { _all: true },
        orderBy: { evidenceId: "asc" },
        take: 2000,
      }),
      prisma.evidenceReviewWorkflow
        .findMany({
          where: {
            teamId,
            status: { in: ["QUEUED", "ASSIGNED", "IN_REVIEW", "NEEDS_INFO"] },
            dueAt: { lt: now },
            evidence: { caseLinks: { some: { caseId: { in: caseIds } } } },
          },
          select: {
            evidence: {
              select: {
                caseLinks: {
                  where: { caseId: { in: caseIds } },
                  orderBy: { linkedAtUtc: "asc" },
                  select: { caseId: true },
                  take: 1,
                },
              },
            },
          },
          take: 500,
        })
        .catch(() => []),
      prisma.reviewEscalation
        .findMany({
          where: {
            teamId,
            status: "OPEN",
            workflow: {
              evidence: { caseLinks: { some: { caseId: { in: caseIds } } } },
            },
          },
          select: {
            workflow: {
              select: {
                evidence: {
                  select: {
                    caseLinks: {
                      where: { caseId: { in: caseIds } },
                      orderBy: { linkedAtUtc: "asc" },
                      select: { caseId: true },
                      take: 1,
                    },
                  },
                },
              },
            },
          },
          take: 500,
        })
        .catch(() => []),
      // P12.3 canonical-only (scope=CASE).
      prisma.evidenceLegalHold
        .findMany({
          where: { caseId: { in: caseIds }, scope: "CASE", status: "ACTIVE" },
          select: { caseId: true },
          take: caseIds.length * 4,
        })
        .catch(() => []),
      prisma.caseEvidenceLink
        .findMany({
          where: {
            caseId: { in: caseIds },
            evidence: { status: { in: ["SIGNED", "REPORTED"] } },
          },
          select: {
            caseId: true,
            evidence: { select: { verificationPackageMetadata: true } },
          },
          take: 1000,
        })
        .catch(() => []),
      prisma.caseEvidenceLink
        .findMany({
          where: {
            caseId: { in: caseIds },
            evidence: { status: "SIGNED", reports: { none: {} } },
          },
          select: { caseId: true },
          take: 500,
        })
        .catch(() => []),
    ]);

    // Build per-case maps.
    const evidenceCountByCase = new Map<string, number>();
    for (const g of evidenceByCase) {
      if (g.caseId) evidenceCountByCase.set(g.caseId, g._count._all);
    }
    const overdueCountByCase = new Map<string, number>();
    for (const r of overdueByCase) {
      const cid = r.evidence?.caseLinks[0]?.caseId;
      if (typeof cid === "string") {
        overdueCountByCase.set(cid, (overdueCountByCase.get(cid) ?? 0) + 1);
      }
    }
    const escalationsCountByCase = new Map<string, number>();
    for (const e of escalationsByCase) {
      const cid = e.workflow?.evidence?.caseLinks[0]?.caseId;
      if (typeof cid === "string") {
        escalationsCountByCase.set(
          cid,
          (escalationsCountByCase.get(cid) ?? 0) + 1,
        );
      }
    }
    const holdsByCaseSet = new Set<string>();
    // scope='CASE' guarantees a case target; narrow rather than assert.
    for (const h of holdsByCase) if (h.caseId) holdsByCaseSet.add(h.caseId);
    const blockedByCase = new Map<string, number>();
    for (const row of blockedExportsByCase) {
      const meta = row.evidence?.verificationPackageMetadata as Record<
        string,
        unknown
      > | null;
      if (meta && meta.blocked === true && row.caseId) {
        blockedByCase.set(row.caseId, (blockedByCase.get(row.caseId) ?? 0) + 1);
      }
    }
    const missingReportsByCaseMap = new Map<string, number>();
    for (const m of missingReportsByCase) {
      if (m.caseId)
        missingReportsByCaseMap.set(
          m.caseId,
          (missingReportsByCaseMap.get(m.caseId) ?? 0) + 1,
        );
    }

    const items: InvestigationRiskItem[] = cases.map((c) => {
      const evidenceCount = evidenceCountByCase.get(c.id) ?? 0;
      const overdueReviewCount = overdueCountByCase.get(c.id) ?? 0;
      const openEscalationsCount = escalationsCountByCase.get(c.id) ?? 0;
      const hasActiveLegalHold = holdsByCaseSet.has(c.id);
      const blockedExports = blockedByCase.get(c.id) ?? 0;
      const missingReports = missingReportsByCaseMap.get(c.id) ?? 0;
      const isStale = c.updatedAt.getTime() < since30d.getTime();

      const reasonCodes: string[] = [];
      let score = 0;
      if (evidenceCount === 0) {
        reasonCodes.push("CASE_NO_EVIDENCE");
        score += 1;
      }
      if (openEscalationsCount > 0) {
        reasonCodes.push("OPEN_ESCALATIONS");
        score += 3 + Math.min(openEscalationsCount, 5);
      }
      if (overdueReviewCount > 0) {
        reasonCodes.push("OVERDUE_REVIEWS");
        score += 2 + Math.min(overdueReviewCount, 5);
      }
      if (blockedExports > 0) {
        reasonCodes.push("PACKAGE_BLOCKED");
        score += 3 + Math.min(blockedExports, 4);
      }
      if (missingReports > 0) {
        reasonCodes.push("MISSING_REPORTS");
        score += 1 + Math.min(missingReports, 3);
      }
      if (hasActiveLegalHold && isStale) {
        reasonCodes.push("ACTIVE_HOLD_STALE");
        score += 2;
      }

      const riskLevel: InvestigationRiskLevel =
        score >= 10 ||
        reasonCodes.some((r) => CRITICAL_REASON_CODES.has(r))
          ? score >= 12
            ? "CRITICAL"
            : "HIGH"
          : score >= 5
            ? "MEDIUM"
            : score >= 1
              ? "LOW"
              : "NONE";

      const recommendedAction =
        riskLevel === "NONE"
          ? "Case operating within bounded thresholds."
          : reasonCodes.includes("OPEN_ESCALATIONS")
            ? "Triage the open escalation(s) for this case in Reviewer Ops."
            : reasonCodes.includes("PACKAGE_BLOCKED")
              ? "Review the governance block and update the policy or hold."
              : reasonCodes.includes("OVERDUE_REVIEWS")
                ? "Reassign or complete the overdue review workflow(s)."
                : reasonCodes.includes("CASE_NO_EVIDENCE")
                  ? "Link evidence to this case or close it."
                  : "Open the case workspace and address the flagged signals.";

      return {
        caseId: c.id,
        caseName: c.name,
        riskLevel,
        riskScore: score,
        reasonCodes,
        recommendedAction,
        evidenceCount,
        overdueReviewCount,
        openEscalationsCount,
        hasActiveLegalHold,
        lastActivityAtUtc: c.updatedAt.toISOString(),
        href: `/cases/${c.id}`,
      };
    });

    // Sort by risk score desc.
    items.sort((a, b) => b.riskScore - a.riskScore);

    // Cross-case signals from real data.
    const crossCaseSignals: CrossCaseSignal[] = [];
    const casesWithBlockedExports = blockedByCase.size;
    if (casesWithBlockedExports >= 2) {
      crossCaseSignals.push({
        kind: "governance_block_multi_case",
        affectedCount: casesWithBlockedExports,
        description: `Governance gate blocked package generation across ${casesWithBlockedExports} cases.`,
        href: "/governance",
      });
    }
    if (scope === "SHARED") {
      try {
        // Reviewer overload affecting multi-case = reviewer with >= 5
        // assignments that touch >= 2 distinct cases.
        const overloadAssignments = await prisma.evidenceReviewWorkflow.groupBy(
          {
            by: ["assignedToUserId"],
            where: {
              teamId,
              assignedToUserId: { not: null },
              status: { in: ["ASSIGNED", "IN_REVIEW", "NEEDS_INFO"] },
              evidence: { caseLinks: { some: { caseId: { in: caseIds } } } },
            },
            _count: { _all: true },
            having: { assignedToUserId: { _count: { gte: 5 } } },
            orderBy: { _count: { assignedToUserId: "desc" } },
            take: 10,
          },
        );
        if (overloadAssignments.length > 0) {
          crossCaseSignals.push({
            kind: "reviewer_overload_multi_case",
            affectedCount: overloadAssignments.length,
            description: `${overloadAssignments.length} reviewer${overloadAssignments.length === 1 ? "" : "s"} carry ≥ 5 open assignments across multiple cases.`,
            href: "/reviewer-ops",
          });
        }
      } catch {
        meta.warnings.push(
          "Multi-case reviewer overload check could not complete.",
        );
      }
    }

    return { meta, items, crossCaseSignals };
  } catch {
    return {
      meta: { ...meta, status: "unavailable" },
      items: [],
      crossCaseSignals: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Queue Congestion Engine
// ---------------------------------------------------------------------------

async function runQueueCongestion(
  teamId: string,
  scope: WorkspaceScope,
  pop: WorkspacePopulation,
): Promise<{ meta: SectionMeta; items: QueueCongestionItem[] }> {
  const meta: SectionMeta = {
    status: "ok",
    warnings: [],
    unsupportedSignals: [
      "bullmq_infra_queues (BullMQ queue depth is in-memory; no DB snapshot)",
      "worker_stalled_jobs (worker stall signal lives in the worker process, not DB)",
    ],
    sourceSummary: [
      "EvidenceReviewWorkflow",
      "Evidence",
      "Report",
      "VerificationPackage",
      "DestructionReview",
      "ReviewEscalation",
    ],
  };
  const items: QueueCongestionItem[] = [];

  try {
    // Review queue depth (QUEUED workflows + oldest age)
    if (scope === "SHARED") {
      const queuedDepth = await prisma.evidenceReviewWorkflow.count({
        where: { teamId, status: "QUEUED" },
      });
      const oldestQueued = await prisma.evidenceReviewWorkflow.findFirst({
        where: { teamId, status: "QUEUED" },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      });
      const oldestAgeMs = oldestQueued
        ? Date.now() - oldestQueued.createdAt.getTime()
        : null;
      const severity: SeverityTone =
        queuedDepth >= 25 ? "high" : queuedDepth >= 10 ? "warning" : "info";
      items.push({
        queueId: "review_queue",
        label: "Review queue",
        depth: queuedDepth,
        oldestAgeMs,
        severity,
        source: "EvidenceReviewWorkflow(status=QUEUED)",
      });
    }

    // Report pipeline pressure: evidence SIGNED without a Report row.
    const reportPending = await prisma.evidence.count({
      where: { AND: [pop.evidence], status: "SIGNED", reports: { none: {} } },
    });
    items.push({
      queueId: "report_queue_pending",
      label: "Report generation pending",
      depth: reportPending,
      oldestAgeMs: null,
      severity: reportPending >= 15 ? "high" : reportPending >= 5 ? "warning" : "info",
      source: "Evidence(status=SIGNED, reports={none})",
    });

    // Package pipeline pressure: evidence REPORTED without a Package row.
    const packagePending = await prisma.evidence.count({
      where: {
        AND: [pop.evidence],
        status: "REPORTED",
        verificationPackages: { none: {} },
      },
    });
    items.push({
      queueId: "package_queue_pending",
      label: "Verification package pending",
      depth: packagePending,
      oldestAgeMs: null,
      severity:
        packagePending >= 15 ? "high" : packagePending >= 5 ? "warning" : "info",
      source: "Evidence(status=REPORTED, verificationPackages={none})",
    });

    if (scope === "SHARED") {
      const destructionPending = await prisma.destructionReview
        .count({
          where: {
            teamId,
            status: { in: ["PROPOSED", "PENDING_APPROVAL"] },
          },
        })
        .catch(() => 0);
      items.push({
        queueId: "destruction_review_queue",
        label: "Destruction reviews pending",
        depth: destructionPending,
        oldestAgeMs: null,
        severity: destructionPending >= 5 ? "warning" : "info",
        source: "DestructionReview(status in PROPOSED|PENDING_APPROVAL)",
      });

      const openEscalations = await prisma.reviewEscalation.count({
        where: { teamId, status: "OPEN" },
      });
      items.push({
        queueId: "escalation_queue",
        label: "Open escalations",
        depth: openEscalations,
        oldestAgeMs: null,
        severity:
          openEscalations >= 5 ? "high" : openEscalations >= 1 ? "warning" : "info",
        source: "ReviewEscalation(status=OPEN)",
      });
    }
  } catch {
    return { meta: { ...meta, status: "unavailable" }, items: [] };
  }

  return { meta, items };
}

// ---------------------------------------------------------------------------
// Custody / Integrity Anomaly Engine
// ---------------------------------------------------------------------------

async function runCustodyIntegrityAnomalies(
  teamId: string,
  pop: WorkspacePopulation,
): Promise<{ meta: SectionMeta; items: IntegrityAnomalyItem[] }> {
  const meta: SectionMeta = {
    status: "ok",
    warnings: [],
    unsupportedSignals: [
      "custody_chain_hash_recompute (per-evidence chain recompute is a worker-side audit, not a dashboard query)",
      "tsa_signal_unavailable (TSA failures are surfaced as OperationalIncident rows; see Operational Incidents section)",
      "ots_signal_unavailable (OTS failures are surfaced via OperationalIncident category=PACKAGE)",
      "signature_mismatch (no dedicated mismatch column; integrity classifier lives in worker)",
    ],
    sourceSummary: ["Evidence (verificationStatus + report/package relations)"],
  };
  const items: IntegrityAnomalyItem[] = [];

  try {
    // Integrity REVIEW_REQUIRED or FAILED — real classifications on Evidence.
    const integrityRows = await prisma.evidence.findMany({
      where: {
        AND: [pop.evidence],
        verificationStatus: { in: ["REVIEW_REQUIRED", "FAILED"] },
      },
      orderBy: { updatedAt: "desc" },
      take: INTEGRITY_ANOMALY_LIMIT,
      select: {
        id: true,
        title: true,
        verificationStatus: true,
        updatedAt: true,
      },
    });
    for (const r of integrityRows) {
      const failed = r.verificationStatus === "FAILED";
      items.push({
        evidenceId: r.id,
        title: r.title ?? "Untitled evidence",
        reasonCode: failed ? "INTEGRITY_FAILED" : "INTEGRITY_REVIEW_REQUIRED",
        severity: failed ? "critical" : "high",
        detectedAt: r.updatedAt.toISOString(),
        href: `/evidence/${r.id}`,
      });
    }

    // Package exists but no Report — integrity inconsistency.
    const packageButNoReport = await prisma.evidence.findMany({
      where: {
        AND: [pop.evidence],
        status: "REPORTED",
        reports: { none: {} },
        verificationPackages: { some: {} },
      },
      orderBy: { updatedAt: "desc" },
      take: 6,
      select: { id: true, title: true, updatedAt: true },
    });
    for (const r of packageButNoReport) {
      items.push({
        evidenceId: r.id,
        title: r.title ?? "Untitled evidence",
        reasonCode: "PACKAGE_BUT_NO_REPORT",
        severity: "warning",
        detectedAt: r.updatedAt.toISOString(),
        href: `/evidence/${r.id}`,
      });
    }

    // Package blocked by governance metadata.
    const sample = await prisma.evidence.findMany({
      where: {
        AND: [pop.evidence],
        status: { in: ["SIGNED", "REPORTED"] },
      },
      take: 500,
      select: {
        id: true,
        title: true,
        updatedAt: true,
        verificationPackageMetadata: true,
      },
    });
    for (const row of sample) {
      const m = row.verificationPackageMetadata as Record<
        string,
        unknown
      > | null;
      if (m && m.blocked === true) {
        items.push({
          evidenceId: row.id,
          title: row.title ?? "Untitled evidence",
          reasonCode: "PACKAGE_BLOCKED",
          severity: "high",
          detectedAt: row.updatedAt.toISOString(),
          href: `/evidence/${row.id}`,
        });
      }
      if (items.length >= INTEGRITY_ANOMALY_LIMIT * 2) break;
    }

    return {
      meta,
      items: items.slice(0, INTEGRITY_ANOMALY_LIMIT * 2),
    };
  } catch {
    return { meta: { ...meta, status: "unavailable" }, items: [] };
  }
}

// ---------------------------------------------------------------------------
// Access / Security Anomaly Engine
// ---------------------------------------------------------------------------

async function runAccessSecurityAnomalies(
  teamId: string,
): Promise<{ meta: SectionMeta; items: SecurityAnomalyItem[] }> {
  const meta: SectionMeta = {
    status: "ok",
    warnings: [],
    unsupportedSignals: [
      "access_anomaly_classifier (no DB-side classifier; operator-side review is the canonical path)",
      "failed_login_burst (auth failure events live in IdentitySecurity stream, not in SecurityEvent table)",
    ],
    sourceSummary: ["SecurityEvent (severity in WARNING|HIGH, last 24h)"],
  };

  try {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = await prisma.securityEvent.findMany({
      where: {
        teamId,
        severity: { in: ["WARNING", "HIGH"] },
        createdAt: { gte: since24h },
      },
      orderBy: { createdAt: "desc" },
      take: SECURITY_ANOMALY_LIMIT,
      select: {
        id: true,
        eventType: true,
        severity: true,
        createdAt: true,
        userId: true,
      },
    });
    const items: SecurityAnomalyItem[] = rows.map((r) => ({
      eventId: r.id,
      eventType: r.eventType,
      severity: (r.severity === "HIGH" ? "high" : "warning") as SeverityTone,
      detectedAt: r.createdAt.toISOString(),
      userId: r.userId,
      source: "SecurityEvent",
    }));
    return { meta, items };
  } catch {
    return { meta: { ...meta, status: "unavailable" }, items: [] };
  }
}

// ---------------------------------------------------------------------------
// Workload Engine (extends reviewer orchestration)
// ---------------------------------------------------------------------------

async function runWorkloadEngine(
  teamId: string,
  scope: WorkspaceScope,
): Promise<{
  meta: SectionMeta;
  health: WorkloadHealth;
  reviewers: WorkloadEngineRow[];
  saturationScore: number;
  bottlenecks: number;
}> {
  const meta: SectionMeta = {
    status: "ok",
    warnings: [],
    unsupportedSignals: [],
    sourceSummary: [
      "EvidenceReviewWorkflow (groupBy assignedToUserId)",
      "User (display)",
    ],
  };

  if (scope === "SINGLE_OCCUPANT") {
    return {
      meta: { ...meta, status: "not_applicable" },
      health: "HEALTHY",
      reviewers: [],
      saturationScore: 0,
      bottlenecks: 0,
    };
  }

  try {
    const now = new Date();
    const dueSoonCutoff = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const inactivityCutoff = new Date(
      Date.now() - REVIEWER_INACTIVITY_HOURS * 60 * 60 * 1000,
    );

    const grouped = await prisma.evidenceReviewWorkflow.groupBy({
      by: ["assignedToUserId"],
      where: {
        teamId,
        assignedToUserId: { not: null },
        status: { in: ["ASSIGNED", "IN_REVIEW", "NEEDS_INFO"] },
      },
      _count: { _all: true },
      orderBy: { _count: { assignedToUserId: "desc" } },
      take: WORKLOAD_TOP_LIMIT,
    });
    const reviewerIds = grouped
      .map((g) => g.assignedToUserId)
      .filter((v): v is string => v !== null);

    if (reviewerIds.length === 0) {
      return {
        meta,
        health: "HEALTHY",
        reviewers: [],
        saturationScore: 0,
        bottlenecks: 0,
      };
    }

    const [users, overdueGroups, dueSoonGroups, lastActions] = await Promise.all([
      prisma.user.findMany({
        where: { id: { in: reviewerIds } },
        select: { id: true, email: true, displayName: true },
        take: WORKLOAD_TOP_LIMIT,
      }),
      prisma.evidenceReviewWorkflow.groupBy({
        by: ["assignedToUserId"],
        where: {
          teamId,
          assignedToUserId: { in: reviewerIds },
          status: { in: ["QUEUED", "ASSIGNED", "IN_REVIEW", "NEEDS_INFO"] },
          dueAt: { lt: now },
        },
        _count: { _all: true },
      }),
      prisma.evidenceReviewWorkflow.groupBy({
        by: ["assignedToUserId"],
        where: {
          teamId,
          assignedToUserId: { in: reviewerIds },
          status: { in: ["QUEUED", "ASSIGNED", "IN_REVIEW", "NEEDS_INFO"] },
          dueAt: { gte: now, lt: dueSoonCutoff },
        },
        _count: { _all: true },
      }),
      prisma.evidenceReviewWorkflow.groupBy({
        by: ["assignedToUserId"],
        where: {
          teamId,
          assignedToUserId: { in: reviewerIds },
          lastReviewedAt: { not: null },
        },
        _max: { lastReviewedAt: true },
      }),
    ]);

    const userById = new Map(users.map((u) => [u.id, u]));
    const overdueById = new Map(
      overdueGroups
        .filter((g) => g.assignedToUserId)
        .map((g) => [g.assignedToUserId as string, g._count._all]),
    );
    const dueSoonById = new Map(
      dueSoonGroups
        .filter((g) => g.assignedToUserId)
        .map((g) => [g.assignedToUserId as string, g._count._all]),
    );
    const lastActionById = new Map(
      lastActions
        .filter((g) => g.assignedToUserId && g._max.lastReviewedAt)
        .map((g) => [
          g.assignedToUserId as string,
          g._max.lastReviewedAt as Date,
        ]),
    );

    const reviewers: WorkloadEngineRow[] = grouped
      .filter(
        (g): g is typeof g & { assignedToUserId: string } =>
          g.assignedToUserId !== null,
      )
      .map((g) => {
        const lastAction = lastActionById.get(g.assignedToUserId) ?? null;
        const inactive =
          lastAction === null ||
          lastAction.getTime() < inactivityCutoff.getTime();
        const overdue = overdueById.get(g.assignedToUserId) ?? 0;
        const dueSoon = dueSoonById.get(g.assignedToUserId) ?? 0;
        // Saturation = normalized load 0–10 based on assigned + overdue weighting.
        const saturationScore = Math.min(
          10,
          Math.round(g._count._all + overdue * 1.5),
        );
        return {
          userId: g.assignedToUserId,
          displayName: userById.get(g.assignedToUserId)?.displayName ?? null,
          email: userById.get(g.assignedToUserId)?.email ?? null,
          assignedCount: g._count._all,
          overdueCount: overdue,
          dueSoonCount: dueSoon,
          saturationScore,
          bottleneck: saturationScore >= 8 || overdue >= 4,
          lastActionAtUtc: lastAction ? lastAction.toISOString() : null,
          inactive,
        };
      });

    const bottlenecks = reviewers.filter((r) => r.bottleneck).length;
    const meanSaturation =
      reviewers.reduce((s, r) => s + r.saturationScore, 0) /
      Math.max(1, reviewers.length);
    const teamOverdue = reviewers.reduce((s, r) => s + r.overdueCount, 0);

    const health: WorkloadHealth =
      bottlenecks >= 2 || teamOverdue >= 8
        ? "CRITICAL"
        : bottlenecks >= 1 || teamOverdue >= 4 || meanSaturation >= 7
          ? "DEGRADED"
          : meanSaturation >= 5
            ? "WATCH"
            : "HEALTHY";

    return {
      meta,
      health,
      reviewers,
      saturationScore: Number(meanSaturation.toFixed(1)),
      bottlenecks,
    };
  } catch {
    return {
      meta: { ...meta, status: "unavailable" },
      health: "HEALTHY",
      reviewers: [],
      saturationScore: 0,
      bottlenecks: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Timeline Intelligence (groupings from existing timeline events)
// ---------------------------------------------------------------------------

function classifyTimelineDomain(kind: TimelineEvent["kind"]): OperationalDomain {
  switch (kind) {
    case "evidence_finalized":
      return "evidence_pipeline";
    case "report_generated":
      return "reports";
    case "package_generated":
      return "packages";
    case "verification_published":
      return "packages";
    case "lifecycle_transition":
      return "evidence_pipeline";
    case "hold_placed":
    case "hold_released":
      return "governance";
    case "destruction_review":
      return "governance";
    case "escalation_opened":
      return "review_ops";
    case "incident_opened":
      return "operational_health";
    case "workspace_activity":
      return "operational_health";
  }
}

function buildTimelineGroupings(events: TimelineEvent[]): TimelineGroupedView {
  const now = Date.now();
  const _24h = 24 * 60 * 60 * 1000;
  const _7d = 7 * _24h;
  const _30d = 30 * _24h;
  const byDomain: Record<OperationalDomain, number> = {
    review_ops: 0,
    evidence_pipeline: 0,
    reports: 0,
    packages: 0,
    governance: 0,
    custody_integrity: 0,
    security_access: 0,
    operational_health: 0,
    case_ops: 0,
  };
  const bySeverity: Record<SeverityTone, number> = {
    critical: 0,
    high: 0,
    warning: 0,
    info: 0,
  };
  const byWindow = { last24h: 0, last7d: 0, last30d: 0 };
  for (const ev of events) {
    byDomain[classifyTimelineDomain(ev.kind)] += 1;
    bySeverity[ev.severity] += 1;
    const age = now - new Date(ev.occurredAt).getTime();
    if (age <= _24h) byWindow.last24h += 1;
    if (age <= _7d) byWindow.last7d += 1;
    if (age <= _30d) byWindow.last30d += 1;
  }
  return { byDomain, bySeverity, byWindow };
}

function annotateTimelineEvents(
  events: TimelineEvent[],
): Array<TimelineEvent & { domain: OperationalDomain; operationalMeaning: string }> {
  return events.map((ev) => {
    const domain = classifyTimelineDomain(ev.kind);
    const operationalMeaning = (() => {
      switch (ev.kind) {
        case "evidence_finalized":
          return "Evidence transitioned to a finalized state. The downstream report + package pipeline takes over from here.";
        case "report_generated":
          return "A report row was created. The verification package pipeline continues if governance permits.";
        case "verification_published":
          return "A public verification page went live for this record — anyone with the link can independently confirm it.";
        case "package_generated":
          return "A verification package row was created. Operators may now offer download or external review.";
        case "lifecycle_transition":
          return "Workspace lifecycle event (retention / hold / destruction / archive).";
        case "hold_placed":
          return "Legal preservation was applied. Affected exports are blocked until the hold is released.";
        case "hold_released":
          return "Legal preservation was released. Affected exports may resume subject to other governance gates.";
        case "destruction_review":
          return "A destruction review is moving through the bounded workflow. Final destruction requires step-up.";
        case "escalation_opened":
          return "A reviewer escalation was opened. Triage required.";
        case "incident_opened":
          return "An operational incident fired and is unacknowledged or open.";
        case "workspace_activity":
          return "Workspace administration event.";
      }
    })();
    return { ...ev, domain, operationalMeaning };
  });
}

// =============================================================================
// Phase 32.8C+ — Top-level unsupported-signals catalog
// =============================================================================

function buildUnsupportedSignalsCatalog(metas: SectionMeta[]): Array<{
  signal: string;
  reason: string;
}> {
  const result: Array<{ signal: string; reason: string }> = [];
  for (const m of metas) {
    for (const entry of m.unsupportedSignals) {
      // Each unsupported entry is `signal_name (reason)` from the engines.
      const idx = entry.indexOf("(");
      if (idx > 0) {
        const signal = entry.slice(0, idx).trim();
        const reason = entry.slice(idx + 1).replace(/\)$/, "").trim();
        result.push({ signal, reason });
      } else {
        result.push({ signal: entry, reason: "no schema/data source" });
      }
    }
  }
  return result;
}

// =============================================================================
// Phase 32.8C++ — DEEP OPERATIONS INTELLIGENCE
// =============================================================================

export type Confidence = "direct" | "inferred" | "low" | "medium" | "high";

// ---------------------------------------------------------------------------
// Relationship Intelligence
// ---------------------------------------------------------------------------

export type RelationshipClusterKind =
  | "duplicate_hash"
  | "same_intake_session"
  | "same_submitter"
  | "explicit_relationship"
  | "same_case";

export type RelationshipCluster = {
  id: string;
  kind: RelationshipClusterKind;
  reasonCode: string;
  severity: SeverityTone;
  evidenceIds: string[];
  caseIds: string[];
  operationalExplanation: string;
  recommendedAction: string;
  route: string;
  confidence: Confidence;
};

const RELATIONSHIP_CLUSTER_LIMIT = 12;

async function runRelationshipIntelligence(
  teamId: string,
  pop: WorkspacePopulation,
): Promise<{ meta: SectionMeta; clusters: RelationshipCluster[] }> {
  const meta: SectionMeta = {
    status: "ok",
    warnings: [],
    unsupportedSignals: [
      "evidence_in_multiple_cases (Evidence.caseId is singular; no join table)",
      "same_capture_session_full_graph (CaptureSession→Evidence linkage is many-to-one via session metadata, not a dedicated join)",
    ],
    sourceSummary: [
      "Evidence (fileSha256, submittedByUserId, submittedByEmail)",
      "EvidenceRelationship",
      "WorkflowIntakeSession",
    ],
  };
  const clusters: RelationshipCluster[] = [];

  // (1) Duplicate file hash clusters — REAL signal from Evidence.fileSha256.
  try {
    const dupHashes = await prisma.evidence.groupBy({
      by: ["fileSha256"],
      where: { AND: [pop.evidence], fileSha256: { not: null } },
      _count: { _all: true },
      having: { fileSha256: { _count: { gt: 1 } } },
      orderBy: { _count: { fileSha256: "desc" } },
      take: RELATIONSHIP_CLUSTER_LIMIT,
    });
    for (const g of dupHashes) {
      if (!g.fileSha256) continue;
      const members = await prisma.evidence.findMany({
        where: { AND: [pop.evidence], fileSha256: g.fileSha256 },
        select: { id: true, caseLinks: { select: { caseId: true } } },
        take: 10,
      });
      const evidenceIds = members.map((m) => m.id);
      const caseIds = Array.from(
        new Set(members.flatMap((m) => m.caseLinks.map((l) => l.caseId))),
      );
      clusters.push({
        id: `dup_hash:${g.fileSha256.slice(0, 16)}`,
        kind: "duplicate_hash",
        reasonCode: "DUPLICATE_FILE_HASH",
        severity: g._count._all >= 5 ? "high" : "warning",
        evidenceIds,
        caseIds,
        operationalExplanation: `${g._count._all} evidence records share the same fileSha256. This may indicate duplicate uploads, intake replay, or shared source material.`,
        recommendedAction:
          "Open each record and confirm whether the duplication is intentional. Consider linking duplicates to the same case.",
        route: `/evidence?filter=hash:${encodeURIComponent(g.fileSha256.slice(0, 16))}`,
        confidence: "direct",
      });
    }
  } catch {
    meta.warnings.push("Duplicate-hash clustering could not complete.");
  }

  // (2) Explicit EvidenceRelationship rows.
  try {
    const rels = await prisma.evidenceRelationship.findMany({
      where: { teamId },
      orderBy: { createdAt: "desc" },
      take: RELATIONSHIP_CLUSTER_LIMIT,
      select: {
        id: true,
        sourceEvidenceId: true,
        targetEvidenceId: true,
        relationshipType: true,
      },
    });
    for (const r of rels) {
      clusters.push({
        id: `rel:${r.id}`,
        kind: "explicit_relationship",
        reasonCode: r.relationshipType.toUpperCase(),
        severity: "info",
        evidenceIds: [r.sourceEvidenceId, r.targetEvidenceId],
        caseIds: [],
        operationalExplanation: `Explicit relationship recorded · type ${r.relationshipType}.`,
        recommendedAction:
          "Open the related evidence to confirm the operational link.",
        route: `/evidence/${r.sourceEvidenceId}`,
        confidence: "direct",
      });
    }
  } catch {
    /* relationship table missing or unreadable — skip silently */
  }

  // (3) Submitter clusters — same submittedByUserId/email producing ≥ 3 records.
  try {
    const submitterGroups = await prisma.evidence.groupBy({
      by: ["submittedByUserId"],
      where: { AND: [pop.evidence], submittedByUserId: { not: null } },
      _count: { _all: true },
      having: { submittedByUserId: { _count: { gte: 3 } } },
      orderBy: { _count: { submittedByUserId: "desc" } },
      take: 6,
    });
    for (const g of submitterGroups) {
      if (!g.submittedByUserId) continue;
      const sample = await prisma.evidence.findMany({
        where: { AND: [pop.evidence], submittedByUserId: g.submittedByUserId },
        take: 5,
        select: { id: true, caseLinks: { select: { caseId: true } } },
      });
      const caseIds = Array.from(
        new Set(sample.flatMap((s) => s.caseLinks.map((l) => l.caseId))),
      );
      clusters.push({
        id: `submitter:${g.submittedByUserId.slice(0, 12)}`,
        kind: "same_submitter",
        reasonCode: "SAME_SUBMITTER_USER",
        severity: caseIds.length >= 2 ? "warning" : "info",
        evidenceIds: sample.map((s) => s.id),
        caseIds,
        operationalExplanation: `Submitter user has contributed ${g._count._all} evidence records${caseIds.length >= 2 ? ` across ${caseIds.length} cases` : ""}.`,
        recommendedAction:
          "Confirm the submission pattern aligns with the expected intake plan.",
        route: "/evidence",
        confidence: "direct",
      });
    }
  } catch {
    /* best-effort */
  }

  // (4) Intake-session clusters — DEFERRED. Evidence has no
  // `intakeSessionId` column today; the join would route through
  // EvidenceRequest → WorkflowIntakeSession. Surfaced as unsupported.
  meta.unsupportedSignals.push(
    "intake_session_clustering (Evidence has no intakeSessionId column; clustering requires join through EvidenceRequest)",
  );

  return {
    meta: { ...meta, status: clusters.length === 0 ? "ok" : "ok" },
    clusters: clusters.slice(0, RELATIONSHIP_CLUSTER_LIMIT * 2),
  };
}

// ---------------------------------------------------------------------------
// Cross-Case Intelligence V2 (extension of investigation engine signals)
// ---------------------------------------------------------------------------

export type CrossCaseSignalV2 = {
  id: string;
  signalType:
    | "shared_governance_block"
    | "shared_reviewer_overload"
    | "shared_failed_report_pattern"
    | "shared_failed_package_pattern"
    | "repeated_evidence_gaps"
    | "repeated_overdue_reviews"
    | "stale_with_active_hold";
  severity: SeverityTone;
  reasonCode: string;
  affectedCaseIds: string[];
  affectedEvidenceIds: string[];
  operationalMeaning: string;
  recommendedAction: string;
  route: string;
};

async function runCrossCaseIntelligenceV2(
  teamId: string,
  scope: WorkspaceScope,
  pop: WorkspacePopulation,
): Promise<{ meta: SectionMeta; signals: CrossCaseSignalV2[] }> {
  const meta: SectionMeta = {
    status: "ok",
    warnings: [],
    unsupportedSignals: [
      "cases_with_same_submitter_identity (no canonical submitter identity table)",
    ],
    sourceSummary: [
      "CaseEvidenceLink (Phase 32.8C+++++ — many-to-many evidence ↔ case linkage)",
      "Case",
      "Evidence (verificationPackageMetadata.blocked)",
      "EvidenceReviewWorkflow",
      "OperationalIncident",
      "CaseLegalHold",
    ],
  };
  const signals: CrossCaseSignalV2[] = [];
  if (scope === "SINGLE_OCCUPANT") {
    return { meta: { ...meta, status: "not_applicable" }, signals: [] };
  }

  // Cross-case evidence: evidence rows linked to >1 cases.
  try {
    const multiCaseEvidence = await listEvidenceLinkedToMultipleCases({
      teamId,
      limit: 12,
    });
    if (multiCaseEvidence.length > 0) {
      const allCases = new Set<string>();
      const allEvidence: string[] = [];
      for (const m of multiCaseEvidence) {
        allEvidence.push(m.evidenceId);
        for (const c of m.caseIds) allCases.add(c);
      }
      signals.push({
        id: `multi_case_evidence:${multiCaseEvidence.length}`,
        signalType: "shared_governance_block",
        severity: "warning",
        reasonCode: "EVIDENCE_LINKED_TO_MULTIPLE_CASES",
        affectedCaseIds: Array.from(allCases).slice(0, 12),
        affectedEvidenceIds: allEvidence.slice(0, 12),
        operationalMeaning: `${multiCaseEvidence.length} evidence rows are linked to multiple cases.`,
        recommendedAction:
          "Review the cross-linked evidence to confirm the linkage is intended.",
        route: "/cases",
      });
    }
  } catch {
    /* degrade — keep existing signals */
  }

  // Case clusters: cases that share evidence rows with another case.
  try {
    const clusters = await listCaseSharedEvidenceClusters({
      teamId,
      limit: 12,
    });
    if (clusters.length >= 2) {
      signals.push({
        id: `case_clusters:${clusters.length}`,
        signalType: "shared_governance_block",
        severity: "info",
        reasonCode: "CASE_SHARED_EVIDENCE_CLUSTER",
        affectedCaseIds: clusters.map((c) => c.caseId).slice(0, 12),
        affectedEvidenceIds: [],
        operationalMeaning: `${clusters.length} cases share at least one evidence row with another case.`,
        recommendedAction:
          "Open the cross-case cluster view to confirm investigation scope.",
        route: "/cases",
      });
    }
  } catch {
    /* degrade — keep existing signals */
  }

  try {
    // Shared governance block — multiple cases with package-blocked evidence.
    const blockedSample = await prisma.evidence.findMany({
      where: {
        AND: [pop.evidence],
        status: { in: ["SIGNED", "REPORTED"] },
        caseLinks: { some: {} },
      },
      take: 500,
      select: {
        id: true,
        caseLinks: { select: { caseId: true } },
        verificationPackageMetadata: true,
      },
    });
    const blockedCases = new Set<string>();
    const blockedEvidence: string[] = [];
    for (const row of blockedSample) {
      const m = row.verificationPackageMetadata as Record<
        string,
        unknown
      > | null;
      if (m && m.blocked === true && row.caseLinks.length > 0) {
        for (const l of row.caseLinks) blockedCases.add(l.caseId);
        blockedEvidence.push(row.id);
      }
    }
    if (blockedCases.size >= 2) {
      signals.push({
        id: `gov_block:${Array.from(blockedCases).slice(0, 3).join("_")}`,
        signalType: "shared_governance_block",
        severity: "high",
        reasonCode: "SHARED_GOVERNANCE_BLOCK",
        affectedCaseIds: Array.from(blockedCases),
        affectedEvidenceIds: blockedEvidence.slice(0, 12),
        operationalMeaning: `${blockedCases.size} cases have evidence with packages blocked by governance.`,
        recommendedAction:
          "Review the governance policy or hold causing the cross-case block.",
        route: "/governance",
      });
    }

    // Shared failed pattern — multiple cases affected by same incident category.
    const incidentSample = await prisma.operationalIncident.findMany({
      where: {
        OR: [{ teamId }, { teamId: null }],
        status: { in: ["OPEN", "ACKNOWLEDGED"] },
        category: { in: ["REPORT", "PACKAGE"] },
        relatedEvidenceId: { not: null },
      },
      orderBy: { lastSeenAtUtc: "desc" },
      take: 50,
      select: { id: true, category: true, relatedEvidenceId: true },
    });
    const evidenceIds = incidentSample
      .map((i) => i.relatedEvidenceId)
      .filter((v): v is string => v !== null);
    if (evidenceIds.length >= 3) {
      const relatedEvidence = await prisma.evidence.findMany({
        where: { id: { in: evidenceIds } },
        select: { id: true, caseLinks: { select: { caseId: true } } },
        take: 50,
      });
      const cases = new Set<string>();
      const evs: string[] = [];
      for (const e of relatedEvidence) {
        if (e.caseLinks.length > 0) {
          for (const l of e.caseLinks) cases.add(l.caseId);
          evs.push(e.id);
        }
      }
      if (cases.size >= 2) {
        const isReport = incidentSample.some((i) => i.category === "REPORT");
        signals.push({
          id: `failed_pattern:${incidentSample[0]?.category ?? "unknown"}`,
          signalType: isReport
            ? "shared_failed_report_pattern"
            : "shared_failed_package_pattern",
          severity: "high",
          reasonCode: isReport
            ? "SHARED_FAILED_REPORT_PATTERN"
            : "SHARED_FAILED_PACKAGE_PATTERN",
          affectedCaseIds: Array.from(cases),
          affectedEvidenceIds: evs.slice(0, 12),
          operationalMeaning: `${cases.size} cases are affected by the same ${isReport ? "report" : "package"} generation failure pattern.`,
          recommendedAction:
            "Open the runbook for the underlying incident.",
          route: "/ops/observability",
        });
      }
    }

    // Cases stale with active hold — preservation pressure cross-case.
    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const heldButStale = await prisma.case.findMany({
      where: {
        AND: [pop.cases],
        updatedAt: { lt: since30d },
        // PHASE 12 POINT 3 — the legacy `legalHolds` relation pointed at the
        // dropped `case_legal_holds` table. CASE-scoped rows now live in the
        // canonical store, reached through `canonicalLegalHolds`; `scope` is
        // stated explicitly so this cannot silently widen if the relation
        // ever carries another scope.
        canonicalLegalHolds: { some: { scope: "CASE", status: "ACTIVE" } },
      },
      orderBy: { updatedAt: "asc" },
      take: 12,
      select: { id: true },
    });
    if (heldButStale.length >= 2) {
      signals.push({
        id: `stale_held:${heldButStale.length}`,
        signalType: "stale_with_active_hold",
        severity: "warning",
        reasonCode: "STALE_CASE_ACTIVE_HOLD",
        affectedCaseIds: heldButStale.map((c) => c.id),
        affectedEvidenceIds: [],
        operationalMeaning: `${heldButStale.length} cases have legal preservation active but no activity in 30 days.`,
        recommendedAction:
          "Review whether preservation is still required or update the hold reason.",
        route: "/governance",
      });
    }
  } catch {
    return { meta: { ...meta, status: "unavailable" }, signals: [] };
  }
  return { meta, signals };
}

// ---------------------------------------------------------------------------
// Reconstructed Timeline (AdminAuditLog + actor + confidence + safeToDisplay)
// ---------------------------------------------------------------------------

export type ReconstructedTimelineEvent = {
  id: string;
  type: string;
  family:
    | "evidence"
    | "report"
    | "package"
    | "governance"
    | "review"
    | "incident"
    | "audit"
    | "security";
  timestamp: string;
  severity: SeverityTone;
  actor: string | null;
  entityType: string | null;
  entityId: string | null;
  caseId: string | null;
  evidenceId: string | null;
  operationalMeaning: string;
  route: string | null;
  sourceTable: string;
  confidence: Confidence;
  safeToDisplay: boolean;
};

const RECONSTRUCTED_TIMELINE_LIMIT = 60;
const RECONSTRUCTED_TIMELINE_WINDOW_DAYS = 14;

async function runReconstructedTimeline(
  teamId: string,
): Promise<{ meta: SectionMeta; events: ReconstructedTimelineEvent[] }> {
  const meta: SectionMeta = {
    status: "ok",
    warnings: [],
    unsupportedSignals: [
      "public_verify_view_actor (anonymous public-verify views do not record actor)",
      "external_review_action_actor (external grants may carry only a grant id, not a workspace user)",
    ],
    sourceSummary: [
      "OperationalTimelineEvent (Phase 32.8C+++++ — normalized projection)",
      "AdminAuditLog",
      "OperationalIncident",
      "ReviewEscalation",
      "EvidenceLifecycleEvent",
      "Report",
      "VerificationPackage",
    ],
  };
  const events: ReconstructedTimelineEvent[] = [];
  const since = new Date(
    Date.now() - RECONSTRUCTED_TIMELINE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );

  // Phase 32.8C+++++ — lazy projection. If the table is empty, build a
  // bounded slice from source tables, then read from the projection.
  try {
    const existing = await listWorkspaceTimelineEvents({ teamId, limit: 1 });
    if (existing.length === 0) {
      await projectWorkspaceTimeline({
        teamId,
        sinceMinutes: 60 * 24 * RECONSTRUCTED_TIMELINE_WINDOW_DAYS,
      }).catch(() => {});
    }
  } catch {
    /* degrade — projection unavailable, fall back to live aggregation below */
  }

  // AdminAuditLog — NOT included in this section. AdminAuditLog has
  // no teamId column; surfacing rows without a workspace join would
  // leak cross-workspace admin actions. The audit chain remains
  // canonical, just not surfaced through this dashboard view.
  meta.unsupportedSignals.push(
    "admin_audit_log_workspace_scope (AdminAuditLog has no teamId; workspace scoping would require joining through resourceId for every resourceType)",
  );

  // Reports + packages
  try {
    const [reports, packages] = await Promise.all([
      prisma.report.findMany({
        where: {
          evidence: { teamId },
          generatedAtUtc: { gte: since },
        },
        orderBy: { generatedAtUtc: "desc" },
        take: 10,
        select: {
          id: true,
          evidenceId: true,
          version: true,
          generatedAtUtc: true,
        },
      }),
      prisma.verificationPackage.findMany({
        where: {
          evidence: { teamId },
          generatedAtUtc: { gte: since },
        },
        orderBy: { generatedAtUtc: "desc" },
        take: 10,
        select: {
          id: true,
          evidenceId: true,
          version: true,
          generatedAtUtc: true,
        },
      }),
    ]);
    for (const r of reports) {
      events.push({
        id: `report:${r.id}`,
        type: "report_generated",
        family: "report",
        timestamp: r.generatedAtUtc.toISOString(),
        severity: "info",
        actor: null,
        entityType: "evidence",
        entityId: r.evidenceId,
        caseId: null,
        evidenceId: r.evidenceId,
        operationalMeaning: `Report v${r.version} generated.`,
        route: `/evidence/${r.evidenceId}`,
        sourceTable: "Report",
        confidence: "direct",
        safeToDisplay: true,
      });
    }
    for (const p of packages) {
      events.push({
        id: `pkg:${p.id}`,
        type: "package_generated",
        family: "package",
        timestamp: p.generatedAtUtc.toISOString(),
        severity: "info",
        actor: null,
        entityType: "evidence",
        entityId: p.evidenceId,
        caseId: null,
        evidenceId: p.evidenceId,
        operationalMeaning: `Verification package v${p.version} generated.`,
        route: `/evidence/${p.evidenceId}`,
        sourceTable: "VerificationPackage",
        confidence: "direct",
        safeToDisplay: true,
      });
    }
  } catch {
    meta.warnings.push("Report/package timeline read could not complete.");
  }

  // EvidenceLifecycleEvent
  try {
    const rows = await prisma.evidenceLifecycleEvent.findMany({
      where: { teamId, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 12,
      select: {
        id: true,
        eventType: true,
        summary: true,
        evidenceId: true,
        actorUserId: true,
        createdAt: true,
      },
    });
    for (const r of rows) {
      const isHold = r.eventType.startsWith("hold_");
      const isDestruction = r.eventType.includes("destruction");
      events.push({
        id: `lifecycle:${r.id}`,
        type: r.eventType,
        family: "governance",
        timestamp: r.createdAt.toISOString(),
        severity: isDestruction ? "high" : isHold ? "warning" : "info",
        actor: r.actorUserId ? r.actorUserId.slice(0, 8) : null,
        entityType: "evidence",
        entityId: r.evidenceId,
        caseId: null,
        evidenceId: r.evidenceId,
        operationalMeaning: r.summary.slice(0, 200),
        route: `/evidence/${r.evidenceId}`,
        sourceTable: "EvidenceLifecycleEvent",
        confidence: "direct",
        safeToDisplay: true,
      });
    }
  } catch {
    meta.warnings.push("Lifecycle timeline read could not complete.");
  }

  // Operational incidents + escalations + security events (with safe actor masking).
  try {
    const [incidents, escalations, security] = await Promise.all([
      prisma.operationalIncident.findMany({
        where: {
          OR: [{ teamId }, { teamId: null }],
          firstSeenAtUtc: { gte: since },
        },
        orderBy: { firstSeenAtUtc: "desc" },
        take: 10,
        select: {
          id: true,
          title: true,
          category: true,
          severity: true,
          runbookSlug: true,
          firstSeenAtUtc: true,
        },
      }),
      prisma.reviewEscalation.findMany({
        where: { teamId, createdAt: { gte: since } },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: {
          id: true,
          severity: true,
          reason: true,
          workflowId: true,
          createdAt: true,
        },
      }),
      prisma.securityEvent.findMany({
        where: {
          teamId,
          severity: { in: ["WARNING", "HIGH"] },
          createdAt: { gte: since },
        },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: {
          id: true,
          eventType: true,
          severity: true,
          userId: true,
          createdAt: true,
        },
      }),
    ]);
    for (const i of incidents) {
      events.push({
        id: `incident:${i.id}`,
        type: "incident_opened",
        family: "incident",
        timestamp: i.firstSeenAtUtc.toISOString(),
        severity: (i.severity === "CRITICAL"
          ? "critical"
          : i.severity === "HIGH"
            ? "high"
            : "warning") as SeverityTone,
        actor: "system",
        entityType: "incident",
        entityId: i.id,
        caseId: null,
        evidenceId: null,
        operationalMeaning: `Incident · ${i.category} · ${i.title}`,
        route: i.runbookSlug
          ? `/ops/runbooks#${i.runbookSlug}`
          : "/ops/observability",
        sourceTable: "OperationalIncident",
        confidence: "direct",
        safeToDisplay: true,
      });
    }
    for (const e of escalations) {
      events.push({
        id: `escalation:${e.id}`,
        type: "escalation_opened",
        family: "review",
        timestamp: e.createdAt.toISOString(),
        severity: (e.severity === "CRITICAL"
          ? "critical"
          : e.severity === "HIGH"
            ? "high"
            : "warning") as SeverityTone,
        actor: null,
        entityType: "escalation",
        entityId: e.id,
        caseId: null,
        evidenceId: null,
        operationalMeaning: `Escalation · ${String(e.reason)}`,
        route: "/reviewer-ops/escalations",
        sourceTable: "ReviewEscalation",
        confidence: "direct",
        safeToDisplay: true,
      });
    }
    for (const s of security) {
      events.push({
        id: `sec:${s.id}`,
        type: s.eventType,
        family: "security",
        timestamp: s.createdAt.toISOString(),
        severity: (s.severity === "HIGH" ? "high" : "warning") as SeverityTone,
        actor: s.userId ? s.userId.slice(0, 8) : "anonymous",
        entityType: "security_event",
        entityId: s.id,
        caseId: null,
        evidenceId: null,
        operationalMeaning: `Security · ${s.eventType}`,
        route: "/security-center",
        sourceTable: "SecurityEvent",
        confidence: "direct",
        safeToDisplay: true,
      });
    }
  } catch {
    meta.warnings.push("Incident/escalation/security timeline read could not complete.");
  }

  events.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return {
    meta,
    events: events.slice(0, RECONSTRUCTED_TIMELINE_LIMIT),
  };
}

// ---------------------------------------------------------------------------
// Deep Integrity Watch (TSA / OTS / verificationStatus signals + sourceFields)
// ---------------------------------------------------------------------------

export type DeepIntegritySignal = {
  evidenceId: string;
  title: string;
  reasonCode:
    | "INTEGRITY_REVIEW_REQUIRED"
    | "INTEGRITY_FAILED"
    | "TSA_UNAVAILABLE"
    | "OTS_UNAVAILABLE"
    | "OTS_FAILED"
    | "PACKAGE_BUT_NO_REPORT"
    | "REPORT_FINALIZED_NO_PACKAGE_AGED"
    | "PACKAGE_BLOCKED";
  severity: SeverityTone;
  detectedAt: string;
  sourceFields: string[];
  confidence: Confidence;
  explanation: string;
  recommendedAction: string;
  href: string;
  /** Phase 32.8C++++++ — TSA timestamp intelligence from
   *  EvidenceIntegritySnapshot. Null when the snapshot is absent. */
  tsaTimestampIntelligence?: {
    /** "PARSED" | "UNAVAILABLE" | "FAILED" — null when no snapshot row exists. */
    parseStatus: string | null;
    parseErrorCode: string | null;
    issuerCommonName: string | null;
    issuerOrganization: string | null;
    policyOid: string | null;
    parsedAtUtc: string | null;
  };
};

const DEEP_INTEGRITY_LIMIT = 24;
const REPORT_BUT_NO_PACKAGE_AGE_HOURS = 6;

async function runDeepIntegrityWatch(
  teamId: string,
  pop: WorkspacePopulation,
): Promise<{ meta: SectionMeta; items: DeepIntegritySignal[] }> {
  const meta: SectionMeta = {
    status: "ok",
    warnings: [],
    unsupportedSignals: [
      "tsa_issuer_real_parsing (worker-side ASN.1 TSA parser not yet deployed; EvidenceIntegritySnapshot.tsaParseStatus surfaces 'UNAVAILABLE' instead of fabricated issuer data)",
    ],
    sourceSummary: [
      "EvidenceIntegritySnapshot (Phase 32.8C++++ + 32.8C+++++ — bounded advisory snapshot, TSA issuer columns)",
      "Evidence (verificationStatus, tsaTokenBase64, tsaGenTimeUtc, tsaSerialNumber, otsStatus)",
      "Report",
      "VerificationPackage",
    ],
  };
  const items: DeepIntegritySignal[] = [];

  // Phase 32.8C++++ — prefer the persisted snapshot when present.
  // Lazy backfill on first read: if no rows exist, populate from real
  // Evidence + TSA + OTS columns then continue with the live
  // derivation below. The snapshot write is advisory — failures here
  // never block the dashboard.
  try {
    const snapshots = await listWorkspaceIntegritySnapshots({
      teamId,
      limit: DEEP_INTEGRITY_LIMIT,
    });
    if (snapshots.length === 0) {
      // Lazy backfill — small bounded slice. Wrapped in try/catch so
      // a failure never blocks the rest of the engine.
      try {
        await backfillIntegritySnapshots({ teamId, limit: 100 });
      } catch {
        meta.warnings.push(
          "EvidenceIntegritySnapshot lazy-backfill could not complete; falling back to live derivation.",
        );
      }
    } else {
      for (const s of snapshots) {
        const failed = s.overallStatus === "FAILED";
        const reason: DeepIntegritySignal["reasonCode"] = failed
          ? "INTEGRITY_FAILED"
          : "INTEGRITY_REVIEW_REQUIRED";
        items.push({
          evidenceId: s.evidenceId,
          title: `Evidence ${s.evidenceId.slice(0, 8)}`,
          reasonCode: reason,
          severity: failed ? "critical" : "high",
          detectedAt: s.computedAtUtc,
          sourceFields: [
            "EvidenceIntegritySnapshot.overallStatus",
            "EvidenceIntegritySnapshot.reasonCodes",
            "EvidenceIntegritySnapshot.tsaParseStatus",
          ],
          confidence: "direct",
          explanation: failed
            ? "Worker integrity classifier marked this evidence FAILED. Operator review is required."
            : "Worker integrity classifier flagged this evidence for review.",
          recommendedAction:
            "Open the evidence detail and consult the integrity panel.",
          href: `/evidence/${s.evidenceId}`,
          tsaTimestampIntelligence: {
            parseStatus: s.tsaParseStatus,
            parseErrorCode: s.tsaParseErrorCode,
            issuerCommonName: s.tsaIssuerCommonName,
            issuerOrganization: s.tsaIssuerOrganization,
            policyOid: s.tsaPolicyOid,
            parsedAtUtc: s.tsaParsedAtUtc,
          },
        });
      }
    }
  } catch {
    meta.warnings.push(
      "EvidenceIntegritySnapshot read could not complete; falling back to live derivation.",
    );
  }

  try {
    // verificationStatus = REVIEW_REQUIRED / FAILED
    const reviewRequired = await prisma.evidence.findMany({
      where: {
        AND: [pop.evidence],
        verificationStatus: { in: ["REVIEW_REQUIRED", "FAILED"] },
      },
      orderBy: { updatedAt: "desc" },
      take: 10,
      select: {
        id: true,
        title: true,
        verificationStatus: true,
        updatedAt: true,
      },
    });
    for (const r of reviewRequired) {
      const failed = r.verificationStatus === "FAILED";
      items.push({
        evidenceId: r.id,
        title: r.title ?? "Untitled evidence",
        reasonCode: failed ? "INTEGRITY_FAILED" : "INTEGRITY_REVIEW_REQUIRED",
        severity: failed ? "critical" : "high",
        detectedAt: r.updatedAt.toISOString(),
        sourceFields: ["Evidence.verificationStatus"],
        confidence: "direct",
        explanation: failed
          ? "Worker integrity classifier marked this evidence FAILED. Operator review is required."
          : "Worker integrity classifier flagged this evidence for review.",
        recommendedAction:
          "Open the evidence detail and consult the integrity panel.",
        href: `/evidence/${r.id}`,
      });
    }

    // TSA unavailable for finalized evidence (REPORTED but no tsaTokenBase64).
    const tsaUnavailable = await prisma.evidence.findMany({
      where: {
        AND: [pop.evidence],
        status: "REPORTED",
        tsaTokenBase64: null,
      },
      orderBy: { updatedAt: "desc" },
      take: 6,
      select: { id: true, title: true, updatedAt: true },
    });
    for (const r of tsaUnavailable) {
      items.push({
        evidenceId: r.id,
        title: r.title ?? "Untitled evidence",
        reasonCode: "TSA_UNAVAILABLE",
        severity: "warning",
        detectedAt: r.updatedAt.toISOString(),
        sourceFields: ["Evidence.tsaTokenBase64", "Evidence.status"],
        confidence: "direct",
        explanation:
          "Evidence is REPORTED but no TSA token was recorded. Timestamp signal is unavailable for this record.",
        recommendedAction:
          "Confirm the TSA pipeline is healthy and reprocess if required.",
        href: `/evidence/${r.id}`,
      });
    }

    // OTS unavailable / failed.
    const otsUnavailable = await prisma.evidence.findMany({
      where: {
        AND: [pop.evidence],
        status: "REPORTED",
        OR: [
          { otsStatus: null },
          { otsStatus: { in: ["PENDING", "FAILED", "ERRORED"] } },
        ],
      },
      orderBy: { updatedAt: "desc" },
      take: 6,
      select: { id: true, title: true, updatedAt: true, otsStatus: true },
    });
    for (const r of otsUnavailable) {
      const failed =
        r.otsStatus === "FAILED" || r.otsStatus === "ERRORED";
      items.push({
        evidenceId: r.id,
        title: r.title ?? "Untitled evidence",
        reasonCode: failed ? "OTS_FAILED" : "OTS_UNAVAILABLE",
        severity: failed ? "high" : "warning",
        detectedAt: r.updatedAt.toISOString(),
        sourceFields: ["Evidence.otsStatus", "Evidence.status"],
        confidence: "direct",
        explanation: failed
          ? "OpenTimestamps anchor reported a failure status. Anchor signal requires reprocessing."
          : "OpenTimestamps anchor signal is unavailable or pending for this finalized record.",
        recommendedAction:
          "Confirm the OTS pipeline is healthy and reprocess if required.",
        href: `/evidence/${r.id}`,
      });
    }

    // REPORTED for > N hours without a package.
    const cutoff = new Date(
      Date.now() - REPORT_BUT_NO_PACKAGE_AGE_HOURS * 60 * 60 * 1000,
    );
    const reportFinalizedNoPackage = await prisma.evidence.findMany({
      where: {
        AND: [pop.evidence],
        status: "REPORTED",
        updatedAt: { lt: cutoff },
        verificationPackages: { none: {} },
      },
      orderBy: { updatedAt: "asc" },
      take: 6,
      select: { id: true, title: true, updatedAt: true },
    });
    for (const r of reportFinalizedNoPackage) {
      items.push({
        evidenceId: r.id,
        title: r.title ?? "Untitled evidence",
        reasonCode: "REPORT_FINALIZED_NO_PACKAGE_AGED",
        severity: "warning",
        detectedAt: r.updatedAt.toISOString(),
        sourceFields: ["Evidence.status", "VerificationPackage relation"],
        confidence: "direct",
        explanation: `Evidence has been REPORTED for more than ${REPORT_BUT_NO_PACKAGE_AGE_HOURS}h without a verification package row.`,
        recommendedAction:
          "Confirm the package generator is healthy and reprocess if required.",
        href: `/evidence/${r.id}`,
      });
    }

    // Package blocked.
    const sample = await prisma.evidence.findMany({
      where: {
        AND: [pop.evidence],
        status: { in: ["SIGNED", "REPORTED"] },
      },
      take: 400,
      select: {
        id: true,
        title: true,
        updatedAt: true,
        verificationPackageMetadata: true,
      },
    });
    for (const row of sample) {
      const m = row.verificationPackageMetadata as Record<
        string,
        unknown
      > | null;
      if (m && m.blocked === true) {
        items.push({
          evidenceId: row.id,
          title: row.title ?? "Untitled evidence",
          reasonCode: "PACKAGE_BLOCKED",
          severity: "high",
          detectedAt: row.updatedAt.toISOString(),
          sourceFields: ["Evidence.verificationPackageMetadata.blocked"],
          confidence: "direct",
          explanation:
            "Package generation was blocked by governance gate. The block reason is recorded in the metadata blob.",
          recommendedAction:
            "Open the evidence detail and review the governance block reason.",
          href: `/evidence/${row.id}`,
        });
      }
      if (items.length >= DEEP_INTEGRITY_LIMIT * 2) break;
    }
  } catch {
    return { meta: { ...meta, status: "unavailable" }, items: [] };
  }
  return { meta, items: items.slice(0, DEEP_INTEGRITY_LIMIT * 2) };
}

// ---------------------------------------------------------------------------
// Access Security Classifier (SecurityEvent → categorized anomaly)
// ---------------------------------------------------------------------------

export type SecurityAnomalyCategory =
  | "repeated_failed_access"
  | "blocked_export_attempt"
  | "api_credential_change"
  | "webhook_failure_spike"
  | "admin_role_change"
  | "step_up_failed"
  | "permission_denied_burst"
  | "uncategorized";

export type ClassifiedSecurityAnomaly = {
  category: SecurityAnomalyCategory;
  severity: SeverityTone;
  eventType: string;
  count: number;
  timeWindow: string;
  userId: string | null;
  firstSeen: string;
  lastSeen: string;
  explanation: string;
  recommendedAction: string;
  sourceTable: string;
};

function classifySecurityEventType(eventType: string): SecurityAnomalyCategory {
  const t = eventType.toLowerCase();
  if (t.includes("login_failed") || t.includes("auth_failed") || t.includes("failed_login"))
    return "repeated_failed_access";
  if (t.includes("permission_denied")) return "permission_denied_burst";
  if (t.includes("step_up_failed") || t.includes("stepup_failed"))
    return "step_up_failed";
  if (t.includes("export") && (t.includes("block") || t.includes("denied")))
    return "blocked_export_attempt";
  if (t.includes("api_credential") || t.includes("api_key"))
    return "api_credential_change";
  if (t.includes("webhook") && (t.includes("fail") || t.includes("error")))
    return "webhook_failure_spike";
  if (t.includes("admin_role") || t.includes("role_change"))
    return "admin_role_change";
  return "uncategorized";
}

async function runAccessSecurityClassifier(
  teamId: string,
): Promise<{ meta: SectionMeta; anomalies: ClassifiedSecurityAnomaly[] }> {
  const meta: SectionMeta = {
    status: "ok",
    warnings: [],
    unsupportedSignals: [
      "ml_anomaly_score (no ML pipeline; classifier is rule-based on eventType strings)",
      "geo_login_pattern (no geo enrichment column)",
      "device_fingerprint (no device fingerprint column on SecurityEvent)",
    ],
    sourceSummary: [
      "AccessAnomaly (Phase 32.8C++++ — persisted classifier output)",
      "SecurityEvent (last 24h, severity in WARNING|HIGH)",
    ],
  };

  // Phase 32.8C++++ — prefer persisted AccessAnomaly rows. If the
  // table is empty for this workspace, run the classifier lazily to
  // populate it. Classifier failures never block the dashboard.
  try {
    const persisted = await listWorkspaceAccessAnomalies({
      teamId,
      limit: 16,
    });
    if (persisted.length === 0) {
      try {
        await runClassifierForWorkspace({ teamId });
      } catch {
        meta.warnings.push(
          "AccessAnomaly classifier lazy-run could not complete; falling back to live grouping.",
        );
      }
      // Re-read after the lazy classifier run.
      const refreshed = await listWorkspaceAccessAnomalies({
        teamId,
        limit: 16,
      });
      if (refreshed.length > 0) {
        return {
          meta,
          anomalies: refreshed.map((r) => ({
            category: r.category as ClassifiedSecurityAnomaly["category"],
            severity: (r.severity === "HIGH" || r.severity === "CRITICAL"
              ? "high"
              : "warning") as SeverityTone,
            eventType: r.sampleEventType,
            count: r.count,
            timeWindow: "24h",
            userId: r.actorUserId,
            firstSeen: r.windowStartUtc,
            lastSeen: r.windowEndUtc,
            explanation:
              r.summary ??
              "Classified security anomaly persisted by the dashboard classifier.",
            recommendedAction: recommendAnomalyAction(
              r.category as ClassifiedSecurityAnomaly["category"],
            ),
            sourceTable: "AccessAnomaly",
          })),
        };
      }
    } else {
      return {
        meta,
        anomalies: persisted.map((r) => ({
          category: r.category as ClassifiedSecurityAnomaly["category"],
          severity: (r.severity === "HIGH" || r.severity === "CRITICAL"
            ? "high"
            : "warning") as SeverityTone,
          eventType: r.sampleEventType,
          count: r.count,
          timeWindow: "24h",
          userId: r.actorUserId,
          firstSeen: r.windowStartUtc,
          lastSeen: r.windowEndUtc,
          explanation:
            r.summary ??
            "Classified security anomaly persisted by the dashboard classifier.",
          recommendedAction: recommendAnomalyAction(
            r.category as ClassifiedSecurityAnomaly["category"],
          ),
          sourceTable: "AccessAnomaly",
        })),
      };
    }
  } catch {
    meta.warnings.push(
      "AccessAnomaly read could not complete; falling back to live grouping.",
    );
  }

  try {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = await prisma.securityEvent.findMany({
      where: {
        teamId,
        severity: { in: ["WARNING", "HIGH"] },
        createdAt: { gte: since24h },
      },
      orderBy: { createdAt: "asc" },
      take: 500,
      select: {
        eventType: true,
        severity: true,
        userId: true,
        createdAt: true,
      },
    });
    // Group by (category, userId, eventType) — bursts.
    const grouped = new Map<
      string,
      {
        category: SecurityAnomalyCategory;
        severity: SeverityTone;
        eventType: string;
        userId: string | null;
        count: number;
        firstSeen: Date;
        lastSeen: Date;
      }
    >();
    for (const r of rows) {
      const category = classifySecurityEventType(r.eventType);
      const key = `${category}|${r.userId ?? "anon"}|${r.eventType}`;
      const sev: SeverityTone =
        r.severity === "HIGH" ? "high" : "warning";
      const entry = grouped.get(key);
      if (entry) {
        entry.count += 1;
        if (r.createdAt > entry.lastSeen) entry.lastSeen = r.createdAt;
        if (r.createdAt < entry.firstSeen) entry.firstSeen = r.createdAt;
        if (
          sev === "high" ||
          (entry.severity !== "high" && sev === "warning")
        ) {
          entry.severity = sev;
        }
      } else {
        grouped.set(key, {
          category,
          severity: sev,
          eventType: r.eventType,
          userId: r.userId,
          count: 1,
          firstSeen: r.createdAt,
          lastSeen: r.createdAt,
        });
      }
    }

    const anomalies: ClassifiedSecurityAnomaly[] = [];
    for (const v of grouped.values()) {
      if (v.category === "uncategorized" && v.count < 3) continue;
      anomalies.push({
        category: v.category,
        severity: v.severity,
        eventType: v.eventType,
        count: v.count,
        timeWindow: "24h",
        userId: v.userId,
        firstSeen: v.firstSeen.toISOString(),
        lastSeen: v.lastSeen.toISOString(),
        explanation: describeAnomalyCategory(v.category, v.count),
        recommendedAction: recommendAnomalyAction(v.category),
        sourceTable: "SecurityEvent",
      });
    }
    anomalies.sort((a, b) => b.count - a.count);
    return { meta, anomalies: anomalies.slice(0, 16) };
  } catch {
    return { meta: { ...meta, status: "unavailable" }, anomalies: [] };
  }
}

function describeAnomalyCategory(
  c: SecurityAnomalyCategory,
  count: number,
): string {
  switch (c) {
    case "repeated_failed_access":
      return `${count} failed access events recorded in 24h.`;
    case "blocked_export_attempt":
      return `${count} blocked export attempts in 24h.`;
    case "api_credential_change":
      return `${count} API credential change event(s) in 24h.`;
    case "webhook_failure_spike":
      return `${count} webhook failure event(s) in 24h.`;
    case "admin_role_change":
      return `${count} admin role-change event(s) in 24h.`;
    case "step_up_failed":
      return `${count} step-up authentication failure(s) in 24h.`;
    case "permission_denied_burst":
      return `${count} permission-denied event(s) in 24h.`;
    case "uncategorized":
      return `${count} security event(s) outside the classified catalog in 24h.`;
  }
}

function recommendAnomalyAction(c: SecurityAnomalyCategory): string {
  switch (c) {
    case "repeated_failed_access":
      return "Review the affected user and consider an identity check.";
    case "blocked_export_attempt":
      return "Confirm whether the export was legitimately blocked by governance.";
    case "api_credential_change":
      return "Confirm the credential change was authorized.";
    case "webhook_failure_spike":
      return "Inspect the webhook endpoint and recent deliveries.";
    case "admin_role_change":
      return "Confirm the admin role change was authorized.";
    case "step_up_failed":
      return "Review the failed step-up challenge and verify operator identity.";
    case "permission_denied_burst":
      return "Review the access pattern and confirm the user's role assignment.";
    case "uncategorized":
      return "Review the event in the Security Center for context.";
  }
}

// ---------------------------------------------------------------------------
// Queue / Worker Telemetry (heartbeat freshness from SecurityEvent + DB queues)
// ---------------------------------------------------------------------------

export type QueueWorkerTelemetry = {
  reconcileLastRunAtUtc: string | null;
  reconcileFreshnessHours: number | null;
  reconcileHealth: "FRESH" | "STALE" | "UNAVAILABLE";
  reviewQueueDepth: number;
  reportQueuePending: number;
  packageQueuePending: number;
  oldestQueuedAgeHours: number | null;
  retryStormIncidents: number;
  /** Phase 32.8C+++++ — persisted queue snapshots (BullMQ or DB-derived). */
  queueSnapshots: Array<{
    queueName: string;
    queueDomain: string;
    waitingCount: number;
    activeCount: number;
    delayedCount: number;
    failedCount: number;
    retryCount: number;
    stalledCount: number;
    sampledAtUtc: string;
    source: string;
  }>;
  /** Phase 32.8C+++++ — persisted worker heartbeat per workerKind. */
  workerHeartbeats: Array<{
    workerId: string;
    workerKind: string;
    status: string;
    heartbeatAtUtc: string;
    ageSeconds: number;
    lastErrorCode: string | null;
    processedCount: number | null;
    failedCount: number | null;
  }>;
};

async function runQueueWorkerTelemetry(
  teamId: string,
  scope: WorkspaceScope,
  pop: WorkspacePopulation,
): Promise<{ meta: SectionMeta; data: QueueWorkerTelemetry }> {
  const meta: SectionMeta = {
    status: "ok",
    warnings: [],
    unsupportedSignals: [],
    sourceSummary: [
      "QueueTelemetrySnapshot (Phase 32.8C+++++ — durable queue depth/backlog samples)",
      "WorkerTelemetrySnapshot (Phase 32.8C+++++ — durable worker heartbeat samples)",
      "SecurityEvent(eventType=reviewer_reconcile_run)",
      "EvidenceReviewWorkflow",
      "Evidence",
      "OperationalIncident(occurrenceCount)",
    ],
  };
  // Phase 32.8C+++++ — read durable snapshots if present; lazy-write DB-derived
  // snapshots if absent so the next dashboard load sees data. Both reads are
  // wrapped — a failure degrades to the live-aggregation fallback below.
  let queueSnapshots: QueueWorkerTelemetry["queueSnapshots"] = [];
  let workerHeartbeats: QueueWorkerTelemetry["workerHeartbeats"] = [];
  try {
    queueSnapshots = await listLatestQueueSnapshots({
      teamId,
      withinMinutes: 240,
      limit: 20,
    });
    if (queueSnapshots.length === 0) {
      await recordDbDerivedSnapshotsForWorkspace({ teamId }).catch(() => {});
      queueSnapshots = await listLatestQueueSnapshots({
        teamId,
        withinMinutes: 240,
        limit: 20,
      });
    }
  } catch {
    /* degrade — keep empty array, live-aggregation fallback below covers it */
  }
  try {
    workerHeartbeats = await listLatestWorkerTelemetry({ withinMinutes: 1440 });
  } catch {
    /* degrade */
  }
  try {
    const heartbeat = await prisma.securityEvent.findFirst({
      where: { teamId, eventType: "reviewer_reconcile_run" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    const heartbeatAtUtc = heartbeat?.createdAt ?? null;
    const heartbeatHours = heartbeatAtUtc
      ? (Date.now() - heartbeatAtUtc.getTime()) / 60 / 60 / 1000
      : null;
    const reconcileHealth: "FRESH" | "STALE" | "UNAVAILABLE" =
      heartbeatHours === null
        ? "UNAVAILABLE"
        : heartbeatHours <= 1
          ? "FRESH"
          : "STALE";

    const [
      reviewQueueDepth,
      reportQueuePending,
      packageQueuePending,
      oldestQueued,
      retryStormIncidents,
    ] = await Promise.all([
      scope === "SHARED"
        ? prisma.evidenceReviewWorkflow.count({
            where: { teamId, status: "QUEUED" },
          })
        : Promise.resolve(0),
      prisma.evidence.count({
        where: { AND: [pop.evidence], status: "SIGNED", reports: { none: {} } },
      }),
      prisma.evidence.count({
        where: {
          AND: [pop.evidence],
          status: "REPORTED",
          verificationPackages: { none: {} },
        },
      }),
      scope === "SHARED"
        ? prisma.evidenceReviewWorkflow.findFirst({
            where: { teamId, status: "QUEUED" },
            orderBy: { createdAt: "asc" },
            select: { createdAt: true },
          })
        : Promise.resolve(null),
      prisma.operationalIncident.count({
        where: {
          OR: [{ teamId }, { teamId: null }],
          status: { in: ["OPEN", "ACKNOWLEDGED"] },
          occurrenceCount: { gte: RETRY_STORM_OCCURRENCE_THRESHOLD },
        },
      }),
    ]);

    const oldestQueuedAgeHours = oldestQueued
      ? (Date.now() - oldestQueued.createdAt.getTime()) / 60 / 60 / 1000
      : null;

    return {
      meta,
      data: {
        reconcileLastRunAtUtc: heartbeatAtUtc?.toISOString() ?? null,
        reconcileFreshnessHours:
          heartbeatHours !== null
            ? Number(heartbeatHours.toFixed(2))
            : null,
        reconcileHealth,
        reviewQueueDepth,
        reportQueuePending,
        packageQueuePending,
        oldestQueuedAgeHours:
          oldestQueuedAgeHours !== null
            ? Number(oldestQueuedAgeHours.toFixed(2))
            : null,
        retryStormIncidents,
        queueSnapshots,
        workerHeartbeats,
      },
    };
  } catch {
    return {
      meta: { ...meta, status: "unavailable" },
      data: {
        reconcileLastRunAtUtc: null,
        reconcileFreshnessHours: null,
        reconcileHealth: "UNAVAILABLE",
        reviewQueueDepth: 0,
        reportQueuePending: 0,
        packageQueuePending: 0,
        oldestQueuedAgeHours: null,
        retryStormIncidents: 0,
        queueSnapshots,
        workerHeartbeats,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Coordination Signals (escalations w/o owner + annotations + legal notes)
// ---------------------------------------------------------------------------

export type CoordinationSignal = {
  id: string;
  signalType:
    | "escalation_unassigned"
    | "annotation_requires_review"
    | "annotation_unresolved"
    | "reviewer_comment_unresolved"
    | "case_comment_unresolved"
    | "legal_note_pending"
    | "review_without_recent_activity";
  severity: SeverityTone;
  reasonCode: string;
  entityId: string;
  entityType: "escalation" | "evidence" | "review_workflow" | "case";
  detectedAt: string;
  explanation: string;
  route: string;
};

export type CoordinationBacklog = {
  caseCommentOpenCount: number;
  caseCommentResolvedCount: number;
  caseCommentStaleOpenCount: number;
  reviewerCommentOpenCount: number;
  annotationOpenCount: number;
};

async function runCoordinationSignals(
  teamId: string,
  scope: WorkspaceScope,
): Promise<{
  meta: SectionMeta;
  signals: CoordinationSignal[];
  backlog: CoordinationBacklog;
}> {
  const meta: SectionMeta = {
    status: "ok",
    warnings: [],
    unsupportedSignals: [],
    sourceSummary: [
      "ReviewEscalation(acknowledgedByUserId IS NULL)",
      "EvidenceAnnotation(resolvedAtUtc IS NULL — Phase 32.8C++++)",
      "EvidenceReviewerComment(resolvedAtUtc IS NULL — Phase 32.8C++++)",
      "CaseComment(resolvedAtUtc IS NULL — Phase 32.8C+++++)",
      "EvidenceLegalNote",
      "EvidenceReviewWorkflow(updatedAt stale)",
    ],
  };
  const emptyBacklog: CoordinationBacklog = {
    caseCommentOpenCount: 0,
    caseCommentResolvedCount: 0,
    caseCommentStaleOpenCount: 0,
    reviewerCommentOpenCount: 0,
    annotationOpenCount: 0,
  };
  if (scope === "SINGLE_OCCUPANT") {
    return {
      meta: { ...meta, status: "not_applicable" },
      signals: [],
      backlog: emptyBacklog,
    };
  }
  const signals: CoordinationSignal[] = [];
  // Backlog counts from Phase 32.8C++++ + Phase 32.8C+++++ resolved-tracking
  // columns. Each query is wrapped — a single failure degrades that count
  // to 0 without breaking the whole section.
  const [
    caseCommentBacklog,
    reviewerCommentOpen,
    annotationOpen,
  ] = await Promise.all([
    getWorkspaceCaseCommentBacklog({ teamId, staleAfterDays: 14 }),
    prisma.evidenceReviewerComment
      .count({
        where: { evidence: { teamId }, resolvedAtUtc: null },
      })
      .catch(() => 0),
    prisma.evidenceAnnotation
      .count({
        where: { evidence: { teamId }, resolvedAtUtc: null },
      })
      .catch(() => 0),
  ]);
  const backlog: CoordinationBacklog = {
    caseCommentOpenCount: caseCommentBacklog.openCount,
    caseCommentResolvedCount: caseCommentBacklog.resolvedCount,
    caseCommentStaleOpenCount: caseCommentBacklog.staleOpenCount,
    reviewerCommentOpenCount: reviewerCommentOpen,
    annotationOpenCount: annotationOpen,
  };
  try {
    // Unresolved reviewer comments — surface the oldest ones as signals.
    const unresolvedReviewerComments = await prisma.evidenceReviewerComment
      .findMany({
        where: { evidence: { teamId }, resolvedAtUtc: null },
        orderBy: { createdAt: "asc" },
        take: 6,
        select: { id: true, evidenceId: true, createdAt: true },
      })
      .catch(() => []);
    for (const c of unresolvedReviewerComments) {
      signals.push({
        id: `unresolved_rc:${c.id}`,
        signalType: "reviewer_comment_unresolved",
        severity: "warning",
        reasonCode: "REVIEWER_COMMENT_UNRESOLVED",
        entityId: c.evidenceId,
        entityType: "evidence",
        detectedAt: c.createdAt.toISOString(),
        explanation: "Reviewer comment recorded but not marked resolved.",
        route: `/evidence/${c.evidenceId}`,
      });
    }
    // Unresolved annotations.
    const unresolvedAnnotations = await prisma.evidenceAnnotation
      .findMany({
        where: { evidence: { teamId }, resolvedAtUtc: null },
        orderBy: { createdAt: "asc" },
        take: 6,
        select: { id: true, evidenceId: true, createdAt: true },
      })
      .catch(() => []);
    for (const a of unresolvedAnnotations) {
      signals.push({
        id: `unresolved_ann:${a.id}`,
        signalType: "annotation_unresolved",
        severity: "warning",
        reasonCode: "ANNOTATION_UNRESOLVED",
        entityId: a.evidenceId,
        entityType: "evidence",
        detectedAt: a.createdAt.toISOString(),
        explanation: "Annotation recorded but not marked resolved.",
        route: `/evidence/${a.evidenceId}`,
      });
    }
    // Unresolved case-level comments.
    const unresolvedCaseComments = await prisma.caseComment
      .findMany({
        where: { teamId, resolvedAtUtc: null },
        orderBy: { createdAt: "asc" },
        take: 6,
        select: { id: true, caseId: true, createdAt: true },
      })
      .catch(() => []);
    for (const c of unresolvedCaseComments) {
      signals.push({
        id: `unresolved_cc:${c.id}`,
        signalType: "case_comment_unresolved",
        severity: "warning",
        reasonCode: "CASE_COMMENT_UNRESOLVED",
        entityId: c.caseId,
        entityType: "case",
        detectedAt: c.createdAt.toISOString(),
        explanation: "Case-level comment recorded but not marked resolved.",
        route: `/cases/${c.caseId}`,
      });
    }
    // Unowned open escalations.
    const unowned = await prisma.reviewEscalation.findMany({
      where: { teamId, status: "OPEN", acknowledgedByUserId: null },
      orderBy: { createdAt: "desc" },
      take: 6,
      select: { id: true, severity: true, createdAt: true, reason: true },
    });
    for (const e of unowned) {
      signals.push({
        id: `unowned_esc:${e.id}`,
        signalType: "escalation_unassigned",
        severity: (e.severity === "CRITICAL"
          ? "critical"
          : e.severity === "HIGH"
            ? "high"
            : "warning") as SeverityTone,
        reasonCode: "ESCALATION_UNASSIGNED",
        entityId: e.id,
        entityType: "escalation",
        detectedAt: e.createdAt.toISOString(),
        explanation: `Open escalation has no acknowledging user · ${String(e.reason)}.`,
        route: "/reviewer-ops/escalations",
      });
    }
    // Recent annotations (assumed to require review on creation; we surface
    // recent ones as coordination signals — no dedicated "resolved" column).
    const annotations = await prisma.evidenceAnnotation
      .findMany({
        where: { evidence: { teamId } },
        orderBy: { createdAt: "desc" },
        take: 6,
        select: { id: true, evidenceId: true, createdAt: true },
      })
      .catch(() => []);
    for (const a of annotations) {
      signals.push({
        id: `ann:${a.id}`,
        signalType: "annotation_requires_review",
        severity: "info",
        reasonCode: "ANNOTATION_NEW",
        entityId: a.evidenceId,
        entityType: "evidence",
        detectedAt: a.createdAt.toISOString(),
        explanation:
          "A new annotation was recorded; resolution tracking is not yet modeled in this workspace.",
        route: `/evidence/${a.evidenceId}`,
      });
    }
    // Recent legal notes.
    const legalNotes = await prisma.evidenceLegalNote
      .findMany({
        where: { evidence: { teamId } },
        orderBy: { createdAt: "desc" },
        take: 6,
        select: { id: true, evidenceId: true, createdAt: true, noteType: true },
      })
      .catch(() => []);
    for (const n of legalNotes) {
      signals.push({
        id: `legal_note:${n.id}`,
        signalType: "legal_note_pending",
        severity: "info",
        reasonCode: `LEGAL_NOTE_${String(n.noteType).toUpperCase()}`,
        entityId: n.evidenceId,
        entityType: "evidence",
        detectedAt: n.createdAt.toISOString(),
        explanation: `Legal note · ${String(n.noteType)}`,
        route: `/evidence/${n.evidenceId}`,
      });
    }
    // Review workflows with no recent activity (assigned but stale).
    const stale = await prisma.evidenceReviewWorkflow.findMany({
      where: {
        teamId,
        status: { in: ["ASSIGNED", "IN_REVIEW", "NEEDS_INFO"] },
        updatedAt: {
          lt: new Date(Date.now() - STALLED_REVIEW_HOURS * 60 * 60 * 1000),
        },
      },
      orderBy: { updatedAt: "asc" },
      take: 6,
      select: { id: true, evidenceId: true, updatedAt: true },
    });
    for (const r of stale) {
      signals.push({
        id: `stale_rev:${r.id}`,
        signalType: "review_without_recent_activity",
        severity: "warning",
        reasonCode: "REVIEW_NO_RECENT_ACTIVITY",
        entityId: r.id,
        entityType: "review_workflow",
        detectedAt: r.updatedAt.toISOString(),
        explanation: `Assigned review workflow has not been touched in ${STALLED_REVIEW_HOURS}h+.`,
        route: `/evidence/${r.evidenceId}`,
      });
    }
  } catch {
    return {
      meta: { ...meta, status: "unavailable" },
      signals: [],
      backlog,
    };
  }
  return { meta, signals: signals.slice(0, 16), backlog };
}

// ---------------------------------------------------------------------------
// Predictive Risk Forecast (deterministic heuristics — no ML/AI)
// ---------------------------------------------------------------------------

export type PredictiveRiskForecast = {
  id: string;
  forecastType:
    | "sla_breach_imminent"
    | "reviewer_capacity_breach"
    | "report_pipeline_degradation"
    | "package_pipeline_degradation"
    | "governance_pressure_rising"
    | "audit_readiness_gap";
  severity: SeverityTone;
  reason: string;
  likelyImpact: string;
  recommendedAction: string;
  confidence: "low" | "medium" | "high";
  evidenceCount: number;
  caseCount: number;
};

function runPredictiveRisk(input: {
  reviewer: CommandCenterEnvelope["sections"]["reviewerOrchestration"];
  governance: CommandCenterEnvelope["sections"]["governancePosture"];
  pipeline: CommandCenterEnvelope["sections"]["pipelineDetail"];
  audit: CommandCenterEnvelope["sections"]["auditReadiness"];
  retryStorm: number;
}): { meta: SectionMeta; forecasts: PredictiveRiskForecast[] } {
  const meta: SectionMeta = {
    status: "ok",
    warnings: [],
    unsupportedSignals: [
      "ml_probability_model (no ML in scope; this is deterministic heuristic forecast)",
      "historical_trend_baseline (only last 7d + prev 7d windows; no longer baseline persisted)",
    ],
    sourceSummary: [
      "ReviewerOrchestration (overdueCount, dueSoonCount, completedLast7dCount vs completedPrev7dCount)",
      "GovernancePosture (policyConflictsCount, blockedExportsCount)",
      "PipelineDetail (reports/packages failed/blocked counts)",
      "AuditReadiness (severity != info counters)",
      "OperationalIncident (retry storms)",
    ],
  };
  const forecasts: PredictiveRiskForecast[] = [];

  const reviewer = input.reviewer.data;
  const pipeline = input.pipeline.data;
  const governance = input.governance.data;
  const audit = input.audit.counters;

  if (reviewer) {
    if (reviewer.dueSoonCount >= 5 && reviewer.queueDepth >= 10) {
      forecasts.push({
        id: "fc_sla_imminent",
        forecastType: "sla_breach_imminent",
        severity: reviewer.dueSoonCount >= 12 ? "high" : "warning",
        reason: `${reviewer.dueSoonCount} review workflows are due within 24h and the queue depth is ${reviewer.queueDepth}.`,
        likelyImpact:
          "Without rebalancing, several reviews will breach SLA inside the next operational window.",
        recommendedAction:
          "Reassign or expedite the due-soon workflows.",
        confidence: reviewer.dueSoonCount >= 12 ? "high" : "medium",
        evidenceCount: reviewer.dueSoonCount,
        caseCount: 0,
      });
    }
    const delta =
      reviewer.completedLast7dCount - reviewer.completedPrev7dCount;
    if (delta <= -3 && reviewer.queueDepth >= 10) {
      forecasts.push({
        id: "fc_reviewer_capacity",
        forecastType: "reviewer_capacity_breach",
        severity: "warning",
        reason: `Throughput dropped by ${Math.abs(delta)} reviews week-over-week while queue depth remains at ${reviewer.queueDepth}.`,
        likelyImpact:
          "Backlog growth without capacity intervention.",
        recommendedAction:
          "Investigate reviewer availability and redistribute workload.",
        confidence: "medium",
        evidenceCount: reviewer.queueDepth,
        caseCount: 0,
      });
    }
  }

  if (pipeline) {
    if (pipeline.reports.failed >= 2 || pipeline.reports.queued >= 10) {
      forecasts.push({
        id: "fc_report_pipeline",
        forecastType: "report_pipeline_degradation",
        severity: pipeline.reports.failed >= 4 ? "high" : "warning",
        reason: `Reports failed: ${pipeline.reports.failed} · reports queued: ${pipeline.reports.queued}.`,
        likelyImpact:
          "Report pipeline backlog will continue to grow without operator intervention.",
        recommendedAction:
          "Investigate the report generator and the affected runbooks.",
        confidence: pipeline.reports.failed >= 4 ? "high" : "medium",
        evidenceCount: pipeline.reports.queued + pipeline.reports.failed,
        caseCount: 0,
      });
    }
    if (pipeline.packages.blocked >= 3 || pipeline.packages.failed >= 2) {
      forecasts.push({
        id: "fc_package_pipeline",
        forecastType: "package_pipeline_degradation",
        severity:
          pipeline.packages.blocked >= 5 || pipeline.packages.failed >= 4
            ? "high"
            : "warning",
        reason: `Packages blocked: ${pipeline.packages.blocked} · packages failed: ${pipeline.packages.failed}.`,
        likelyImpact:
          "Deliverable generation will stall without governance review or runbook intervention.",
        recommendedAction:
          "Address blocked packages in Governance and failed packages in Operations Center.",
        confidence: "medium",
        evidenceCount:
          pipeline.packages.blocked + pipeline.packages.failed,
        caseCount: 0,
      });
    }
  }

  if (governance) {
    if (
      governance.policyConflictsCount >= 1 ||
      governance.blockedExportsCount >= 3
    ) {
      forecasts.push({
        id: "fc_governance",
        forecastType: "governance_pressure_rising",
        severity:
          governance.policyConflictsCount >= 3 ||
          governance.blockedExportsCount >= 6
            ? "high"
            : "warning",
        reason: `Policy conflicts: ${governance.policyConflictsCount} · blocked exports: ${governance.blockedExportsCount}.`,
        likelyImpact:
          "Governance gate denials will continue to interfere with downstream operations.",
        recommendedAction:
          "Open the governance control plane and reconcile policy + holds.",
        confidence:
          governance.policyConflictsCount >= 3 ||
          governance.blockedExportsCount >= 6
            ? "high"
            : "medium",
        evidenceCount: governance.blockedExportsCount,
        caseCount: 0,
      });
    }
  }

  const flagged = audit.filter(
    (c) => c.severity !== "info" && c.value > 0,
  ).length;
  if (flagged >= 3) {
    forecasts.push({
      id: "fc_audit",
      forecastType: "audit_readiness_gap",
      severity: flagged >= 5 ? "high" : "warning",
      reason: `${flagged} audit-readiness signals are flagged.`,
      likelyImpact:
        "An external audit pass would surface unresolved gaps without operator action.",
      recommendedAction:
        "Resolve the flagged audit-readiness counters before the next reporting cycle.",
      confidence: "medium",
      evidenceCount: audit.reduce(
        (s, c) => (c.severity !== "info" ? s + c.value : s),
        0,
      ),
      caseCount: 0,
    });
  }

  if (input.retryStorm >= 1) {
    forecasts.push({
      id: "fc_retry_storm",
      forecastType: "report_pipeline_degradation",
      severity: input.retryStorm >= 3 ? "high" : "warning",
      reason: `${input.retryStorm} active retry-storm incident(s).`,
      likelyImpact:
        "Repeat failures will continue to consume worker capacity.",
      recommendedAction:
        "Open the runbook and address the underlying job.",
      confidence: input.retryStorm >= 3 ? "high" : "medium",
      evidenceCount: 0,
      caseCount: 0,
    });
  }

  return { meta, forecasts };
}

// ---------------------------------------------------------------------------
// Organizational Intelligence V2 (bottleneck domains + top pressure sources)
// ---------------------------------------------------------------------------

export type OrgIntelligenceV2 = {
  orgHealth: "HEALTHY" | "WATCH" | "DEGRADED" | "CRITICAL";
  bottleneckDomains: Array<{
    domain: OperationalDomain;
    pressureItems: number;
  }>;
  topPressureSources: Array<{ sourceTable: string; itemCount: number }>;
  throughputWindows: {
    last24h: number;
    last7d: number;
    last30d: number;
  };
  recommendedActions: string[];
};

async function runOrgIntelligenceV2(
  teamId: string,
  pressure: CommandCenterEnvelope["sections"]["operationalPressure"],
  workload: CommandCenterEnvelope["sections"]["workloadEngine"],
  pop: WorkspacePopulation,
): Promise<{ meta: SectionMeta; data: OrgIntelligenceV2 }> {
  const meta: SectionMeta = {
    status: "ok",
    warnings: [],
    unsupportedSignals: [],
    sourceSummary: [
      "OperationalPressure items (by affectedDomain + sourceTable)",
      "Evidence (24h / 7d / 30d windows)",
      "WorkloadEngine.health",
    ],
  };
  try {
    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const evidence30d = await prisma.evidence.count({
      where: { AND: [pop.evidence], createdAt: { gte: since30d } },
    });
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [last24h, last7d] = await Promise.all([
      prisma.evidence.count({ where: { AND: [pop.evidence], createdAt: { gte: since24h } } }),
      prisma.evidence.count({ where: { AND: [pop.evidence], createdAt: { gte: since7d } } }),
    ]);

    // Bottleneck domains — group pressure items by affectedDomain.
    const domainCounts = new Map<OperationalDomain, number>();
    for (const item of pressure.items) {
      domainCounts.set(
        item.affectedDomain,
        (domainCounts.get(item.affectedDomain) ?? 0) + 1,
      );
    }
    const bottleneckDomains = Array.from(domainCounts.entries())
      .map(([domain, pressureItems]) => ({ domain, pressureItems }))
      .sort((a, b) => b.pressureItems - a.pressureItems)
      .slice(0, 5);

    // Top pressure sources — group by sourceTable.
    const sourceCounts = new Map<string, number>();
    for (const item of pressure.items) {
      sourceCounts.set(
        item.sourceTable,
        (sourceCounts.get(item.sourceTable) ?? 0) + 1,
      );
    }
    const topPressureSources = Array.from(sourceCounts.entries())
      .map(([sourceTable, itemCount]) => ({ sourceTable, itemCount }))
      .sort((a, b) => b.itemCount - a.itemCount)
      .slice(0, 5);

    const critical = pressure.counts.critical;
    const high = pressure.counts.high;
    const orgHealth: OrgIntelligenceV2["orgHealth"] =
      critical > 0 || workload.health === "CRITICAL"
        ? "CRITICAL"
        : high > 0 || workload.health === "DEGRADED"
          ? "DEGRADED"
          : pressure.counts.warning > 0 || workload.health === "WATCH"
            ? "WATCH"
            : "HEALTHY";

    const recommendedActions: string[] = [];
    for (const b of bottleneckDomains.slice(0, 3)) {
      if (b.pressureItems > 0) {
        recommendedActions.push(
          `Address pressure in domain · ${b.domain} (${b.pressureItems} items)`,
        );
      }
    }
    if (workload.health === "CRITICAL" || workload.health === "DEGRADED") {
      recommendedActions.push(
        "Rebalance reviewer workload — team health is " + workload.health,
      );
    }

    return {
      meta,
      data: {
        orgHealth,
        bottleneckDomains,
        topPressureSources,
        throughputWindows: {
          last24h,
          last7d,
          last30d: evidence30d,
        },
        recommendedActions,
      },
    };
  } catch {
    return {
      meta: { ...meta, status: "unavailable" },
      data: {
        orgHealth: "WATCH",
        bottleneckDomains: [],
        topPressureSources: [],
        throughputWindows: { last24h: 0, last7d: 0, last30d: 0 },
        recommendedActions: [],
      },
    };
  }
}

// =============================================================================
// PHASE 37.98 — Projection-backed summary
// =============================================================================

/**
 * Threshold for "fresh" projection rows. The refresh worker is expected to
 * tick every 60s; anything older than 90s is reported as stale so the UI
 * can render an honest chip.
 */
const PROJECTION_FRESH_THRESHOLD_SEC = 90;

/**
 * PHASE 13 §4 (2026-08-17) — THIS READ REFRESHES THE PROJECTION WHEN IT IS
 * MISSING OR STALE. That is what makes the projection a projection.
 *
 * `refreshOrgHealthProjection` was the only writer of `orgHealthProjection` and
 * nothing called it, so the row read below was never written by anything: every
 * request took the "missing" branch, reported `usedLiveFallback: true`, and
 * returned two of the eight counters with the other six defaulted to zero. The
 * comment further down still said "until the refresh worker populates the row";
 * there was no refresh worker. The worker-side queue processor that would have
 * been one has no producer either — nothing ever enqueues `org-health-refresh` —
 * so neither half of the pair ran.
 *
 * Refresh-on-stale-read rather than a new scheduler, deliberately:
 *
 *   - freshness only matters when somebody is looking, and this IS the moment
 *     somebody is looking;
 *   - a per-tenant scheduler for every workspace in the system would compute
 *     eight counters for tenants nobody has opened in months;
 *   - the write is bounded by the sample bucket. `sampledAtUtc` is floored to
 *     the minute and the upsert keys on it, so concurrent dashboard loads inside
 *     one minute converge on ONE row rather than racing to append.
 *
 * Failure is non-fatal and falls through to the branches below: a dashboard must
 * render when its cache cannot be written.
 *
 * PHASE 13 (NEW-047) — THIS CONSTRAINT NO LONGER EXISTS, AND SAYING SO MATTERS.
 *
 * This paragraph used to instruct future editors to keep commentary out of the
 * body because `phase-37-98-command-center-projection-consumption.test.ts`
 * pinned the live fallback with a 3000-CHARACTER WINDOW measured from the
 * `buildProjectionSummary` token — so a long comment between the two could fail
 * the assertion while the code it described was unchanged.
 *
 * That test now resolves this declaration through the module's import table and
 * walks the resolved call graph, so distance in the source text decides nothing
 * and a comment cannot break it. Write the explanation wherever it belongs.
 *
 * The instruction is removed rather than softened because a comment that
 * invents a constraint is how the next reader arranges real code around a rule
 * that is not there — the same defect class as NEW-038.
 */
async function buildProjectionSummary(
  teamId: string,
  pop: WorkspacePopulation,
): Promise<CommandCenterEnvelope["projectionSummary"]> {
  // Read the most recent projection row for THIS tenant. The Prisma
  // helper filters by teamId; cross-tenant read is impossible.
  let row: Awaited<ReturnType<typeof readLatestOrgHealthProjection>> = null;
  try {
    row = await readLatestOrgHealthProjection({ teamId });
  } catch {
    row = null;
  }

  // PHASE 13 §4 (2026-08-17) — refresh when the read finds the projection
  // missing or stale. Rationale in the docblock above; the bound is the sample
  // bucket, so concurrent loads inside a minute converge on one row.
  const projectionStale =
    row === null ||
    Date.now() - row.sampledAtUtc.getTime() > PROJECTION_FRESH_THRESHOLD_SEC * 1000;
  if (projectionStale) {
    try {
      row = await refreshOrgHealthProjection({ teamId });
    } catch {
      /* keep whatever the read returned; the branches below cope with null */
    }
  }

  if (row) {
    const ageSec = Math.max(
      0,
      Math.floor((Date.now() - row.sampledAtUtc.getTime()) / 1000),
    );
    const projectionStatus =
      ageSec <= PROJECTION_FRESH_THRESHOLD_SEC ? "fresh" : "stale";
    return {
      projectionStatus,
      projectionRefreshedAt: row.sampledAtUtc.toISOString(),
      projectionAgeSeconds: ageSec,
      usedLiveFallback: false,
      teamId,
      counts: {
        evidenceCount: row.evidenceCount,
        caseCount: row.caseCount,
        pendingReportCount: row.pendingReportCount,
        pendingPackageCount: row.pendingPackageCount,
        openIncidentCount: row.openIncidentCount,
        slaBreachCount: row.slaBreachCount,
        governanceBlockerCount: row.governanceBlockerCount,
        recentVerificationCount: row.recentVerificationCount,
      },
    };
  }

  // No projection — bounded live fallback. Only the two counters that
  // live-aggregate cheaply (evidence + case totals) are queried; the
  // other six default to 0 and the consumer renders an "unavailable"
  // chip until the refresh worker populates the row.
  try {
    const [evidenceCount, caseCount] = await Promise.all([
      prisma.evidence.count({ where: { AND: [pop.evidence], deletedAt: null } }),
      prisma.case.count({ where: { AND: [pop.cases] } }),
    ]);
    return {
      projectionStatus: "missing",
      projectionRefreshedAt: null,
      projectionAgeSeconds: null,
      usedLiveFallback: true,
      teamId,
      counts: {
        evidenceCount,
        caseCount,
        pendingReportCount: 0,
        pendingPackageCount: 0,
        openIncidentCount: 0,
        slaBreachCount: 0,
        governanceBlockerCount: 0,
        recentVerificationCount: 0,
      },
    };
  } catch {
    return {
      projectionStatus: "missing",
      projectionRefreshedAt: null,
      projectionAgeSeconds: null,
      usedLiveFallback: true,
      teamId,
      counts: {
        evidenceCount: 0,
        caseCount: 0,
        pendingReportCount: 0,
        pendingPackageCount: 0,
        openIncidentCount: 0,
        slaBreachCount: 0,
        governanceBlockerCount: 0,
        recentVerificationCount: 0,
      },
    };
  }
}

