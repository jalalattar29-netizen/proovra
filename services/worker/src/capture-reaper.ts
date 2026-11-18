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
  EVIDENCE_RESERVATION_TTL_MS,
  expiredEvidenceReservationWhere,
  releaseEvidenceReservationTx,
  reservationHoldsStagedContentTx,
  runGovernanceReconciliation,
} from "@proovra/shared-runtime";
import { CAPTURE_SEAL_CLAIM } from "@proovra/shared";

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
  /** Rows a previous page of THIS run could not process; skipped so paging moves on. */
  excludeIds?: readonly string[];
}

export interface ReapExpiredCaptureDraftsResult {
  scanned: number;
  expired: number;
  failed: number;
  skipped: number;
  /** The rows that threw, so the caller can page past them. */
  failedIds: string[];
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
      ...(options.excludeIds?.length ? { id: { notIn: [...options.excludeIds] } } : {}),
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
  const failedIds: string[] = [];

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
      failedIds.push(draft.id);
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
    failedIds,
  };
}

// =============================================================================
// ET-DC-05 / ET-ACQ-02 — expired direct-capture sessions and reservations.
// =============================================================================

export interface ReleaseExpiredReservationsResult {
  sessionsExpired: number;
  reservationsReleased: number;
  objectDeletesRequested: number;
  /** Object versions a post-delete listing proved removed (AUD-028). */
  objectVersionsDeleted: number;
  /** Objects whose versions retention or a legal hold kept — never attempted, never counted removed. */
  objectsRetained: number;
  objectDeletesFailed: number;
  failed: number;
  /** Rows selected by this pass (sessions + reservations). */
  scanned: number;
  /** The rows that threw, so the caller can page past them. */
  failedIds: string[];
  /** UC-STR-002 — seal claims whose lease expired (crashed seals), released. */
  staleSealClaimsReleased: number;
  /**
   * C-13 — sessions whose record is SEALED but whose bind never ran, kept
   * (ACTIVE, expiry moved to their maximum lifetime) for the client bind retry.
   */
  sealedUnboundKept: number;
  /** C-13 — such sessions past their maximum lifetime, closed (record untouched). */
  sealedUnboundClosed: number;
  /**
   * B4-F-004 (free audit 0ea0) — objects of released reservations whose delete
   * failed in this pass (a retried one included). The run records them and the
   * next run retries them, until a delete reports them gone or retained.
   */
  pendingObjectDeletes: Array<{ bucket: string; key: string }>;
}

/** B4-F-004 — the run metadata key that carries pending object deletes forward. */
export const PENDING_OBJECT_DELETES_METADATA_KEY = "pendingObjectDeletes";
/** B4-F-004 — at most this many pending deletes are carried from run to run. */
export const MAX_PENDING_OBJECT_DELETES = 1000;

function parsePendingObjectDeletes(value: unknown): Array<{ bucket: string; key: string }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ bucket: string; key: string }> = [];
  for (const v of value) {
    const o = v as { bucket?: unknown; key?: unknown } | null;
    if (o && typeof o.bucket === "string" && typeof o.key === "string" && o.bucket && o.key) {
      out.push({ bucket: o.bucket, key: o.key });
    }
    if (out.length >= MAX_PENDING_OBJECT_DELETES) break;
  }
  return out;
}

/**
 * B4-F-004 — of the carried keys, only those still owned by released,
 * never-sealed records (or by no record) may be deleted. A key a live or
 * sealed record references is never touched, whatever the carried list says.
 */
async function releasedObjectKeysOnly(
  objects: Array<{ bucket: string; key: string }>,
): Promise<Array<{ bucket: string; key: string }>> {
  if (objects.length === 0) return [];
  const keys = [...new Set(objects.map((o) => o.key))];
  const UNSEALED = [prismaPkg.EvidenceStatus.CREATED, prismaPkg.EvidenceStatus.UPLOADING];
  const releasedRecord = { deletedAt: { not: null }, status: { in: UNSEALED } };
  const [liveParts, liveRecords] = await Promise.all([
    prisma.evidencePart.findMany({
      where: { storageKey: { in: keys }, NOT: { evidence: releasedRecord } },
      select: { storageBucket: true, storageKey: true },
    }),
    prisma.evidence.findMany({
      where: { storageKey: { in: keys }, NOT: releasedRecord },
      select: { storageBucket: true, storageKey: true },
    }),
  ]);
  const protectedKeys = new Set([...liveParts, ...liveRecords].map((o) => `${o.storageBucket}/${o.storageKey}`));
  return objects.filter((o) => !protectedKeys.has(`${o.bucket}/${o.key}`));
}

