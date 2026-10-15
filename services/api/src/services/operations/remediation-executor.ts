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

import {
  OTS_ANCHORING_RECORD_SELECT,
  otsBlocksPublication,
  resolveRecordOtsAnchoring,
  type OtsAnchoringRecord,
} from "@proovra/shared";
import type { PrismaClient } from "@prisma/client";
import { resolveEvidenceWorkspaceId } from "@proovra/shared-runtime";

import { prisma as defaultPrisma } from "../../db.js";
import { requestEvidenceOtsAnchoring } from "../integrity/ots-anchoring-authority.service.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
import { workspaceIncidentWhere } from "../observability/incident-scope.js";
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
  remediationAuditOutcome,
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
    where: { id: input.incidentId, ...workspaceIncidentWhere(input.teamId) },
  });
  if (!incident) return outcome("REFUSED");

  // ---- 2. The registry must actually offer this action here --------------
  const entry = entryForIncident({
    sourceId: incident.sourceId,
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

  // The record's workspace is decided by the canonical resolver, never by
  // `team_id` alone: a Personal record is stored with team_id NULL and lives
  // in its owner's Personal workspace, which is where its condition is.
  const evidence = await client.evidence.findUnique({
    where: { id: evidenceId },
    select: {
      id: true,
      teamId: true,
      ownerUserId: true,
      status: true,
      ...OTS_ANCHORING_RECORD_SELECT,
      deletedAt: true,
    },
  });
  // Cross-tenant evidence, or evidence deleted since the incident opened.
  if (!evidence || evidence.deletedAt) return outcome("NOT_ELIGIBLE");
  if ((await resolveEvidenceWorkspaceId(evidence, client as never)) !== input.teamId) {
    return outcome("NOT_ELIGIBLE");
  }

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
          reason: input.reason ?? null,
          requestKey: `incident:${incident.id}`,
        });

  // ---- 5. Audit, exactly once, on the canonical tenant authority ---------
  //
  // Appended for every terminal answer including refusals: "an operator tried
  // to act and was told no" is a fact worth keeping, and it is the one an
  // access review asks for.
  await emitTenantAudit(
    {
      action: `operations.remediation.${action.actionId}`,
      // THE one mapping (ET-REC-07), shared with the platform path: an intent
      // already met is not an error, and "we said no" is not "it broke".
      outcome: remediationAuditOutcome(dispatched.result),
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
      },
      // ET-CUS-14: masked columns, not hashed metadata.
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
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
async function resumeOtsAnchoring(evidence: OtsAnchoringRecord & { id: string }): Promise<ExecuteRemediationOutcome> {
  // (2026-10-13) The ONE state authority decides: the stored proof executed
  // against the record's digest.
  const anchoring = resolveRecordOtsAnchoring(evidence);
  // An anchored proof is immutable and needs nothing. Re-running would spend
  // work to reach the state it is already in.
  if (anchoring.state === "ANCHORED") return outcome("ALREADY_SATISFIED");
  // ET-REC-06 — a proof that does not commit to this record, cannot be parsed
  // or attests nothing valid is terminal: the worker ends the job without a
  // change. Queueing it answered QUEUED and recorded "remediation_queued" for
  // nothing.
  if (otsBlocksPublication(anchoring)) return outcome("NOT_ELIGIBLE");

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
  opts: {
    supersede: boolean;
    platformOperator?: boolean;
    packageForReportVersion?: number | null;
    /** AUD-027 — the operator's recorded reason and the request's idempotency key. */
    reason?: string | null;
    requestKey?: string | null;
  },
): Promise<ExecuteRemediationOutcome> {
  const reason = opts.reason?.trim() ?? "";
  const result: OutputRecoveryResult = await requestOutputRecovery({
    evidenceId,
    actorUserId,
    purpose: "operator_regenerate",
    regenerateReason: opts.supersede ? "operations_supersede" : "operations_remediation",
    operatorSupersede: opts.supersede,
    // An operator supersession is recorded (actor, reason, key) and drawn on
    // the operator budget; without a reason it is not one.
    operatorRecovery:
      opts.supersede && reason.length >= 3 && opts.requestKey
        ? { reason, requestKey: opts.requestKey }
        : null,
    platformOperator: opts.platformOperator === true,
    packageForReportVersion: opts.packageForReportVersion ?? null,
  });

  if (result.kind === "not_found") return outcome("NOT_ELIGIBLE");
  if (result.kind === "idempotency_key_required") return outcome("REFUSED");
  // The operator path carries no customer offer revision, so this is unreachable
  // here; refused rather than guessed if it ever is.
  if (result.kind === "stale_offer") return outcome("REFUSED");
  if (result.kind === "declined") {
    if (result.outcome === "NOTHING_TO_RECOVER") return outcome("ALREADY_SATISFIED");
    // A live request already exists for this output (QUEUED / PROCESSING) —
    // most often the first of two clicks. The intent is being met: collapse
    // onto it rather than telling the operator the record is ineligible.
    if (result.reason === "IN_PROGRESS") return outcome("ALREADY_IN_PROGRESS");
    if (result.requiresExplicitNewVersion) {
      return {
        result: "NOT_ELIGIBLE",
        message:
          "This record already has an issued report, and the failed request was an attempt to issue a newer one. Recovery never issues a new report version; an updated report is requested with “Issue updated report” on the record, with a stated reason.",
      };
    }
    if (result.reason === "ESCALATED_TO_OPERATOR" && !opts.supersede) {
      return {
        result: "NOT_ELIGIBLE",
        message:
          "Automatic retries for this record were exhausted. Use “Retry after exhausted failure” and state a reason.",
      };
    }
    return outcome("NOT_ELIGIBLE");
  }
  if (result.outcome === "TERMINAL" && result.authorityReason === "operator_supersession_budget_exhausted") {
    return {
      result: "NOT_ELIGIBLE",
      message:
        "The operator recovery budget for this record is spent for now (a small number of operator retries per day). Investigate the failure before retrying again.",
      ...(result.requestId ? { reference: result.requestId } : {}),
    };
  }
  switch (result.outcome) {
    case "ENQUEUED":
    case "SUPERSEDED":
      return outcome("QUEUED", result.requestId ?? undefined);
    // REPLAYED: the same operator request (its idempotency key) again — the
    // first answer stands.
    case "ALREADY_ACTIVE":
    case "REPLAYED":
      return outcome("ALREADY_IN_PROGRESS", result.requestId ?? undefined);
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

/**
 * PLATFORM-OPERATOR RECOVERY OF ONE RECORD CONDITION (2026-09-29).
 *
 * The same canonical component recovery the workspace remediation runs
 * (`recoverArtifacts` → `requestOutputRecovery`), for a report/package
 * condition a platform operator acts on — including one with no workspace row
 * (a Personal record stored with team_id NULL). The caller's route has
 * already proven platform authority and recorded a reason. The recovery is
 * scoped to the RECORD's workspace by the durable writer, and targets the
 * EXACT component the condition names: package vN for PACKAGE:<id>:v<N>:*.
 * A deterministic (terminal) failure is never retried here without
 * `supersede`.
 */
export async function executePlatformRecordRecovery(input: {
  target: { component: "REPORT" | "VERIFICATION_PACKAGE"; evidenceId: string; reportVersion: number | null };
  actorUserId: string;
  supersede: boolean;
  /** AUD-027 — the recorded reason and the incident the request is keyed on. */
  reason?: string | null;
  incidentId?: string | null;
}): Promise<ExecuteRemediationOutcome> {
  return recoverArtifacts(input.target.evidenceId, input.actorUserId, {
    supersede: input.supersede,
    reason: input.reason ?? null,
    requestKey: input.incidentId ? `platform-incident:${input.incidentId}` : null,
    platformOperator: true,
    packageForReportVersion:
      input.target.component === "VERIFICATION_PACKAGE" ? input.target.reportVersion : null,
  });
}
