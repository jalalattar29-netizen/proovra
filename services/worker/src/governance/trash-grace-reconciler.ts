/**
 * THE TRASH-GRACE RECONCILER — the producer that did not exist.
 *
 * The trash lifecycle had a beginning and an end and nothing in between. Moving
 * a record to trash stamped a 90-day deadline and enqueued a delayed purge job
 * bound to that one record. If the enqueue was lost, if Redis was flushed, if
 * the job was drained by a queue migration, or if the record was trashed by a
 * path that did not enqueue at all, nothing ever looked at that record again.
 * Its grace deadline passed in silence and it sat in the trash forever — a
 * workspace that believed its retention policy was being enforced was, for
 * those records, storing them indefinitely.
 *
 * A deadline in a column with no scanner is not a policy. This is the scanner.
 *
 * WHAT IT DOES, AND WHAT IT REFUSES TO DO
 * ---------------------------------------------------------------------------
 * It finds TRASHED records whose recovery grace has elapsed and evaluates each
 * one through the SAME authority the executor will use — so the reconciler can
 * never nominate a candidate the executor would then refuse, and the operator
 * report can never disagree with what actually happens.
 *
 * For each expired candidate:
 *
 *   - still retained, still Object-Locked, still held, still locked
 *       -> NOTHING. Not a retry, not a warning, not a state change. These are
 *          the ordinary case and they are not incidents.
 *   - approval required and absent
 *       -> ensure a destruction review exists, IDEMPOTENTLY, so a governance
 *          workspace sees the decision it needs to make instead of a record
 *          that quietly never goes anywhere.
 *   - fully eligible
 *       -> enqueue the canonical destruction execution.
 *
 * OBSERVE-ONLY BY DEFAULT
 * ---------------------------------------------------------------------------
 * The last bullet is gated by `AUTOMATIC_EVIDENCE_DESTRUCTION_ENABLED`, which
 * defaults to FALSE, and the default is the point. This pass is the first time
 * anything in this system has been able to correctly and automatically destroy
 * evidence; the previous implementations were wrong in ways that made them
 * safe by accident (two of them deleted nothing). Turning a newly-correct
 * irreversible pipeline loose on a production backlog that has been
 * accumulating under the broken one — where every record's real eligibility has
 * never been computed — would mean the first thing the fix does is delete
 * things nobody has looked at.
 *
 * So the pipeline is complete and observe-only: it reports exactly what it
 * WOULD destroy, the operator reads that report (the worker's
 * `destruction-candidates` script, which shares this module's evaluation), and
 * enabling the flag is a separate, deliberate act taken after that review.
 */

import { randomUUID } from "node:crypto";
import {
  evaluateDestructionCandidate,
  evaluateTrashExit,
  type EvidenceLifecycleBlockReason,
  type TrashExitEvaluation,
} from "@proovra/shared";
import {
  appendCustodyEventTx,
  readRequiredObjectRetention,
  resolveDestructionApproval,
  type EvidenceDestructionStoragePort,
  type RequiredObjectRetentionReading,
} from "@proovra/shared-runtime";

import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { evaluateEffectiveLegalHold } from "@proovra/shared-runtime";

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
  "PURGE_DELETED_EVIDENCE",
  "TRASH_GRACE_RECONCILER",
] as const;

// `enqueueEvidencePurgeJob` is imported LAZILY, at the one branch that enqueues.
//
// A static import pulls in `queue.js`, which pulls in the worker's `config.ts`,
// which validates the FULL runtime environment — Redis, and every S3 variable.
// That made the read-only candidate report refuse to start without object-store
// credentials, for a command that never touches storage and never enqueues
// anything. An operator running a non-mutating report against production should
// not have to put S3 secrets in their shell to do it, and requiring them is how
// a safety tool stops being run.

/** Bounded per tick — a sweep is not a migration. */
const DEFAULT_BATCH_SIZE = 200;
const MAX_BATCH_SIZE = 1000;

/**
 * The production safety gate for AUTOMATIC physical destruction.
 *
 * Read at call time, not at module load, so a test and an operator can both
 * change it without a restart being part of the contract.
 */
export function automaticDestructionEnabled(): boolean {
  return (
    String(process.env.AUTOMATIC_EVIDENCE_DESTRUCTION_ENABLED ?? "")
      .trim()
      .toLowerCase() === "true"
  );
}

