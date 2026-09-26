/**
 * THE OPERATIONS REMEDIATION EXECUTOR.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES AND WHAT IT REFUSES TO DO
 * ---------------------------------------------------------------------------
 * Turns an authorized operator's request into a call on the DOMAIN authority
 * that owns the work. It owns no queue, no job id, no retry policy and no
 * artifact lifecycle — it dispatches:
 *
 *   OTS anchoring      -> `requestEvidenceOtsAnchoring`, the API's one
 *                         transport, whose deterministic job id IS the dedupe.
 *   Report + package   -> `requestReportGeneration(...)`, which persists the
 *                         authorization OUTCOME as a `ReportGenerationRequest`
 *                         and enqueues that row's id.
 *
 * There is no third branch, and specifically no TSA branch. See
 * `remediation-registry.ts` for why that absence is a decision.
 *
 * ---------------------------------------------------------------------------
 * ACCEPTED IS NOT COMPLETED
 * ---------------------------------------------------------------------------
 * Both authorities are asynchronous, and both already distinguish "the work is
 * durable and queued" from "the work is done". This module preserves that
 * distinction all the way to the wire: its success value is `QUEUED`, never
 * `SUCCEEDED`, because nothing here can know whether the job will succeed.
 *
 * The incident is NOT resolved by enqueuing. It resolves when the source
 * domain's own truth converges — the evidence-integrity resolver re-reads each
 * condition's record and closes it when the record recovers. Marking an
 * incident resolved because a job was accepted would be the exact false-clear
 * this program exists to remove.
 *
 * ---------------------------------------------------------------------------
 * NOTHING RAW REACHES THE BROWSER
 * ---------------------------------------------------------------------------
 * Every failure is mapped to a bounded `RemediationResult`. Provider strings,
 * Redis errors, Prisma errors and queue names stay in the logs.
 */

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { requestEvidenceOtsAnchoring } from "../integrity/ots-anchoring-authority.service.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
import { bump } from "../ops/metrics.service.js";
import {
  requestOutputRecovery,
  type OutputRecoveryResult,
} from "../reports/output-recovery.service.js";
import {
  actionById,
  entryForIncident,
  type RemediationActionId,
  type RemediationResult,
} from "./remediation-registry.js";

export type ExecuteRemediationInput = {
  incidentId: string;
  teamId: string;
  actionId: string;
  actorUserId: string;
  /** Required by actions that override a pipeline decision; audited. */
  reason?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
};

export type ExecuteRemediationOutcome = {
  result: RemediationResult;
  /** Operator-facing, bounded. Never a provider or database string. */
  message: string;
  /** Present when the request produced durable work. */
  reference?: string;
};

/** Bounded copy per outcome. The operator reads these, so they say what happened. */
const MESSAGES: Record<RemediationResult, string> = {
  QUEUED: "Accepted and queued.",
  ALREADY_IN_PROGRESS: "This work is already in progress.",
  ALREADY_SATISFIED: "Nothing to do — this has already completed.",
  REFUSED: "This action is not permitted for this record.",
  NOT_ELIGIBLE: "This record is no longer eligible for this action.",
  QUEUE_UNAVAILABLE:
    "The work was recorded but could not be scheduled yet. It will be picked up automatically.",
  FAILED: "The action could not be completed.",
};

function outcome(
  result: RemediationResult,
  reference?: string,
): ExecuteRemediationOutcome {
  return { result, message: MESSAGES[result], ...(reference ? { reference } : {}) };
}

