/**
 * THREE PRODUCT DECISIONS — the owner-run BACKFILL (2026-10-14).
 *
 *   tsx src/scripts/three-decisions-backfill.ts free-outputs           [--apply] [--enqueue] [--batch=200] [--after=<userId>] [--max-batches=N]
 *   tsx src/scripts/three-decisions-backfill.ts verification-references [--apply] [--batch=500] [--after=<evidenceId>] [--max-batches=N]
 *
 * DRY RUN BY DEFAULT. Nothing is written without --apply. Every pass is
 * bounded (one keyset page per batch, deterministic order), resumable (the
 * last cursor is printed; pass it back as --after) and idempotent (every write
 * is conditional on the column still being empty, so a re-run or a concurrent
 * finalize changes nothing twice). It prints exact counts. It embeds no
 * credentials: DATABASE_URL comes from the operator's environment and the
 * Prisma safety hook still refuses anything it does not recognise.
 *
 * free-outputs — FREE THREE-RECORD CONTRACT (decision 1).
 *   For every personal subject whose effective plan is FREE, the first three
 *   PLAN-funded finalized records — ordered by signed_at_utc, then id — get the
 *   stored FREE_ALLOWANCE earned fact, exactly what finalization now writes.
 *   A record that already carries an earned fact keeps it; a credit-funded
 *   record is not a FREE slot; records beyond the first three are untouched
 *   (they stay accessible and earn no new issuance). No artifact is created,
 *   deleted, revoked or rewritten here.
 *   With --enqueue (and --apply), each covered ACTIVE record missing its report
 *   or package is handed to the canonical recovery CLI path
 *   (`recoverEvidenceOutputs`), whose request rows deduplicate; a covered
 *   TRASHED / archived record is deferred — the first-issuance reconciliation
 *   issues it once it is restored. Without --enqueue the same reconciliation
 *   issues them gradually (bounded per tick, gated by
 *   OUTPUT_HISTORICAL_FIRST_ISSUANCE_ENABLED for records older than 7 days).
 *   REFUSES (exit 3) when a subject holds more than three FREE_ALLOWANCE facts:
 *   that is a state this contract cannot produce and must be investigated.
 *
 * verification-references — CANONICAL VERIFICATION IDENTITY (decision 2).
 *   Every ELIGIBLE record (finalized, active, not deleted/destroyed/archived,
 *   integrity intact — the shared eligibility rule) without a canonical
 *   reference gets one, through the same set-once authority finalization and
 *   the report worker use; an existing reference is never replaced. Dry run by
 *   default; prints exact scanned / eligible / issued / alreadyIssued /
 *   refused* / skippedRowMoved / failed counts; exits 4 on any failure. Old
 *   reports are NOT regenerated: their printed links keep resolving through the
 *   public route's compatibility.
 *
 *   tsx src/scripts/three-decisions-backfill.ts lifecycle [--apply] [--batch=500] [--after=<evidenceId>] [--max-batches=N] [--team=<teamId>]
 *
 * lifecycle — LEGACY LIFECYCLE RECONCILIATION (2026-10-15).
 *   Classifies EVERY evidence row into exactly one population class (the one
 *   authority, `classifyEvidencePopulation`) and prints the counts. With
 *   --apply it repairs only what a canonical transition can: a completed
 *   record still ACTIVE but carrying a deletion marker moves to Trash (its
 *   original deletion date starts the 90-day Trash); an expired, unreleased
 *   upload reservation is released. Incomplete uploads are never trashed or
 *   archived; locked, held and contradictory rows are REFUSED and listed for
 *   manual review. No hard deletion; bytes, hashes, signatures, custody,
 *   reports and packages are untouched.
 */
import * as prismaPkg from "@prisma/client";

import { prisma } from "../db.js";
import {
  ACTIVE_EVIDENCE_LIFECYCLE_STATES,
  EVIDENCE_POPULATION_CLASSES,
  UNSEALED_EVIDENCE_STATUSES,
  appendCustodyEventTx,
  classifyEvidencePopulation,
  CANONICAL_VERIFICATION_ELIGIBILITY_SELECT,
  ensureVerificationRefTx,
  evaluateEffectiveLegalHold,
  isEvidenceReservationExpiredTx,
  releaseEvidenceReservationTx,
  resolveCanonicalVerificationEligibility,
  type CanonicalVerificationRefusal,
  type EvidencePopulationClass,
} from "@proovra/shared-runtime";
import { TRASH_GRACE_DAYS } from "../services/evidence/evidence-lifecycle.service.js";
import { resolveCommercialPlan } from "../services/billing/commercial-context.service.js";

