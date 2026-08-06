/**
 * Worker-side fail-closed verification-package gate.
 *
 * Every invocation of `createVerificationPackage` MUST call this gate
 * first. The gate gathers facts from the same database the api reads
 * from, then runs the canonical decision helper
 * `canonicalEvaluatePackageEligibility` in `@proovra/shared`. The
 * canonical helper is the SINGLE source of truth — this module never
 * re-implements its rules.
 *
 * Fail-closed contract:
 *   - If governance state cannot be determined: DENY.
 *   - If any Prisma read throws: DENY.
 *   - If the canonical helper returns anything other than ALLOWED:
 *     DENY with the canonical outcome.
 *   - If immutable drift state is ambiguous (open incident found):
 *     DENY.
 *   - No silent fallback-to-allow path exists anywhere.
 *
 * On denial:
 *   - Logs an operational event (severity=warning).
 *   - Bumps `package_generation_blocked_total`.
 *   - Records a GOVERNANCE OperationalIncident with a stable
 *     fingerprint so repeated denials for the same record collapse.
 *   - Sentry-tagged via the worker's captureException.
 *
 * The caller (processor.ts → createVerificationPackage) must check
 * the returned `allowed` flag and refuse to build artifacts / emit
 * success metrics / write download-ready state when false.
 */

import * as prismaPkg from "@prisma/client";
import {
  canonicalEvaluatePackageEligibility,
  packageEligibilityLabel,
  type CanonicalPackageFacts,
  type EvidenceLifecycleState,
  type PackageEligibilityOutcome,
} from "@proovra/shared";

import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { captureException } from "../sentry.js";
import { recordWorkerIncident } from "./incident-emitter.js";

const IMMUTABLE_DRIFT_RUNBOOK = "immutable-drift";

/**
 * The explicit denial outcomes the brief requires the gate to
 * support. These are a strict superset of the canonical helper's
 * outcomes, plus two extra states ("BLOCKED_BY_GOVERNANCE",
 * "GOVERNANCE_STATE_UNAVAILABLE") that only exist at the worker
 * runtime layer (the canonical helper assumes its inputs are
 * trustworthy; the gate handles the case where they're not).
 */
export type WorkerPackageGateOutcome =
  | "ALLOWED"
  | PackageEligibilityOutcome
  // Outcomes ABOVE come from the canonical helper. Below are gate-
  // layer outcomes for failure modes the canonical helper does not
  // (and should not) model.
  | "BLOCKED_BY_REVIEW_POLICY"
  | "BLOCKED_BY_REVIEW_STATE"
  | "BLOCKED_BY_RETENTION"
  | "BLOCKED_BY_GOVERNANCE"
  | "BLOCKED_BY_EXTERNAL_ACCESS_POLICY"
  | "GOVERNANCE_STATE_UNAVAILABLE";

export type WorkerPackageGateDecision =
  | { allowed: true; outcome: "ALLOWED"; reason: "ok" }
  | {
      allowed: false;
      outcome: Exclude<WorkerPackageGateOutcome, "ALLOWED">;
      reason: string;
      label: string;
    };

export type AssertPackageEligibleInput = {
  teamId: string;
  evidenceId: string;
  /** Optional caller context for the audit + incident records. */
  triggeredByUserId?: string | null;
  triggerSource?: string;
};

/**
 * Gather the canonical facts for this evidence + run the canonical
 * helper. NEVER throws — every error path produces a denial decision
 * with `outcome: "GOVERNANCE_STATE_UNAVAILABLE"`.
 */
export async function assertPackageEligibleOrDeny(
  input: AssertPackageEligibleInput,
): Promise<WorkerPackageGateDecision> {
  let facts: CanonicalPackageFacts | null = null;
  try {
    facts = await gatherPackageFacts(input);
  } catch (err) {
    return await emitDenial(input, {
      outcome: "GOVERNANCE_STATE_UNAVAILABLE",
      reason: "governance_state_query_failed",
      err,
    });
  }

  if (!facts) {
    return await emitDenial(input, {
      outcome: "GOVERNANCE_STATE_UNAVAILABLE",
      reason: "evidence_not_found",
    });
  }

  const decision = canonicalEvaluatePackageEligibility(facts);
  if (decision.outcome === "ALLOWED") {
    return { allowed: true, outcome: "ALLOWED", reason: "ok" };
  }

  return await emitDenial(input, {
    outcome: decision.outcome,
    reason: decision.reason,
  });
}

// -----------------------------------------------------------------------------
// Facts gathering
// -----------------------------------------------------------------------------

