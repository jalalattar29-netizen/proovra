/**
 * OTS STATE RECONCILIATION (2026-10-13) — legacy rows onto the one authority.
 *
 * Rows written before the canonical OpenTimestamps state (ots-anchoring.ts)
 * can carry a stored `ots_status` that disagrees with their stored proof: an
 * upgraded proof that executes to a valid Bitcoin block attestation still
 * labelled PENDING, an ANCHORED label over a proof with no Bitcoin attestation,
 * or a proof that does not commit to the record's digest. This script brings
 * the stored status in line with what the stored proof resolves to, through
 * the same transition the worker uses (`decideStoredStatusAlignment`), and —
 * for a record whose latest report stated an earlier state — runs the one
 * automatic report-version decision (`ensureOtsAnchoredReportVersion`).
 *
 * SAFETY DESIGN
 *   * Dry-run by default. Writes nothing without `--apply`.
 *   * Bounded: `--limit` (1..1000, default 100), `--evidence-id`, `--team-id`.
 *   * Compare-and-set: each write is conditional on the exact OTS facts the
 *     decision was made from; a row that moved on is skipped, never
 *     overwritten.
 *   * Idempotent: an aligned row produces no decision, so a second run
 *     changes nothing and records nothing.
 *   * One custody event per ACTUAL change (OTS_APPLIED / OTS_FAILED, in the
 *     same transaction as the write) — none for a row left unchanged.
 *   * No deletes. Proof bytes are never rewritten or removed; an ANCHORED
 *     state is never inferred from a txid, time or label — only from the
 *     executed proof.
 *   * Prints evidence ids, states and bounded codes only: no proof bytes,
 *     storage keys, credentials or URLs.
 *
 * Usage (inside the worker image):
 *   node dist/scripts/reconcile-ots-state.js --evidence-id <uuid>            # dry run
 *   node dist/scripts/reconcile-ots-state.js --evidence-id <uuid> --apply
 *   node dist/scripts/reconcile-ots-state.js --team-id <uuid> --limit 50
 */
import type { Prisma } from "@prisma/client";
import * as prismaPkg from "@prisma/client";

import { appendCustodyEventTx } from "../custody-events.js";
import { prisma } from "../db.js";
import { ensureOtsAnchoredReportVersion } from "../ots-anchored-version.js";
import {
  OTS_ROW_SNAPSHOT_SELECT,
  applyOtsTransition,
  decideStoredStatusAlignment,
  resolveRowOtsAnchoring,
  type OtsRowSnapshot,
} from "../ots-state.js";

type Args = {
  apply: boolean;
  limit: number;
  evidenceId: string | null;
  teamId: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, limit: 100, evidenceId: null, teamId: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const value = argv[i + 1];
    if (a === "--apply") args.apply = true;
    else if (a === "--limit") {
      const n = value ? Number.parseInt(value, 10) : NaN;
      if (!Number.isFinite(n) || n <= 0 || n > 1000) throw new Error("--limit must be an integer between 1 and 1000");
      args.limit = n;
      i += 1;
    } else if (a === "--evidence-id" || a === "--team-id") {
      if (!value || !UUID.test(value)) throw new Error(`${a} requires a UUID`);
      if (a === "--evidence-id") args.evidenceId = value;
      else args.teamId = value;
      i += 1;
    } else if (a === "--help" || a === "-h") {
      throw new Error("usage");
    } else {
      throw new Error(`unknown argument ${a}`);
    }
  }
  return args;
}

export type ReconcileRowResult = {
  evidenceId: string;
  storedStatus: string | null;
  state: string;
  failureCode: string | null;
  action: "none" | "align" | "aligned" | "skipped_row_moved";
  phase: string | null;
  version: string;
};

