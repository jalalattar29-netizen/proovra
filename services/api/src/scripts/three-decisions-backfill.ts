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
 *   Every record that has an issued report and no canonical reference gets one
 *   (the same authority the report worker uses; never replaces an existing
 *   one). Old reports are NOT regenerated: their printed links keep resolving
 *   through the legacy compatibility the public route provides.
 */
import { prisma } from "../db.js";
import { ensureVerificationRefTx } from "@proovra/shared-runtime";
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
  scanned: number;
  issued: number;
  alreadyIssued: number;
  nextCursor: string | null;
};

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
    issued: 0,
    alreadyIssued: 0,
    nextCursor: options.after ?? null,
  };
  for (let batch = 0; batch < maxBatches; batch++) {
    // Records with at least one issued report: exactly the population whose
    // reports print (or printed) a verification link.
    const rows = await prisma.evidence.findMany({
      where: {
        ...(summary.nextCursor ? { id: { gt: summary.nextCursor } } : {}),
        reports: { some: {} },
      },
      orderBy: { id: "asc" },
      take: batchSize,
      select: { id: true, verificationRef: true },
    });
    if (rows.length === 0) {
      summary.nextCursor = null;
      break;
    }
    for (const row of rows) {
      summary.scanned += 1;
      if (row.verificationRef) {
        summary.alreadyIssued += 1;
        continue;
      }
      if (!apply) {
        summary.issued += 1;
        continue;
      }
      const res = await prisma.$transaction((tx) => ensureVerificationRefTx(tx, row.id, { source: "BACKFILL" }));
      if (res.issued) summary.issued += 1;
      else summary.alreadyIssued += 1;
    }
    summary.nextCursor = rows[rows.length - 1]!.id;
    if (rows.length < batchSize) {
      summary.nextCursor = null;
      break;
    }
  }
  return summary;
}

async function main(): Promise<number> {
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
    return 0;
  }
  console.error("usage: three-decisions-backfill.ts free-outputs|verification-references [--apply] [--enqueue] [--batch=N] [--after=<id>] [--max-batches=N]");
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
