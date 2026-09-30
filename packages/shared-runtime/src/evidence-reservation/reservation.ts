/**
 * THE EVIDENCE RESERVATION AUTHORITY (ET-ACQ-02, ET-INT-03, ET-DC-05).
 *
 * A record is RESERVED from creation until it is finalized (it leaves
 * CREATED/UPLOADING). Every capture path reserves first: a web upload, an
 * external-intake submission, a direct-capture session. An interrupted capture
 * used to leave the reservation forever — counting against the owner's
 * allowance, listed nowhere, never reaped.
 *
 * This module is the one place that decides:
 *   - how long a reservation is LIVE (EVIDENCE_RESERVATION_TTL_MS, measured from
 *     the record's last write);
 *   - which records occupy an allowance slot (countedEvidenceRecordWhere) — the
 *     API's admission, settlement and meters all use it;
 *   - which reservations are EXPIRED and may be released
 *     (expiredEvidenceReservationWhere) — the Worker's reservation sweep;
 *   - how a reservation is RELEASED (releaseEvidenceReservationTx) — used by a
 *     direct-capture discard (API) and by the sweep (Worker) alike.
 *
 * Release is a soft delete plus an EVIDENCE_DELETED custody event, under the
 * evidence lock, and only while the record is still unsealed: finalization
 * holds the same lock and its claim requires deletedAt IS NULL, so a record is
 * either released or finalized, never both.
 */
import type { Prisma } from "@prisma/client";
import * as prismaPkg from "@prisma/client";

import { appendCustodyEventTx } from "../custody/custody-chain.js";

export const EVIDENCE_RESERVATION_TTL_MS = 24 * 60 * 60 * 1000;

const UNSEALED = [prismaPkg.EvidenceStatus.CREATED, prismaPkg.EvidenceStatus.UPLOADING];

/** An evidence record occupies an allowance slot when established or while its reservation is live. */
export function countedEvidenceRecordWhere(now: Date = new Date()): Prisma.EvidenceWhereInput {
  return {
    OR: [
      { status: { notIn: UNSEALED } },
      { createdAt: { gte: new Date(now.getTime() - EVIDENCE_RESERVATION_TTL_MS) } },
    ],
  };
}

const LIVE_INTAKE: prismaPkg.WorkflowIntakeSessionStatus[] = [
  "CREATED",
  "OPENED",
  "UPLOAD_STARTED",
  "UPLOAD_COMPLETED",
];

/**
 * Reservations the sweep may release: unsealed, not deleted, untouched for the
 * whole window, and not held open by any live session (an intake link that is
 * still open, a resumable upload with recent activity, a direct-capture session
 * that has not expired).
 */
export function expiredEvidenceReservationWhere(now: Date = new Date()): Prisma.EvidenceWhereInput {
  const cutoff = new Date(now.getTime() - EVIDENCE_RESERVATION_TTL_MS);
  return {
    status: { in: UNSEALED },
    deletedAt: null,
    createdAt: { lt: cutoff },
    updatedAt: { lt: cutoff },
    NOT: [
      { workflowIntakeSession: { is: { status: { in: LIVE_INTAKE }, expiresAtUtc: { gt: now } } } },
      { uploadSession: { is: { lastActivityAtUtc: { gte: cutoff } } } },
    ],
  } satisfies Prisma.EvidenceWhereInput;
}

const LIVE_CAPTURE: prismaPkg.CaptureSessionStatus[] = ["ACTIVE", "INTERRUPTED"];

/** True when a session that may still complete this record is open. */
async function heldByLiveSession(tx: Prisma.TransactionClient, evidenceId: string, now: Date): Promise<boolean> {
  const [intake, capture] = await Promise.all([
    tx.workflowIntakeSession.count({
      where: { evidenceId, status: { in: LIVE_INTAKE }, expiresAtUtc: { gt: now } },
    }),
    tx.captureSession.count({
      where: {
        finalizedEvidenceId: evidenceId,
        status: { in: LIVE_CAPTURE },
        OR: [{ expiresAtUtc: null }, { expiresAtUtc: { gt: now } }],
      },
    }),
  ]);
  return intake > 0 || capture > 0;
}

export type ReservationReleaseReason =
  | "CAPTURE_SESSION_DISCARDED"
  | "CAPTURE_SESSION_EXPIRED"
  | "RESERVATION_EXPIRED"
  // ET-INT-09 — two first-part intake uploads raced; the loser releases its own
  // still-empty reservation (the session is bound to the winner's record).
  | "INTAKE_SESSION_RACE_LOST";

/**
 * Release one reservation inside the caller's transaction. Returns false (and
 * writes nothing) when the record is gone, already deleted, or no longer
 * unsealed — finalization won.
 */
export async function releaseEvidenceReservationTx(
  tx: Prisma.TransactionClient,
  params: {
    evidenceId: string;
    reason: ReservationReleaseReason;
    now: Date;
    captureSessionId?: string | null;
  },
): Promise<boolean> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${params.evidenceId}))`;
  const evidence = await tx.evidence.findUnique({
    where: { id: params.evidenceId },
    select: { id: true, status: true, deletedAt: true },
  });
  if (!evidence || evidence.deletedAt || !UNSEALED.includes(evidence.status as never)) return false;
  // A time-based release never takes a record a live session can still finish.
  // (A discard or a session expiry has already ended its own session.)
  if (params.reason === "RESERVATION_EXPIRED" && (await heldByLiveSession(tx, evidence.id, params.now))) {
    return false;
  }

  const claimed = await tx.evidence.updateMany({
    where: { id: evidence.id, deletedAt: null, status: { in: UNSEALED } },
    data: { deletedAt: params.now },
  });
  if (claimed.count !== 1) return false;

  await appendCustodyEventTx(tx, {
    evidenceId: evidence.id,
    eventType: prismaPkg.CustodyEventType.EVIDENCE_DELETED,
    atUtc: params.now,
    payload: {
      reason: params.reason,
      ...(params.captureSessionId ? { captureSessionId: params.captureSessionId } : {}),
      statusAtRelease: evidence.status,
      note: "Reservation released before any content was committed.",
    },
  });
  return true;
}