/**
 * Removes the storage objects of released reservations. Best-effort and after
 * commit: the release is the record's truth. Version-aware (AUD-028): every
 * version is removed by its VersionId, a version under retention or legal hold
 * is RETAINED (never attempted) and reported as such, and only versions a
 * post-delete listing proves gone are counted. A key-only delete used to add a
 * delete marker over a locked version and count it deleted.
 */
export type ReservationObjectDeleter = (p: { bucket: string; key: string }) => Promise<{
  deleted: boolean;
  deletedVersions: number;
  retainedVersions: number;
  deleteMarkerOnly: boolean;
  failed: number;
}>;

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
  options: {
    batchSize?: number;
    trigger?: string;
    deleteObject?: ReservationObjectDeleter;
    now?: Date;
    /** Rows a previous page of THIS run could not process; skipped so paging moves on. */
    excludeIds?: readonly string[];
    /** B4-F-004 — objects whose delete failed in an earlier run, retried first. */
    retryObjectDeletes?: ReadonlyArray<{ bucket: string; key: string }>;
  } = {},
): Promise<ReleaseExpiredReservationsResult> {
  const trigger = options.trigger ?? "manual";
  const now = options.now ?? new Date();
  const batchSize = Math.max(1, Math.min(options.batchSize ?? DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE));
  const result: ReleaseExpiredReservationsResult = {
    sessionsExpired: 0,
    reservationsReleased: 0,
    objectDeletesRequested: 0,
    objectVersionsDeleted: 0,
    objectsRetained: 0,
    objectDeletesFailed: 0,
    failed: 0,
    scanned: 0,
    failedIds: [],
    staleSealClaimsReleased: 0,
    sealedUnboundKept: 0,
    sealedUnboundClosed: 0,
    pendingObjectDeletes: [],
  };
  const exclude = options.excludeIds?.length ? { id: { notIn: [...options.excludeIds] } } : {};
  const released: string[] = [];
  const LIVE = [prismaPkg.CaptureSessionStatus.ACTIVE, prismaPkg.CaptureSessionStatus.INTERRUPTED];

  // UC-STR-002 — a STALE seal claim (a seal that crashed between its claim and
  // its bind) is released after its lease, so the session can be sealed again
  // or discarded. A LIVE claim is a seal hashing right now: never touched.
  const staleClaimBefore = new Date(now.getTime() - CAPTURE_SEAL_CLAIM.leaseMs);
  const notLiveSealClaim = [
    { endReason: null },
    { endReason: { not: CAPTURE_SEAL_CLAIM.endReason } },
    { updatedAt: { lt: staleClaimBefore } },
  ];
  const releasedClaims = await prisma.captureSession.updateMany({
    where: {
      status: prismaPkg.CaptureSessionStatus.ACTIVE,
      endReason: CAPTURE_SEAL_CLAIM.endReason,
      updatedAt: { lt: staleClaimBefore },
    },
    data: { endReason: null },
  });
  result.staleSealClaimsReleased = releasedClaims.count;

  const sessions = await prisma.captureSession.findMany({
    where: {
      status: { in: LIVE },
      expiresAtUtc: { not: null, lt: now },
      // A session a seal is hashing is not expired under it (NULL-safe: an
      // ordinary ACTIVE session has a NULL end reason).
      OR: notLiveSealClaim,
      ...exclude,
    },
    orderBy: { expiresAtUtc: "asc" },
    take: batchSize,
    select: { id: true },
  });
  result.scanned += sessions.length;
  for (const s of sessions) {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`capture-session:${s.id}`}))`;
        // F-23 (independent forward audit) — a session whose record is already
        // SEALED is never expired: its seal committed (a seal that outlived its
        // claim lease), only the bind is missing, and the retry binds it.
        // Expiring it made the sealed record permanently unbindable.
        const reserved = await tx.captureSession.findUnique({
          where: { id: s.id },
          select: { finalizedEvidenceId: true, status: true, startedAtUtc: true, createdAt: true },
        });
        if (reserved?.finalizedEvidenceId) {
          const record = await tx.evidence.findUnique({
            where: { id: reserved.finalizedEvidenceId },
            select: { status: true, deletedAt: true },
          });
          const maxEnd = new Date((reserved.startedAtUtc ?? reserved.createdAt).getTime() + EVIDENCE_RESERVATION_TTL_MS);
          if (record?.status === prismaPkg.EvidenceStatus.SIGNED || record?.status === prismaPkg.EvidenceStatus.REPORTED) {
            // C-13 (Free-user audit of 4d9b78963) — returning here left the
            // session ACTIVE with its expiry in the past, so EVERY pass selected
            // it again at the head of the page (oldest expiry first): enough of
            // them filled every page and genuinely expired sessions behind them
            // were never reached. Nothing re-drove the bind but a client retry.
            // Now, within the session's maximum lifetime it stays ACTIVE for that
            // retry (completeDirectCapture binds a sealed record: no second
            // seal, no second charge) with its expiry moved to that maximum, so
            // it is not reselected; past it — or INTERRUPTED, which can never
            // bind — the session is closed EXPIRED with end reason
            // SEALED_UNBOUND. The sealed record, its objects and its custody are
            // never touched: no reservation release, nothing deleted.
            if (reserved.status === prismaPkg.CaptureSessionStatus.ACTIVE && maxEnd.getTime() > now.getTime()) {
              const kept = await tx.captureSession.updateMany({
                where: { id: s.id, status: prismaPkg.CaptureSessionStatus.ACTIVE, expiresAtUtc: { lt: now }, OR: notLiveSealClaim },
                data: { expiresAtUtc: maxEnd },
              });
              if (kept.count === 1) {
                result.sealedUnboundKept++;
                logger.info(
                  { captureSessionId: s.id, evidenceId: reserved.finalizedEvidenceId, keptUntil: maxEnd.toISOString(), trigger },
                  "capture.reaper.session_kept_sealed_unbound",
                );
              }
              return;
            }
            const closed = await tx.captureSession.updateMany({
              where: { id: s.id, status: { in: LIVE }, expiresAtUtc: { lt: now }, OR: notLiveSealClaim },
              data: { status: prismaPkg.CaptureSessionStatus.EXPIRED, endedAtUtc: now, endReason: "SEALED_UNBOUND" },
            });
            if (closed.count === 1) {
              result.sealedUnboundClosed++;
              logger.warn(
                { captureSessionId: s.id, evidenceId: reserved.finalizedEvidenceId, trigger },
                "capture.reaper.session_closed_sealed_unbound",
              );
            }
            return;
          }
          // C-02 — an idle session whose record already holds staged parts is
          // not released at its one-hour idle expiry: the mobile app deletes
          // its device copies once the parts are staged, so releasing the
          // record (and deleting its objects) destroyed the capture. The
          // session is kept to its maximum lifetime (24 h from its start, the
          // reservation window — MAX_SESSION_LIFETIME_SECONDS in the API) and
          // is expired and released by a later pass once that has passed.
          // Only an ACTIVE session can still be sealed; an INTERRUPTED one has
          // no way back, so it is ended and released as before (AUD-0065).
          if (
            reserved.status === prismaPkg.CaptureSessionStatus.ACTIVE &&
            maxEnd.getTime() > now.getTime() &&
            record &&
            !record.deletedAt &&
            (record.status === prismaPkg.EvidenceStatus.CREATED || record.status === prismaPkg.EvidenceStatus.UPLOADING) &&
            (await reservationHoldsStagedContentTx(tx, reserved.finalizedEvidenceId))
          ) {
            const kept = await tx.captureSession.updateMany({
              where: { id: s.id, status: prismaPkg.CaptureSessionStatus.ACTIVE, expiresAtUtc: { lt: now }, OR: notLiveSealClaim },
              data: { expiresAtUtc: maxEnd },
            });
            if (kept.count === 1) {
              logger.info(
                { captureSessionId: s.id, evidenceId: reserved.finalizedEvidenceId, keptUntil: maxEnd.toISOString(), trigger },
                "capture.reaper.session_kept_staged_parts",
              );
            }
            return;
          }
        }
        const claim = await tx.captureSession.updateMany({
          where: {
            id: s.id,
            status: { in: LIVE },
            expiresAtUtc: { lt: now },
            OR: notLiveSealClaim,
          },
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
      result.failedIds.push(s.id);
      logger.warn({ captureSessionId: s.id, err, trigger }, "capture.reaper.session_expire_failed");
    }
  }

  const reservations = await prisma.evidence.findMany({
    where: { AND: [expiredEvidenceReservationWhere(now), exclude] },
    orderBy: { createdAt: "asc" },
    take: batchSize,
    select: { id: true },
  });
  result.scanned += reservations.length;
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
      result.failedIds.push(e.id);
      logger.warn({ evidenceId: e.id, err, trigger }, "capture.reaper.reservation_release_failed");
    }
  }

  // B4-F-004 (free audit 0ea0) — object deletion is no longer coupled to the
  // run that released the record. A delete that failed in an earlier run is
  // retried here (the run carries it forward in its metadata) until it
  // reports the object gone or retained; a key still owned by a live or sealed
  // record is never touched.
  const keys = new Map<string, { bucket: string; key: string }>();
  if (options.deleteObject && options.retryObjectDeletes?.length) {
    for (const o of await releasedObjectKeysOnly([...options.retryObjectDeletes])) {
      keys.set(`${o.bucket}/${o.key}`, o);
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
    for (const o of [...parts, ...records]) {
      if (o.storageBucket && o.storageKey) keys.set(`${o.storageBucket}/${o.storageKey}`, { bucket: o.storageBucket, key: o.storageKey });
    }
  }
  if (options.deleteObject) {
    for (const o of keys.values()) {
      result.objectDeletesRequested++;
      try {
        const removal = await options.deleteObject(o);
        result.objectVersionsDeleted += removal.deletedVersions;
        if (removal.retainedVersions > 0) result.objectsRetained++;
        if (removal.failed > 0) {
          result.objectDeletesFailed++;
          result.pendingObjectDeletes.push(o);
        }
      } catch {
        result.objectDeletesFailed++;
        result.pendingObjectDeletes.push(o);
      }
    }
  }

  logger.info({ ...result, trigger }, "capture.reaper.reservations_completed");
  return result;
}

// =============================================================================
// PRO-C1C-01 / PRO-C1-03 — RELEASED RESERVATIONS GIVE THEIR BYTES BACK.
// =============================================================================

/** A released reservation is swept only after this grace: a presigned PUT issued just before the release may still land. */
export const RELEASED_OBJECTS_GRACE_MS = 60 * 60 * 1000;

export type ReleasedObjectSweepResult = {
  scanned: number;
  swept: number;
  objectDeletesRequested: number;
  objectVersionsDeleted: number;
  objectsRetained: number;
  objectDeletesFailed: number;
  failed: number;
  pendingObjectDeletes: Array<{ bucket: string; key: string }>;
};

/**
 * A reservation released by the API (a discard, a changed selection, a
 * workspace change, a direct-capture discard) is a soft delete: its record
 * keeps lifecycleState ACTIVE, so neither trash-grace nor the destruction
 * prefix sweep ever reaches it, and the reservation sweep above deleted only
 * the objects of records IT released. Their uploaded bytes stayed, unmetered.
 *
 * Object removal is now a property of the released record, whoever released
 * it: every unsealed record with deletedAt set (older than the grace) whose
 * objects were not yet removed has its part objects, its own object and every
 * key under its own evidence/<id>/ prefix (the resumable door's assembled
 * session object included, PRO-C1-03) deleted through the version-aware
 * deleter. A key a live or sealed record references is never touched; a
 * version under retention or a legal hold is retained and reported. The record
 * is stamped releasedObjectsRemovedAtUtc once; a failed delete is carried
 * forward by the existing pendingObjectDeletes carrier.
 */
export async function removeReleasedReservationObjects(options: {
  deleteObject: ReservationObjectDeleter;
  listKeys?: (p: { bucket: string; prefix: string }) => Promise<string[]>;
  bucket?: string | null;
  batchSize?: number;
  now?: Date;
}): Promise<ReleasedObjectSweepResult> {
  const now = options.now ?? new Date();
  const batchSize = Math.max(1, Math.min(options.batchSize ?? DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE));
  const result: ReleasedObjectSweepResult = {
    scanned: 0,
    swept: 0,
    objectDeletesRequested: 0,
    objectVersionsDeleted: 0,
    objectsRetained: 0,
    objectDeletesFailed: 0,
    failed: 0,
    pendingObjectDeletes: [],
  };
  const UNSEALED = [prismaPkg.EvidenceStatus.CREATED, prismaPkg.EvidenceStatus.UPLOADING];
  const records = await prisma.evidence.findMany({
    where: {
      status: { in: UNSEALED },
      deletedAt: { not: null, lt: new Date(now.getTime() - RELEASED_OBJECTS_GRACE_MS) },
      lifecycleState: "ACTIVE",
      releasedObjectsRemovedAtUtc: null,
    },
    orderBy: { deletedAt: "asc" },
    take: batchSize,
    select: { id: true, storageBucket: true, storageKey: true },
  });
  result.scanned = records.length;
  for (const record of records) {
    try {
      const keys = new Map<string, { bucket: string; key: string }>();
      const add = (bucket: string | null | undefined, key: string | null | undefined) => {
        if (bucket && key) keys.set(`${bucket}/${key}`, { bucket, key });
      };
      add(record.storageBucket, record.storageKey);
      const parts = await prisma.evidencePart.findMany({
        where: { evidenceId: record.id },
        select: { storageBucket: true, storageKey: true },
      });
      for (const p of parts) add(p.storageBucket, p.storageKey);
      const bucket = record.storageBucket ?? options.bucket ?? null;
      if (options.listKeys && bucket) {
        for (const key of await options.listKeys({ bucket, prefix: `evidence/${record.id}/` })) add(bucket, key);
      }
      for (const o of await releasedObjectKeysOnly([...keys.values()])) {
        result.objectDeletesRequested++;
        try {
          const removal = await options.deleteObject(o);
          result.objectVersionsDeleted += removal.deletedVersions;
          if (removal.retainedVersions > 0) result.objectsRetained++;
          if (removal.failed > 0) {
            result.objectDeletesFailed++;
            result.pendingObjectDeletes.push(o);
          }
        } catch {
          result.objectDeletesFailed++;
          result.pendingObjectDeletes.push(o);
        }
      }
      // Stamped once; anything that failed is carried forward, not re-listed.
      const stamped = await prisma.evidence.updateMany({
        where: { id: record.id, deletedAt: { not: null }, status: { in: UNSEALED }, releasedObjectsRemovedAtUtc: null },
        data: { releasedObjectsRemovedAtUtc: now },
      });
      if (stamped.count === 1) result.swept++;
    } catch (err) {
      result.failed++;
      logger.warn({ evidenceId: record.id, err }, "capture.reaper.released_objects_failed");
    }
  }
  return result;
}

// =============================================================================
// THE ONE REAPER RUN (2026-09-30) — recorded, paged, observable.
// =============================================================================

/** Pages one run may take per pass. A larger backlog drains over the following ticks. */
export const CAPTURE_REAPER_MAX_PAGES = 20;

export interface CaptureReaperSweepResult {
  runId: string | null;
  status: string;
  pages: number;
  draftsExpired: number;
  sessionsExpired: number;
  reservationsReleased: number;
  failed: number;
}

/**
 * The worker reaper is the ONLY authority that expires abandoned capture
 * drafts and releases abandoned evidence reservations (the API sweep was
 * retired, ET-SEC-24). It ran on a bare timer: each pass took one page of 100,
 * swallowed its own failure and recorded nothing, so a stopped, disabled or
 * always-failing reaper was indistinguishable from a healthy one.
 *
 * This is the run the scheduler calls:
 *
 *   - RECORDED under the reconciliation-run authority (kind CAPTURE_REAPER):
 *     one run at a time across workers, a lease a crashed run frees, and a
 *     SUCCEEDED / PARTIAL / FAILED row per tick. readScheduledSweepHealth
 *     reads last-run, last-success and failure from those rows — from outside
 *     the worker, because a stopped sweep cannot report its own silence.
 *   - PAGED: each pass repeats, oldest first, until a page comes back short,
 *     up to CAPTURE_REAPER_MAX_PAGES. Rows that threw are excluded from the
 *     next page, so a poison row at the head cannot stop the rows behind it
 *     from being reached.
 *   - IDEMPOTENT: every expiry and release is a conditional claim on the row,
 *     so an overlapping or repeated run releases each record once.
 *   - RECOVERABLE without a queue: what is expired is a fact in the database,
 *     so a tick that never ran is made up by the next one.
 *
 * A failure of the run itself is NOT swallowed here: it fails the run row and
 * is rethrown to the scheduler, which logs and reports it.
 */
/** B4-F-004 — the pending deletes the latest earlier CAPTURE_REAPER run recorded. */
async function readPendingObjectDeletes(currentRunId: string): Promise<Array<{ bucket: string; key: string }>> {
  const previous = await prisma.governanceReconciliationRun.findFirst({
    where: {
      kind: prismaPkg.GovernanceReconciliationKind.CAPTURE_REAPER,
      id: { not: currentRunId },
      finishedAtUtc: { not: null },
    },
    orderBy: { startedAtUtc: "desc" },
    select: { metadata: true },
  });
  const metadata = previous?.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  return parsePendingObjectDeletes((metadata as Record<string, unknown>)[PENDING_OBJECT_DELETES_METADATA_KEY]);
}

export async function runCaptureReaperSweep(
  options: {
    trigger?: string;
    batchSize?: number;
    deleteObject?: ReservationObjectDeleter;
    /** PRO-C1C-01 — lists a released record's own prefix (the multipart session key included). */
    listKeys?: (p: { bucket: string; prefix: string }) => Promise<string[]>;
    bucket?: string | null;
    now?: Date;
  } = {},
): Promise<CaptureReaperSweepResult> {
  const trigger = options.trigger ?? "manual";
  const batchSize = Math.max(1, Math.min(options.batchSize ?? DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE));
  const tally = { pages: 0, draftsExpired: 0, sessionsExpired: 0, reservationsReleased: 0, failed: 0 };

  const run = await runGovernanceReconciliation(prisma, {
    kind: prismaPkg.GovernanceReconciliationKind.CAPTURE_REAPER,
    trigger,
    body: async (ctx) => {
      const failedDrafts: string[] = [];
      for (let page = 0; page < CAPTURE_REAPER_MAX_PAGES; page++) {
        const res = await reapExpiredCaptureDrafts({ trigger, batchSize, excludeIds: failedDrafts });
        tally.pages++;
        tally.draftsExpired += res.expired;
        tally.failed += res.failed;
        failedDrafts.push(...res.failedIds);
        ctx.reportProgress({ scanned: res.scanned, created: res.expired, skipped: res.skipped, failed: res.failed });
        if (res.scanned < batchSize) break;
      }

      // B4-F-004 — the deletes the previous run could not complete. Recorded
      // on THIS run at once too, so a run that fails midway still carries
      // them forward.
      // A run without a deleter (a manual check) passes the list on unchanged.
      const carried = await readPendingObjectDeletes(ctx.runId);
      ctx.setMetadata(PENDING_OBJECT_DELETES_METADATA_KEY, carried);
      const pending: Array<{ bucket: string; key: string }> = [];

      const failedReservations: string[] = [];
      for (let page = 0; page < CAPTURE_REAPER_MAX_PAGES; page++) {
        const res = await releaseExpiredReservations({
          trigger,
          batchSize,
          deleteObject: options.deleteObject,
          now: options.now,
          excludeIds: failedReservations,
          ...(page === 0 ? { retryObjectDeletes: carried } : {}),
        });
        pending.push(...res.pendingObjectDeletes);
        if (options.deleteObject) {
          ctx.setMetadata(PENDING_OBJECT_DELETES_METADATA_KEY, pending.slice(0, MAX_PENDING_OBJECT_DELETES));
        }
        tally.pages++;
        tally.sessionsExpired += res.sessionsExpired;
        tally.reservationsReleased += res.reservationsReleased;
        tally.failed += res.failed;
        failedReservations.push(...res.failedIds);
        ctx.reportProgress({
          scanned: res.scanned,
          created: res.sessionsExpired + res.reservationsReleased,
          failed: res.failed,
        });
        // Two populations share the page size; stop only when neither filled it.
        if (res.scanned < batchSize) break;
      }
      // PRO-C1C-01 — the objects of every released, never-sealed reservation.
      if (options.deleteObject) {
        const swept = await removeReleasedReservationObjects({
          deleteObject: options.deleteObject,
          listKeys: options.listKeys,
          bucket: options.bucket ?? null,
          batchSize,
          now: options.now,
        });
        pending.push(...swept.pendingObjectDeletes);
        ctx.setMetadata(PENDING_OBJECT_DELETES_METADATA_KEY, pending.slice(0, MAX_PENDING_OBJECT_DELETES));
        ctx.setMetadata("releasedObjectsSwept", swept.swept);
        tally.failed += swept.failed;
      }
      ctx.setMetadata("pages", tally.pages);
      ctx.setMetadata("draftsExpired", tally.draftsExpired);
      ctx.setMetadata("sessionsExpired", tally.sessionsExpired);
      ctx.setMetadata("reservationsReleased", tally.reservationsReleased);
      return tally;
    },
  });

  if (run.error) throw run.error;
  return { runId: run.runId || null, status: String(run.status), ...tally };
}
