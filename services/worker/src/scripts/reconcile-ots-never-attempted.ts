/**
 * OTS INTEGRITY DECOUPLING — the historical reconciliation path.
 *
 * ===========================================================================
 * THE POPULATION THIS EXISTS FOR
 * ===========================================================================
 * OpenTimestamps used to be stamped inside the report job. A record whose plan
 * does not include reports therefore never entered the OTS lifecycle at all —
 * not because a stamp was attempted and failed, but because nothing ever
 * asked. Those records are finalized, signed, and carry NULL in every OTS
 * column.
 *
 * They are now indistinguishable from nothing else, and that matters: a NULL
 * `ots_status` means NEVER ATTEMPTED, and `FAILED` means TRIED AND DID NOT
 * WORK. Treating the first as the second would invent an integrity incident
 * for every Free record ever captured; treating the second as the first would
 * silently re-stamp records whose proof the calendar is already tracking.
 *
 * This script counts all four populations and acts on exactly one.
 *
 * ===========================================================================
 * WHAT A BACKFILLED PROOF DOES AND DOES NOT SAY
 * ===========================================================================
 * An OpenTimestamps proof attests that the stamped bytes existed NO LATER THAN
 * its anchor time. A proof created today for a record finalized last year
 * therefore says "this digest existed by today" — not "by last year".
 *
 * That is still worth having: the digest is bound to the record's signature
 * and its RFC 3161 timestamp, and those DO carry the original moment. But it
 * must never be presented as original-time anchoring. The record keeps three
 * distinct times — capture/finalization, TSA, and OTS anchor — and nothing in
 * this path collapses them. The custody event written by the initializer
 * records the trigger, so the later anchor is explicable from the chain rather
 * than inferred from a gap.
 *
 * PRODUCT/LEGAL REVIEW REQUIRED before this is run anywhere real. Not because
 * the mechanism is unsound, but because "we anchored your year-old evidence
 * today" is an evidentiary statement, and whether to make it for existing
 * customers is not an engineering decision. This script does nothing until a
 * human passes `--apply`, and it has never been run against Production.
 *
 * ===========================================================================
 * SAFETY DESIGN — deliberately identical to `repair-ots-hybrid-state.ts`
 * ===========================================================================
 *   * Dry-run by default. Writes nothing without `--apply`.
 *   * It NEVER writes OTS columns itself. It enqueues the canonical
 *     `ots-upgrade` job, whose id is derived from the evidence id, so BullMQ
 *     collapses duplicates and the worker performs the stamp through the one
 *     audited path (conditional write + custody event).
 *   * Bounded: `--limit` caps the batch, `--evidence-id` targets one record,
 *     `--team-id` scopes to a workspace.
 *   * Idempotent: a record that gains a proof between the scan and the run is
 *     rejected by the initializer's own guard.
 *   * It does not touch TSA. It cannot: nothing here reads or writes a TSA
 *     column, and there is no TSA retry in this product.
 *   * It does not generate reports or verification packages, for any plan.
 *     Enqueuing an anchor is not enqueuing an artifact.
 *
 * Usage:
 *   node dist/scripts/reconcile-ots-never-attempted.js                # count only
 *   node dist/scripts/reconcile-ots-never-attempted.js --apply        # enqueue
 *   node dist/scripts/reconcile-ots-never-attempted.js --limit 50
 *   node dist/scripts/reconcile-ots-never-attempted.js --team-id <uuid>
 *   node dist/scripts/reconcile-ots-never-attempted.js --evidence-id <uuid>
 */

import type { Prisma } from "@prisma/client";

import { prisma } from "../db.js";
import { enqueueOtsUpgradeJob } from "../queue.js";

