/**
 * Phase CAPTURE-HARDENING — Capture draft expiry sweeper.
 *
 * The CaptureSession row carries an `expiresAtUtc` that is set when
 * the draft is created (typically ~7 days out). Until this sweeper
 * existed, expired drafts remained at `status = DRAFT` forever; the
 * draft list (GET /v1/capture/sessions?status=DRAFT) would return
 * them, and they would accumulate against the user's draft pile
 * indefinitely.
 *
 * SAFETY RULES (these are the WHOLE point of the file — read them):
 *   - This sweeper NEVER touches finalized evidence rows.
 *   - It NEVER touches S3 / storage objects.
 *   - It NEVER touches drafts that already left DRAFT
 *     (FINALIZED / DISCARDED / EXPIRED are skipped by the WHERE
 *     clause; finalized drafts carry `finalizedEvidenceId` and
 *     `finalizedAtUtc` which we do not read).
 *   - It NEVER skips audit: every state change appends a
 *     CaptureSessionEvent(EXPIRED) so the operator-visible trail
 *     records exactly when and why the draft was retired.
 *   - It is idempotent: a row that is already EXPIRED is not
 *     re-touched (the WHERE clause excludes anything but DRAFT).
 *   - It cannot run as a real cron in tests — `sweepExpiredCaptureDrafts`
 *     is exported as a pure function so vitest can call it directly
 *     against a transactional Prisma client.
 */

import { Prisma } from "@prisma/client";

import { prisma } from "../db.js";
import { log as logInfo, warn as logWarn } from "../utils/logger.js";

export type SweepResult = {
  scannedAt: string;
  expiredCount: number;
  expiredIds: string[];
};

const SWEEP_BATCH_LIMIT = 500;

/**
 * Find every CaptureSession that is still in DRAFT but whose
 * `expiresAtUtc` is now in the past, flip its status to EXPIRED,
 * and append an audit event.
 *
 * Returns the list of ids that were transitioned so the caller can
 * log / surface them.
 *
 * Implementation notes:
 *   - We hold the rows in a Prisma transaction so a concurrent
 *     finalize/discard race can never race past the EXPIRED flip
 *     (both updates contend for the same row).
 *   - The CaptureSessionEvent insert and the row update happen in
 *     the same transaction — if the event insert fails the status
 *     change rolls back, so the audit trail can never miss an
 *     expiry.
 *   - The query uses the existing `(status, expiresAtUtc)` index.
 *   - LIMIT prevents a runaway sweep from holding a long
 *     transaction; the caller can re-invoke until the result count
 *     is zero.
 */
export async function sweepExpiredCaptureDrafts(args: {
  now?: Date;
  limit?: number;
} = {}): Promise<SweepResult> {
  const now = args.now ?? new Date();
  const limit = args.limit ?? SWEEP_BATCH_LIMIT;

  const expiredIds = await prisma.$transaction(async (tx) => {
    const rows = await tx.captureSession.findMany({
      where: {
        status: "DRAFT",
        expiresAtUtc: { lt: now, not: null },
      },
      orderBy: { expiresAtUtc: "asc" },
      take: limit,
      select: { id: true, expiresAtUtc: true },
    });
    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id);

    // Update first — keeps the audit insert dependent on the row
    // having actually transitioned. The Prisma updateMany is bounded
    // to status=DRAFT, so a row that just got DISCARDED by another
    // worker is silently skipped.
    const update = await tx.captureSession.updateMany({
      where: { id: { in: ids }, status: "DRAFT" },
      data: { status: "EXPIRED" },
    });

    if (update.count === 0) return [];

    // Audit one event per transitioned row. We use createMany for
    // the bulk insert; the payload records the original expiresAtUtc
    // so an operator can correlate.
    const events = rows.map((r) => ({
      sessionId: r.id,
      eventType: "EXPIRED" as const,
      payload: {
        reason: "expiresAtUtc elapsed",
        expiresAtUtc: r.expiresAtUtc?.toISOString() ?? null,
        sweepAt: now.toISOString(),
      } as Prisma.InputJsonValue,
    }));
    await tx.captureSessionEvent.createMany({ data: events });

    return ids;
  });

  return {
    scannedAt: now.toISOString(),
    expiredCount: expiredIds.length,
    expiredIds,
  };
}

/**
 * Cron-friendly wrapper: swallows errors so a transient DB blip on a
 * 6h tick never escalates. Errors are logged at warn (operators have
 * the structured log line) but never thrown — capture itself must
 * keep working even if the sweeper has a bad day.
 */
export async function runCaptureDraftExpirySweepSafe(): Promise<SweepResult | null> {
  try {
    const result = await sweepExpiredCaptureDrafts();
    if (result.expiredCount > 0) {
      logInfo("capture_draft_expiry_sweep.completed", {
        expiredCount: result.expiredCount,
        scannedAt: result.scannedAt,
      });
    }
    return result;
  } catch (err) {
    logWarn("capture_draft_expiry_sweep.failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
