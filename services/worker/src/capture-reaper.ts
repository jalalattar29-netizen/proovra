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
import {
  expiredEvidenceReservationWhere,
  releaseEvidenceReservationTx,
} from "@proovra/shared-runtime";

/**
 * THE WORK THIS MODULE RECOVERS.
 *
 * Declared here so the canonical work registry's `reconciler` field can be
 * checked against the module it names rather than merely against the
 * filesystem. The topology gate proves the two agree in both directions: a
 * registry entry pointing at a module that does not claim its work fails, and
 * a module claiming work no entry assigns it fails.
 *
 * That check exists because the weaker one — "the declared file exists" —
 * passed three false declarations in a row: UPGRADE_OTS and
 * PURGE_DELETED_EVIDENCE both named a module containing no such code, and
 * EMBED_SEMANTIC_CHUNKS named one whose every scan keyed on a table the embed
 * chain never writes. All three resolved to a real file. None of them was true.
 *
 * Keys, not values: the registry addresses work through `JOB_NAMES` /
 * `SWEEP_NAMES`, and a literal string here would be a second spelling of a
 * name the shared authority already owns.
 */
export const RECOVERED_WORK_TYPES = [
  "CAPTURE_DRAFT_REAPER",
] as const;


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

        // PHASE 12 POINT 5 — THE CLAIM.
        //
        // The re-read above is not one. At READ COMMITTED a `findUnique`
        // takes no lock, so two reapers both saw DRAFT, both wrote EXPIRED
        // (harmless, same value) and both appended an EXPIRED audit event —
        // two ledger rows for one expiry, in a table whose whole purpose is
        // to say what happened once. The conditional UPDATE is the claim:
        // the row's own status is the precondition, so exactly one caller
        // gets `count === 1` and only that caller writes the event.
        const claimed = await tx.captureSession.updateMany({
          where: {
            id: draft.id,
            status: prismaPkg.CaptureSessionStatus.DRAFT,
          },
          data: {
            status: prismaPkg.CaptureSessionStatus.EXPIRED,
          },
        });
        if (claimed.count !== 1) {
          skipped++;
          return;
        }
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

// =============================================================================
// ET-DC-05 / ET-ACQ-02 — expired direct-capture sessions and reservations.
// =============================================================================

export interface ReleaseExpiredReservationsResult {
  sessionsExpired: number;
  reservationsReleased: number;
  objectDeletesRequested: number;
  objectDeletesFailed: number;
  failed: number;
}

/**
 * Removes the storage keys of released reservations. Best-effort and after
 * commit: the release is the record's truth. On a versioned (Object Lock)
 * bucket a key delete only adds a delete marker; a retained version persists
 * until its own retention ends — that is the bucket's guarantee, not a leak.
 */
export type ReservationObjectDeleter = (p: { bucket: string; key: string }) => Promise<unknown>;

/**
 * THE reservation sweep. Two passes, both through THE reservation authority
 * (@proovra/shared-runtime evidence-reservation):
 *
 *  1. Direct-capture sessions still ACTIVE/INTERRUPTED past their expiry can
 *     never complete (completion refuses an expired session), so each is
 *     claimed EXPIRED under the same session lock a discard takes, and its
 *     reservation is released (reason CAPTURE_SESSION_EXPIRED). The extension
 *     never discards and an interrupted app may never come back; before this
 *     nothing ended such a session.
 *  2. Unsealed records untouched for the whole reservation window and held
 *     open by no live session (web captures abandoned mid-upload, intake
 *     reservations whose link closed) are released (RESERVATION_EXPIRED).
 *
 * Bounded per run; every claim is a conditional write, so concurrent sweeps
 * release each record once.
 */
export async function releaseExpiredReservations(
  options: { batchSize?: number; trigger?: string; deleteObject?: ReservationObjectDeleter; now?: Date } = {},
): Promise<ReleaseExpiredReservationsResult> {
  const trigger = options.trigger ?? "manual";
  const now = options.now ?? new Date();
  const batchSize = Math.max(1, Math.min(options.batchSize ?? DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE));
  const result: ReleaseExpiredReservationsResult = {
    sessionsExpired: 0,
    reservationsReleased: 0,
    objectDeletesRequested: 0,
    objectDeletesFailed: 0,
    failed: 0,
  };
  const released: string[] = [];
  const LIVE = [prismaPkg.CaptureSessionStatus.ACTIVE, prismaPkg.CaptureSessionStatus.INTERRUPTED];

  const sessions = await prisma.captureSession.findMany({
    where: { status: { in: LIVE }, expiresAtUtc: { not: null, lt: now } },
    orderBy: { expiresAtUtc: "asc" },
    take: batchSize,
    select: { id: true },
  });
  for (const s of sessions) {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`capture-session:${s.id}`}))`;
        const claim = await tx.captureSession.updateMany({
          where: { id: s.id, status: { in: LIVE }, expiresAtUtc: { lt: now } },
          data: { status: prismaPkg.CaptureSessionStatus.EXPIRED, endedAtUtc: now, endReason: "EXPIRED" },
        });
        if (claim.count !== 1) return;
        result.sessionsExpired++;
        const row = await tx.captureSession.findUnique({ where: { id: s.id }, select: { finalizedEvidenceId: true } });
        if (
          row?.finalizedEvidenceId &&
          (await releaseEvidenceReservationTx(tx, {
            evidenceId: row.finalizedEvidenceId,
            reason: "CAPTURE_SESSION_EXPIRED",
            now,
            captureSessionId: s.id,
          }))
        ) {
          result.reservationsReleased++;
          released.push(row.finalizedEvidenceId);
        }
      });
    } catch (err) {
      result.failed++;
      logger.warn({ captureSessionId: s.id, err, trigger }, "capture.reaper.session_expire_failed");
    }
  }

  const reservations = await prisma.evidence.findMany({
    where: expiredEvidenceReservationWhere(now),
    orderBy: { createdAt: "asc" },
    take: batchSize,
    select: { id: true },
  });
  for (const e of reservations) {
    try {
      const ok = await prisma.$transaction((tx) =>
        releaseEvidenceReservationTx(tx, { evidenceId: e.id, reason: "RESERVATION_EXPIRED", now }),
      );
      if (ok) {
        result.reservationsReleased++;
        released.push(e.id);
      }
    } catch (err) {
      result.failed++;
      logger.warn({ evidenceId: e.id, err, trigger }, "capture.reaper.reservation_release_failed");
    }
  }

  if (options.deleteObject && released.length > 0) {
    const [parts, records] = await Promise.all([
      prisma.evidencePart.findMany({
        where: { evidenceId: { in: released } },
        select: { storageBucket: true, storageKey: true },
      }),
      prisma.evidence.findMany({
        where: { id: { in: released }, storageKey: { not: null } },
        select: { storageBucket: true, storageKey: true },
      }),
    ]);
    const keys = new Map<string, { bucket: string; key: string }>();
    for (const o of [...parts, ...records]) {
      if (o.storageBucket && o.storageKey) keys.set(`${o.storageBucket}/${o.storageKey}`, { bucket: o.storageBucket, key: o.storageKey });
    }
    for (const o of keys.values()) {
      result.objectDeletesRequested++;
      try {
        await options.deleteObject(o);
      } catch {
        result.objectDeletesFailed++;
      }
    }
  }

  logger.info({ ...result, trigger }, "capture.reaper.reservations_completed");
  return result;
}