export const FREE_INCLUDED_RECORDS = 3;

function arg(name: string): string | null {
  const argv = process.argv.slice(2);
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).trim() : null;
}
const flag = (name: string) => process.argv.slice(2).includes(`--${name}`);

export type FreeOutputsSummary = {
  mode: "DRY-RUN" | "APPLY";
  subjectsScanned: number;
  freeSubjects: number;
  recordsCovered: number;
  factsWritten: number;
  alreadyCovered: number;
  beyondAllowance: number;
  recoveryRequested: number;
  deferredNotActive: number;
  refusedSubjects: string[];
  nextCursor: string | null;
};

/**
 * One bounded page of personal subjects (users), ordered by id.
 */
export async function backfillFreeOutputs(options: {
  apply?: boolean;
  enqueue?: boolean;
  batchSize?: number;
  after?: string | null;
  maxBatches?: number;
  log?: (line: string) => void;
}): Promise<FreeOutputsSummary> {
  const apply = options.apply === true;
  const log = options.log ?? ((l: string) => console.log(l));
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 200, 1000));
  const maxBatches = Math.max(1, options.maxBatches ?? Number.MAX_SAFE_INTEGER);
  const summary: FreeOutputsSummary = {
    mode: apply ? "APPLY" : "DRY-RUN",
    subjectsScanned: 0,
    freeSubjects: 0,
    recordsCovered: 0,
    factsWritten: 0,
    alreadyCovered: 0,
    beyondAllowance: 0,
    recoveryRequested: 0,
    deferredNotActive: 0,
    refusedSubjects: [],
    nextCursor: options.after ?? null,
  };

  for (let batch = 0; batch < maxBatches; batch++) {
    const users = await prisma.user.findMany({
      where: summary.nextCursor ? { id: { gt: summary.nextCursor } } : {},
      orderBy: { id: "asc" },
      take: batchSize,
      select: { id: true },
    });
    if (users.length === 0) {
      summary.nextCursor = null;
      break;
    }
    for (const user of users) {
      summary.subjectsScanned += 1;
      const plan = await resolveCommercialPlan({ type: "PERSONAL_ACCOUNT", userId: user.id }).catch(() => null);
      if (!plan || plan.plan !== "FREE") continue;
      summary.freeSubjects += 1;

      const personalTeam = await prisma.team.findFirst({
        where: { ownerUserId: user.id, isPersonal: true },
        select: { id: true },
      });
      const records = await prisma.evidence.findMany({
        where: {
          ownerUserId: user.id,
          OR: [{ teamId: null }, ...(personalTeam ? [{ teamId: personalTeam.id }] : [])],
          status: { in: ["SIGNED", "REPORTED"] },
          signedAtUtc: { not: null },
        },
        orderBy: [{ signedAtUtc: "asc" }, { id: "asc" }],
        select: { id: true, lifecycleState: true, outputEarnedBasis: true, teamId: true },
      });
      const creditFunded = new Set(
        (
          await prisma.evidenceCreditLedgerEntry.findMany({
            where: { evidenceId: { in: records.map((r) => r.id) }, entryType: "CONSUMPTION" },
            select: { evidenceId: true },
          })
        ).map((r) => r.evidenceId),
      );
      const planFunded = records.filter((r) => !creditFunded.has(r.id));
      const existingFree = planFunded.filter((r) => r.outputEarnedBasis === "FREE_ALLOWANCE").length;
      if (existingFree > FREE_INCLUDED_RECORDS) {
        summary.refusedSubjects.push(user.id);
        log(`[free-outputs] REFUSED ${JSON.stringify({ userId: user.id, freeAllowanceFacts: existingFree })}`);
        continue;
      }
      const covered = planFunded.slice(0, FREE_INCLUDED_RECORDS);
      summary.beyondAllowance += Math.max(0, planFunded.length - FREE_INCLUDED_RECORDS);
      for (const record of covered) {
        summary.recordsCovered += 1;
        if (record.outputEarnedBasis) {
          summary.alreadyCovered += 1;
          continue;
        }
        if (apply) {
          const written = await prisma.evidence.updateMany({
            where: { id: record.id, outputEarnedBasis: null },
            data: { outputEarnedPlan: "FREE", outputEarnedBasis: "FREE_ALLOWANCE", outputEarnedAtUtc: new Date() },
          });
          summary.factsWritten += written.count;
        } else {
          summary.factsWritten += 1; // would write
        }
        if (record.lifecycleState !== "ACTIVE") {
          summary.deferredNotActive += 1;
          continue;
        }
        if (apply && options.enqueue) {
          const { recoverEvidenceOutputs } = await import("./recover-evidence-outputs.js");
          const out = await recoverEvidenceOutputs({ evidenceId: record.id, apply: true });
          summary.recoveryRequested += out.summary.requested ?? 0;
        }
      }
      log(
        `[free-outputs] ${JSON.stringify({
          mode: summary.mode,
          userId: user.id,
          finalizedPlanFunded: planFunded.length,
          covered: covered.map((r) => r.id),
          beyondAllowance: Math.max(0, planFunded.length - FREE_INCLUDED_RECORDS),
        })}`,
      );
    }
    summary.nextCursor = users[users.length - 1]!.id;
    if (users.length < batchSize) {
      summary.nextCursor = null;
      break;
    }
  }
  return summary;
}

