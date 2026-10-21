/**
 * PHASE 12 — POINT 5: the worker side of the report/package generation
 * authority.
 *
 * The queue tells this module ONE thing: a `ReportGenerationRequest` id.
 * Everything the generation actually depends on — which workspace, which
 * organization, whether that organization is still active, which governance
 * policy applies, whether the evidence still exists, whether it is under legal
 * hold, whether an artifact newer than the one this request was created against
 * has appeared, and whether an authorized actor really did approve a
 * regeneration — is loaded HERE, from persistence, at run time.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR REFUSALS
 * ---------------------------------------------------------------------------
 * Most of this file is about not acting:
 *
 *   * REPLAY. A request already in a terminal state returns its STORED result.
 *     It does not regenerate, does not overwrite a newer artifact and does not
 *     emit a second completion event.
 *
 *   * STALE. A request whose recorded policy version no longer matches the
 *     workspace's current one, or whose baseline artifact version has been
 *     overtaken, is blocked BEFORE any storage write. An artifact generated
 *     under a policy nobody approved is worse than no artifact.
 *
 *   * SCOPE. A request whose workspace disagrees with the evidence row's
 *     workspace is denied. Both sides are loaded from the database; neither
 *     comes off the wire. This catches an evidence record moved or rebound
 *     between enqueue and execution.
 *
 *   * LOST CLAIM. The claim is a conditional UPDATE, so two workers racing the
 *     same request produce exactly one winner and one bounded no-op. The loser
 *     mutates nothing.
 */

import { bump } from "@proovra/shared-runtime/ops";
import { workerOutputEntitlement } from "./output-issuance.js";
import { decideOutputProduction } from "@proovra/shared";
import {
  createReportGenerationRequest,
  type ReportGenerationPurpose,
} from "@proovra/shared-runtime/reports";
import {
  isTerminalJobExecutionState,
  type OutputProductionRefusal,
  type OutputProgressStage,
} from "@proovra/shared";

import { resolveEvidenceWorkspaceId } from "@proovra/shared-runtime";
import { lifecycleRefusalForRequest, settleReportRequestNotApplicable } from "@proovra/shared-runtime/reports";
import { versionPackagesComplete } from "@proovra/shared-runtime/reports";
import {
  REPORT_CLAIM_HEARTBEAT_MS,
  REPORT_CLAIM_LEASE_MS as SHARED_REPORT_CLAIM_LEASE_MS,
  isReportClaimLive,
  reportClaimExpiredWhere,
} from "@proovra/shared-runtime/reports";

import { prisma } from "./db.js";
import { OutputPolicyBlockedError, OutputProductionRefusedError } from "./output-production-refusal.js";
import { evaluateEffectiveLegalHold } from "@proovra/shared-runtime";
import { recordWorkerIncident } from "./governance/incident-emitter.js";
import { logger } from "./logger.js";
import { resolveEvidenceOutputIssuance } from "./output-issuance.js";


/**
 * How long a PROCESSING claim is believed before a competing worker may take
 * it. Sourced from the registry so the lease, the retry policy and the
 * reconciler's recovery window cannot drift apart.
 */
// F-06 — renewed by the run that holds it; THE live / expired definition is
// shared with the destruction executor (shared-runtime/reports/report-claim-lease).
export const REPORT_CLAIM_LEASE_MS = SHARED_REPORT_CLAIM_LEASE_MS;

/** States from which a request may be claimed for execution. */
const CLAIMABLE_STATES = ["QUEUED", "FAILED_RETRYABLE"] as const;

/**
 * THE RECONCILER'S ATTEMPT CEILING.
 *
 * The stranded sweep re-enqueued every `QUEUED`/`FAILED_RETRYABLE` row on every
 * tick, with no bound. That is correct for the case it was written for — a
 * committed request whose enqueue did not land — and wrong for a request that
 * genuinely cannot succeed: it re-ran forever, burned worker capacity on every
 * sweep, and never produced the one thing an operator needs, which is a
 * terminal state saying "this is not going to work".
 *
 * Deliberately generous, and deliberately not the queue's own attempt budget:
 * BullMQ's retries cover a single scheduled run, while this counts how many
 * times the request was CLAIMED at all — across worker restarts, redeploys and
 * lease expiries. A transient outage that spans several sweeps must not be
 * mistaken for a broken record, which is why this is not 3.
 */
export const REPORT_RECONCILE_MAX_ATTEMPTS = 12;

export type ResolvedReportCommand = {
  requestId: string;
  /**
   * ET-SEC-30 — THE FENCING TOKEN: the claimedAtUtc this worker's claim wrote.
   * A second claim is only possible after this lease expired, so the value
   * identifies exactly one claim; every later write by this run is conditional
   * on it and a late worker's write matches nothing.
   */
  claimedAtUtc: Date;
  evidenceId: string;
  /** Loaded from the request row and cross-checked against the evidence row. */
  teamId: string;
  artifactType: string;
  forceRegenerate: boolean;
  regenerateReason: string | null;
  attemptCount: number;
  /**
   * Durable progress. `reportVersion` is the report this request committed
   * (full generation) or targets (package-only recovery); `stage` is the last
   * boundary it reached. A retry resumes from them.
   */
  reportVersion: number | null;
  stage: string | null;
};