export type TrashGraceDisposition =
  /** RETENTION ARCHIVE — left the Trash for the archive (a barrier remains). */
  | "RETENTION_ARCHIVED"
  /** RETENTION ARCHIVE — still archived; the barrier has not ended. */
  | "ARCHIVE_BARRIER_ACTIVE"
  | "ELIGIBLE_ENQUEUED"
  | "ELIGIBLE_OBSERVE_ONLY"
  | "APPROVAL_REQUESTED"
  | "APPROVAL_PENDING"
  | "BLOCKED";

export interface TrashGraceCandidate {
  evidenceId: string;
  teamId: string | null;
  trashGraceUntilUtc: string | null;
  destructionEligibleAtUtc: string | null;
  appRetentionUntilUtc: string | null;
  objectLockRetainUntilUtc: string | null;
  objectLockMode: string | null;
  legalHold: boolean;
  approvalRequired: boolean;
  approved: boolean;
  blockReason: EvidenceLifecycleBlockReason | null;
  /** RETENTION ARCHIVE — the barrier keeping the record, when there is one. */
  retentionBarrier: TrashExitEvaluation["barrier"];
  /** RETENTION ARCHIVE — how trustworthy the storage reading was. */
  storageRetentionTruth: RequiredObjectRetentionReading["truth"];
  disposition: TrashGraceDisposition;
}

export interface TrashGraceReconciliationResult {
  runId: string;
  scanned: number;
  eligible: number;
  enqueued: number;
  approvalRequested: number;
  blocked: number;
  /** RETENTION ARCHIVE — moved from Trash to the archive this run. */
  archived: number;
  observeOnly: boolean;
  candidates: TrashGraceCandidate[];
}

export interface TrashGraceReconciliationOptions {
  batchSize?: number;
  teamId?: string | null;
  now?: Date;
  /**
   * Never mutate anything, whatever the flag says. Used by the operator report,
   * which must be able to run in a workspace where automatic destruction IS
   * enabled without becoming the thing that triggers it.
   */
  dryRun?: boolean;
  trigger?: string;
  /**
   * The storage port the retention reading uses. Defaults to the worker's own
   * (loaded lazily, so a dry run without storage credentials still runs and
   * reports every record as STORAGE_UNAVAILABLE rather than guessing).
   */
  storage?: EvidenceDestructionStoragePort;
  /** Whether this deployment writes Object Lock retention (defaults to env). */
  objectLockExpected?: boolean;
}

/**
 * The columns the authority reads, and the tenancy needed to resolve holds.
 */
const CANDIDATE_SELECT = {
  id: true,
  teamId: true,
  lifecycleState: true,
  archivedAt: true,
  deletedAt: true,
  destroyedAtUtc: true,
  lockedAt: true,
  deleteScheduledForUtc: true,
  retentionUntilUtc: true,
  storageObjectLockMode: true,
  storageObjectLockRetainUntilUtc: true,
  activeDestructionReviewId: true,
  retentionBarrierState: true,
  caseLinks: { select: { caseId: true } },
} as const;

/** Re-read an archived record's storage retention at most this often. */
const ARCHIVE_REEVALUATE_MS = 24 * 60 * 60 * 1000;

const BARRIER_STATE: Readonly<Record<NonNullable<TrashExitEvaluation["barrier"]>, string>> = {
  LEGAL_HOLD: "LEGAL_HOLD",
  APP_RETENTION: "APP_RETENTION",
  OBJECT_RETENTION: "OBJECT_RETENTION",
  EVIDENCE_LOCKED: "EVIDENCE_LOCKED",
  METADATA_MISSING: "METADATA_MISSING",
  METADATA_INCONSISTENT: "METADATA_INCONSISTENT",
  STORAGE_UNAVAILABLE: "STORAGE_UNAVAILABLE",
};

function objectLockExpectedFromEnv(): boolean {
  return String(process.env.S3_OBJECT_LOCK_ENABLED ?? "").trim().toLowerCase() === "true";
}

async function resolveStoragePort(
  options: TrashGraceReconciliationOptions,
): Promise<EvidenceDestructionStoragePort | null> {
  if (options.storage) return options.storage;
  try {
    return (await import("./destruction-storage-port.js")).workerEvidenceDestructionStorage;
  } catch {
    return null;
  }
}