export type VerificationReferenceSummary = {
  mode: "DRY-RUN" | "APPLY";
  /** Every evidence row read. */
  scanned: number;
  /** Eligible records without a reference (each is issued, or would be). */
  eligible: number;
  /** References written (APPLY) or that would be written (DRY-RUN). */
  issued: number;
  /** Records that already hold their permanent reference (never touched). */
  alreadyIssued: number;
  refusedNotFinalized: number;
  refusedDeleted: number;
  refusedDestroyed: number;
  refusedArchived: number;
  refusedIntegrity: number;
  /** The row changed between read and write (issued elsewhere, or became ineligible). */
  skippedRowMoved: number;
  failed: number;
  /** Resume point: pass as --after to continue; null when the scan finished. */
  nextCursor: string | null;
};

const REFUSAL_COUNTER: Record<
  Exclude<CanonicalVerificationRefusal, "NOT_FOUND">,
  keyof Pick<
    VerificationReferenceSummary,
    "refusedNotFinalized" | "refusedDeleted" | "refusedDestroyed" | "refusedArchived" | "refusedIntegrity"
  >
> = {
  NOT_FINALIZED: "refusedNotFinalized",
  DELETED: "refusedDeleted",
  DESTROYED: "refusedDestroyed",
  ARCHIVED: "refusedArchived",
  INTEGRITY_FAILED: "refusedIntegrity",
};

/**
 * Issue the canonical reference to every ELIGIBLE record that lacks one, through
 * the one authority (`ensureVerificationRefTx`, which applies the same shared
 * eligibility rule and is set-once). Read-only by default; `--apply` writes.
 *
 *   - Scans EVERY evidence row in id order with a stable cursor (resumable).
 *   - One transaction per record: a failure never strands a batch half-done.
 *   - Never rotates or replaces a reference, never touches storage, reports,
 *     packages or retention; the only custody write is the one
 *     VERIFICATION_REFERENCE_ISSUED event the authority appends per issuance.
 *   - Fails closed: the first failure stops the run (its cursor is reported so
 *     it can resume after the cause is fixed) and the exit status is non-zero.
 */
