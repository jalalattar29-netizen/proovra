/**
 * Phase C #8 — Capture draft reaper.
 *
 * Sweeps CaptureSession rows whose expiresAtUtc is in the past and whose
 * status is still DRAFT, marking them EXPIRED and appending a
 * CaptureSessionEventType.EXPIRED audit event. Bounded batch size; safe to
 * run repeatedly.
 *
 * Safety guarantees:
 *   - Only touches rows where status === DRAFT. Finalized / discarded /
 *     already-expired drafts are never modified.
 *   - Never deletes or modifies any Evidence, EvidencePart, Report,
 *     VerificationPackage, or CustodyEvent row.
 *   - Per-row work runs inside a transaction so the status flip and the
 *     audit event are atomic.
 *   - Designed to be called on a setInterval timer matching the existing
 *     demo-followup scheduler pattern in services/worker/src/index.ts.
 */
import * as prismaPkg from "@prisma/client";
import { randomUUID } from "node:crypto";
import { logger } from "./logger.js";
import { prisma } from "./db.js";
import { shouldExpireCaptureDraft } from "./capture-draft-governance.js";

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 500;

export interface ReapExpiredCaptureDraftsOptions {
  /** Max number of drafts processed per invocation. */
  batchSize?: number;
  /** Calling context label for logs (e.g. "interval", "startup"). */
  trigger?: string;
}

export interface ReapExpiredCaptureDraftsResult {
  scanned: number;
  expired: number;
  failed: number;
  skipped: number;
}

export async function reapExpiredCaptureDrafts(
  options: ReapExpiredCaptureDraftsOptions = {}
): Promise<ReapExpiredCaptureDraftsResult> {
  const requestId = randomUUID();
  const trigger = options.trigger ?? "manual";
  const batchSize = Math.max(
    1,
    Math.min(options.batchSize ?? DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE)
  );
  const now = new Date();

  const candidates = await prisma.captureSession.findMany({
    where: {
      status: prismaPkg.CaptureSessionStatus.DRAFT,
      expiresAtUtc: { not: null, lt: now },
    },
    orderBy: { expiresAtUtc: "asc" },
    take: batchSize,
    select: {
      id: true,
      ownerUserId: true,
      teamId: true,
      expiresAtUtc: true,
    },
  });

  let expired = 0;
  let failed = 0;
  let skipped = 0;

  for (const draft of candidates) {
    try {
      await prisma.$transaction(async (tx) => {
        // Re-check inside the transaction; another reaper instance may have
        // already taken this draft.
        const fresh = await tx.captureSession.findUnique({
          where: { id: draft.id },
          select: { status: true, expiresAtUtc: true },
        });
        if (!fresh) {
          skipped++;
          return;
        }
        if (
          !shouldExpireCaptureDraft({
            status: fresh.status,
            expiresAtUtc: fresh.expiresAtUtc,
            now,
          })
        ) {
          skipped++;
          return;
        }

        await tx.captureSession.update({
          where: { id: draft.id },
          data: {
            status: prismaPkg.CaptureSessionStatus.EXPIRED,
          },
        });
        await tx.captureSessionEvent.create({
          data: {
            sessionId: draft.id,
            actorUserId: null,
            eventType: prismaPkg.CaptureSessionEventType.EXPIRED,
            payload: {
              reason: "expires_at_utc_passed",
              expiredAtUtc: now.toISOString(),
              trigger,
            } as prismaPkg.Prisma.InputJsonValue,
          },
        });
        expired++;
      });
    } catch (err) {
      failed++;
      logger.warn(
        {
          requestId,
          captureSessionId: draft.id,
          err,
          trigger,
        },
        "capture.reaper.draft_expire_failed"
      );
    }
  }

  logger.info(
    {
      requestId,
      trigger,
      scanned: candidates.length,
      expired,
      failed,
      skipped,
    },
    "capture.reaper.completed"
  );

  return {
    scanned: candidates.length,
    expired,
    failed,
    skipped,
  };
}
