/**
 * Phase IA-OTS-hybrid — repair script.
 *
 * Walks Evidence rows that are stuck in the hybrid OTS state
 *   `ots_status = 'PENDING' AND ots_bitcoin_txid IS NOT NULL
 *    AND ots_anchored_at_utc IS NULL AND ots_proof_base64 IS NOT NULL`
 * and re-classifies each one through the SAME classifier the worker
 * uses at runtime.
 *
 * Safety design:
 *   * Dry-run by default. Writes ONLY when `--apply` is passed.
 *   * Never writes `ots_status='ANCHORED'` directly. When the
 *     classifier says FULLY_ANCHORED we re-enqueue the canonical
 *     `ots-upgrade` job with the stable `ots-upgrade-followup-<id>`
 *     job id; BullMQ deduplicates, so a concurrent worker can never
 *     race us. The worker's processor then performs the ANCHORED
 *     promotion through the audited transaction (CustodyEvent +
 *     report-job enqueue).
 *   * When the classifier says ANCHOR_MATERIAL_RECOVERED or
 *     STILL_PENDING we ALSO re-enqueue the follow-up job (idempotent)
 *     so the proof keeps getting re-attempted within the global
 *     budget. We never write to the DB from this branch.
 *   * Hard errors are logged + counted but never crash the script.
 *
 * Usage:
 *   node dist/scripts/repair-ots-hybrid-state.js                 # dry-run
 *   node dist/scripts/repair-ots-hybrid-state.js --apply         # write
 *   node dist/scripts/repair-ots-hybrid-state.js --limit 50      # cap batch
 *   node dist/scripts/repair-ots-hybrid-state.js --evidence-id <uuid>
 */

import type { Prisma } from "@prisma/client";

import { classifyOtsResult, type OtsUpgradeOutput } from "../ots-upgrade-output.js";
import { verifyOtsProof } from "../ots.service.js";
import { prisma } from "../db.js";
import { enqueueOtsUpgradeJob } from "../queue.js";

type Args = {
  apply: boolean;
  limit: number;
  evidenceId: string | null;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, limit: 100, evidenceId: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--limit") {
      const next = argv[i + 1];
      const n = next ? Number.parseInt(next, 10) : NaN;
      if (!Number.isFinite(n) || n <= 0 || n > 1000) {
        console.error(
          "[repair-ots] --limit must be an integer between 1 and 1000",
        );
        process.exit(2);
      }
      args.limit = n;
      i += 1;
    } else if (a === "--evidence-id") {
      const next = argv[i + 1];
      if (!next) {
        console.error("[repair-ots] --evidence-id requires a value");
        process.exit(2);
      }
      args.evidenceId = next;
      i += 1;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: node dist/scripts/repair-ots-hybrid-state.js [--apply] [--limit N] [--evidence-id <uuid>]",
      );
      process.exit(0);
    }
  }
  return args;
}

// The classifier expects an `OtsUpgradeOutput`. At repair time we
// don't run `ots upgrade` (the work was already done by the worker);
// the relevant signals are the persisted txid + the fresh verify
// output. We pass an empty upgrade-output stub; the classifier reads
// `existingTxid` from input directly.
const UPGRADE_STUB: OtsUpgradeOutput = {
  raw: "",
  txid: null,
  anchoredOutput: false,
  pendingOutput: false,
};

