/**
 * THE OUTPUT-PRODUCER GUARD — SETTLEMENT OF A WAITING REQUEST (2026-10-20).
 *
 * Kept apart from the writer on purpose: the writer only ever CREATES rows
 * (a supersession is a new row, never an update — pinned by
 * commercial-output-journeys). Settling an existing request whose record left
 * the producible states is the one place a request row is moved to its
 * not-applicable terminal.
 */
import type { PrismaClient } from "@prisma/client";
import { outputLifecycleRefusal, type OutputProductionRefusal } from "@proovra/shared";

/**
 * THE OUTPUT-PRODUCER GUARD'S SETTLEMENT (2026-10-20, AUD-01/02/35).
 *
 * A request whose record may no longer receive the output — it was archived,
 * trashed, destroyed or deleted, or its plan stopped including the output,
 * after the request was written — is settled as an expected business outcome
 * with its bounded `NOT_APPLICABLE_*` reason. One implementation for the api's
 * re-enqueue and every worker checkpoint (claim, report commit, package
 * commit, stranded sweep). Fenced by the run's claim when a worker ran it.
 */
export async function settleReportRequestNotApplicable(
  prisma: PrismaClient,
  input: { requestId: string; refusal: OutputProductionRefusal; fence?: { claimedAtUtc: Date } },
): Promise<boolean> {
  const updated = await prisma.reportGenerationRequest.updateMany({
    where: input.fence
      ? { id: input.requestId, state: "PROCESSING", claimedAtUtc: input.fence.claimedAtUtc }
      : { id: input.requestId, state: { notIn: ["SUCCEEDED", "FAILED_TERMINAL", "BLOCKED_STALE", "BLOCKED_POLICY"] } },
    data: {
      state: "BLOCKED_POLICY",
      terminalReasonCode: input.refusal.slice(0, 64),
      completedAtUtc: new Date(),
    },
  });
  return updated.count > 0;
}

/**
 * The lifecycle refusal for the record a stored request names — what a
 * re-enqueue path asks before putting a job back on the queue. Null when the
 * record may still receive outputs (or no longer exists: the claim answers).
 */
export async function lifecycleRefusalForRequest(
  prisma: PrismaClient,
  requestId: string,
): Promise<OutputProductionRefusal | null> {
  const row = await prisma.reportGenerationRequest.findUnique({ where: { id: requestId }, select: { evidenceId: true } });
  if (!row) return null;
  const evidence = await prisma.evidence.findUnique({
    where: { id: row.evidenceId },
    select: { status: true, lifecycleState: true, deletedAt: true },
  });
  if (!evidence) return null;
  const refusal = outputLifecycleRefusal(evidence as never);
  return refusal;
}