export type ReportCommandResolution =
  | { outcome: "run"; command: ResolvedReportCommand }
  /** Already finished. The stored result is returned; nothing is re-run. */
  | { outcome: "replay"; state: string; resultReportId: string | null }
  /** Bounded refusal. The row is terminal or was left for another worker. */
  | { outcome: "noop"; reason: string };

/**
 * F-07 (independent forward audit) — the run admission asked inside a commit
 * transaction (the caller holds the record's advisory lock). A refusal throws
 * the business refusal (NOT_APPLICABLE), a block the policy block
 * (BLOCKED_POLICY); an entitlement that cannot be read now is a retryable
 * failure — never assumed entitled.
 */
export async function assertRunAdmittedAtCommit(
  command: Pick<ResolvedReportCommand, "teamId" | "artifactType" | "forceRegenerate">,
  live: { id: string; teamId: string | null; ownerUserId: string; status: unknown; lifecycleState: unknown; deletedAt: Date | null },
): Promise<void> {
  const admission = await decideRunAdmission({
    evidence: live,
    requestTeamId: command.teamId,
    artifactType: command.artifactType,
    forceRegenerate: command.forceRegenerate,
  });
  if (admission.kind === "REFUSED") throw new OutputProductionRefusedError(admission.refusal);
  if (admission.kind === "BLOCKED") throw new OutputPolicyBlockedError(admission.reasonCode);
  if (!admission.entitlementResolved) {
    throw Object.assign(new Error("OUTPUT_ENTITLEMENT_UNRESOLVED_AT_COMMIT"), {
      code: "OUTPUT_ENTITLEMENT_UNRESOLVED_AT_COMMIT",
      retriable: true,
    });
  }
}


// ===========================================================================
// Resolve + claim
// ===========================================================================

export type RunAdmission =
  | { kind: "ADMITTED"; workspaceId: string; entitlementResolved: boolean }
  /** An expected business outcome: settle NOT_APPLICABLE, publish nothing. */
  | { kind: "REFUSED"; refusal: OutputProductionRefusal }
  /** A policy block: BLOCKED_POLICY with this bounded reason, publish nothing. */
  | { kind: "BLOCKED"; reasonCode: "workspace_mismatch" | "workspace_not_found" | "organization_not_active" | "legal_hold_active" };

/**
 * F-07 (independent forward audit) — THE RUN ADMISSION: may this request's run
 * produce its output for this record NOW? One decision, asked at claim AND
 * inside the report and package commit transactions (under the record's
 * advisory lock — the lock legal-hold placement and trash also take), so a
 * hold, a plan lapse, a suspension or a workspace move that lands while the
 * report renders or the package builds refuses the commit instead of being
 * noticed only by the next request.
 *
 *   1. the output-producer decision (lifecycle + entitlement) — a refusal;
 *   2. the record's workspace must still be the request's;
 *   3. its organization must be ACTIVE;
 *   4. a REGENERATION is refused under any effective legal hold (an
 *      unreadable hold is a hold).
 */
export async function decideRunAdmission(input: {
  evidence: { id: string; teamId: string | null; ownerUserId: string; status: unknown; lifecycleState: unknown; deletedAt: Date | null };
  requestTeamId: string;
  artifactType: string;
  forceRegenerate: boolean;
}): Promise<RunAdmission> {
  const { evidence } = input;
  const decision = decideOutputProduction({
    subject: evidence as never,
    artifactType: input.artifactType === "VERIFICATION_PACKAGE" ? "VERIFICATION_PACKAGE" : "REPORT",
    entitlement: await workerOutputEntitlement({
      id: evidence.id,
      ownerUserId: evidence.ownerUserId,
      teamId: evidence.teamId ?? null,
    }),
  });
  if (!decision.produce && decision.refusal) return { kind: "REFUSED", refusal: decision.refusal };
  // The record's workspace — its team, or its owner's personal workspace for
  // a Personal record stored with team_id NULL (2026-09-29): the same
  // resolution the writer used, re-derived here at run time.
  const workspaceId = await resolveEvidenceWorkspaceId(evidence as never, prisma);
  if (!workspaceId || workspaceId !== input.requestTeamId) return { kind: "BLOCKED", reasonCode: "workspace_mismatch" };
  // Lifecycle lives on the Organization (a Team has no status of its own), so
  // "is this workspace still allowed to do work" resolves through the org,
  // which is also where suspension is applied.
  const workspace = await prisma.team.findUnique({ where: { id: workspaceId }, select: { organizationId: true } });
  if (!workspace) return { kind: "BLOCKED", reasonCode: "workspace_not_found" };
  const organization = await prisma.organization.findUnique({
    where: { id: workspace.organizationId },
    select: { status: true },
  });
  if (!organization || organization.status !== "ACTIVE") return { kind: "BLOCKED", reasonCode: "organization_not_active" };
  // Regeneration REPLACES a finalised artifact: under an effective hold
  // (record, linked case or workspace) it is refused; a first generation is
  // not, because there is nothing yet to preserve.
  if (input.forceRegenerate) {
    const held = (
      await evaluateEffectiveLegalHold(prisma, { teamId: workspaceId, evidenceId: evidence.id }).catch(() => ({ held: true }))
    ).held;
    if (held) return { kind: "BLOCKED", reasonCode: "legal_hold_active" };
  }
  return { kind: "ADMITTED", workspaceId, entitlementResolved: decision.produce };
}