type Args = {
  apply: boolean;
  limit: number;
  evidenceId: string | null;
  teamId: string | null;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, limit: 100, evidenceId: null, teamId: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--limit") {
      const n = argv[i + 1] ? Number.parseInt(argv[i + 1]!, 10) : NaN;
      if (!Number.isFinite(n) || n <= 0 || n > 1000) {
        console.error("[reconcile-ots] --limit must be an integer between 1 and 1000");
        process.exit(2);
      }
      args.limit = n;
      i += 1;
    } else if (a === "--evidence-id") {
      if (!argv[i + 1]) {
        console.error("[reconcile-ots] --evidence-id requires a value");
        process.exit(2);
      }
      args.evidenceId = argv[i + 1]!;
      i += 1;
    } else if (a === "--team-id") {
      if (!argv[i + 1]) {
        console.error("[reconcile-ots] --team-id requires a value");
        process.exit(2);
      }
      args.teamId = argv[i + 1]!;
      i += 1;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: node dist/scripts/reconcile-ots-never-attempted.js " +
          "[--apply] [--limit N] [--team-id <uuid>] [--evidence-id <uuid>]",
      );
      process.exit(0);
    }
  }
  return args;
}

/**
 * FINALIZED means the digest OTS stamps actually exists.
 *
 * `fingerprintCanonicalJson` is the stamped content and is written by the
 * finalize transaction, so its presence is the honest test — stronger than a
 * status label, because it is the input itself.
 */
function finalizedScope(args: Args): Prisma.EvidenceWhereInput {
  return {
    deletedAt: null,
    fingerprintCanonicalJson: { not: null },
    ...(args.evidenceId ? { id: args.evidenceId } : {}),
    ...(args.teamId ? { teamId: args.teamId } : {}),
  };
}

/**
 * The four populations, stated as queries so the distinction is testable
 * rather than described.
 *
 * NEVER_ATTEMPTED is the only one this script acts on. The other three are
 * counted so an operator reading the output can see the shape of the estate
 * and confirm the categories are not being conflated.
 */
const CATEGORIES = {
  /** A — nothing ever asked. The population the old coupling stranded. */
  NEVER_ATTEMPTED: { otsStatus: null, otsProofBase64: null },
  /** B — a stamp was made and reported failure. Not this script's business. */
  FAILED: { otsStatus: "FAILED" },
  /** C — stamped, waiting on the calendar. The upgrade ladder owns these. */
  PENDING: { otsStatus: "PENDING" },
  /** D — done. */
  ANCHORED: { otsStatus: "ANCHORED" },
} as const satisfies Record<string, Prisma.EvidenceWhereInput>;

export async function main(argv: string[] = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const scope = finalizedScope(args);

  const counts: Record<string, number> = {};
  for (const [name, where] of Object.entries(CATEGORIES)) {
    counts[name] = await prisma.evidence.count({
      where: { AND: [scope, where as Prisma.EvidenceWhereInput] },
    });
  }

  console.log("[reconcile-ots] finalized evidence by OTS category:");
  for (const [name, n] of Object.entries(counts)) {
    console.log(`  ${name.padEnd(16)} ${n}`);
  }
  console.log(
    "[reconcile-ots] NOTE: a proof created now attests existence no later " +
      "than TODAY, not the original capture time. Capture, TSA and OTS times " +
      "remain three separate facts on the record.",
  );

  if (!args.apply) {
    console.log(
      `[reconcile-ots] DRY RUN — would enqueue up to ${Math.min(
        args.limit,
        counts.NEVER_ATTEMPTED ?? 0,
      )} anchor job(s). Re-run with --apply to act.`,
    );
    return { counts, enqueued: 0, applied: false };
  }

  const rows = await prisma.evidence.findMany({
    where: { AND: [scope, CATEGORIES.NEVER_ATTEMPTED] },
    // Oldest first: if a run is interrupted, the records that have waited
    // longest are the ones that got served.
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: args.limit,
    select: { id: true },
  });

  let enqueued = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await enqueueOtsUpgradeJob(row.id, { traceId: "ots_backfill" });
      enqueued += 1;
    } catch (error) {
      failed += 1;
      console.error(
        `[reconcile-ots] enqueue failed for ${row.id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  console.log(`[reconcile-ots] enqueued=${enqueued} failed=${failed}`);
  return { counts, enqueued, applied: true };
}

// Only self-execute when run as a script, so the suite can import `main`.
if (process.argv[1]?.includes("reconcile-ots-never-attempted")) {
  main()
    .then(() => prisma.$disconnect())
    .catch(async (error) => {
      console.error("[reconcile-ots] fatal:", error);
      await prisma.$disconnect();
      process.exit(1);
    });
}