export async function executeRemediation(
  input: ExecuteRemediationInput,
  client: PrismaClient = defaultPrisma,
): Promise<ExecuteRemediationOutcome> {
  const action = actionById(input.actionId);
  if (!action) return outcome("REFUSED");

  // ---- 1. The incident, scoped by the WHERE clause ------------------------
  //
  // A condition belonging to another workspace is not found here at all, so
  // there is no branch that could be reordered into leaking its existence.
  const incident = await client.operationalIncident.findFirst({
    where: { id: input.incidentId, teamId: input.teamId },
  });
  if (!incident) return outcome("REFUSED");

  // ---- 2. The registry must actually offer this action here --------------
  const entry = entryForIncident({
    category: incident.category,
    fingerprint: incident.fingerprint,
  });
  if (
    entry?.action?.actionId !== action.actionId &&
    entry?.secondaryAction?.actionId !== action.actionId
  ) {
    // The caller posted an action id that this incident type does not govern.
    // A projection is a convenience, not a permission.
    return outcome("REFUSED");
  }

  // ---- 3. Lifecycle -------------------------------------------------------
  if (incident.status !== "OPEN" && incident.status !== "ACKNOWLEDGED") {
    return outcome("NOT_ELIGIBLE");
  }

  // ---- 4. The affected record --------------------------------------------
  //
  // Both actions operate on Evidence. An incident with no related record
  // cannot be remediated by either — there is nothing to name.
  const evidenceId = incident.relatedEvidenceId;
  if (!evidenceId) return outcome("NOT_ELIGIBLE");

  const evidence = await client.evidence.findFirst({
    where: { id: evidenceId, teamId: input.teamId },
    select: {
      id: true,
      teamId: true,
      status: true,
      otsStatus: true,
      deletedAt: true,
    },
  });
  // Cross-tenant evidence, or evidence deleted since the incident opened.
  if (!evidence || evidence.deletedAt) return outcome("NOT_ELIGIBLE");

  if (action.requiresReason && !(input.reason ?? "").trim()) {
    return outcome("REFUSED");
  }

  const dispatched =
    action.actionId === ("ots.resume_anchoring" satisfies RemediationActionId)
      ? await resumeOtsAnchoring(evidence)
      : await recoverArtifacts(evidence.id, input.actorUserId, {
          supersede:
            action.actionId ===
            ("report.supersede_failed_generation" satisfies RemediationActionId),
        });

  // ---- 5. Audit, exactly once, on the canonical tenant authority ---------
  //
  // Appended for every terminal answer including refusals: "an operator tried
  // to act and was told no" is a fact worth keeping, and it is the one an
  // access review asks for.
  await emitTenantAudit(
    {
      action: `operations.remediation.${action.actionId}`,
      // The canonical vocabulary is success | denied | error. A refusal is
      // DENIED (an authorization answer); everything else that is not queued
      // is an ERROR (the work could not be accepted). Collapsing the two would
      // make an access review unable to tell "we said no" from "it broke".
      outcome:
        dispatched.result === "QUEUED"
          ? "success"
          : dispatched.result === "REFUSED" || dispatched.result === "NOT_ELIGIBLE"
            ? "denied"
            : "error",
      sourceApp: "API",
      actorUserId: input.actorUserId,
      workspaceId: input.teamId,
      resourceType: "operational_incident",
      resourceId: incident.id,
      metadata: {
        actionId: action.actionId,
        result: dispatched.result,
        evidenceId: evidence.id,
        fingerprint: incident.fingerprint,
        category: incident.category,
        severity: incident.severity,
        reference: dispatched.reference ?? null,
        reason: input.reason?.trim().slice(0, 500) || null,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      },
    },
    client,
  ).catch(() => {
    /* an audit sink outage must not undo authorized, already-queued work */
  });

  // ---- 6. The incident's own history -------------------------------------
  //
  // Written only when work was actually accepted. A refusal is in the audit
  // log; putting it in the operator-facing timeline would make every declined
  // click look like something happened to the condition.
  if (dispatched.result === "QUEUED") {
    await client.operationalIncidentEvent
      .create({
        data: {
          incidentId: incident.id,
          eventType: "remediation_queued",
          safeMessage: input.reason?.trim()
            ? `${action.label} was requested by an operator and accepted. Reason: ${input.reason.trim().slice(0, 300)}`
            : `${action.label} was requested by an operator and accepted.`,
        },
      })
      .catch(() => null);
    bump("operations_remediation_queued_total");
  }

  return dispatched;
}

// ===========================================================================
// DISPATCH — one function per domain authority
// ===========================================================================