/**
 * Turn a request id into a runnable command, or into a reason not to run.
 *
 * Every branch that declines leaves the database exactly as it found it,
 * except the two that write a TERMINAL blocked state — and those write it
 * before any external effect, which is the property that makes "no partial
 * mutation" true rather than hoped for.
 */
export async function resolveAndClaimReportRequest(input: {
  requestId: string;
  requestIdForLog: string;
}): Promise<ReportCommandResolution> {
  const { requestId } = input;

  const request = await prisma.reportGenerationRequest.findUnique({
    where: { id: requestId },
    select: {
      id: true,
      teamId: true,
      evidenceId: true,
      artifactType: true,
      forceRegenerate: true,
      regenerateReason: true,
      expectedPolicyVersion: true,
      state: true,
      attemptCount: true,
      resultReportId: true,
      requestedByUserId: true,
      requestedByMachineId: true,
      idempotencyKey: true,
      reportVersion: true,
      stage: true,
    },
  });

  if (!request) {
    // A job naming a row that does not exist is not retryable — the row is not
    // going to appear. Bounded no-op rather than a burned retry budget.
    return { outcome: "noop", reason: "request_not_found" };
  }

  if (isTerminalJobExecutionState(request.state)) {
    bump("queue_replay_noop_total");
    return {
      outcome: "replay",
      state: request.state,
      resultReportId: request.resultReportId,
    };
  }

  if (!request.requestedByUserId && !request.requestedByMachineId) {
    await markRequestTerminal({
      requestId,
      state: "BLOCKED_POLICY",
      terminalReasonCode: "no_principal",
    });
    return { outcome: "noop", reason: "no_principal" };
  }

  // ---- Tenancy: derived from the evidence row, not from the request --------
  const evidence = await prisma.evidence.findFirst({
    where: { id: request.evidenceId },
    select: { id: true, teamId: true, ownerUserId: true, status: true, lifecycleState: true, deletedAt: true },
  });
  if (!evidence) {
    await markRequestTerminal({
      requestId,
      state: "FAILED_TERMINAL",
      terminalReasonCode: "evidence_not_found",
    });
    return { outcome: "noop", reason: "evidence_not_found" };
  }

  // ---- THE RUN ADMISSION, AT CLAIM (AUD-01/02, F-07) ------------------------
  // The record may have been archived, trashed, destroyed or deleted — or its
  // plan may have stopped including the output, its workspace moved, its
  // organization been suspended, or (for a regeneration) a legal hold been
  // placed — after the request was written. THE one admission decision
  // (decideRunAdmission) decides here, and again inside the commit
  // transactions (F-07). An unreadable entitlement is not a refusal at claim:
  // the run's own gate retries it.
  const admission = await decideRunAdmission({
    evidence,
    requestTeamId: request.teamId,
    artifactType: request.artifactType,
    forceRegenerate: request.forceRegenerate,
  });
  if (admission.kind === "REFUSED") {
    const { settleRequestAsNotApplicable } = await import("./output-production-refusal.js");
    await settleRequestAsNotApplicable({ requestId, refusal: admission.refusal });
    return { outcome: "noop", reason: admission.refusal };
  }
  if (admission.kind === "BLOCKED") {
    if (admission.reasonCode === "workspace_mismatch") bump("queue_workspace_mismatch_total");
    await markRequestTerminal({
      requestId,
      state: "BLOCKED_POLICY",
      terminalReasonCode: admission.reasonCode,
    });
    return { outcome: "noop", reason: admission.reasonCode };
  }
  const workspaceId = admission.workspaceId;

  // ---- Policy version, reloaded and compared -------------------------------
  const policy = await prisma.workspaceGovernancePolicy.findFirst({
    where: { teamId: workspaceId },
    select: { version: true },
  });
  const currentPolicyVersion = policy?.version ?? 0;
  if (
    request.expectedPolicyVersion !== null &&
    request.expectedPolicyVersion !== currentPolicyVersion
  ) {
    bump("queue_stale_request_blocked_total");
    await markRequestTerminal({
      requestId,
      state: "BLOCKED_STALE",
      terminalReasonCode: "policy_version_changed",
    });
    return { outcome: "noop", reason: "policy_version_changed" };
  }

  // ---- Atomic claim --------------------------------------------------------
  // The predicate accepts a claimable state OR an expired lease. Expressing
  // recovery IN the claim rather than in a separate sweep means a worker that
  // died mid-run cannot hold a request forever, and it costs one statement.
  const claimedAtUtc = new Date();
  const claimed = await prisma.reportGenerationRequest.updateMany({
    where: {
      id: requestId,
      OR: [
        { state: { in: [...CLAIMABLE_STATES] } },
        // F-06 — only an EXPIRED claim is taken over: neither its claim nor
        // its last renewal within the lease.
        reportClaimExpiredWhere(claimedAtUtc),
      ],
    },
    data: {
      state: "PROCESSING",
      claimedAtUtc,
      leaseRenewedAtUtc: null,
      attemptCount: { increment: 1 },
    },
  });

  if (claimed.count === 0) {
    // Another worker holds a live claim. Losing the race is a normal outcome,
    // not a failure: the winner will write the terminal state.
    bump("queue_claim_lost_total");
    return { outcome: "noop", reason: "claim_held_by_another_worker" };
  }

  return {
    outcome: "run",
    command: {
      requestId: request.id,
      claimedAtUtc,
      evidenceId: evidence.id,
      teamId: workspaceId,
      artifactType: request.artifactType,
      forceRegenerate: request.forceRegenerate,
      regenerateReason: request.regenerateReason,
      attemptCount: request.attemptCount + 1,
      reportVersion: request.reportVersion,
      stage: request.stage,
    },
  };
}

