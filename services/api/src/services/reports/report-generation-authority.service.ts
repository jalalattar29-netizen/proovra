/**
 * PHASE 12 — POINT 5: the api's report/package generation producer.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS REPLACES, AND WHY IT MATTERED
 * ---------------------------------------------------------------------------
 * Report generation used to be requested by putting
 *
 *     { evidenceId, forceRegenerate, regenerateReason }
 *
 * on a BullMQ payload. `forceRegenerate` is not a parameter — it is the
 * OUTCOME OF AN AUTHORIZATION DECISION. It is the flag that lets the worker
 * bypass the guard refusing to overwrite an already-REPORTED artifact, and it
 * was arriving as an unverified boolean on a queue message. Anything able to
 * write to Redis could set it, and the worker would replace a finalised
 * evidentiary artifact on its word.
 *
 * Now the authorized synchronous path persists its decision as a
 * `ReportGenerationRequest`, and the queue carries only that row's id. The
 * worker re-derives workspace, organization, policy, eligibility and lifecycle
 * state from persistence and compares them against what the request recorded.
 *
 * ---------------------------------------------------------------------------
 * ORDERING
 * ---------------------------------------------------------------------------
 * The row is COMMITTED before the enqueue is attempted, and that ordering is
 * the whole durability argument:
 *
 *   * DB commit then queue failure  → the row sits QUEUED and the reconciler
 *                                     re-enqueues it. Nothing is lost.
 *   * DB rollback                   → no row, so no id, so no enqueue can have
 *                                     happened. A rolled-back request cannot
 *                                     produce a runnable job.
 *   * queue success then DB failure → impossible; the DB wrote first.
 *
 * Callers must therefore NOT invoke this inside an open transaction.
 */

import {
  createReportGenerationRequest,
  type ReportArtifactType,
  type ReportGenerationPurpose,
} from "@proovra/shared-runtime/reports";
import { bump } from "@proovra/shared-runtime/ops";
import { JOB_NAMES, isTerminalJobExecutionState } from "@proovra/shared";
import { triggerEvidenceReported } from "../automation/automation-triggers.js";

import { prisma } from "../../db.js";
import { enqueueCanonicalWork } from "../../queue/canonical-queue-client.js";
// COMMERCIAL CLOSURE (2026-09-08) — the record-aware eligibility resolver, so a
// request that the worker would only refuse is never created at all.
import { resolveEvidenceOutputEligibility } from "../billing/evidence-output-eligibility.service.js";

export {
  REPORT_ARTIFACT_TYPES,
  REPORT_GENERATION_PURPOSES,
  buildReportGenerationIdempotencyKey,
} from "@proovra/shared-runtime/reports";
export type { ReportArtifactType, ReportGenerationPurpose };

export type RequestReportGenerationInput = {
  evidenceId: string;
  purpose: ReportGenerationPurpose;
  artifactType?: ReportArtifactType;
  forceRegenerate?: boolean;
  regenerateReason?: string | null;
  requestedByUserId?: string | null;
  requestedByMachineId?: string | null;
};

export type RequestReportGenerationResult =
  | {
      requested: true;
      requestId: string;
      /** False when the row is durable but Redis refused; the reconciler owns it. */
      enqueued: boolean;
      /** Bounded reason when not enqueued, or when a duplicate collapsed. */
      reason?: string;
      deduplicated: boolean;
      terminalState?: string;
    }
  | { requested: false; reason: string };

/**
 * Persist the intent, then enqueue its id.
 *
 * Never throws into a calling flow. Every failure mode is a bounded reason, so
 * an evidence-completion fan-out cannot be broken by a Redis outage or by a
 * duplicate-request race.
 */
