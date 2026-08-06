/**
 * Phase 28-D — Governance Snapshot Service.
 *
 * Single read-side aggregator that returns the FULL governance state
 * for one evidence record. Used by:
 *
 *   - Evidence detail page (lifecycle / hold / retention / export
 *     / package eligibility badges)
 *   - Reviewer Ops workspace (governance blockers banner)
 *   - Compliance export flow (pre-flight check)
 *   - Verification package builder (pre-generation gate)
 *   - Governance dashboard (per-record drill-down)
 *
 * Before this service existed, every consumer ran its own bespoke
 * combination of `checkExportEligibility`, `listLegalHoldsForEvidence`,
 * `resolveEffectiveRetentionPolicy`, and direct prisma reads against
 * `evidence_review_workflows` / `operational_incidents`. The result
 * was inconsistent: the export flow used one decision shape, the
 * destruction queue used another, the Reviewer Ops dashboard used a
 * third. This service is the SINGLE source of truth.
 *
 * Hard rules:
 *   - Read-only. Never mutates state.
 *   - Routes the export + package decisions through the canonical
 *     helpers in @proovra/shared (`canonicalEvaluateExportEligibility`,
 *     `canonicalEvaluatePackageEligibility`,
 *     `canonicalCanEnterPendingDestruction`). No inline duplication.
 *   - Storage drift is reported as a STORAGE GOVERNANCE state, never
 *     as content tampering. The label and reason fields are bounded.
 *   - Privacy: never returns private reviewer notes, raw evidence
 *     bytes, legal-note bodies, or secrets. Only operator-safe
 *     identifiers and labels.
 *   - The same projection is safe to send to a public verify page,
 *     a workspace operator, or an external reviewer — the consumer
 *     decides which fields to render.
 */

