/**
 * OTS STATE RECONCILIATION — legacy rows onto the one authority, and the
 * independent Bitcoin-chain verification of historical ANCHORED proofs.
 *
 * TWO PASSES OVER THE SAME ROWS, ONE AUTHORITY EACH
 *
 *   alignment (always)  a stored `ots_status` that disagrees with what the
 *                       stored proof resolves to (ots-anchoring.ts) is brought
 *                       in line through the worker's own transition
 *                       (`decideStoredStatusAlignment`).
 *   chain (--chain)     every row whose stored proof RESOLVES to ANCHORED (the
 *                       canonical reading of the bytes — never the raw label)
 *                       is checked against the dedicated Bitcoin Core node by
 *                       the SAME verifier and the SAME transition the
 *                       `ots-upgrade` job uses (`checkOtsProofAgainstBitcoin`,
 *                       `decideOtsChainTransition`). Nothing is ever promoted
 *                       from a stored ANCHORED label: only an RPC-proven match
 *                       of the block's merkle root is VERIFIED.
 *
 * After a chain VERIFIED outcome, the one automatic derivative version is
 * decided by the normal lifecycle (`ensureOtsAnchoredReportVersion`): one
 * request per proof + block, never a version for an unchecked attestation, and
 * report/package history is never touched.
 *
 * SAFETY DESIGN
 *   * Dry-run by default. Writes nothing without `--apply`. A dry run of the
 *     chain pass performs read-only RPC calls and reports what would change.
 *   * `--chain --apply` REFUSES to start unless the verifier readiness gate
 *     passes NOW (node reachable, authenticated, main chain, out of IBD,
 *     caught up, fresh tip, no warnings, genesis probe).
 *   * Keyset pagination on (createdAt, id); batches of at most 100; a total
 *     bound (`--max-rows`, default 1000); resumable with `--after`.
 *     Every row is counted exactly once.
 *   * Compare-and-set on the full OTS snapshot (chain columns included): a row
 *     that moved on is skipped and counted, never overwritten.
 *   * Idempotent: a second run decides nothing new and records nothing.
 *   * One bounded custody event per ACTUAL change.
 *   * Prints evidence ids, states and bounded codes only: no proof bytes,
 *     storage keys, node address, user or password.
 *
 * Usage (inside the worker image):
 *   node dist/scripts/reconcile-ots-state.js                        # alignment, dry run
 *   node dist/scripts/reconcile-ots-state.js --chain                 # + chain, dry run (read-only RPC)
 *   node dist/scripts/reconcile-ots-state.js --chain --apply --max-rows 500
 *   node dist/scripts/reconcile-ots-state.js --chain --after 2026-10-01T00:00:00.000Z,<uuid>
 */
import type { Prisma } from "@prisma/client";
import * as prismaPkg from "@prisma/client";

import { appendCustodyEventTx } from "../custody-events.js";
import { prisma } from "../db.js";
import { ensureOtsAnchoredReportVersion } from "../ots-anchored-version.js";
import { resolveOtsBitcoinVerifierConfig } from "../ots-bitcoin-config.js";
import { checkOtsProofAgainstBitcoin, probeOtsBitcoinVerifierReadiness, type OtsBitcoinVerifierDeps } from "../ots-bitcoin-verifier.js";
import {
  OTS_ROW_SNAPSHOT_SELECT,
  applyOtsTransition,
  decideOtsChainTransition,
  decideStoredStatusAlignment,
  isTerminalOtsChainOutcome,
  resolveRowOtsAnchoring,
  type OtsRowSnapshot,
  type OtsTransition,
} from "../ots-state.js";