export async function backfillVerificationReferences(options: {
  apply?: boolean;
  batchSize?: number;
  after?: string | null;
  maxBatches?: number;
}): Promise<VerificationReferenceSummary> {
  const apply = options.apply === true;
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 500, 2000));
  const maxBatches = Math.max(1, options.maxBatches ?? Number.MAX_SAFE_INTEGER);
  const summary: VerificationReferenceSummary = {
    mode: apply ? "APPLY" : "DRY-RUN",
    scanned: 0,
    eligible: 0,
    issued: 0,
    alreadyIssued: 0,
    refusedNotFinalized: 0,
    refusedDeleted: 0,
    refusedDestroyed: 0,
    refusedArchived: 0,
    refusedIntegrity: 0,
    skippedRowMoved: 0,
    failed: 0,
    nextCursor: options.after ?? null,
  };
  for (let batch = 0; batch < maxBatches; batch++) {
    const rows = await prisma.evidence.findMany({
      where: summary.nextCursor ? { id: { gt: summary.nextCursor } } : {},
      orderBy: { id: "asc" },
      take: batchSize,
      select: { id: true, verificationRef: true, ...CANONICAL_VERIFICATION_ELIGIBILITY_SELECT },
    });
    if (rows.length === 0) {
      summary.nextCursor = null;
      break;
    }
    for (const row of rows) {
      summary.scanned += 1;
      if (row.verificationRef) {
        summary.alreadyIssued += 1;
        summary.nextCursor = row.id;
        continue;
      }
      const eligibility = resolveCanonicalVerificationEligibility(row);
      if (!eligibility.eligible) {
        if (eligibility.reason !== "NOT_FOUND") summary[REFUSAL_COUNTER[eligibility.reason]] += 1;
        summary.nextCursor = row.id;
        continue;
      }
      summary.eligible += 1;
      if (!apply) {
        summary.issued += 1;
        summary.nextCursor = row.id;
        continue;
      }
      try {
        const res = await prisma.$transaction((tx) => ensureVerificationRefTx(tx, row.id, { source: "BACKFILL" }));
        if (res.issued) summary.issued += 1;
        else summary.skippedRowMoved += 1;
      } catch (err) {
        summary.failed += 1;
        console.error(
          `[verification-references] FAILED at the record after cursor ${summary.nextCursor ?? "(start)"}: ${(err as Error).message}`,
        );
        // Fail closed: stop here; resume with --after=<nextCursor> once fixed.
        return summary;
      }
      summary.nextCursor = row.id;
    }
    if (rows.length < batchSize) {
      summary.nextCursor = null;
      break;
    }
  }
  return summary;
}

// ===========================================================================
// lifecycle — LEGACY LIFECYCLE RECONCILIATION (2026-10-15)
// ===========================================================================

export type LifecycleReconciliationAction =
  | "NONE"
  | "MOVE_TO_TRASH"
  | "RELEASE_ABANDONED_RESERVATION"
  | "REFUSED_MANUAL_REVIEW";

/**
 * Exact counts. Every scanned row is in exactly ONE of activeConsistent,
 * legacyActiveDeleted, validTrash, retentionArchived, ownerArchived, purge,
 * inProgress, abandonedUpload and manualReview; wouldChange (dry run),
 * changed, skippedRowMoved (the row moved between read and write) and
 * refused (held, locked or contradictory) describe what was done with them.
 */
export type LifecycleReconciliationCounts = {
  activeConsistent: number;
  legacyActiveDeleted: number;
  validTrash: number;
  retentionArchived: number;
  ownerArchived: number;
  purge: number;
  inProgress: number;
  abandonedUpload: number;
  manualReview: number;
  wouldChange: number;
  changed: number;
  skippedRowMoved: number;
  refused: number;
};

export type LifecycleReconciliationSummary = {
  mode: "DRY-RUN" | "APPLY";
  scanned: number;
  counts: LifecycleReconciliationCounts;
  byClass: Record<EvidencePopulationClass, number>;
  movedToTrash: number;
  releasedReservations: number;
  manualReview: Array<{ id: string; reason: string }>;
  nextCursor: string | null;
};

const LIFECYCLE_SELECT = {
  id: true,
  teamId: true,
  status: true,
  lifecycleState: true,
  deletedAt: true,
  deletedAtUtc: true,
  archivedAt: true,
  destroyedAtUtc: true,
  signedAtUtc: true,
  lockedAt: true,
} as const;

/**
 * Classify every row with the ONE population authority and repair only what a
 * canonical transition can repair:
 *
 *   - a SEALED record still in an active lifecycle but carrying a deletion
 *     marker (legacy `deleted_at` or `deleted_at_utc`) moves to TRASH, keeping
 *     its original deletion instant as the start of its 90-day Trash — the
 *     trash-grace sweep then carries it to the Retention Archive or purge
 *     exactly like any other trashed record;
 *   - an UNSEALED reservation whose window has expired is released through
 *     the canonical reservation release (soft delete + custody event);
 *   - everything else is left alone; contradictory rows — and a deleted record
 *     that is locked or under Legal Hold — are REFUSED for manual review.
 *
 * It never hard-deletes, never touches bytes, hashes, signatures, custody,
 * reports or packages, and never moves an incomplete upload to Trash or the
 * Retention Archive. Every write is conditional on the row still being in the
 * state that was classified, under the record's advisory lock, so a re-run or
 * a concurrent user action changes nothing twice.
 */