async function readRetention(
  evidenceId: string,
  storage: EvidenceDestructionStoragePort | null,
  objectLockExpected: boolean,
  now: Date,
): Promise<RequiredObjectRetentionReading> {
  if (!storage) {
    return { truth: "UNAVAILABLE", latestRequiredRetainUntil: null, legalHoldVersion: false, objectCount: 0, detail: "STORAGE_PORT_UNAVAILABLE" };
  }
  try {
    return await readRequiredObjectRetention(prisma, evidenceId, storage, { objectLockExpected, now });
  } catch {
    return { truth: "UNAVAILABLE", latestRequiredRetainUntil: null, legalHoldVersion: false, objectCount: 0, detail: "RETENTION_READ_FAILED" };
  }
}

/**
 * Raise the actionable condition for a storage reading that cannot be trusted.
 * One condition per record and cause (fingerprinted), never a purge.
 */
async function raiseRetentionUnverified(
  row: { id: string; teamId: string | null },
  reading: RequiredObjectRetentionReading,
): Promise<void> {
  const cause =
    reading.truth === "MISSING"
      ? "metadata_missing"
      : reading.truth === "INCONSISTENT"
        ? "metadata_inconsistent"
        : "storage_unavailable";
  try {
    const { recordWorkerIncident } = await import("./incident-emitter.js");
    await recordWorkerIncident({
      sourceId: "governance.retention_unverified",
      teamId: row.teamId,
      category: "GOVERNANCE",
      severity: reading.truth === "UNAVAILABLE" ? "WARNING" : "HIGH",
      fingerprint: `retention_unverified:${row.id}:${cause}`,
      relatedEvidenceId: row.id,
      message: { code: "ops.governance.retention_unverified", params: { evidenceId: row.id, cause } },
      metadata: { detail: reading.detail, objectCount: reading.objectCount },
    } as never);
  } catch (err) {
    logger.warn({ err, evidenceId: row.id }, "trash_grace.reconciler.retention_condition_failed");
  }
}

/**
 * TRASHED -> RETENTION_ARCHIVED, conditional on the record still being
 * TRASHED (a concurrent restore wins), with the custody event in the same
 * transaction. Nothing in storage is touched.
 */