/**
 * OTS anchoring.
 *
 * The Evidence row is the durable authority (see the canonical work registry),
 * so the command id is the evidence id and the deterministic job id
 * `ots-upgrade-<evidenceId>` is itself the dedupe: a second request while one
 * is live collapses onto it rather than creating a second unit of work.
 */
async function resumeOtsAnchoring(evidence: {
  id: string;
  otsStatus: string | null;
}): Promise<ExecuteRemediationOutcome> {
  // An already-anchored proof is immutable and needs nothing. Re-running would
  // spend work to reach the state it is already in.
  if (evidence.otsStatus === "ANCHORED" || evidence.otsStatus === "UPGRADED") {
    return outcome("ALREADY_SATISFIED");
  }

  /*
   * OTS INTEGRITY DECOUPLING (2026-09-09) — through the request authority.
   *
   * This enqueued the canonical work directly. So did evidence finalization,
   * once every finalized record began entering the OTS lifecycle, and the
   * audit engine reported the pair as `parallelAuthorities = 1` — correctly:
   * the registry's central claim is ONE producer module per work name, and two
   * producers are two places for the semantics to drift.
   *
   * The enqueue now lives in `ots-anchoring-authority.service.ts`. What is
   * kept here is the part that is genuinely this caller's: translating the
   * outcome into what an OPERATOR needs to read. "Collapsed onto live work"
   * and "the transport is down" look the same to a completion path and must
   * never look the same on an Operations console.
   */
  const requested = await requestEvidenceOtsAnchoring({
    evidenceId: evidence.id,
    trigger: "operations.remediation",
  });

  if (requested.requested) return outcome("QUEUED", requested.jobId);
  if (requested.reason === "collapsed") return outcome("ALREADY_IN_PROGRESS");
  if (requested.reason === "queue_unavailable") return outcome("QUEUE_UNAVAILABLE");
  return outcome("FAILED");
}

/**
 * Report + verification package, through the SAME recovery authority as the
 * customer route (`requestOutputRecovery`): the server decides what the
 * record needs — only the package beside an existing report, the pair when
 * there is no report — and never mints a report to obtain a package.
 *
 * `supersede` is the D3 override. The route has already required the
 * operator capability and the stated reason; the writer supersedes a
 * TECHNICAL terminal only.
 */
async function recoverArtifacts(
  evidenceId: string,
  actorUserId: string,
  opts: { supersede: boolean },
): Promise<ExecuteRemediationOutcome> {
  const result: OutputRecoveryResult = await requestOutputRecovery({
    evidenceId,
    actorUserId,
    purpose: "operator_regenerate",
    regenerateReason: opts.supersede ? "operations_supersede" : "operations_remediation",
    operatorSupersede: opts.supersede,
  });

  if (result.kind === "not_found") return outcome("NOT_ELIGIBLE");
  if (result.kind === "idempotency_key_required") return outcome("REFUSED");
  if (result.kind === "declined") {
    if (result.outcome === "NOTHING_TO_RECOVER") return outcome("ALREADY_SATISFIED");
    if (result.reason === "ESCALATED_TO_OPERATOR" && !opts.supersede) {
      return {
        result: "NOT_ELIGIBLE",
        message:
          "Automatic retries for this record were exhausted. Use “Retry after exhausted failure” and state a reason.",
      };
    }
    return outcome("NOT_ELIGIBLE");
  }
  switch (result.outcome) {
    case "ENQUEUED":
    case "SUPERSEDED":
      return outcome("QUEUED", result.requestId ?? undefined);
    case "ALREADY_ACTIVE":
      return outcome("ALREADY_IN_PROGRESS");
    case "QUEUE_UNAVAILABLE":
      return outcome("QUEUE_UNAVAILABLE", result.requestId ?? undefined);
    case "TERMINAL":
    case "RECOVERABLE_BLOCKED":
    case "NOT_INCLUDED":
      return outcome("NOT_ELIGIBLE", result.requestId ?? undefined);
    default:
      return outcome("FAILED");
  }
}