import type { PrismaClient } from "@prisma/client";
import * as prismaPkg from "@prisma/client";
import {
  canonicalCanEnterPendingDestruction,
  canonicalEvaluateExportEligibility,
  canonicalEvaluatePackageEligibility,
  exportEligibilityLabel,
  packageEligibilityLabel,
  type CanonicalExportOutcome,
  type EvidenceLifecycleState,
  type PackageEligibilityOutcome,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";

// -----------------------------------------------------------------------------
// Shape
// -----------------------------------------------------------------------------

export type GovernanceWarningSeverity = "INFO" | "WARNING" | "HIGH" | "CRITICAL";

export type GovernanceWarning = {
  /** Stable code; UI consumers may key conditional rendering on it. */
  code:
    | "ACTIVE_LEGAL_HOLD"
    | "ACTIVE_CASE_HOLD"
    | "LIFECYCLE_PENDING_DESTRUCTION"
    | "LIFECYCLE_DESTROYED"
    | "LIFECYCLE_ON_HOLD"
    | "LIFECYCLE_RETENTION_LOCKED"
    | "DESTRUCTION_REVIEW_ACTIVE"
    | "IMMUTABLE_STORAGE_DRIFT"
    | "SLA_DUE_SOON"
    | "SLA_BREACHED"
    | "ESCALATION_OPEN"
    | "RETENTION_EXPIRED"
    | "INCIDENT_OPEN_HIGH"
    | "INCIDENT_OPEN_CRITICAL";
  /** Operator-readable, bounded-catalog label. Safe to render. */
  label: string;
  severity: GovernanceWarningSeverity;
};

export type GovernanceSnapshot = {
  evidenceId: string;
  teamId: string;
  generatedAtUtc: string;

  lifecycle: {
    state: EvidenceLifecycleState;
    label: string;
    isTerminal: boolean;
  };

  review: {
    workflowId: string | null;
    status: string | null;
    stage: string | null;
    assignedReviewerUserId: string | null;
    slaStatus: string | null;
    activeEscalationId: string | null;
    activeEscalationSeverity: string | null;
  };

  legalHold: {
    hasActiveDirectHold: boolean;
    hasActiveCaseHold: boolean;
    directHoldCount: number;
    caseHoldCount: number;
    blocksDestruction: boolean;
    blocksExport: boolean;
  };

  retention: {
    bound: boolean;
    policyId: string | null;
    policyVersion: number | null;
    retentionUntilUtc: string | null;
    immutable: boolean;
    expired: boolean;
  };

  destruction: {
    activeReviewId: string | null;
    activeReviewStatus: string | null;
    eligible: boolean;
    blockedReason: string | null;
  };

  export: {
    eligible: boolean;
    outcome: CanonicalExportOutcome;
    reason: string;
    label: string;
  };

  package: {
    eligible: boolean;
    outcome: PackageEligibilityOutcome;
    reason: string;
    label: string;
  };

  immutableStorage: {
    driftDetected: boolean;
    driftIncidentId: string | null;
    /** Operator-safe wording; NEVER implies content tamper. */
    driftLabel: string | null;
  };

  incidents: Array<{
    id: string;
    severity: string;
    category: string;
    title: string;
    openedAtUtc: string;
    runbookSlug: string | null;
  }>;

  warnings: ReadonlyArray<GovernanceWarning>;
};

// -----------------------------------------------------------------------------
// Helper — operator-readable label for each lifecycle state
// -----------------------------------------------------------------------------

function lifecycleLabel(state: EvidenceLifecycleState): string {
  switch (state) {
    case "ACTIVE":
      return "Active";
    case "UNDER_REVIEW":
      return "Under review";
    case "ON_HOLD":
      return "On hold";
    case "RETENTION_LOCKED":
      return "Retention locked";
    case "PENDING_DESTRUCTION":
      return "Pending destruction";
    case "DESTROYED":
      return "Destroyed";
    case "ARCHIVED":
      return "Archived";
  }
}

function lifecycleIsTerminal(state: EvidenceLifecycleState): boolean {
  return state === "DESTROYED";
}

// -----------------------------------------------------------------------------
// Warning derivation
// -----------------------------------------------------------------------------

function deriveWarnings(snap: Omit<GovernanceSnapshot, "warnings">): GovernanceWarning[] {
  const out: GovernanceWarning[] = [];

  if (snap.legalHold.hasActiveDirectHold) {
    out.push({
      code: "ACTIVE_LEGAL_HOLD",
      label: "Active legal hold on this evidence record",
      severity: "HIGH",
    });
  }
  if (snap.legalHold.hasActiveCaseHold) {
    out.push({
      code: "ACTIVE_CASE_HOLD",
      label: "Active legal hold on the parent case",
      severity: "HIGH",
    });
  }

  switch (snap.lifecycle.state) {
    case "PENDING_DESTRUCTION":
      out.push({
        code: "LIFECYCLE_PENDING_DESTRUCTION",
        label: "Evidence is queued for destruction",
        severity: "HIGH",
      });
      break;
    case "DESTROYED":
      out.push({
        code: "LIFECYCLE_DESTROYED",
        label: "Evidence has been destroyed",
        severity: "CRITICAL",
      });
      break;
    case "ON_HOLD":
      out.push({
        code: "LIFECYCLE_ON_HOLD",
        label: "Lifecycle state is on hold",
        severity: "WARNING",
      });
      break;
    case "RETENTION_LOCKED":
      out.push({
        code: "LIFECYCLE_RETENTION_LOCKED",
        label: "Retention locked — destruction is not currently allowed",
        severity: "INFO",
      });
      break;
    default:
      break;
  }

  if (snap.destruction.activeReviewId && snap.destruction.activeReviewStatus) {
    if (
      ["PENDING", "UNDER_REVIEW", "DEFERRED", "APPROVED"].includes(
        snap.destruction.activeReviewStatus,
      )
    ) {
      out.push({
        code: "DESTRUCTION_REVIEW_ACTIVE",
        label: `Destruction review in progress (${snap.destruction.activeReviewStatus.toLowerCase()})`,
        severity: "HIGH",
      });
    }
  }

  if (snap.immutableStorage.driftDetected) {
    out.push({
      code: "IMMUTABLE_STORAGE_DRIFT",
      label:
        "Storage governance drift — database immutability flag and object-lock state disagree (storage state only; not a content-integrity finding)",
      severity: "HIGH",
    });
  }

  switch (snap.review.slaStatus) {
    case "DUE_SOON":
      out.push({
        code: "SLA_DUE_SOON",
        label: "Reviewer SLA approaching deadline",
        severity: "WARNING",
      });
      break;
    case "BREACHED":
      out.push({
        code: "SLA_BREACHED",
        label: "Reviewer SLA breached",
        severity: "HIGH",
      });
      break;
    default:
      break;
  }

  if (snap.review.activeEscalationId) {
    out.push({
      code: "ESCALATION_OPEN",
      label: `Open reviewer escalation (${(
        snap.review.activeEscalationSeverity ?? "WARNING"
      ).toLowerCase()})`,
      severity:
        snap.review.activeEscalationSeverity === "CRITICAL"
          ? "CRITICAL"
          : "HIGH",
    });
  }

  if (snap.retention.expired) {
    out.push({
      code: "RETENTION_EXPIRED",
      label: "Retention window expired — destruction review eligible",
      severity: "INFO",
    });
  }

  for (const incident of snap.incidents) {
    if (incident.severity === "CRITICAL") {
      out.push({
        code: "INCIDENT_OPEN_CRITICAL",
        label: `Open CRITICAL incident: ${incident.title}`,
        severity: "CRITICAL",
      });
    } else if (incident.severity === "HIGH") {
      out.push({
        code: "INCIDENT_OPEN_HIGH",
        label: `Open HIGH incident: ${incident.title}`,
        severity: "HIGH",
      });
    }
  }

  return out;
}

// -----------------------------------------------------------------------------
// Service entry
// -----------------------------------------------------------------------------

export class GovernanceSnapshotError extends Error {
  readonly code: "EVIDENCE_NOT_FOUND" | "TEAM_MISMATCH";
  constructor(code: "EVIDENCE_NOT_FOUND" | "TEAM_MISMATCH") {
    super(code);
    this.code = code;
    this.name = "GovernanceSnapshotError";
  }
}

const IMMUTABLE_DRIFT_RUNBOOK = "immutable-drift";

export async function buildGovernanceSnapshot(
  input: { teamId: string; evidenceId: string },
  client: PrismaClient = defaultPrisma,
): Promise<GovernanceSnapshot> {
  bump("governance_snapshot_requested_total");

  // 1) Evidence + retention + active destruction review pointer.
  const evidence = await client.evidence.findFirst({
    where: { id: input.evidenceId, teamId: input.teamId },
    select: {
      id: true,
      teamId: true,
      caseLinks: { select: { caseId: true }, take: 100 },
      lifecycleState: true,
      retentionPolicyVersionId: true,
      retentionUntilUtc: true,
      activeDestructionReviewId: true,
    },
  });
  if (!evidence) {
    throw new GovernanceSnapshotError("EVIDENCE_NOT_FOUND");
  }
  const lifecycleState = (evidence.lifecycleState ??
    "ACTIVE") as EvidenceLifecycleState;

  // 2) Run the data-fan-out in parallel. Each query is bounded and
  //    returns a small projection.
  const [
    directHoldCount,
    caseHoldCount,
    retentionPolicyVersion,
    activeDestructionReview,
    workflow,
    openIncidents,
    activeEscalation,
  ] = await Promise.all([
    client.evidenceLegalHold.count({
      where: {
        evidenceId: input.evidenceId,
        status: prismaPkg.LegalHoldStatus.ACTIVE,
      },
    }),
    // Track 1B closure — count ACTIVE holds across ALL linked cases.
    evidence.caseLinks.length > 0
      ? client.evidenceLegalHold.count({
          // P12.3 canonical-only (scope='CASE').
          where: { scope: "CASE",
            caseId: { in: evidence.caseLinks.map((l) => l.caseId) },
            status: prismaPkg.LegalHoldStatus.ACTIVE,
          },
        })
      : Promise.resolve(0),
    evidence.retentionPolicyVersionId
      ? client.evidenceRetentionPolicyVersion.findUnique({
          where: { id: evidence.retentionPolicyVersionId },
          select: {
            id: true,
            retentionPolicyId: true,
            version: true,
            immutable: true,
          },
        })
      : Promise.resolve(null),
    evidence.activeDestructionReviewId
      ? client.destructionReview.findUnique({
          where: { id: evidence.activeDestructionReviewId },
          select: { id: true, status: true },
        })
      : Promise.resolve(null),
    client.evidenceReviewWorkflow.findUnique({
      where: { evidenceId: input.evidenceId },
      select: {
        id: true,
        status: true,
        assignedToUserId: true,
        slaStatus: true,
        activeEscalationId: true,
      },
    }),
    client.operationalIncident.findMany({
      where: {
        teamId: input.teamId,
        relatedEvidenceId: input.evidenceId,
        status: { in: ["OPEN", "ACKNOWLEDGED"] },
      },
      select: {
        id: true,
        severity: true,
        category: true,
        title: true,
        firstSeenAtUtc: true,
        runbookSlug: true,
      },
      orderBy: { firstSeenAtUtc: "desc" },
      take: 50,
    }),
    // Active escalation severity. Looked up lazily via the workflow
    // pointer below.
    Promise.resolve(null as null | {
      id: string;
      severity: string;
    }),
  ]);

  let escalation: { id: string; severity: string } | null = null;
  if (workflow?.activeEscalationId) {
    const row = await client.reviewEscalation.findUnique({
      where: { id: workflow.activeEscalationId },
      select: { id: true, severity: true },
    });
    if (row) escalation = { id: row.id, severity: row.severity };
  }
  // `activeEscalation` placeholder kept so the parallel-load pattern
  // stays uniform if a future revision moves the lookup back into the
  // Promise.all.
  void activeEscalation;

  // 3) Immutable drift = OPEN OperationalIncident with the
  //    `immutable-drift` runbookSlug pointing at this evidence.
  const driftIncident =
    openIncidents.find(
      (i) => i.runbookSlug === IMMUTABLE_DRIFT_RUNBOOK,
    ) ?? null;

  // 4) Run the canonical decision helpers with the gathered facts.
  const exportDecision = canonicalEvaluateExportEligibility({
    lifecycleState,
    hasActiveDirectHold: directHoldCount > 0,
    hasActiveCaseHold: caseHoldCount > 0,
    hasActiveDestructionReview: Boolean(activeDestructionReview),
    destructionReviewStatus:
      (activeDestructionReview?.status as never) ?? null,
  });
  const packageDecision = canonicalEvaluatePackageEligibility({
    lifecycleState,
    hasActiveDirectHold: directHoldCount > 0,
    hasActiveCaseHold: caseHoldCount > 0,
    hasActiveDestructionReview: Boolean(activeDestructionReview),
    destructionReviewStatus:
      (activeDestructionReview?.status as never) ?? null,
    hasOpenImmutableDriftIncident: Boolean(driftIncident),
  });
  const destructionDecision = canonicalCanEnterPendingDestruction({
    fromState: lifecycleState,
    hasActiveDirectHold: directHoldCount > 0,
    hasActiveCaseHold: caseHoldCount > 0,
    immutableRetention: retentionPolicyVersion?.immutable ?? false,
    hasActiveDestructionReview: Boolean(activeDestructionReview),
  });

  // 5) Retention expiration is purely a timestamp check.
  const retentionExpired =
    evidence.retentionUntilUtc != null &&
    evidence.retentionUntilUtc.getTime() < Date.now();

  // 6) Assemble (without warnings yet — they're derived in step 7).
  const partial: Omit<GovernanceSnapshot, "warnings"> = {
    evidenceId: evidence.id,
    teamId: evidence.teamId ?? input.teamId,
    generatedAtUtc: new Date().toISOString(),
    lifecycle: {
      state: lifecycleState,
      label: lifecycleLabel(lifecycleState),
      isTerminal: lifecycleIsTerminal(lifecycleState),
    },
    review: {
      workflowId: workflow?.id ?? null,
      status: workflow?.status ?? null,
      stage: workflow?.status ?? null,
      assignedReviewerUserId: workflow?.assignedToUserId ?? null,
      slaStatus: workflow?.slaStatus ?? null,
      activeEscalationId: workflow?.activeEscalationId ?? null,
      activeEscalationSeverity: escalation?.severity ?? null,
    },
    legalHold: {
      hasActiveDirectHold: directHoldCount > 0,
      hasActiveCaseHold: caseHoldCount > 0,
      directHoldCount,
      caseHoldCount,
      blocksDestruction: directHoldCount > 0 || caseHoldCount > 0,
      blocksExport: directHoldCount > 0 || caseHoldCount > 0,
    },
    retention: {
      bound: Boolean(retentionPolicyVersion),
      policyId: retentionPolicyVersion?.retentionPolicyId ?? null,
      policyVersion: retentionPolicyVersion?.version ?? null,
      retentionUntilUtc: evidence.retentionUntilUtc
        ? evidence.retentionUntilUtc.toISOString()
        : null,
      immutable: retentionPolicyVersion?.immutable ?? false,
      expired: retentionExpired,
    },
    destruction: {
      activeReviewId: activeDestructionReview?.id ?? null,
      activeReviewStatus: activeDestructionReview?.status ?? null,
      eligible: destructionDecision.allowed,
      blockedReason: destructionDecision.allowed
        ? null
        : destructionDecision.reason,
    },
    export: {
      eligible: exportDecision.outcome === "ALLOWED",
      outcome: exportDecision.outcome,
      reason: exportDecision.reason,
      label: exportEligibilityLabel(exportDecision.outcome),
    },
    package: {
      eligible: packageDecision.outcome === "ALLOWED",
      outcome: packageDecision.outcome,
      reason: packageDecision.reason,
      label: packageEligibilityLabel(packageDecision.outcome),
    },
    immutableStorage: {
      driftDetected: Boolean(driftIncident),
      driftIncidentId: driftIncident?.id ?? null,
      driftLabel: driftIncident
        ? "Storage governance drift — reconciliation required"
        : null,
    },
    incidents: openIncidents.map((i) => ({
      id: i.id,
      severity: i.severity,
      category: i.category,
      title: i.title,
      openedAtUtc: i.firstSeenAtUtc.toISOString(),
      runbookSlug: i.runbookSlug ?? null,
    })),
  };

  // 7) Derive UI-safe warnings from the assembled state.
  const warnings = deriveWarnings(partial);

  return { ...partial, warnings };
}
