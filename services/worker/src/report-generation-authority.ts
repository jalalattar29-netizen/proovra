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
import {
  createReportGenerationRequest,
  type ReportGenerationPurpose,
} from "@proovra/shared-runtime/reports";
import {
  JOB_NAMES,
  isTerminalJobExecutionState,
  getWorkEntryOrThrow,
} from "@proovra/shared";

import { prisma } from "./db.js";
import { logger } from "./logger.js";

const ENTRY = getWorkEntryOrThrow(JOB_NAMES.GENERATE_REPORT);

/**
 * How long a PROCESSING claim is believed before a competing worker may take
 * it. Sourced from the registry so the lease, the retry policy and the
 * reconciler's recovery window cannot drift apart.
 */
export const REPORT_CLAIM_LEASE_MS = ENTRY.claim?.leaseMs ?? 15 * 60 * 1000;

/** States from which a request may be claimed for execution. */
const CLAIMABLE_STATES = ["QUEUED", "FAILED_RETRYABLE"] as const;

export type ResolvedReportCommand = {
  requestId: string;
  evidenceId: string;
  /** Loaded from the request row and cross-checked against the evidence row. */
  teamId: string;
  artifactType: string;
  forceRegenerate: boolean;
  regenerateReason: string | null;
  attemptCount: number;
};

export type ReportCommandResolution =
  | { outcome: "run"; command: ResolvedReportCommand }
  /** Already finished. The stored result is returned; nothing is re-run. */
  | { outcome: "replay"; state: string; resultReportId: string | null }
  /** Bounded refusal. The row is terminal or was left for another worker. */
  | { outcome: "noop"; reason: string };