async function gatherPackageFacts(
  input: AssertPackageEligibleInput,
): Promise<CanonicalPackageFacts | null> {
  // The brief mandates fail-closed: ambiguous drift = deny. We treat
  // any unhandled error here as "ambiguous", and the caller maps it
  // to GOVERNANCE_STATE_UNAVAILABLE.
  const evidence = await prisma.evidence.findFirst({
    where: { id: input.evidenceId, teamId: input.teamId },
    select: {
      id: true,
      teamId: true,
      // PHASE 12B — CaseEvidenceLink is the relationship authority; a hold on
      // ANY linked case blocks (fail closed).
      caseLinks: { select: { caseId: true } },
      lifecycleState: true,
      activeDestructionReviewId: true,
    },
  });
  if (!evidence) return null;
  const linkedCaseIds = evidence.caseLinks.map((l) => l.caseId);

  const [
    directHoldCount,
    caseHoldCount,
    activeDestructionReview,
    openImmutableDriftIncident,
  ] = await Promise.all([
    prisma.evidenceLegalHold.count({
      where: {
        evidenceId: input.evidenceId,
        status: prismaPkg.LegalHoldStatus.ACTIVE,
      },
    }),
    // PHASE 12 POINT 3 — canonical-only. Case-scoped holds live in
    // `evidence_legal_holds` with scope='CASE' after the backfill; the legacy
    // `case_legal_holds` table disappears at the contract migration. The
    // scope filter is what keeps this a CASE-hold count and stops it widening
    // into every hold in the workspace.
    linkedCaseIds.length > 0
      ? prisma.evidenceLegalHold.count({
          where: {
            scope: prismaPkg.LegalHoldScope.CASE,
            caseId: { in: linkedCaseIds },
            status: prismaPkg.LegalHoldStatus.ACTIVE,
          },
        })
      : Promise.resolve(0),
    evidence.activeDestructionReviewId
      ? prisma.destructionReview.findUnique({
          where: { id: evidence.activeDestructionReviewId },
          select: { id: true, status: true },
        })
      : Promise.resolve(null),
    prisma.operationalIncident.findFirst({
      where: {
        teamId: input.teamId,
        relatedEvidenceId: input.evidenceId,
        runbookSlug: IMMUTABLE_DRIFT_RUNBOOK,
        status: { in: ["OPEN", "ACKNOWLEDGED"] },
      },
      select: { id: true },
    }),
  ]);

  return {
    lifecycleState: (evidence.lifecycleState ?? "ACTIVE") as EvidenceLifecycleState,
    hasActiveDirectHold: directHoldCount > 0,
    hasActiveCaseHold: caseHoldCount > 0,
    hasActiveDestructionReview: Boolean(activeDestructionReview),
    destructionReviewStatus:
      (activeDestructionReview?.status as never) ?? null,
    hasOpenImmutableDriftIncident: Boolean(openImmutableDriftIncident),
  };
}

// -----------------------------------------------------------------------------
// Denial emission — operational log + metric + incident + Sentry tag.
// -----------------------------------------------------------------------------

async function emitDenial(
  input: AssertPackageEligibleInput,
  denial: {
    outcome: Exclude<WorkerPackageGateOutcome, "ALLOWED">;
    reason: string;
    err?: unknown;
  },
): Promise<WorkerPackageGateDecision> {
  const label = mapOutcomeToLabel(denial.outcome);

  // 1) Structured operational log.
  logger.warn(
    {
      teamId: input.teamId,
      evidenceId: input.evidenceId,
      triggeredByUserId: input.triggeredByUserId ?? null,
      triggerSource: input.triggerSource ?? null,
      packageGateOutcome: denial.outcome,
      packageGateReason: denial.reason,
    },
    "package_generation.denied",
  );

  // 2) Sentry context (only when an error caused the denial).
  if (denial.err) {
    captureException(denial.err, {
      packageGateOutcome: denial.outcome,
      teamId: input.teamId,
      evidenceId: input.evidenceId,
    });
  }

  // 3) Worker-side metric. We use a structured log line that the
  //    Phase Y exposer can scrape, mirroring how the worker emits
  //    other counters (the worker process doesn't have a Prometheus
  //    server of its own; it relies on the api scraper).
  logger.info(
    {
      metric: "package_generation_blocked_total",
      teamId: input.teamId,
      outcome: denial.outcome,
    },
    "metric.package_generation_blocked",
  );

  // 4) Incident — best-effort. NEVER fail the gate if incident
  //    recording errors; the deny outcome is what protects production.
  try {
    await recordWorkerIncident({
      teamId: input.teamId,
      category: "GOVERNANCE",
      severity: denial.outcome === "GOVERNANCE_STATE_UNAVAILABLE" ? "HIGH" : "WARNING",
      fingerprint: `worker_package_gate:${input.teamId}:${input.evidenceId}:${denial.outcome}`,
      title: `Package generation denied — ${denial.outcome}`,
      safeSummary: `Verification package denied for evidence record. ${label}`,
      relatedEvidenceId: input.evidenceId,
      metadata: {
        outcome: denial.outcome,
        reason: denial.reason,
        triggerSource: input.triggerSource ?? null,
        runbookSlug: "package-generation-denied",
      },
    });
  } catch {
    // Already deny. Incident recording is observability; never block
    // the protective denial.
  }

  return {
    allowed: false,
    outcome: denial.outcome,
    reason: denial.reason,
    label,
  };
}

function mapOutcomeToLabel(
  outcome: Exclude<WorkerPackageGateOutcome, "ALLOWED">,
): string {
  switch (outcome) {
    case "BLOCKED_BY_HOLD":
    case "BLOCKED_BY_LIFECYCLE":
    case "BLOCKED_BY_REVIEW_GATE":
    case "BLOCKED_BY_IMMUTABLE_DRIFT":
      return packageEligibilityLabel(outcome);
    case "BLOCKED_BY_REVIEW_POLICY":
      return "Workspace review policy requires review before package generation";
    case "BLOCKED_BY_REVIEW_STATE":
      return "Review state does not allow package generation";
    case "BLOCKED_BY_RETENTION":
      return "Retention policy blocks package generation";
    case "BLOCKED_BY_GOVERNANCE":
      return "Governance policy blocks package generation";
    case "BLOCKED_BY_EXTERNAL_ACCESS_POLICY":
      return "External access policy blocks package generation";
    case "GOVERNANCE_STATE_UNAVAILABLE":
      return "Governance state could not be determined — package generation denied";
  }
}
