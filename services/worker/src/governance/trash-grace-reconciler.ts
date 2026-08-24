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
  type EvidenceLifecycleBlockReason,
} from "@proovra/shared";
import { resolveDestructionApproval } from "@proovra/shared-runtime";

import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { evaluateEffectiveLegalHold } from "./effective-legal-hold.js";
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
  disposition: TrashGraceDisposition;
}

export interface TrashGraceReconciliationResult {
  runId: string;
  scanned: number;
  eligible: number;
  enqueued: number;
  approvalRequested: number;
  blocked: number;
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
  caseLinks: { select: { caseId: true } },
} as const;

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
  const rows = await prisma.evidence.findMany({
    where: {
      lifecycleState: "TRASHED",
      deleteScheduledForUtc: { lte: now },
      ...(options.teamId ? { teamId: options.teamId } : {}),
    },
    orderBy: { deleteScheduledForUtc: "asc" },
    take: batchSize,
    select: CANDIDATE_SELECT,
  });

  const candidates: TrashGraceCandidate[] = [];
  let enqueued = 0;
  let approvalRequested = 0;
  let blocked = 0;
  let eligible = 0;

  for (const row of rows) {
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

    const approval = await resolveDestructionApproval(prisma, {
      evidenceId: row.id,
      teamId: row.teamId ?? null,
    });

    const verdict = evaluateDestructionCandidate(
      {
        lifecycleState: row.lifecycleState,
        archivedAt: row.archivedAt,
        trashedAt: row.deletedAt,
        destroyedAt: row.destroyedAtUtc,
        lockedAt: row.lockedAt,
        trashGraceUntil: row.deleteScheduledForUtc,
        appRetentionUntil: row.retentionUntilUtc,
        objectLockRetainUntil: row.storageObjectLockRetainUntilUtc,
        objectLockMode: row.storageObjectLockMode,
        legalHold,
        destructionApprovalRequired: approval.required,
        destructionApproved: approval.approved,
      },
      now,
    );

    let disposition: TrashGraceDisposition;

    if (verdict.eligible) {
      eligible += 1;
      if (observeOnly) {
        disposition = "ELIGIBLE_OBSERVE_ONLY";
      } else {
        // The enqueue is the ONLY mutation on this branch. The job is the
        // existing purge trigger, which now calls the canonical executor — so
        // the reconciler nominates and the executor decides, again, against a
        // freshly re-read row.
        const { enqueueEvidencePurgeJob } = await import("../queue.js");
        await enqueueEvidencePurgeJob(row.id, now.toISOString());
        enqueued += 1;
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
        const created = await ensureDestructionReview(row.id, row.teamId, now);
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
      disposition,
    });
  }

  logger.info(
    {
      runId,
      trigger: options.trigger ?? "manual",
      scanned: rows.length,
      eligible,
      enqueued,
      approvalRequested,
      blocked,
      observeOnly,
    },
    observeOnly
      ? "trash_grace.reconciler.completed_observe_only"
      : "trash_grace.reconciler.completed",
  );

  return {
    runId,
    scanned: rows.length,
    eligible,
    enqueued,
    approvalRequested,
    blocked,
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
          fromState: "TRASHED",
          toState: "TRASHED",
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