// ===========================================================================
// Terminal writes
// ===========================================================================

/**
 * Write a terminal state, but only over a NON-terminal one.
 *
 * The `state: { notIn: TERMINAL }` predicate is what stops a stale worker —
 * one whose lease expired and whose replacement already finished — from
 * overwriting a SUCCEEDED row with its own late failure.
 */
export async function markRequestTerminal(input: {
  requestId: string;
  state: "SUCCEEDED" | "FAILED_TERMINAL" | "BLOCKED_STALE" | "BLOCKED_POLICY" | "NOT_APPLICABLE";
  terminalReasonCode: string;
  resultReportId?: string | null;
  resultChecksum?: string | null;
  /**
   * ET-SEC-30 — a worker that RAN the request passes its claim; the write then
   * lands only on that live claim. Without it (pre-claim refusals, operator
   * repair) the non-terminal predicate alone applies.
   */
  fence?: { claimedAtUtc: Date };
  /**
   * F-38 (independent forward audit) — a SWEEP that decided from a row it read
   * passes what it read: the write lands only if the row is still exactly
   * that (no claim taken, no state moved, between its read and its write).
   */
  observed?: { state: string; claimedAtUtc: Date | null };
}): Promise<boolean> {
  const updated = await prisma.reportGenerationRequest.updateMany({
    where: input.fence
      ? { id: input.requestId, state: "PROCESSING", claimedAtUtc: input.fence.claimedAtUtc }
      : input.observed
        ? { id: input.requestId, state: input.observed.state as never, claimedAtUtc: input.observed.claimedAtUtc }
        : {
          id: input.requestId,
          state: {
            notIn: ["SUCCEEDED", "FAILED_TERMINAL", "BLOCKED_STALE", "BLOCKED_POLICY", "NOT_APPLICABLE"],
          },
        },
    data: {
      state: input.state,
      terminalReasonCode: input.terminalReasonCode.slice(0, 64),
      resultReportId: input.resultReportId ?? undefined,
      resultChecksum: input.resultChecksum?.slice(0, 128) ?? undefined,
      completedAtUtc: new Date(),
    },
  });
  return updated.count > 0;
}

/**
 * AN EXHAUSTED REQUEST IS AN OPERATOR MATTER, and the customer is told so.
 *
 * It opens (or re-counts) the SAME incident the pipeline's own DLQ path uses
 * for this record — deduplicated on (workspace, fingerprint) — so Operations
 * shows one actionable condition, never a second system. Called when the
 * request went FAILED_TERMINAL because its retries were spent: by the worker
 * on BullMQ's last attempt, and by the reconciler at the durable claim ceiling.
 *
 * NAME THE COMPONENT THAT IS ACTUALLY MISSING. A request that committed its
 * report (`stage = REPORT_COMMITTED`) or that only ever targeted a package is
 * missing a PACKAGE at a known version. Filing it under the REPORT source let
 * a probe that asks "does a report exist?" declare it recovered while the
 * package was absent.
 */