type Args = {
  apply: boolean;
  chain: boolean;
  batchSize: number;
  maxRows: number;
  evidenceId: string | null;
  teamId: string | null;
  after: { createdAt: Date; id: string } | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const RECONCILE_MAX_BATCH = 100;

export function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, chain: false, batchSize: RECONCILE_MAX_BATCH, maxRows: 1000, evidenceId: null, teamId: null, after: null };
  const int = (v: string | undefined, name: string, max: number) => {
    const n = v ? Number.parseInt(v, 10) : NaN;
    if (!Number.isFinite(n) || n <= 0 || n > max) throw new Error(`${name} must be an integer between 1 and ${max}`);
    return n;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const value = argv[i + 1];
    if (a === "--apply") args.apply = true;
    else if (a === "--chain") args.chain = true;
    else if (a === "--batch-size") {
      args.batchSize = int(value, "--batch-size", RECONCILE_MAX_BATCH);
      i += 1;
    } else if (a === "--max-rows" || a === "--limit") {
      args.maxRows = int(value, a, 100_000);
      i += 1;
    } else if (a === "--evidence-id" || a === "--team-id") {
      if (!value || !UUID.test(value)) throw new Error(`${a} requires a UUID`);
      if (a === "--evidence-id") args.evidenceId = value;
      else args.teamId = value;
      i += 1;
    } else if (a === "--after") {
      const [at, id] = String(value ?? "").split(",");
      const createdAt = new Date(at ?? "");
      if (!Number.isFinite(createdAt.getTime()) || !id || !UUID.test(id)) throw new Error("--after requires <createdAt ISO>,<evidence uuid>");
      args.after = { createdAt, id };
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
  verification: string;
  failureCode: string | null;
  action: "none" | "align" | "aligned" | "skipped_row_moved";
  phase: string | null;
  chain:
    | "not_evaluated"
    | "not_applicable"
    | "terminal"
    | "would_verify"
    | "verified"
    | "insufficient_confirmations"
    | "unavailable"
    | "failed"
    | "unchanged"
    | "skipped_row_moved";
  chainCode: string | null;
  version: string;
};

export type ReconcileSummary = {
  applied: boolean;
  chainPass: boolean;
  scanned: number;
  toAlign: number;
  aligned: number;
  wouldVerify: number;
  verified: number;
  insufficientConfirmations: number;
  unavailable: number;
  failed: number;
  skippedRowMoved: number;
  refused: number;
  versionWouldRequest: number;
  versionRequested: number;
  /** Resume point: pass as --after to continue. */
  nextAfter: string | null;
};

function snapshotOf(row: OtsRowSnapshot): OtsRowSnapshot {
  return row;
}

async function commitWrite(
  evidenceId: string,
  snapshot: OtsRowSnapshot,
  transition: Extract<OtsTransition, { kind: "WRITE" }>,
  previousOtsStatus: string | null,
  now: Date,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const applied = await applyOtsTransition(tx, evidenceId, snapshot, transition);
    if (!applied) return false;
    if (!transition.material) return true;
    const c = transition.anchoring.chain;
    await appendCustodyEventTx(tx, {
      evidenceId,
      eventType: transition.status === "FAILED" ? prismaPkg.CustodyEventType.OTS_FAILED : prismaPkg.CustodyEventType.OTS_APPLIED,
      atUtc: now,
      payload: {
        otsStatus: transition.status,
        otsState: transition.anchoring.state,
        otsVerification: transition.anchoring.verification,
        otsPhase: transition.phase,
        previousOtsStatus,
        proofSha256: transition.anchoring.proofSha256,
        bitcoinBlockHeight: transition.anchoring.state === "ANCHORED" ? transition.anchoring.bitcoinBlockHeight : null,
        bitcoinTxid: transition.anchoring.state === "ANCHORED" ? transition.anchoring.bitcoinTxid : null,
        validator: transition.anchoring.validator,
        failureReason: (transition.data.otsFailureReason as string | null | undefined) ?? null,
        ...(transition.phase.startsWith("chain_") && c
          ? {
              chain: {
                status: c.status,
                failureCode: c.failureCode,
                blockHeight: c.blockHeight,
                blockHash: c.blockHash,
                blockTimeUtc: c.blockTimeUtc,
                confirmations: c.confirmations,
                checkedAtUtc: c.checkedAtUtc,
                verifiedAtUtc: c.verifiedAtUtc,
                verifier: c.verifier,
              },
            }
          : {}),
        trigger: "reconcile_ots_state",
      } as Prisma.InputJsonValue,
    });
    return true;
  });
}