export async function requestReportGeneration(
  input: RequestReportGenerationInput,
): Promise<RequestReportGenerationResult> {
  /**
   * THE COMMERCIAL PRECHECK.
   *
   * A request for an output the record is not entitled to used to be created,
   * enqueued, refused by the worker, moved to the DLQ and turned into a
   * CRITICAL operational incident — a full failure pipeline for a decision the
   * customer made deliberately when they chose their plan.
   *
   * It is refused HERE instead, before any row exists, with a bounded reason.
   * Nothing is enqueued, no incident opens, and the caller gets a commercial
   * answer to a commercial question.
   *
   * Eligibility is per RECORD (`resolveEvidenceOutputEligibility` asks the one
   * authority with the effective plan AND this record's funding), so a
   * credit-funded record on a FREE account passes.
   *
   * FAIL OPEN on a resolution error: the worker's own gate is still there and
   * is the enforcement point. This check exists to stop a POINTLESS job, not to
   * be the authority — making it fail closed would let a slow commercial lookup
   * refuse an entitled customer's report.
   */
  const evidenceSubject = await prisma.evidence
    .findUnique({
      where: { id: input.evidenceId },
      select: { ownerUserId: true, teamId: true },
    })
    .catch(() => null);
  if (evidenceSubject?.ownerUserId) {
    const eligibility = await resolveEvidenceOutputEligibility({
      evidenceId: input.evidenceId,
      ownerUserId: evidenceSubject.ownerUserId,
      teamId: evidenceSubject.teamId ?? null,
    }).catch(() => null);
    if (eligibility && !eligibility.reportsIncluded) {
      bump("report_generation_not_included_total");
      return { requested: false, reason: "not_included_in_plan" };
    }
  }

  const persisted = await createReportGenerationRequest(prisma, input);
  if (!persisted.created) {
    return { requested: false, reason: persisted.reason };
  }
  bump("report_generation_request_created_total");

  /**
   * ARCH-005 (2026-08-07) — EVIDENCE_REPORTED.
   *
   * Fired on the CREATION of the durable request, not on the report's
   * completion: "reported" is what the operator asked for, and the request row
   * is the durable fact. The tenant is read from the evidence row rather than
   * taken from the input — `RequestReportGenerationInput` carries no teamId,
   * and inventing a parameter for one would be a caller-supplied tenant claim.
   *
   * `persisted.created` is already false for a duplicate, so this is reached
   * once per genuine request; the source identity collapses anything the
   * guard above lets through twice.
   */
  try {
    const ev = await prisma.evidence.findUnique({
      where: { id: input.evidenceId },
      select: { teamId: true },
    });
    if (ev?.teamId) {
      await triggerEvidenceReported(prisma, {
        teamId: ev.teamId,
        evidenceId: input.evidenceId,
        reportId: persisted.requestId,
        context: { purpose: String(input.purpose) },
      });
    }
  } catch {
    /* a report request is never broken by an automation lookup */
  }

  // A request that already reached a terminal state is REPORTED, not re-run.
  // Re-enqueuing it would make the worker's replay path do the work of
  // deciding not to act, on every duplicate click.
  if (isTerminalJobExecutionState(persisted.state)) {
    return {
      requested: true,
      requestId: persisted.requestId,
      enqueued: false,
      reason: "already_terminal",
      deduplicated: persisted.deduplicated,
      terminalState: persisted.state,
    };
  }

  const outcome = await enqueueCanonicalWork({
    workName: JOB_NAMES.GENERATE_REPORT,
    commandId: persisted.requestId,
    traceId: input.purpose,
  });

  if (outcome.enqueued) {
    bump("report_generation_enqueue_total");
    return {
      requested: true,
      requestId: persisted.requestId,
      enqueued: true,
      reason: outcome.collapsed ? "collapsed_onto_live_job" : undefined,
      deduplicated: persisted.deduplicated,
    };
  }

  // Durable, unscheduled, recoverable — and reported as exactly that. The row
  // stays QUEUED; the worker's stranded-request reconciler re-enqueues it.
  bump("report_generation_enqueue_failed_total");
  return {
    requested: true,
    requestId: persisted.requestId,
    enqueued: false,
    reason: outcome.reason,
    deduplicated: persisted.deduplicated,
  };
}