export async function recordRequestExhaustedIncident(requestId: string): Promise<void> {
  const row = await prisma.reportGenerationRequest.findUnique({
    where: { id: requestId },
    select: {
      id: true,
      attemptCount: true,
      evidenceId: true,
      teamId: true,
      artifactType: true,
      stage: true,
      reportVersion: true,
      terminalReasonCode: true,
    },
  });
  if (!row) return;
  const packageOnly =
    row.reportVersion != null &&
    (row.artifactType === "VERIFICATION_PACKAGE" || row.stage === "REPORT_COMMITTED");
  // OPS-004 — a REPORT condition names the version the request was for:
  // the one after the latest committed report.
  const targetReportVersion = packageOnly
    ? null
    : ((
        await prisma.evidence
          .findUnique({ where: { id: row.evidenceId }, select: { latestReportVersion: true } })
          .catch(() => null)
      )?.latestReportVersion ?? 0) + 1;
  const rootCause = row.terminalReasonCode ?? null;
  await recordWorkerIncident(
    packageOnly
      ? {
          sourceId: "pipeline.package_generation_failed",
          teamId: row.teamId,
          category: "PACKAGE",
          severity: "HIGH",
          fingerprint: `PACKAGE:${row.evidenceId}:v${row.reportVersion}:RETRY_BUDGET_EXHAUSTED`,
          message: {
            code: "ops.pipeline.package_generation_failed.retry_budget_exhausted",
            params: { version: row.reportVersion!, recordRef: row.evidenceId.slice(0, 8) },
          },
          relatedEvidenceId: row.evidenceId,
          metadata: {
            queueName: "report",
            retriable: false,
            errorClass: "RETRY_BUDGET_EXHAUSTED",
            rootCause,
            requestId: row.id,
            attemptCount: row.attemptCount,
            reportVersion: row.reportVersion,
          },
        }
      : {
          sourceId: "pipeline.report_generation_failed",
          teamId: row.teamId,
          category: "REPORT",
          severity: "HIGH",
          fingerprint: `REPORT:${row.evidenceId}:v${targetReportVersion}:RETRY_BUDGET_EXHAUSTED`,
          message: {
            code: "ops.pipeline.report_generation_failed.retry_budget_exhausted",
            params: { version: targetReportVersion!, recordRef: row.evidenceId.slice(0, 8) },
          },
          relatedEvidenceId: row.evidenceId,
          metadata: {
            queueName: "report",
            retriable: false,
            errorClass: "RETRY_BUDGET_EXHAUSTED",
            rootCause,
            requestId: row.id,
            attemptCount: row.attemptCount,
            reportVersion: targetReportVersion,
          },
        },
  );
}

/**
 * Release a claim so the queue's own retry can pick the request up again.
 *
 * Distinct from a terminal write: this is the "the attempt failed but the
 * intent is still valid" path, and it deliberately leaves no completion
 * timestamp behind.
 */
export async function markRequestRetryable(input: {
  requestId: string;
  terminalReasonCode: string;
  /** ET-SEC-30 — only this worker's own live claim is released. */
  fence: { claimedAtUtc: Date };
}): Promise<boolean> {
  const released = await prisma.reportGenerationRequest.updateMany({
    where: { id: input.requestId, state: "PROCESSING", claimedAtUtc: input.fence.claimedAtUtc },
    data: {
      state: "FAILED_RETRYABLE",
      terminalReasonCode: input.terminalReasonCode.slice(0, 64),
      claimedAtUtc: null,
    },
  });
  return released.count > 0;
}

/**
 * ET-SEC-30 — a run whose claim was taken over (its lease expired and another
 * worker re-claimed) must not commit anything. Thrown from a fenced in-run
 * write so the surrounding transaction rolls back.
 */
export class ReportClaimLost extends Error {
  readonly code = "REPORT_CLAIM_LOST";
  constructor(requestId: string) {
    super(`REPORT_CLAIM_LOST:${requestId}`);
    this.name = "ReportClaimLost";
  }
}

/**
 * F-06 — RENEW this run's claim lease (fenced: a run whose claim was taken over
 * renews nothing). Returns whether the claim is still this run's.
 */
export async function renewReportClaimLease(
  command: Pick<ResolvedReportCommand, "requestId" | "claimedAtUtc">,
): Promise<boolean> {
  if (!command.requestId) return false;
  const renewed = await prisma.reportGenerationRequest.updateMany({
    where: claimFenceWhere(command),
    data: { leaseRenewedAtUtc: new Date() },
  });
  return renewed.count === 1;
}

let heartbeatIntervalOverrideMs: number | null = null;
/** Test seam: a short heartbeat cadence (null restores the production one). */
export function setReportClaimHeartbeatIntervalForTests(ms: number | null): void {
  heartbeatIntervalOverrideMs = ms;
}

/**
 * F-06 — the heartbeat a claimed run keeps while it works. Best-effort: a
 * failed beat is retried on the next tick; the lease allows several to be
 * missed. Returns the stop function the run calls when it finishes.
 */
