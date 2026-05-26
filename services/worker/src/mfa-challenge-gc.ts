/**
 * PHASE R8.1.4 — Scheduled MFA pending challenge cleanup.
 *
 * Recurring worker that periodically deletes expired / consumed
 * MfaPendingChallenge rows from the durable challenge store, plus
 * flips PENDING MfaRecoveryRequest rows to EXPIRED when their TTL
 * has passed. Both operations are bounded, idempotent, and safe
 * under concurrency.
 *
 * The sweep deliberately does NOT delete UNEXPIRED active rows:
 *
 *   - Pending challenges: only rows where `expiresAt < now - retention`
 *     OR (`consumedAt IS NOT NULL` AND `consumedAt < now - retention`)
 *     are removed. Active challenges within the live 5-min window
 *     are NEVER touched.
 *   - Recovery requests: only rows with `status = PENDING` AND
 *     `expiresAt < now` get flipped to EXPIRED. APPROVED / COMPLETED /
 *     REJECTED rows are append-only audit trail.
 *
 * Emits one `mfa_challenge_gc_completed` SecurityEvent per
 * non-trivial sweep so SecOps can confirm the job is running.
 */

import { randomUUID } from "node:crypto";

import { logger } from "./logger.js";
import { prisma } from "./db.js";
import { captureException } from "./sentry.js";

/** How long expired/consumed rows are retained before deletion.
 *  Matches the API's R8.1.3 opportunistic GC constant so the two
 *  paths never disagree on what "stale" means. */
const RETENTION_SECONDS = 60 * 60;

/** Bounded per-call delete batch. Multiple invocations drain the
 *  table; a single invocation is cheap. */
const PENDING_CHALLENGE_BATCH = 200;
const RECOVERY_REQUEST_BATCH = 200;

export interface MfaChallengeGcOptions {
  trigger?: string;
}

export interface MfaChallengeGcResult {
  /** Number of MfaPendingChallenge rows deleted. */
  challengesDeleted: number;
  /** Number of MfaRecoveryRequest rows flipped PENDING → EXPIRED. */
  recoveryRequestsExpired: number;
  /** True when at least one row was touched (used to gate the
   *  security event emission). */
  didWork: boolean;
}

export async function runMfaChallengeGc(
  options: MfaChallengeGcOptions = {},
): Promise<MfaChallengeGcResult> {
  const trigger = options.trigger ?? "manual";
  const requestId = randomUUID();
  const now = new Date();
  const retentionCutoff = new Date(now.getTime() - RETENTION_SECONDS * 1000);

  // ---------- 1. MfaPendingChallenge sweep ----------
  let challengesDeleted = 0;
  try {
    // Two-step bounded delete. Postgres has no `DELETE ... LIMIT`,
    // so we select ids first and then delete by id. Bounded by
    // PENDING_CHALLENGE_BATCH; multiple ticks drain the backlog.
    const stale = await prisma.mfaPendingChallenge.findMany({
      where: {
        OR: [
          { consumedAt: { not: null, lt: retentionCutoff } },
          { expiresAt: { lt: retentionCutoff } },
        ],
      },
      select: { id: true },
      take: PENDING_CHALLENGE_BATCH,
    });
    if (stale.length > 0) {
      const r = await prisma.mfaPendingChallenge.deleteMany({
        where: { id: { in: stale.map((s) => s.id) } },
      });
      challengesDeleted = r.count;
    }
  } catch (err) {
    logger.error(
      { err, requestId, trigger },
      "mfa.challenge_gc.challenges_failed",
    );
    captureException(err, { trigger, phase: "challenges" });
  }

  // ---------- 2. MfaRecoveryRequest expiry ----------
  let recoveryRequestsExpired = 0;
  try {
    // R8.1.5 — both preflight states qualify for expiry. We also
    // expire EMAIL_VERIFICATION_PENDING rows whose
    // `emailVerificationExpiresAt` is past, even when the outer
    // row TTL has time left — an expired email link means the
    // request is effectively dead.
    const stalePending = await prisma.mfaRecoveryRequest.findMany({
      where: {
        status: { in: ["EMAIL_VERIFICATION_PENDING", "PENDING_ADMIN_REVIEW"] },
        OR: [
          { expiresAt: { lt: now } },
          {
            status: "EMAIL_VERIFICATION_PENDING",
            emailVerificationExpiresAt: { lt: now },
          },
        ],
      },
      select: { id: true },
      take: RECOVERY_REQUEST_BATCH,
    });
    if (stalePending.length > 0) {
      // Re-check status in the WHERE so a parallel approval / cancel
      // that raced us cannot be silently overwritten.
      const r = await prisma.mfaRecoveryRequest.updateMany({
        where: {
          id: { in: stalePending.map((s) => s.id) },
          status: {
            in: ["EMAIL_VERIFICATION_PENDING", "PENDING_ADMIN_REVIEW"],
          },
        },
        data: { status: "EXPIRED" },
      });
      recoveryRequestsExpired = r.count;
    }
  } catch (err) {
    logger.error(
      { err, requestId, trigger },
      "mfa.challenge_gc.recovery_failed",
    );
    captureException(err, { trigger, phase: "recovery_requests" });
  }

  const didWork = challengesDeleted > 0 || recoveryRequestsExpired > 0;

  // ---------- 3. SecurityEvent — only on non-trivial sweeps ----------
  if (didWork) {
    try {
      await prisma.securityEvent.create({
        data: {
          teamId: null,
          userId: null,
          eventType: "mfa_challenge_gc_completed",
          severity: "INFO",
          details: {
            trigger,
            challengesDeleted,
            recoveryRequestsExpired,
            retentionSeconds: RETENTION_SECONDS,
            batchSize: PENDING_CHALLENGE_BATCH,
          },
        },
      });
    } catch (err) {
      // Best-effort — emission failure must not block the sweep.
      logger.warn(
        { err, requestId, trigger },
        "mfa.challenge_gc.event_emit_failed",
      );
    }
  }

  logger.info(
    {
      requestId,
      trigger,
      challengesDeleted,
      recoveryRequestsExpired,
      didWork,
    },
    "mfa.challenge_gc.completed",
  );
  return {
    challengesDeleted,
    recoveryRequestsExpired,
    didWork,
  };
}