export async function main(argv: string[] = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const where: Prisma.EvidenceWhereInput = {
    deletedAt: null,
    OR: [{ otsProofBase64: { not: null } }, { otsStatus: { in: ["PENDING", "ANCHORED", "FAILED"] } }],
    ...(args.evidenceId ? { id: args.evidenceId } : {}),
    ...(args.teamId ? { teamId: args.teamId } : {}),
  };
  const rows = await prisma.evidence.findMany({
    where,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: args.limit,
    select: { id: true, ...OTS_ROW_SNAPSHOT_SELECT },
  });

  const results: ReconcileRowResult[] = [];
  for (const row of rows) {
    const snapshot: OtsRowSnapshot = row;
    const now = new Date();
    const transition = decideStoredStatusAlignment(snapshot, now);
    const current = transition?.kind === "WRITE" ? transition.anchoring : resolveRowOtsAnchoring(snapshot);
    const result: ReconcileRowResult = {
      evidenceId: row.id,
      storedStatus: row.otsStatus,
      state: current.state,
      failureCode: current.failureCode,
      action: transition ? "align" : "none",
      phase: transition?.kind === "WRITE" ? transition.phase : null,
      version: "not_evaluated",
    };

    if (args.apply && transition?.kind === "WRITE") {
      const won = await prisma.$transaction(async (tx) => {
        const applied = await applyOtsTransition(tx, row.id, snapshot, transition);
        if (!applied) return false;
        await appendCustodyEventTx(tx, {
          evidenceId: row.id,
          eventType:
            transition.status === "FAILED"
              ? prismaPkg.CustodyEventType.OTS_FAILED
              : prismaPkg.CustodyEventType.OTS_APPLIED,
          atUtc: now,
          payload: {
            otsStatus: transition.status,
            otsState: transition.anchoring.state,
            otsPhase: transition.phase,
            previousOtsStatus: row.otsStatus,
            proofSha256: transition.anchoring.proofSha256,
            bitcoinBlockHeight: transition.anchoring.state === "ANCHORED" ? transition.anchoring.bitcoinBlockHeight : null,
            bitcoinTxid: transition.anchoring.state === "ANCHORED" ? transition.anchoring.bitcoinTxid : null,
            validator: transition.anchoring.validator,
            failureReason: (transition.data.otsFailureReason as string | null | undefined) ?? null,
            trigger: "reconcile_ots_state",
          } as Prisma.InputJsonValue,
        });
        return true;
      });
      result.action = won ? "aligned" : "skipped_row_moved";
    }

    if (current.state === "ANCHORED" && result.action !== "skipped_row_moved") {
      const decision = await ensureOtsAnchoredReportVersion({
        evidenceId: row.id,
        anchoring: current,
        dryRun: !args.apply,
      });
      result.version = !args.apply && decision.outcome === "requested" ? "would_request" : decision.outcome;
    }
    results.push(result);
    console.log(JSON.stringify(result));
  }

  const summary = {
    applied: args.apply,
    scanned: results.length,
    toAlign: results.filter((r) => r.action === "align").length,
    aligned: results.filter((r) => r.action === "aligned").length,
    skippedRowMoved: results.filter((r) => r.action === "skipped_row_moved").length,
    anchored: results.filter((r) => r.state === "ANCHORED").length,
    versionRequested: results.filter((r) => r.version === "requested").length,
    versionWouldRequest: results.filter((r) => r.version === "would_request").length,
  };
  console.log(JSON.stringify({ summary }));
  if (!args.apply) console.log("[reconcile-ots-state] DRY RUN — nothing was written. Re-run with --apply to act.");
  return { results, summary };
}

// Only self-execute when run as a script, so the suite can import `main`.
if (process.argv[1]?.includes("reconcile-ots-state")) {
  main()
    .then(() => prisma.$disconnect())
    .catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        message === "usage"
          ? "Usage: node dist/scripts/reconcile-ots-state.js [--apply] [--limit N] [--team-id <uuid>] [--evidence-id <uuid>]"
          : `[reconcile-ots-state] ${message}`,
      );
      await prisma.$disconnect();
      process.exit(message === "usage" ? 0 : 2);
    });
}