export function startReportClaimHeartbeat(
  command: Pick<ResolvedReportCommand, "requestId" | "claimedAtUtc">,
): () => void {
  const timer = setInterval(() => {
    renewReportClaimLease(command).catch((err: unknown) =>
      logger.warn(
        { requestId: command.requestId, err: err instanceof Error ? err.message : String(err) },
        "report_request.lease_renewal_failed",
      ),
    );
  }, heartbeatIntervalOverrideMs ?? REPORT_CLAIM_HEARTBEAT_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** The WHERE of every write made by a claimed run. */
export function claimFenceWhere(command: Pick<ResolvedReportCommand, "requestId" | "claimedAtUtc">) {
  return { id: command.requestId, state: "PROCESSING" as const, claimedAtUtc: command.claimedAtUtc };
}

/**
 * DURABLE PROGRESS — record the display step a claimed run has reached
 * (`progress_stage`, see migration 20281004000000). Fenced by the claim, so a
 * run that lost its lease cannot move a request another worker now owns.
 *
 * Display-only and best-effort: the step is what the Artifacts & Versions tab
 * shows after a reload, never an input to any decision, so a failed write is
 * logged and the artifact work continues. It is written BEFORE the work of the
 * step begins, so a failure is reported against the step it happened in.
 */
export async function recordRequestProgress(
  command: Pick<ResolvedReportCommand, "requestId" | "claimedAtUtc">,
  progressStage: OutputProgressStage,
): Promise<void> {
  if (!command.requestId) return;
  try {
    await prisma.reportGenerationRequest.updateMany({
      where: claimFenceWhere(command),
      data: { progressStage, progressAtUtc: new Date() },
    });
  } catch (err) {
    logger.warn(
      { requestId: command.requestId, progressStage, err: err instanceof Error ? err.message : String(err) },
      "report_request.progress_write_failed",
    );
  }
}

// ===========================================================================
// Legacy drain
// ===========================================================================

/**
 * Mint a durable request for a pre-Point-5 job still draining out of Redis.
 *
 * The old payload carried `{ evidenceId, forceRegenerate, regenerateReason }`.
 * Exactly one of those is used: the evidence id. `forceRegenerate` is the
 * authority this whole change exists to remove from the wire, so a draining
 * legacy job is minted as a NON-force request — it may generate a first
 * artifact, and it may not overwrite a finalised one. A legacy payload cannot
 * escalate its own privileges by surviving in a queue.
 */
export async function mintRequestForLegacyJob(input: {
  evidenceId: string;
  jobId: string | number | null | undefined;
}): Promise<{ requestId: string } | { requestId: null; reason: string }> {
  const persisted = await createReportGenerationRequest(prisma, {
    evidenceId: input.evidenceId,
    purpose: "queue_legacy_drain",
    artifactType: "REPORT",
    // NOT the legacy payload's flag. This is the authority the whole change
    // exists to remove from the wire.
    forceRegenerate: false,
    requestedByMachineId: "queue-legacy-drain",
    entitlement: workerOutputEntitlement,
  });
  return persisted.created
    ? { requestId: persisted.requestId }
    : { requestId: null, reason: persisted.reason };
}

/**
 * The worker's own output producer (2026-09-29).
 *
 * The worker originates exactly two kinds of work, both from the first-issuance
 * reconciliation (lifecycle-recovery.ts): the FIRST report (with its package)
 * for a finalized record that is owed one, and the MISSING PACKAGE for a report
 * version that exists without one. It never forces a new report version: an
 * updated report is an explicit, authorized user action, and the OTS path that
 * used to force one no longer does. Both go through the SAME durable-row-then-
 * enqueue path the api uses, so there is one request model rather than two.
 */
export async function requestReportGenerationFromWorker(input: {
  evidenceId: string;
  purpose: ReportGenerationPurpose;
  machineId: string;
  /** Package-only recovery for exactly this report version. */
  packageForReportVersion?: number | null;
  enqueue: (requestId: string) => Promise<{ enqueued: boolean; reason?: string }>;
}): Promise<{ enqueued: boolean; requestId?: string; reason?: string }> {
  const packageOnly = input.packageForReportVersion != null;
  const persisted = await createReportGenerationRequest(prisma, {
    evidenceId: input.evidenceId,
    purpose: input.purpose,
    artifactType: packageOnly ? "VERIFICATION_PACKAGE" : "REPORT",
    reportVersion: packageOnly ? input.packageForReportVersion : null,
    intent: packageOnly ? "RECOVER" : "GENERATE",
    forceRegenerate: false,
    requestedByMachineId: input.machineId,
    entitlement: workerOutputEntitlement,
  });
  if (!persisted.created) {
    return { enqueued: false, reason: persisted.reason };
  }
  if (isTerminalJobExecutionState(persisted.state)) {
    return {
      enqueued: false,
      requestId: persisted.requestId,
      reason: "already_terminal",
    };
  }
  const outcome = await input.enqueue(persisted.requestId);
  return {
    enqueued: outcome.enqueued,
    requestId: persisted.requestId,
    reason: outcome.reason,
  };
}

// ===========================================================================
// Reconciliation
// ===========================================================================

export type ReportReconcileSummary = {
  scanned: number;
  reenqueued: number;
  leasesReleased: number;
  terminalRepaired: number;
  failures: number;
};

/**
 * Recover report requests that fell into one of the four stranded shapes.
 *
 * This exists because the durable-row-then-enqueue ordering deliberately
 * accepts one failure window: a committed request whose enqueue did not land.
 * Without this sweep, that request would sit QUEUED forever and the evidence
 * would never get its report — silently, with the API having reported success.
 *
 * Concurrency safety comes from the enqueue path, not from a lock: the job id
 * is deterministic in the request id, so two reconcilers running at once
 * collapse onto one queued job rather than scheduling two.
 */
export async function reconcileStrandedReportRequests(input: {
  enqueue: (
    requestId: string,
  ) => Promise<{ enqueued: boolean; reason?: string }>;
  batchSize?: number;
  now?: Date;
}): Promise<ReportReconcileSummary> {
  const batchSize = Math.max(1, Math.min(input.batchSize ?? 100, 500));
  const now = input.now ?? new Date();
  const summary: ReportReconcileSummary = {
    scanned: 0,
    reenqueued: 0,
    leasesReleased: 0,
    terminalRepaired: 0,
    failures: 0,
  };

  // ---- 1. Expired PROCESSING leases → back to FAILED_RETRYABLE ------------
  // Done first so a request whose worker died becomes eligible for the
  // re-enqueue pass in the SAME tick rather than the next one.
  // F-06 — an EXPIRED claim only: a run that renewed its lease is working.
  const released = await prisma.reportGenerationRequest.updateMany({
    where: reportClaimExpiredWhere(now),
    data: { state: "FAILED_RETRYABLE", claimedAtUtc: null, leaseRenewedAtUtc: null },
  });
  summary.leasesReleased = released.count;

  // ---- 2. Completed artifact with no terminal request state ---------------
  // The generation succeeded and the process died before the terminal write.
  // The artifact exists, so re-running would DUPLICATE it; the honest repair
  // is to record the success that already happened.
  /*
   * SUCCESS IS THE OUTPUTS THE REQUEST OWNS, AS A PAIR AT ONE VERSION.
   *
   * This used to close any in-flight request as SUCCEEDED the moment a report
   * newer than the request existed — without asking about the package. A
   * request whose report committed and whose package failed was therefore
   * closed within one tick, the package was never retried, and the retry
   * budget could never be reached. A request is complete only when:
   *
   *   * the report it committed or targets (`report_version`, or for rows
   *     written before that column, the newest report generated after the
   *     request) exists, AND
   *   * the package AT THAT SAME VERSION exists — or the record is not
   *     entitled to one.
   */
  const possiblyDone = await prisma.reportGenerationRequest.findMany({
    where: { state: { in: ["PROCESSING", "FAILED_RETRYABLE"] } },
    select: {
      id: true,
      evidenceId: true,
      createdAtUtc: true,
      artifactType: true,
      reportVersion: true,
      claimedAtUtc: true,
      leaseRenewedAtUtc: true,
      forceRegenerate: true,
      intent: true,
      state: true,
    },
    orderBy: { createdAtUtc: "asc" },
    take: batchSize,
  });
  for (const candidate of possiblyDone) {
    // A live claim is a worker mid-run; its own terminal write decides.
    if (isReportClaimLive(candidate, now)) continue;
    let targetVersion = candidate.reportVersion;
    if (targetVersion == null) {
      if (candidate.artifactType === "VERIFICATION_PACKAGE") continue;
      // F-38 — an explicit NEW version that has not reserved one yet owns no
      // report: another request's newer report is not its output.
      if (candidate.forceRegenerate || candidate.intent === "NEW_VERSION" || candidate.intent === "OPERATOR_SUPERSEDE") continue;
      const newerReport = await prisma.report.findFirst({
        where: {
          evidenceId: candidate.evidenceId,
          generatedAtUtc: { gte: candidate.createdAtUtc },
        },
        orderBy: { version: "desc" },
        select: { version: true },
      });
      if (!newerReport) continue;
      targetVersion = newerReport.version;
    }
    const report = await prisma.report.findUnique({
      where: {
        evidenceId_version: { evidenceId: candidate.evidenceId, version: targetVersion },
      },
      select: { id: true },
    });
    if (!report) continue;
    // Complete = every profile the version owes is PUBLISHED (a reserved or
    // failed package row is not a package).
    const packagesComplete = await versionPackagesComplete(prisma, {
      evidenceId: candidate.evidenceId,
      version: targetVersion,
    });
    if (!packagesComplete && (await verificationPackageOwed(candidate.evidenceId))) continue;
    const repaired = await markRequestTerminal({
      requestId: candidate.id,
      state: "SUCCEEDED",
      terminalReasonCode: "reconciled_artifact_present",
      resultReportId: report.id,
      observed: { state: candidate.state, claimedAtUtc: candidate.claimedAtUtc },
    });
    if (repaired) summary.terminalRepaired += 1;
  }

  /*
   * ---- 3. Retry budget exhausted → TERMINAL --------------------------------
   *
   * A retryable failure that has been claimed `REPORT_RECONCILE_MAX_ATTEMPTS`
   * times is not transient any more, and re-enqueueing it forever is the
   * opposite of reliability: it hides a broken record inside a healthy-looking
   * sweep. Writing the terminal state is what lets the customer projection say
   * "generation stopped" and the operator surface open a real, actionable
   * condition instead of a permanent re-queue.
   *
   * Ordered BEFORE the re-enqueue pass so an exhausted row is retired in the
   * same tick rather than scheduled once more and retired on the next.
   */
  const exhausted = await prisma.reportGenerationRequest.findMany({
    where: {
      state: "FAILED_RETRYABLE",
      attemptCount: { gte: REPORT_RECONCILE_MAX_ATTEMPTS },
    },
    select: { id: true, attemptCount: true, terminalReasonCode: true, claimedAtUtc: true },
    orderBy: { createdAtUtc: "asc" },
    take: batchSize,
  });
  for (const row of exhausted) {
    // The cause the last attempt recorded survives (2026-10-13); only a row
    // that never recorded one (an expired lease) reads retry_budget_exhausted.
    const retired = await markRequestTerminal({
      requestId: row.id,
      state: "FAILED_TERMINAL",
      terminalReasonCode: row.terminalReasonCode?.trim() || "retry_budget_exhausted",
      observed: { state: "FAILED_RETRYABLE", claimedAtUtc: row.claimedAtUtc },
    });
    if (retired) {
      summary.terminalRepaired += 1;
      await recordRequestExhaustedIncident(row.id).catch(() => null);
      logger.warn(
        {
          event: "report_generation.retry_budget_exhausted",
          requestId: row.id,
          attemptCount: row.attemptCount,
          maxAttempts: REPORT_RECONCILE_MAX_ATTEMPTS,
          reasonCode: row.terminalReasonCode ?? null,
        },
        "report_generation.retry_budget_exhausted",
      );
    }
  }

  // ---- 4. Durable but never scheduled → re-enqueue -------------------------
  const stranded = await prisma.reportGenerationRequest.findMany({
    where: {
      state: { in: ["QUEUED", "FAILED_RETRYABLE"] },
      // The ceiling is applied to the SELECTION too, so a row retired above (or
      // by a concurrent reconciler) is never re-enqueued in the same pass.
      attemptCount: { lt: REPORT_RECONCILE_MAX_ATTEMPTS },
    },
    select: { id: true },
    orderBy: { createdAtUtc: "asc" },
    take: batchSize,
  });
  summary.scanned = stranded.length;

  for (const row of stranded) {
    try {
      // THE OUTPUT-PRODUCER GUARD (AUD-01/02): a record that left the
      // producible states while its request waited is settled, never re-enqueued.
      const refusal = await lifecycleRefusalForRequest(prisma as never, row.id);
      if (refusal) {
        await settleReportRequestNotApplicable(prisma as never, { requestId: row.id, refusal });
        continue;
      }
      const outcome = await input.enqueue(row.id);
      if (outcome.enqueued) {
        summary.reenqueued += 1;
        bump("report_generation_reconciled_total");
      } else {
        summary.failures += 1;
      }
    } catch {
      // A reconciler that throws stops reconciling. Count and continue.
      summary.failures += 1;
    }
  }

  if (summary.reenqueued > 0 || summary.leasesReleased > 0 || summary.terminalRepaired > 0) {
    logger.info(
      { event: "report_generation.reconciled", ...summary },
      "report_generation.reconciled",
    );
  }
  return summary;
}

/**
 * Is a verification package still owed for this record? Fails TRUE on a
 * resolution error: closing a request whose package is owed is the silent
 * state this reconciler must never produce, while leaving one open only costs
 * a re-run that decides the same question with full context.
 */
async function verificationPackageOwed(evidenceId: string): Promise<boolean> {
  try {
    const ev = await prisma.evidence.findUnique({
      where: { id: evidenceId },
      select: { ownerUserId: true, teamId: true },
    });
    if (!ev) return true;
    // ET-SEC-20 — THE issuance decision (plan, funding AND the subscription
    // lifecycle) that issuance itself honours. Plan and funding alone said a
    // lapsed paid workspace was still owed a package the worker then refused.
    const issuance = await resolveEvidenceOutputIssuance({
      id: evidenceId,
      ownerUserId: ev.ownerUserId,
      teamId: ev.teamId ?? null,
    });
    if (issuance.decision === "UNRESOLVED") return true;
    return issuance.decision === "ENTITLED" && issuance.verificationPackageIncluded;
  } catch {
    return true;
  }
}