async function moveToRetentionArchive(
  row: { id: string },
  exit: TrashExitEvaluation,
  reading: RequiredObjectRetentionReading,
  now: Date,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${row.id}))`;
    const moved = await tx.evidence.updateMany({
      where: { id: row.id, lifecycleState: "TRASHED" },
      data: {
        lifecycleState: "RETENTION_ARCHIVED",
        retentionArchivedAtUtc: now,
        latestRequiredRetainUntilUtc: reading.latestRequiredRetainUntil,
        purgeEligibleAtUtc: exit.purgeEligibleAt,
        retentionBarrierState: exit.barrier ? BARRIER_STATE[exit.barrier] : null,
        retentionBarrierEvaluatedAtUtc: now,
      },
    });
    if (moved.count !== 1) return false;
    await appendCustodyEventTx(tx, {
      evidenceId: row.id,
      eventType: "RETENTION_ARCHIVED",
      atUtc: now,
      payload: {
        reason: "RETENTION",
        barrier: exit.barrier,
        purgeEligibleAtUtc: exit.purgeEligibleAt ? exit.purgeEligibleAt.toISOString() : null,
        latestRequiredRetainUntilUtc: reading.latestRequiredRetainUntil
          ? reading.latestRequiredRetainUntil.toISOString()
          : null,
      },
    });
    return true;
  });
}

export const TRASH_GRACE_CURSOR_KEY = "trash_grace";

/** The cursor, or null (start from the oldest) — fail-open on a missing table. */
async function readSweepCursor(key: string): Promise<{ at: Date; id: string } | null> {
  try {
    const row = await prisma.workerSweepCursor.findUnique({ where: { key }, select: { cursorAt: true, cursorId: true } });
    return row?.cursorAt && row.cursorId ? { at: row.cursorAt, id: row.cursorId } : null;
  } catch {
    return null;
  }
}

async function writeSweepCursor(key: string, value: { at: Date; id: string } | null): Promise<void> {
  try {
    await prisma.workerSweepCursor.upsert({
      where: { key },
      create: { key, cursorAt: value?.at ?? null, cursorId: value?.id ?? null },
      update: { cursorAt: value?.at ?? null, cursorId: value?.id ?? null },
    });
  } catch {
    /* a cursor that cannot be written restarts from the oldest next tick */
  }
}

export async function runTrashGraceReconciliation(
  options: TrashGraceReconciliationOptions = {},
): Promise<TrashGraceReconciliationResult> {
  const now = options.now ?? new Date();
  const runId = randomUUID();
  const batchSize = Math.max(
    1,
    Math.min(options.batchSize ?? DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE),
  );
  const dryRun = options.dryRun === true;
  const observeOnly = dryRun || !automaticDestructionEnabled();

  // The scan. TRASHED is the state pointer, not a timestamp, so a DESTROYED
  // tombstone (which still carries `deleted_at` from its time in the trash)
  // cannot appear here — which is how the old purge job kept re-examining
  // records it had already finished with.
  // ET-Q-05 — a keyset cursor over (deleteScheduledForUtc, id), so a tick
  // continues past the rows the previous tick examined instead of re-reading
  // the same oldest batch forever once those rows are blocked. It wraps to the
  // start when a tick reaches the end. A team-scoped (manual) run and a dry
  // run neither read nor move the shared cursor.
  const useCursor = !options.teamId && !dryRun;
  const cursor = useCursor ? await readSweepCursor(TRASH_GRACE_CURSOR_KEY) : null;
  const rows = await prisma.evidence.findMany({
    where: {
      lifecycleState: "TRASHED",
      deleteScheduledForUtc: { lte: now },
      ...(options.teamId ? { teamId: options.teamId } : {}),
      ...(cursor
        ? {
            OR: [
              { deleteScheduledForUtc: { gt: cursor.at } },
              { deleteScheduledForUtc: cursor.at, id: { gt: cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ deleteScheduledForUtc: "asc" }, { id: "asc" }],
    take: batchSize,
    select: CANDIDATE_SELECT,
  });
  if (useCursor) {
    const last = rows[rows.length - 1];
    await writeSweepCursor(
      TRASH_GRACE_CURSOR_KEY,
      rows.length === batchSize && last?.deleteScheduledForUtc
        ? { at: last.deleteScheduledForUtc, id: last.id }
        : null, // reached the end: the next tick starts again from the oldest
    );
  }

  // RETENTION ARCHIVE — archived records whose earliest purge date has
  // arrived, whose barrier is not a dated one (a hold, unverified metadata),
  // or whose storage reading is stale. Bounded like the Trash scan.
  const reevaluateBefore = new Date(now.getTime() - ARCHIVE_REEVALUATE_MS);
  const archivedRows = await prisma.evidence.findMany({
    where: {
      lifecycleState: "RETENTION_ARCHIVED",
      ...(options.teamId ? { teamId: options.teamId } : {}),
      OR: [
        { purgeEligibleAtUtc: null },
        { purgeEligibleAtUtc: { lte: now } },
        { retentionBarrierEvaluatedAtUtc: null },
        { retentionBarrierEvaluatedAtUtc: { lt: reevaluateBefore } },
      ],
    },
    orderBy: [{ retentionBarrierEvaluatedAtUtc: { sort: "asc", nulls: "first" } }, { id: "asc" }],
    take: batchSize,
    select: CANDIDATE_SELECT,
  });

  const storage = await resolveStoragePort(options);
  const objectLockExpected = options.objectLockExpected ?? objectLockExpectedFromEnv();

  const candidates: TrashGraceCandidate[] = [];
  let enqueued = 0;
  let approvalRequested = 0;
  let blocked = 0;
  let eligible = 0;
  let archived = 0;

  for (const row of [...rows, ...archivedRows]) {
    // FAIL CLOSED on the hold lookup: an error means "held", which makes the
    // record blocked for this tick rather than a candidate for destruction.
    let legalHold = true;
    try {
      const verdict = await evaluateEffectiveLegalHold(prisma, {
        teamId: row.teamId ?? null,
        evidenceId: row.id,
        caseIds: (row.caseLinks ?? []).map((l) => l.caseId),
      });
      legalHold = verdict.held;
    } catch (err) {
      logger.warn(
        { err, evidenceId: row.id, runId },
        "trash_grace.reconciler.hold_lookup_failed",
      );
    }

    // THE STORAGE TRUTH (owner decision 2026-10-14): every required object
    // version's retain-until, read from storage. A failed or partial reading
    // is never permission to purge.
    const reading = await readRetention(row.id, storage, objectLockExpected, now);
    if (reading.truth !== "VERIFIED" && !dryRun) {
      await raiseRetentionUnverified({ id: row.id, teamId: row.teamId ?? null }, reading);
    }

    const approval = await resolveDestructionApproval(prisma, {
      evidenceId: row.id,
      teamId: row.teamId ?? null,
    });

    const lifecycleInput = {
      lifecycleState: row.lifecycleState,
      archivedAt: row.archivedAt,
      trashedAt: row.deletedAt,
      destroyedAt: row.destroyedAtUtc,
      lockedAt: row.lockedAt,
      trashGraceUntil: row.deleteScheduledForUtc,
      appRetentionUntil: row.retentionUntilUtc,
      objectLockRetainUntil: row.storageObjectLockRetainUntilUtc,
      objectLockMode: row.storageObjectLockMode,
      requiredObjectRetainUntil: reading.latestRequiredRetainUntil,
      storageRetentionTruth: reading.truth,
      legalHold: legalHold || reading.legalHoldVersion,
      destructionApprovalRequired: approval.required,
      destructionApproved: approval.approved,
    };
    // The barrier view is the same for both states: what still prevents purge.
    const exit = evaluateTrashExit(
      { ...lifecycleInput, lifecycleState: "TRASHED", trashedAt: row.deletedAt ?? now },
      now,
    );
    const verdict = evaluateDestructionCandidate(lifecycleInput, now);

    let disposition: TrashGraceDisposition;

    if (row.lifecycleState === "TRASHED" && exit.decision === "RETENTION_ARCHIVE") {
      // TRASH ENDED, A BARRIER REMAINS -> RETENTION ARCHIVE. Never deleted;
      // still self-service recoverable through the verified archive restore.
      if (!dryRun && (await moveToRetentionArchive(row, exit, reading, now))) archived += 1;
      disposition = "RETENTION_ARCHIVED";
    } else if (row.lifecycleState === "RETENTION_ARCHIVED" && !verdict.eligible) {
      if (!dryRun) {
        await prisma.evidence.updateMany({
          where: { id: row.id, lifecycleState: "RETENTION_ARCHIVED" },
          data: {
            latestRequiredRetainUntilUtc: reading.latestRequiredRetainUntil,
            purgeEligibleAtUtc: exit.purgeEligibleAt,
            retentionBarrierState: exit.barrier
              ? BARRIER_STATE[exit.barrier]
              : verdict.blockReason === "DESTRUCTION_APPROVAL_REQUIRED"
                ? "CLEAR"
                : (row.retentionBarrierState ?? null),
            retentionBarrierEvaluatedAtUtc: now,
          },
        });
      }
      if (verdict.blockReason === "DESTRUCTION_APPROVAL_REQUIRED") {
        if (row.activeDestructionReviewId || dryRun) {
          disposition = "APPROVAL_PENDING";
        } else {
          const created = await ensureDestructionReview(row.id, row.teamId, now, row.lifecycleState);
          if (created) approvalRequested += 1;
          disposition = created ? "APPROVAL_REQUESTED" : "APPROVAL_PENDING";
        }
      } else {
        blocked += 1;
        disposition = "ARCHIVE_BARRIER_ACTIVE";
      }
    } else if (verdict.eligible) {
      eligible += 1;
      if (observeOnly) {
        disposition = "ELIGIBLE_OBSERVE_ONLY";
      } else {
        // The enqueue is the ONLY mutation on this branch. The job is the
        // existing purge trigger, which now calls the canonical executor — so
        // the reconciler nominates and the executor decides, again, against a
        // freshly re-read row.
        const { enqueueEvidencePurgeJob } = await import("../queue.js");
        // ET-Q-05 — count what the queue actually accepted.
        const outcome = await enqueueEvidencePurgeJob(row.id, now.toISOString());
        if (outcome.enqueued) enqueued += 1;
        disposition = "ELIGIBLE_ENQUEUED";
      }
    } else if (verdict.blockReason === "DESTRUCTION_APPROVAL_REQUIRED") {
      // The one branch that creates governance work. Idempotent by the
      // `activeDestructionReviewId` pointer: a record that already has an open
      // review is left alone rather than accumulating one review per tick.
      //
      // GATED BY `dryRun` ONLY — deliberately NOT by the destruction flag.
      // Opening a review destroys nothing; it is the opposite, surfacing a
      // decision to a person. Gating it behind
      // AUTOMATIC_EVIDENCE_DESTRUCTION_ENABLED would mean that in the shipping
      // default the reconciler does nothing at all for exactly the records that
      // most need an operator to look at them, which is the backlog the flag
      // exists to have reviewed in the first place.
      if (row.activeDestructionReviewId || dryRun) {
        disposition = "APPROVAL_PENDING";
      } else {
        const created = await ensureDestructionReview(row.id, row.teamId, now, row.lifecycleState);
        if (created) approvalRequested += 1;
        disposition = created ? "APPROVAL_REQUESTED" : "APPROVAL_PENDING";
      }
    } else {
      // Retention, Object Lock, a hold, a lock, or a grace window that has not
      // actually elapsed. Nothing to do and nothing to report as a problem.
      blocked += 1;
      disposition = "BLOCKED";
    }

    candidates.push({
      evidenceId: row.id,
      teamId: row.teamId ?? null,
      trashGraceUntilUtc: verdict.trashGraceUntil?.toISOString() ?? null,
      destructionEligibleAtUtc:
        verdict.destructionEligibleAt?.toISOString() ?? null,
      appRetentionUntilUtc: row.retentionUntilUtc?.toISOString() ?? null,
      objectLockRetainUntilUtc:
        verdict.objectLockRetainUntil?.toISOString() ?? null,
      objectLockMode: row.storageObjectLockMode ?? null,
      legalHold,
      approvalRequired: approval.required,
      approved: approval.approved,
      blockReason: verdict.blockReason,
      retentionBarrier: exit.barrier,
      storageRetentionTruth: reading.truth,
      disposition,
    });
  }

  logger.info(
    {
      runId,
      trigger: options.trigger ?? "manual",
      scanned: rows.length + archivedRows.length,
      eligible,
      enqueued,
      approvalRequested,
      blocked,
      archived,
      observeOnly,
    },
    observeOnly
      ? "trash_grace.reconciler.completed_observe_only"
      : "trash_grace.reconciler.completed",
  );

  return {
    runId,
    scanned: rows.length + archivedRows.length,
    eligible,
    enqueued,
    approvalRequested,
    blocked,
    archived,
    observeOnly,
    candidates,
  };
}

/**
 * Open a destruction review for a record whose workspace requires approval,
 * once.
 *
 * The write is conditional on the record still having NO active review, so two
 * replicas reconciling the same tick produce one review rather than two. It
 * writes the review and the pointer in one transaction: a review with no
 * pointer would be invisible to the record, and a pointer with no review would
 * make the record permanently un-nominatable.
 */
async function ensureDestructionReview(
  evidenceId: string,
  teamId: string | null,
  now: Date,
  fromState: "TRASHED" | "RETENTION_ARCHIVED" | string = "TRASHED",
): Promise<boolean> {
  if (!teamId) return false;
  try {
    return await prisma.$transaction(async (tx) => {
      const claim = await tx.evidence.updateMany({
        where: { id: evidenceId, activeDestructionReviewId: null },
        data: {},
      });
      if (claim.count !== 1) return false;

      const existing = await tx.destructionReview.findFirst({
        where: {
          evidenceId,
          teamId,
          status: { in: ["PENDING", "UNDER_REVIEW", "DEFERRED", "APPROVED"] },
        },
        select: { id: true },
      });
      if (existing) {
        await tx.evidence.update({
          where: { id: evidenceId },
          data: { activeDestructionReviewId: existing.id },
        });
        return false;
      }

      const review = await tx.destructionReview.create({
        data: {
          teamId,
          evidenceId,
          status: "PENDING",
          reason: "RETENTION_EXPIRED",
        },
        select: { id: true },
      });
      await tx.evidence.update({
        where: { id: evidenceId },
        data: { activeDestructionReviewId: review.id },
      });
      await tx.evidenceLifecycleEvent.create({
        data: {
          teamId,
          evidenceId,
          fromState: fromState as "TRASHED",
          toState: fromState as "TRASHED",
          eventType: "destruction_review_created",
          summary:
            "Trash recovery period elapsed; destruction review opened for approval",
          metadata: {
            openedBy: "trash_grace_reconciler",
            openedAtUtc: now.toISOString(),
          },
        },
      });
      return true;
    });
  } catch (err) {
    logger.warn(
      { err, evidenceId },
      "trash_grace.reconciler.review_creation_failed",
    );
    return false;
  }
}