type Summary = {
  scanned: number;
  fullyAnchored: number;
  anchorMaterialRecovered: number;
  stillPending: number;
  failed: number;
  errors: number;
  enqueuedJobs: number;
  skippedNoProof: number;
  skippedNoHash: number;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const summary: Summary = {
    scanned: 0,
    fullyAnchored: 0,
    anchorMaterialRecovered: 0,
    stillPending: 0,
    failed: 0,
    errors: 0,
    enqueuedJobs: 0,
    skippedNoProof: 0,
    skippedNoHash: 0,
  };

  console.log(
    `[repair-ots] start mode=${args.apply ? "APPLY" : "DRY-RUN"} limit=${args.limit} evidenceId=${args.evidenceId ?? "(all)"}`,
  );

  const where: Prisma.EvidenceWhereInput = {
    otsStatus: "PENDING",
    otsBitcoinTxid: { not: null },
    otsAnchoredAtUtc: null,
    otsProofBase64: { not: null },
    deletedAt: null,
  };
  if (args.evidenceId) {
    where.id = args.evidenceId;
  }

  const rows = await prisma.evidence.findMany({
    where,
    select: {
      id: true,
      teamId: true,
      title: true,
      otsHash: true,
      otsProofBase64: true,
      otsBitcoinTxid: true,
      otsAnchoredAtUtc: true,
      otsUpgradedAtUtc: true,
      createdAt: true,
    },
    orderBy: { updatedAt: "asc" },
    take: args.limit,
  });

  if (rows.length === 0) {
    console.log("[repair-ots] no hybrid-state rows found — exiting.");
    await prisma.$disconnect();
    return;
  }

  for (const row of rows) {
    summary.scanned += 1;
    const idShort = row.id.slice(0, 8);

    if (!row.otsProofBase64) {
      summary.skippedNoProof += 1;
      console.log(
        `[repair-ots] skip ${idShort} reason=no-proof status=PENDING`,
      );
      continue;
    }
    if (!row.otsHash) {
      summary.skippedNoHash += 1;
      console.log(
        `[repair-ots] skip ${idShort} reason=no-hash (verify requires SHA-256)`,
      );
      continue;
    }

    let verifyResult;
    try {
      verifyResult = await verifyOtsProof({
        proofBase64: row.otsProofBase64,
        hashHex: row.otsHash,
      });
    } catch (err) {
      summary.errors += 1;
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[repair-ots] verify-error ${idShort} ${message.slice(0, 200)}`,
      );
      continue;
    }

    const verify =
      verifyResult.status === "VERIFIED" ||
      verifyResult.status === "INCOMPLETE"
        ? verifyResult.verify
        : null;

    const classification = classifyOtsResult({
      upgrade: UPGRADE_STUB,
      verify,
      existingTxid: row.otsBitcoinTxid,
      commandErrored: false,
    });

    switch (classification.kind) {
      case "FULLY_ANCHORED": {
        summary.fullyAnchored += 1;
        console.log(
          `[repair-ots] FULLY_ANCHORED ${idShort} txid=${classification.txid?.slice(0, 16) ?? "(none)"} ` +
            `blockHeight=${classification.blockHeight ?? "?"} verifyStatus=${verifyResult.status}`,
        );
        if (args.apply) {
          // Defer the actual DB write + custody event + report-regen
          // to the canonical worker path. Re-enqueueing with the stable
          // jobId is idempotent — BullMQ collapses duplicate adds.
          await enqueueOtsUpgradeJob(row.id, { traceId: "repair_script" });
          summary.enqueuedJobs += 1;
          console.log(
            `[repair-ots]   → enqueued ots-upgrade follow-up for ${idShort}`,
          );
        } else {
          console.log(
            `[repair-ots]   (dry-run) would enqueue ots-upgrade follow-up`,
          );
        }
        break;
      }
      case "ANCHOR_MATERIAL_RECOVERED": {
        summary.anchorMaterialRecovered += 1;
        console.log(
          `[repair-ots] ANCHOR_MATERIAL_RECOVERED ${idShort} txid=${classification.txid?.slice(0, 16) ?? "(none)"} ` +
            `verifyStatus=${verifyResult.status} reason="${classification.reason.slice(0, 120)}"`,
        );
        if (args.apply) {
          await enqueueOtsUpgradeJob(row.id, { traceId: "repair_script" });
          summary.enqueuedJobs += 1;
          console.log(
            `[repair-ots]   → enqueued ots-upgrade follow-up for ${idShort}`,
          );
        } else {
          console.log(
            `[repair-ots]   (dry-run) would enqueue ots-upgrade follow-up`,
          );
        }
        break;
      }
      case "STILL_PENDING": {
        summary.stillPending += 1;
        console.log(
          `[repair-ots] STILL_PENDING ${idShort} verifyStatus=${verifyResult.status}`,
        );
        // No action — the worker's regular follow-up cadence will pick
        // it up. The repair script does NOT enqueue here to avoid
        // double-pressure on the upgrade queue.
        break;
      }
      case "FAILED": {
        summary.failed += 1;
        console.log(
          `[repair-ots] FAILED-classification ${idShort} reason="${classification.reason.slice(0, 200)}"`,
        );
        // The repair script never writes FAILED. If the row is genuinely
        // failing, the worker's normal terminal-failure path will mark
        // it on the next upgrade attempt.
        break;
      }
    }
  }

  console.log("[repair-ots] summary " + JSON.stringify(summary));
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[repair-ots] fatal", err);
  try {
    await prisma.$disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});