export async function main(argv: string[] = process.argv.slice(2), deps: OtsBitcoinVerifierDeps = {}) {
  const args = parseArgs(argv);
  const summary: ReconcileSummary = {
    applied: args.apply,
    chainPass: args.chain,
    scanned: 0,
    toAlign: 0,
    aligned: 0,
    wouldVerify: 0,
    verified: 0,
    insufficientConfirmations: 0,
    unavailable: 0,
    failed: 0,
    skippedRowMoved: 0,
    refused: 0,
    versionWouldRequest: 0,
    versionRequested: 0,
    nextAfter: null,
  };
  const results: ReconcileRowResult[] = [];

  const config = deps.config ?? resolveOtsBitcoinVerifierConfig();
  if (args.chain) {
    if (config.kind !== "enabled") {
      console.log(JSON.stringify({ refused: "the Bitcoin verifier is not enabled and configured (OTS_BITCOIN_VERIFY_ENABLED)", config: config.kind }));
      summary.refused += 1;
      console.log(JSON.stringify({ summary }));
      return { results, summary };
    }
    const readiness = await probeOtsBitcoinVerifierReadiness({ ...deps, config });
    if (!readiness.ready) {
      // Fail closed: no apply against a node that is not ready; a dry run
      // reports the refusal too rather than guessing.
      console.log(JSON.stringify({ refused: "the Bitcoin verifier readiness gate did not pass", code: readiness.code, detail: readiness.detail }));
      summary.refused += 1;
      console.log(JSON.stringify({ summary }));
      return { results, summary };
    }
  }

  let cursor = args.after;
  const baseWhere: Prisma.EvidenceWhereInput = {
    deletedAt: null,
    otsProofBase64: { not: null },
    ...(args.evidenceId ? { id: args.evidenceId } : {}),
    ...(args.teamId ? { teamId: args.teamId } : {}),
  };
  while (summary.scanned < args.maxRows) {
    const take = Math.min(args.batchSize, args.maxRows - summary.scanned);
    const rows = await prisma.evidence.findMany({
      where: cursor
        ? {
            AND: [
              baseWhere,
              { OR: [{ createdAt: { gt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { gt: cursor.id } }] },
            ],
          }
        : baseWhere,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take,
      select: { id: true, createdAt: true, ...OTS_ROW_SNAPSHOT_SELECT },
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      summary.scanned += 1;
      const { id, createdAt, ...rest } = row;
      let snapshot = snapshotOf(rest as OtsRowSnapshot);
      const now = new Date();
      const alignment = decideStoredStatusAlignment(snapshot, now);
      let current = alignment?.kind === "WRITE" ? alignment.anchoring : resolveRowOtsAnchoring(snapshot);
      const result: ReconcileRowResult = {
        evidenceId: id,
        storedStatus: snapshot.otsStatus,
        state: current.state,
        verification: current.verification,
        failureCode: current.failureCode,
        action: alignment ? "align" : "none",
        phase: alignment?.kind === "WRITE" ? alignment.phase : null,
        chain: args.chain ? "not_applicable" : "not_evaluated",
        chainCode: null,
        version: "not_evaluated",
      };
      if (alignment?.kind === "WRITE") summary.toAlign += 1;

      if (args.apply && alignment?.kind === "WRITE") {
        const won = await commitWrite(id, snapshot, alignment, snapshot.otsStatus, now);
        result.action = won ? "aligned" : "skipped_row_moved";
        if (won) {
          summary.aligned += 1;
          snapshot = { ...snapshot, ...(alignment.data as Partial<OtsRowSnapshot>) };
        } else summary.skippedRowMoved += 1;
      }

      if (args.chain && current.state === "ANCHORED" && result.action !== "skipped_row_moved") {
        if (isTerminalOtsChainOutcome(snapshot)) {
          result.chain = "terminal";
        } else {
          const check = await checkOtsProofAgainstBitcoin(current, { ...deps, config });
          const transition = decideOtsChainTransition(snapshot, check, {
            minConfirmations: config.kind === "enabled" ? config.policy.minConfirmations : 0,
          });
          result.chainCode = check.kind === "UNAVAILABLE" ? check.code : check.kind === "DECIDED" ? (check.decision.failureCode ?? null) : null;
          if (transition.kind !== "WRITE") {
            result.chain = check.kind === "UNAVAILABLE" ? "unavailable" : "unchanged";
            if (check.kind === "UNAVAILABLE") summary.unavailable += 1;
          } else {
            const v = transition.anchoring.verification;
            // A re-check that only refreshes the same outcome (same block, same
            // code) decides nothing new: it is applied, and counted as unchanged.
            const kind: ReconcileRowResult["chain"] = !transition.material
              ? "unchanged"
              : v === "CHAIN_VERIFIED"
                ? args.apply
                  ? "verified"
                  : "would_verify"
                : v === "CHAIN_CONFIRMATIONS_PENDING"
                  ? "insufficient_confirmations"
                  : v === "CHAIN_UNAVAILABLE"
                    ? "unavailable"
                    : "failed";
            if (args.apply) {
              const won = await commitWrite(id, snapshot, transition, snapshot.otsStatus, check.kind === "DISABLED" ? now : check.checkedAtUtc);
              if (!won) {
                result.chain = "skipped_row_moved";
                summary.skippedRowMoved += 1;
              } else {
                result.chain = kind;
                current = transition.anchoring;
              }
            } else {
              result.chain = kind;
              current = transition.anchoring;
            }
            if (result.chain === "verified") summary.verified += 1;
            else if (result.chain === "would_verify") summary.wouldVerify += 1;
            else if (result.chain === "insufficient_confirmations") summary.insufficientConfirmations += 1;
            else if (result.chain === "unavailable") summary.unavailable += 1;
            else if (result.chain === "failed") summary.failed += 1;
          }
        }
        result.verification = current.verification;
      }

      if (current.verification === "CHAIN_VERIFIED" && result.chain !== "skipped_row_moved" && result.action !== "skipped_row_moved") {
        const decision = await ensureOtsAnchoredReportVersion({ evidenceId: id, anchoring: current, dryRun: !args.apply });
        result.version = !args.apply && decision.outcome === "requested" ? "would_request" : decision.outcome;
        if (result.version === "requested") summary.versionRequested += 1;
        if (result.version === "would_request") summary.versionWouldRequest += 1;
      }
      results.push(result);
      console.log(JSON.stringify(result));
      cursor = { createdAt, id };
      summary.nextAfter = `${createdAt.toISOString()},${id}`;
    }
    if (rows.length < take) break;
  }

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
          ? "Usage: node dist/scripts/reconcile-ots-state.js [--apply] [--chain] [--batch-size N<=100] [--max-rows N] [--after <createdAt>,<uuid>] [--team-id <uuid>] [--evidence-id <uuid>]"
          : `[reconcile-ots-state] ${message.slice(0, 300)}`,
      );
      await prisma.$disconnect();
      process.exit(message === "usage" ? 0 : 2);
    });
}
