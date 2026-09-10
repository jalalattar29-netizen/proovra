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
import {
  JOB_NAMES,
  isTerminalJobExecutionState,
  // RELIABILITY CLOSURE (2026-09-09) — the intent vocabulary, the one rule that
  // derives forceRegenerate from artifact availability, and the classifier that
  // tells a still-standing blocker apart from a dead terminal.
  isRecoverableBlockedTerminalReason,
  resolveForceRegenerate,
  type GenerationIntent,
  type GenerationRequestOutcome,
} from "@proovra/shared";
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
  /**
   * RELIABILITY CLOSURE (2026-09-09) — DELIBERATELY NO LONGER A CALLER'S
   * BOOLEAN FOR THE SYNCHRONOUS PATH.
   *
   * `forceRegenerate` authorizes REPLACING a finalised artifact. Every caller
   * that took it from a request body hard-coded `true`, because one endpoint
   * serves all three verbs — so a FIRST generation entered the
   * regeneration-only legal-hold branch and burned its own idempotency key on a
   * record that had nothing to preserve.
   *
   * Callers that hold the fact themselves (the worker's OTS-anchored
   * regeneration, which knows an artifact exists because it just anchored the
   * timestamp inside it) may still state it. Callers acting on behalf of a
   * person must NOT: they pass an INTENT instead, and this module derives the
   * flag from persistence.
   */
  forceRegenerate?: boolean;
  /**
   * What the actor asked for. When present, `forceRegenerate` is DERIVED from
   * the record's own artifact availability and this value is used only to
   * detect that the browser was looking at a different state than the one that
   * is true now.
   */
  intent?: GenerationIntent;
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
      /**
       * THE ANSWER EVERY SURFACE WAS GETTING WRONG.
       *
       * Callers rendered `enqueued: false` as "generation is already under way"
       * — true for one of the six reasons it was shown for. A customer whose
       * request was lost to a Redis outage, and one whose record was
       * permanently blocked, were both told the work was in progress.
       */
      outcome: GenerationRequestOutcome;
      /** The flag this module DERIVED, for the caller's audit row. */
      forceRegenerate: boolean;
    }
  | {
      requested: false;
      reason: string;
      outcome: GenerationRequestOutcome;
    };

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
    /*
     * P3-7 CLOSURE (2026-09-10) — THE PAIR, NOT JUST THE REPORT.
     *
     * This asked `!eligibility.reportsIncluded` and nothing else, whatever the
     * request's `artifactType` was. Today the two flags are equal on every
     * catalog row and for a credit-funded record, so the check happened to be
     * right — which is the whole problem with it: it was right by coincidence,
     * and the coincidence is a commercial decision somebody could change in
     * `PLAN_CAPABILITIES` without ever looking at this file.
     *
     * ONE REQUEST STILL PRODUCES ONE PAIR. This does not split the action into
     * two — the worker builds the package inside the report job precisely so
     * the customer has one control for one pipeline, and that stays. What
     * changes is that the precheck asks about EVERY artifact the request will
     * produce, so a plan that included one and not the other could not slip a
     * half-producible request past this gate.
     */
    const requiredEntitlements: Array<{ label: string; included: boolean }> =
      eligibility
        ? input.artifactType === "VERIFICATION_PACKAGE"
          ? [
              {
                label: "verification_package",
                included: eligibility.verificationPackageIncluded,
              },
            ]
          : // A REPORT request produces the pair, so BOTH must be entitled.
            [
              { label: "report", included: eligibility.reportsIncluded },
              {
                label: "verification_package",
                included: eligibility.verificationPackageIncluded,
              },
            ]
        : [];
    if (requiredEntitlements.some((entitlement) => !entitlement.included)) {
      bump("report_generation_not_included_total");
      return {
        requested: false,
        reason: "not_included_in_plan",
        outcome: "NOT_INCLUDED",
      };
    }
  }

  /*
   * ---------------------------------------------------------------------------
   * FORCE-REGENERATE IS DERIVED, NOT DECLARED.
   * ---------------------------------------------------------------------------
   * `POST /v1/evidence/:id/reports/regenerate` is one endpoint for three verbs,
   * and it hard-coded `forceRegenerate: true` for all of them. For a FIRST
   * generation that had two consequences, both bad:
   *
   *   1. the worker's claim path runs its legal-hold branch under
   *      `if (request.forceRegenerate)` and refused with `legal_hold_active` —
   *      even though the branch's own comment says a first generation is not
   *      refused "because there is nothing yet to preserve". The code had no
   *      artifact-existence test, so the comment described an intent the
   *      implementation did not hold.
   *   2. the refusal wrote a terminal row at the exact key every future Generate
   *      click would compute.
   *
   * The fact that decides it is whether an artifact EXISTS, and that fact lives
   * in the database. A caller that supplies an explicit `forceRegenerate` (the
   * worker's OTS-anchored regeneration, which just anchored the timestamp inside
   * an existing report) is trusted; a caller acting for a person supplies an
   * INTENT and gets the truth instead of their own belief.
   */
  let forceRegenerate = input.forceRegenerate === true;
  if (input.forceRegenerate === undefined) {
    const latestReport = await prisma.report
      .findFirst({
        where: { evidenceId: input.evidenceId },
        select: { id: true },
      })
      .catch(() => null);
    forceRegenerate = resolveForceRegenerate({
      availability: latestReport ? "READY" : "NO_ARTIFACT",
    });
  }

  const persisted = await createReportGenerationRequest(prisma, {
    ...input,
    forceRegenerate,
  });
  if (!persisted.created) {
    return {
      requested: false,
      reason: persisted.reason,
      /*
       * P2-1 CLOSURE (2026-09-10) — a record with no workspace is not a record
       * that does not exist.
       *
       * `evidence_workspace_unresolved` was folded into EVIDENCE_NOT_FOUND,
       * whose message is "This evidence record is not available." Legacy
       * personal rows written before the workspace backfill carry a null
       * `teamId`, they are listed by the canonical scope predicate's
       * owner-scoped arm, and their Generate button therefore posted and came
       * back denying the record existed. The two reasons now answer
       * separately.
       */
      outcome:
        persisted.reason === "evidence_workspace_unresolved"
          ? "WORKSPACE_UNRESOLVED"
          : persisted.reason === "evidence_not_found"
            ? "EVIDENCE_NOT_FOUND"
            : persisted.reason === "requester_required"
              ? "REQUESTER_REQUIRED"
              : "REQUEST_PERSIST_FAILED",
    };
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
    /*
     * A BLOCKED TERMINAL AND A DEAD ONE ARE DIFFERENT ANSWERS.
     *
     * The writer supersedes a recoverable blocked terminal whose blocker has
     * actually ended, so reaching this branch with one means the blocker is
     * STILL standing — which is a state the customer can do something about
     * (release the hold, wait for the suspension to lift) and must not be told
     * is "already under way".
     */
    const blockedButRecoverable =
      (persisted.state === "BLOCKED_STALE" ||
        persisted.state === "BLOCKED_POLICY") &&
      isRecoverableBlockedTerminalReason(persisted.terminalReasonCode ?? null);
    return {
      requested: true,
      requestId: persisted.requestId,
      enqueued: false,
      reason: "already_terminal",
      deduplicated: persisted.deduplicated,
      terminalState: persisted.state,
      outcome: blockedButRecoverable ? "RECOVERABLE_BLOCKED" : "TERMINAL",
      forceRegenerate,
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
      /*
       * SUPERSEDED counts as accepted work and is reported separately, because
       * it is the click that finally worked for a customer whose record had
       * been locked out. `collapsed` is the one case that genuinely IS "already
       * under way", and it is now the only one that says so.
       */
      outcome: persisted.superseded
        ? "SUPERSEDED"
        : outcome.collapsed
          ? "ALREADY_ACTIVE"
          : "ENQUEUED",
      forceRegenerate,
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
    outcome: "QUEUE_UNAVAILABLE",
    forceRegenerate,
  };
}
