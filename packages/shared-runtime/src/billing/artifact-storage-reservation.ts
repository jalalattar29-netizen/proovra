/**
 * WS-SCHED / PRO-W1-06 (DEC-04) — THE WORKSPACE STORAGE RESERVATION OF AN
 * ARTIFACT RUN.
 *
 * The worker's artifact storage gate was check-then-write: two runs for
 * different records of one workspace both read the same committed usage, both
 * passed, and both published under Object Lock. Refusing at commit instead
 * would refuse bytes that can no longer be removed. So the bytes are RESERVED
 * before they are written:
 *
 *   - under the EXISTING per-workspace capacity lock (the key the API's
 *     admission, completion and settlement take: `evidence-capacity:<payer>`),
 *     in a short transaction that reads usage PLUS the live reservations of
 *     the workspace and, when the artifact fits, records its size on the
 *     request row the run holds (`report_generation_requests.
 *     storage_reserved_bytes`);
 *   - nothing is held across the upload: the transaction ends before the
 *     first byte leaves the worker.
 *
 * A reservation is LIVE exactly while the request's CLAIM is live (the report
 * claim lease, renewed by the run's heartbeat: `reportClaimLiveWhere`). It
 * therefore needs no clock of its own: a run that died stops counting when its
 * claim expires, and the stranded-request reconciler that releases the claim
 * clears the column. A run that settles (committed, refused, failed) clears it
 * in the same write.
 *
 * Both hosts' usage meters add `sumLiveArtifactStorageReservationBytes`, so an
 * API admission (which runs under the same lock) sees a worker's reservation
 * and a worker's reservation sees the API's committed bytes.
 *
 * M676 — the same sum carries the live reservations of derived-artifact jobs
 * (`evidence_part_derived_assets.storage_reserved_bytes`, derived-storage.ts),
 * so the two meters read ONE reservation figure.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

import { reportClaimLiveWhere } from "../reports/report-claim-lease.js";
import { sumLiveDerivedAssetStorageReservationBytes } from "./derived-storage.js";

/** The payer subject both hosts lock on (the API's `commercialPrincipalOf`). */
export type WorkspaceCapacitySubject = {
  billingShape: "SINGLE_OCCUPANT" | "SHARED";
  ownerUserId: string;
  teamId: string | null;
};

/**
 * The advisory-lock key of a workspace's capacity. Byte-for-byte the key the
 * API's `lockEvidenceCapacitySubject` takes, so the worker's reservation and
 * the API's admission / completion storage check serialize on ONE lock.
 */
export function workspaceCapacityLockKey(subject: WorkspaceCapacitySubject): string {
  if (subject.billingShape === "SINGLE_OCCUPANT") {
    return `evidence-capacity:PERSONAL:${subject.ownerUserId}`;
  }
  if (!subject.teamId) {
    throw new Error("workspaceCapacityLockKey: SHARED scope carries no teamId");
  }
  return `evidence-capacity:WORKSPACE:${subject.teamId}`;
}

/** Take the workspace capacity lock for the rest of this transaction. */
export async function lockWorkspaceCapacityTx(
  tx: Pick<Prisma.TransactionClient, "$executeRaw">,
  subject: WorkspaceCapacitySubject,
): Promise<void> {
  const key = workspaceCapacityLockKey(subject);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}

/** WHERE a request holds a LIVE storage reservation of this workspace Team. */
export function liveArtifactStorageReservationWhere(
  teamId: string,
  now: Date,
): Prisma.ReportGenerationRequestWhereInput {
  return {
    AND: [{ teamId, storageReservedBytes: { not: null } }, reportClaimLiveWhere(now)],
  };
}

/**
 * Bytes reserved by artifact runs in flight for this workspace Team (the usage
 * Team both meters resolve: the workspace, or the owner's personal Team).
 * `excludeRequestId` leaves out the caller's own reservation, so a run that
 * re-reserves (its package after its report, a retry) is not counted twice.
 */
export async function sumLiveArtifactStorageReservationBytes(
  prisma: Pick<PrismaClient, "reportGenerationRequest" | "evidencePartDerivedAsset">,
  input: { teamId: string | null; now?: Date; excludeRequestId?: string | null },
): Promise<bigint> {
  if (!input.teamId) return 0n;
  const now = input.now ?? new Date();
  const live = liveArtifactStorageReservationWhere(input.teamId, now);
  const [agg, derived] = await Promise.all([
    prisma.reportGenerationRequest.aggregate({
      where: input.excludeRequestId ? { AND: [live, { id: { not: input.excludeRequestId } }] } : live,
      _sum: { storageReservedBytes: true },
    }),
    // M676 — derived-artifact jobs in flight (unexpired reservations only).
    sumLiveDerivedAssetStorageReservationBytes(prisma, { teamId: input.teamId, now }),
  ]);
  const raw = agg?._sum?.storageReservedBytes ?? 0;
  const requests = typeof raw === "bigint" ? raw : BigInt(Math.max(0, Math.trunc(Number(raw))));
  return requests + derived;
}

/**
 * STRANDED-RESERVATION RELEASE. A reservation whose request no longer holds a
 * live claim counts nothing already; this clears the column so the row states
 * the truth. Idempotent, bounded by one statement, safe on either host.
 * Returns how many rows were cleared.
 */
export async function releaseStrandedArtifactStorageReservations(
  prisma: Pick<PrismaClient, "reportGenerationRequest">,
  now: Date = new Date(),
): Promise<number> {
  const released = await prisma.reportGenerationRequest.updateMany({
    where: { storageReservedBytes: { not: null }, NOT: reportClaimLiveWhere(now) },
    data: { storageReservedBytes: null },
  });
  return released.count;
}