// ===========================================================================
// Resolve + claim
// ===========================================================================

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
    where: { id: request.evidenceId, deletedAt: null },
    select: { id: true, teamId: true, status: true },
  });
  if (!evidence) {
    await markRequestTerminal({
      requestId,
      state: "FAILED_TERMINAL",
      terminalReasonCode: "evidence_not_found",
    });
    return { outcome: "noop", reason: "evidence_not_found" };
  }
  if (!evidence.teamId || evidence.teamId !== request.teamId) {
    // The evidence moved workspace, or the request was written against one it
    // never belonged to. Either way the run is refused before it can read a
    // single byte of the other tenant's material.
    bump("queue_workspace_mismatch_total");
    await markRequestTerminal({
      requestId,
      state: "BLOCKED_POLICY",
      terminalReasonCode: "workspace_mismatch",
    });
    return { outcome: "noop", reason: "workspace_mismatch" };
  }

  // ---- Organization lifecycle, reloaded ------------------------------------
  //
  // Lifecycle lives on the Organization, not on the workspace: a Team has no
  // status column of its own, and every Team belongs to exactly one
  // Organization. So "is this workspace still allowed to do work" resolves
  // through the org, which is also where suspension is applied.
  const workspace = await prisma.team.findUnique({
    where: { id: evidence.teamId },
    select: { id: true, organizationId: true },
  });
  if (!workspace) {
    await markRequestTerminal({
      requestId,
      state: "BLOCKED_POLICY",
      terminalReasonCode: "workspace_not_found",
    });
    return { outcome: "noop", reason: "workspace_not_found" };
  }
  const organization = await prisma.organization.findUnique({
    where: { id: workspace.organizationId },
    select: { id: true, status: true },
  });
  if (!organization || organization.status !== "ACTIVE") {
    await markRequestTerminal({
      requestId,
      state: "BLOCKED_POLICY",
      terminalReasonCode: "organization_not_active",
    });
    return { outcome: "noop", reason: "organization_not_active" };
  }

  // ---- Policy version, reloaded and compared -------------------------------
  const policy = await prisma.workspaceGovernancePolicy.findFirst({
    where: { teamId: evidence.teamId },
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

  // ---- Legal hold: a held record is not regenerated over ------------------
  // Regeneration REPLACES a finalised artifact. Under an active hold that is a
  // mutation of preserved material, so it is refused; first generation is not,
  // because there is nothing yet to preserve.
  if (request.forceRegenerate) {
    const hold = await prisma.evidenceLegalHold.findFirst({
      where: { evidenceId: evidence.id, status: "ACTIVE" },
      select: { id: true },
    });
    if (hold) {
      await markRequestTerminal({
        requestId,
        state: "BLOCKED_POLICY",
        terminalReasonCode: "legal_hold_active",
      });
      return { outcome: "noop", reason: "legal_hold_active" };
    }
  }

  // ---- Atomic claim --------------------------------------------------------
  // The predicate accepts a claimable state OR an expired lease. Expressing
  // recovery IN the claim rather than in a separate sweep means a worker that
  // died mid-run cannot hold a request forever, and it costs one statement.
  const leaseFloor = new Date(Date.now() - REPORT_CLAIM_LEASE_MS);
  const claimed = await prisma.reportGenerationRequest.updateMany({
    where: {
      id: requestId,
      OR: [
        { state: { in: [...CLAIMABLE_STATES] } },
        { state: "PROCESSING", claimedAtUtc: { lt: leaseFloor } },
      ],
    },
    data: {
      state: "PROCESSING",
      claimedAtUtc: new Date(),
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
      evidenceId: evidence.id,
      teamId: evidence.teamId,
      artifactType: request.artifactType,
      forceRegenerate: request.forceRegenerate,
      regenerateReason: request.regenerateReason,
      attemptCount: request.attemptCount + 1,
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
  state: "SUCCEEDED" | "FAILED_TERMINAL" | "BLOCKED_STALE" | "BLOCKED_POLICY";
  terminalReasonCode: string;
  resultReportId?: string | null;
  resultChecksum?: string | null;
}): Promise<boolean> {
  const updated = await prisma.reportGenerationRequest.updateMany({
    where: {
      id: input.requestId,
      state: {
        notIn: ["SUCCEEDED", "FAILED_TERMINAL", "BLOCKED_STALE", "BLOCKED_POLICY"],
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
 * Release a claim so the queue's own retry can pick the request up again.
 *
 * Distinct from a terminal write: this is the "the attempt failed but the
 * intent is still valid" path, and it deliberately leaves no completion
 * timestamp behind.
 */
export async function markRequestRetryable(input: {
  requestId: string;
  terminalReasonCode: string;
}): Promise<void> {
  await prisma.reportGenerationRequest.updateMany({
    where: { id: input.requestId, state: "PROCESSING" },
    data: {
      state: "FAILED_RETRYABLE",
      terminalReasonCode: input.terminalReasonCode.slice(0, 64),
      claimedAtUtc: null,
    },
  });
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
  });
  return persisted.created
    ? { requestId: persisted.requestId }
    : { requestId: null, reason: persisted.reason };
}

/**
 * The worker's own report producer.
 *
 * The worker legitimately originates report generation in two places: the OTS
 * upgrade, which must regenerate the report once the timestamp is anchored,
 * and the lifecycle-recovery sweep, which finds evidence that was SIGNED but
 * whose report job never ran. Both go through the SAME durable-row-then-enqueue
 * path the api uses, so there is one request model rather than two.
 */
export async function requestReportGenerationFromWorker(input: {
  evidenceId: string;
  purpose: ReportGenerationPurpose;
  forceRegenerate?: boolean;
  regenerateReason?: string | null;
  machineId: string;
  enqueue: (requestId: string) => Promise<{ enqueued: boolean; reason?: string }>;
}): Promise<{ enqueued: boolean; requestId?: string; reason?: string }> {
  const persisted = await createReportGenerationRequest(prisma, {
    evidenceId: input.evidenceId,
    purpose: input.purpose,
    artifactType: "REPORT",
    forceRegenerate: input.forceRegenerate === true,
    regenerateReason: input.regenerateReason ?? null,
    requestedByMachineId: input.machineId,
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
  const leaseFloor = new Date(now.getTime() - REPORT_CLAIM_LEASE_MS);
  const released = await prisma.reportGenerationRequest.updateMany({
    where: { state: "PROCESSING", claimedAtUtc: { lt: leaseFloor } },
    data: { state: "FAILED_RETRYABLE", claimedAtUtc: null },
  });
  summary.leasesReleased = released.count;

  // ---- 2. Completed artifact with no terminal request state ---------------
  // The generation succeeded and the process died before the terminal write.
  // The artifact exists, so re-running would DUPLICATE it; the honest repair
  // is to record the success that already happened.
  const possiblyDone = await prisma.reportGenerationRequest.findMany({
    where: { state: { in: ["PROCESSING", "FAILED_RETRYABLE"] } },
    select: { id: true, evidenceId: true, createdAtUtc: true },
    orderBy: { createdAtUtc: "asc" },
    take: batchSize,
  });
  for (const candidate of possiblyDone) {
    const newerReport = await prisma.report.findFirst({
      where: {
        evidenceId: candidate.evidenceId,
        generatedAtUtc: { gte: candidate.createdAtUtc },
      },
      orderBy: { version: "desc" },
      select: { id: true },
    });
    if (!newerReport) continue;
    const repaired = await markRequestTerminal({
      requestId: candidate.id,
      state: "SUCCEEDED",
      terminalReasonCode: "reconciled_artifact_present",
      resultReportId: newerReport.id,
    });
    if (repaired) summary.terminalRepaired += 1;
  }

  // ---- 3. Durable but never scheduled → re-enqueue -------------------------
  const stranded = await prisma.reportGenerationRequest.findMany({
    where: { state: { in: ["QUEUED", "FAILED_RETRYABLE"] } },
    select: { id: true },
    orderBy: { createdAtUtc: "asc" },
    take: batchSize,
  });
  summary.scanned = stranded.length;

  for (const row of stranded) {
    try {
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