export async function reconcileEvidenceLifecycle(options: {
  apply?: boolean;
  batchSize?: number;
  after?: string | null;
  maxBatches?: number;
  teamId?: string | null;
  now?: Date;
  /** Test seam: runs between classification and the conditional write. */
  beforeWrite?: (evidenceId: string) => Promise<void>;
}): Promise<LifecycleReconciliationSummary> {
  const apply = options.apply === true;
  const now = options.now ?? new Date();
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 500, 2000));
  const maxBatches = Math.max(1, options.maxBatches ?? Number.MAX_SAFE_INTEGER);
  const summary: LifecycleReconciliationSummary = {
    mode: apply ? "APPLY" : "DRY-RUN",
    scanned: 0,
    counts: {
      activeConsistent: 0,
      legacyActiveDeleted: 0,
      validTrash: 0,
      retentionArchived: 0,
      ownerArchived: 0,
      purge: 0,
      inProgress: 0,
      abandonedUpload: 0,
      manualReview: 0,
      wouldChange: 0,
      changed: 0,
      skippedRowMoved: 0,
      refused: 0,
    },
    byClass: Object.fromEntries(EVIDENCE_POPULATION_CLASSES.map((c) => [c, 0])) as Record<EvidencePopulationClass, number>,
    movedToTrash: 0,
    releasedReservations: 0,
    manualReview: [],
    nextCursor: options.after ?? null,
  };
  const activeLifecycle = [...ACTIVE_EVIDENCE_LIFECYCLE_STATES] as prismaPkg.EvidenceLifecycleState[];
  const unsealed = [...UNSEALED_EVIDENCE_STATUSES] as prismaPkg.EvidenceStatus[];

  for (let batch = 0; batch < maxBatches; batch++) {
    const rows = await prisma.evidence.findMany({
      where: {
        ...(summary.nextCursor ? { id: { gt: summary.nextCursor } } : {}),
        ...(options.teamId ? { teamId: options.teamId } : {}),
      },
      orderBy: { id: "asc" },
      take: batchSize,
      select: LIFECYCLE_SELECT,
    });
    if (rows.length === 0) {
      summary.nextCursor = null;
      break;
    }
    for (const row of rows) {
      summary.scanned += 1;
      const isUnsealed = (unsealed as string[]).includes(row.status);
      const marked = row.deletedAt !== null || row.deletedAtUtc !== null;
      const reservationLive =
        isUnsealed && !marked ? !(await isEvidenceReservationExpiredTx(prisma as never, row.id, now)) : undefined;
      let cls = classifyEvidencePopulation({ ...row, reservationLive });
      // A completed record a legacy path deleted without moving it to Trash.
      const legacyDeleted =
        cls === "TRASH" && !isUnsealed && (activeLifecycle as string[]).includes(row.lifecycleState ?? "ACTIVE");
      let refusal: string | null = cls === "MANUAL_REVIEW" ? "CONTRADICTORY_LIFECYCLE_MARKERS" : null;
      if (legacyDeleted) {
        // A canonical trash is refused for a locked or held record, so the
        // tool refuses too — and the row is classified MANUAL_REVIEW.
        if (row.lockedAt) refusal = "DELETED_BUT_RECORD_LOCKED";
        else if ((await evaluateEffectiveLegalHold(prisma as never, { teamId: row.teamId, evidenceId: row.id })).held) {
          refusal = "DELETED_BUT_UNDER_LEGAL_HOLD";
        }
        if (refusal) cls = "MANUAL_REVIEW";
      }
      summary.byClass[cls] += 1;
      const c = summary.counts;
      if (cls === "ACTIVE") c.activeConsistent += 1;
      else if (cls === "TRASH" && legacyDeleted) c.legacyActiveDeleted += 1;
      else if (cls === "TRASH") c.validTrash += 1;
      else if (cls === "RETENTION_ARCHIVE") c.retentionArchived += 1;
      else if (cls === "ARCHIVED") c.ownerArchived += 1;
      else if (cls === "PURGE") c.purge += 1;
      else if (cls === "IN_PROGRESS") c.inProgress += 1;
      else if (cls === "ABANDONED_UPLOAD") c.abandonedUpload += 1;
      else c.manualReview += 1;

      if (refusal) {
        c.refused += 1;
        summary.manualReview.push({ id: row.id, reason: refusal });
        continue;
      }

      const releasable = cls === "ABANDONED_UPLOAD" && isUnsealed && !marked && reservationLive === false;
      if (!legacyDeleted && !releasable) continue;
      if (!apply) {
        c.wouldChange += 1;
        if (legacyDeleted) summary.movedToTrash += 1;
        else summary.releasedReservations += 1;
        continue;
      }
      await options.beforeWrite?.(row.id);

      if (legacyDeleted) {
        const deletedAt = [row.deletedAt, row.deletedAtUtc]
          .filter((d): d is Date => d !== null)
          .sort((a, b) => a.getTime() - b.getTime())[0]!;
        const trashGraceUntil = new Date(deletedAt.getTime() + TRASH_GRACE_DAYS * 24 * 60 * 60 * 1000);
        const moved = await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${row.id}))`;
          // Conditional on the row still being exactly what was classified.
          const res = await tx.evidence.updateMany({
            where: {
              id: row.id,
              status: row.status,
              lifecycleState: row.lifecycleState ?? undefined,
              lockedAt: null,
              deletedAt: row.deletedAt,
              deletedAtUtc: row.deletedAtUtc,
              archivedAt: row.archivedAt,
            },
            data: {
              lifecycleState: "TRASHED",
              deletedAt,
              deletedAtUtc: deletedAt,
              deleteScheduledForUtc: trashGraceUntil,
            },
          });
          if (res.count !== 1) return false;
          await appendCustodyEventTx(tx, {
            evidenceId: row.id,
            eventType: prismaPkg.CustodyEventType.EVIDENCE_DELETE_SCHEDULED,
            atUtc: now,
            payload: {
              reason: "LEGACY_DELETION_MARKER_RECONCILED",
              deletedAtUtc: deletedAt.toISOString(),
              trashGraceUntilUtc: trashGraceUntil.toISOString(),
            },
          });
          return true;
        });
        if (moved) {
          c.changed += 1;
          summary.movedToTrash += 1;
        } else c.skippedRowMoved += 1;
        continue;
      }

      // An incomplete upload whose reservation expired and was never released:
      // the canonical release re-checks it under the record lock.
      const released = await prisma.$transaction((tx) =>
        releaseEvidenceReservationTx(tx, { evidenceId: row.id, reason: "RESERVATION_EXPIRED", now }),
      );
      if (released) {
        c.changed += 1;
        summary.releasedReservations += 1;
      } else c.skippedRowMoved += 1;
    }
    summary.nextCursor = rows[rows.length - 1]!.id;
    if (rows.length < batchSize) {
      summary.nextCursor = null;
      break;
    }
  }
  return summary;
}

export async function main(): Promise<number> {
  const command = process.argv[2];
  const apply = flag("apply");
  const maxBatches = arg("max-batches") ? Number(arg("max-batches")) : undefined;
  if (command === "free-outputs") {
    const summary = await backfillFreeOutputs({
      apply,
      enqueue: flag("enqueue"),
      batchSize: arg("batch") ? Number(arg("batch")) : undefined,
      after: arg("after"),
      maxBatches,
    });
    console.log(`[free-outputs] SUMMARY ${JSON.stringify(summary)}`);
    return summary.refusedSubjects.length > 0 ? 3 : 0;
  }
  if (command === "verification-references") {
    const summary = await backfillVerificationReferences({
      apply,
      batchSize: arg("batch") ? Number(arg("batch")) : undefined,
      after: arg("after"),
      maxBatches,
    });
    console.log(`[verification-references] SUMMARY ${JSON.stringify(summary)}`);
    // A failure is never a quiet success: exit 4 and resume with --after.
    return summary.failed > 0 ? 4 : 0;
  }
  if (command === "lifecycle") {
    const summary = await reconcileEvidenceLifecycle({
      apply,
      batchSize: arg("batch") ? Number(arg("batch")) : undefined,
      after: arg("after"),
      maxBatches,
      teamId: arg("team"),
    });
    console.log(`[lifecycle] SUMMARY ${JSON.stringify(summary)}`);
    return 0;
  }
  console.error("usage: three-decisions-backfill.ts free-outputs|verification-references|lifecycle [--apply] [--enqueue] [--batch=N] [--after=<id>] [--max-batches=N] [--team=<id>]");
  return 2;
}

const invokedDirectly = process.argv[1] && /three-decisions-backfill\.(ts|js)$/.test(process.argv[1]);
if (invokedDirectly) {
  main()
    .then(async (code) => {
      await prisma.$disconnect();
      process.exit(code);
    })
    .catch(async (err) => {
      console.error(err);
      await prisma.$disconnect();
      process.exit(1);
    });
}
