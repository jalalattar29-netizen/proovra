/**
 * Phase IA-OTS-forward-retry-lifecycle — pin the self-reschedule fix.
 *
 * Production incident:
 *   A new evidence reached the OTS-PENDING state and stayed there
 *   indefinitely. Runtime diagnostics showed:
 *     - ots_status = PENDING
 *     - ots_proof_base64 present
 *     - ots_bitcoin_txid = null
 *     - ots_upgraded_at_utc set (a follow-up had completed)
 *     - queue had ZERO waiting / delayed / active / failed jobs for
 *       the evidence
 *
 *   `processOtsUpgrade` had returned a STILL_PENDING / ANCHOR_MATERIAL_
 *   RECOVERED classification and called `enqueueOtsUpgradeJob` to
 *   schedule the next follow-up. That call returned
 *   `{ enqueued: false, reason: "job_active" }` because the running
 *   job's stable jobId (`ots-upgrade-followup-{evidenceId}`) was the
 *   same id we tried to enqueue under — `enqueueOtsUpgradeJob` saw
 *   its own running job in `active` state and short-circuited.
 *   The `excludeJobId: job.id` parameter that the processor passes
 *   was honoured by `findRunnableOtsUpgradeJobForEvidence` but NOT by
 *   the direct jobId lookup that runs first.
 *
 * Fix (queue.ts:enqueueOtsUpgradeJob):
 *   When `existing.id === options.excludeJobId` (self-reference),
 *   generate a discriminated jobId so the new follow-up lands as a
 *   distinct queue entry. Dedup against parallel callers still goes
 *   through `findRunnableOtsUpgradeJobForEvidence`; budget is still
 *   bounded by `isOtsGlobalBudgetExhausted(createdAt, now)`.
 *
 * These tests pin the source contract. They do not exercise BullMQ at
 * runtime — that would require Redis. The behavioural contract is
 * verified at the source-grep layer; runtime smoke is handled by the
 * Phase 8 smoke script.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const UPGRADE_SRC = readSource("../src/ots-upgrade.processor.ts");

// ============================================================================
// THE INVARIANT — top of file because it's the contract.
//
// "After every processOtsUpgrade() invocation, if evidence.otsStatus
//  remains PENDING then EXACTLY ONE of these is true:
//    (1) a delayed follow-up ots-upgrade job exists for this evidence
//    (2) global OTS budget is exhausted and evidence moved to FAILED
//    (3) evidence moved to ANCHORED
//    (4) hard failure occurred and evidence moved to FAILED
//
//  It is INVALID to leave PENDING + no future job + no terminal state."
// ============================================================================

describe("Phase IA-OTS-forward-retry — invariant: PENDING outcome MUST schedule a follow-up", () => {
  it("the upgrade processor's PENDING branch calls enqueueOtsUpgradeJob with the follow-up id", () => {
    // Anchor the PENDING branch: "ANCHOR_MATERIAL_RECOVERED" |
    // "STILL_PENDING" | pendingOutput | !commandErrored — that branch
    // MUST flow to the enqueueOtsUpgradeJob call further down (either
    // directly OR via the txidRecoveredWhileAnchored else-branch).
    // Anchor on `if (` followed by the kind check so we land on the
    // branch code, not the comment block above it. The actual file has
    // varied whitespace between the `if (` and the predicate; use a
    // regex match.
    const m = UPGRADE_SRC.match(
      /if \(\s*\n?\s*classification\.kind === "ANCHOR_MATERIAL_RECOVERED"/,
    );
    expect(m).not.toBeNull();
    const idx = m!.index!;
    const block = UPGRADE_SRC.slice(idx, idx + 14000);
    // The else-of-(txidRecoveredWhileAnchored) is where the budget
    // check + enqueue lives. Pin both:
    expect(block).toMatch(/isOtsGlobalBudgetExhausted\(/);
    expect(block).toMatch(/enqueueOtsUpgradeJob\(evidenceId,\s*\{/);
    // The enqueue MUST set a delayMs (no immediate retry storm).
    expect(block).toMatch(/delayMs:\s*60\s*\*\s*60\s*\*\s*1000/);
    // AND it MUST tell the enqueue authority that the live job under the
    // target id is the CALLER.
    //
    // PHASE 12 — POINT 5 renamed this mechanism without weakening it. There
    // used to be two ids (`ots-upgrade-<id>` and
    // `ots-upgrade-followup-<id>`) and an `excludeJobId` the producer
    // interpreted itself; there is now ONE id and a `selfJobId` the SHARED
    // enqueue authority interprets. The guarantee is identical and is the
    // reason both exist: without it this call finds its own active job,
    // collapses onto it, schedules nothing, and the evidence stays
    // OTS-PENDING forever with an empty queue — the exact production
    // incident this file was written for.
    expect(block).toMatch(/selfJobId:\s*job\.id/);
  });

  it("the FULLY_ANCHORED branch is the ONLY terminal-success branch (no spurious follow-up)", () => {
    const idx = UPGRADE_SRC.indexOf('if (classification.kind === "FULLY_ANCHORED")');
    expect(idx).toBeGreaterThan(-1);
    // Phase IA-OTS-info-fallback — widened from 3000 → 5500 to
    // accommodate additional custody-payload fields the info probe
    // adds (`infoStatus`, `infoFileHashMatches`, `infoBlockHeights`)
    // and the 3-way completionSource conditional.
    const block = UPGRADE_SRC.slice(idx, idx + 5500);
    expect(block).toMatch(/status:\s*"ANCHORED"/);
    // FULLY_ANCHORED enqueues report regen but NOT another upgrade job.
    expect(block).toMatch(/enqueueReportJob\(evidenceId,\s*\{/);
    expect(block).toMatch(/regenerateReason:\s*"ots_anchored"/);
    // No enqueueOtsUpgradeJob in this branch.
    expect(block.match(/enqueueOtsUpgradeJob\(/)).toBeNull();
  });

  it("the global-budget-exhausted branch terminates without re-enqueue", () => {
    const idx = UPGRADE_SRC.lastIndexOf("isOtsGlobalBudgetExhausted({");
    expect(idx).toBeGreaterThan(-1);
    const block = UPGRADE_SRC.slice(idx, idx + 2500);
    // Writes FAILED + records incident.
    expect(block).toMatch(/status:\s*"FAILED"/);
    expect(block).toMatch(/failureReason:\s*"OTS_GLOBAL_BUDGET_EXHAUSTED"/);
    expect(block).toMatch(/recordWorkerIncident\(/);
    // Returns BEFORE the enqueueOtsUpgradeJob call further down.
    const enqueueIdxInBlock = block.indexOf("enqueueOtsUpgradeJob(");
    const returnIdxInBlock = block.indexOf("return;");
    if (enqueueIdxInBlock > -1) {
      expect(returnIdxInBlock).toBeLessThan(enqueueIdxInBlock);
    }
  });
});

// ============================================================================
// THE FIX — the self-reschedule escape hatch, and its bounds
// ============================================================================
//
// PHASE 12 — POINT 5 MOVED this mechanism out of `queue.ts` and into the shared
// `enqueueCanonicalJob`, so the source-regex assertions that used to live here
// (`isSelfReference` + `options?.excludeJobId`, a `Date.now()` job-id suffix,
// `findRunnableOtsUpgradeJobForEvidence`, `attempts: 20` written out as a
// literal) all pinned symbols that no longer exist. Every one of them has been
// replaced by a BEHAVIORAL assertion in
// `services/api/test/phase-12-point5-queue-integrity-gate.test.ts`, which runs
// the real enqueue policy against a fake queue and proves:
//
//   * a job re-scheduling ITSELF is not collapsed into a no-op — it schedules
//     under a distinct id, and the caller's own running job is NOT removed;
//   * a PARALLEL producer for the same evidence still collapses, so the escape
//     hatch cannot become a way to schedule unbounded duplicates;
//   * the retry policy comes from the registry, so `attempts` cannot drift
//     between the request path and the reconciler.
//
// What remains here is the part that is genuinely about THIS processor: that
// the ladder is bounded by a durable global budget rather than by the queue's
// retry count, which is what stops a permanently broken proof from retrying
// forever.

describe("Phase IA-OTS-forward-retry — the ladder is bounded durably", () => {
  it("the global budget is anchored on evidence.createdAt, not on the upgrade clock", () => {
    // `otsAnchoredAtUtc` is null for a proof that never anchored and
    // `upgradedAt` is the CURRENT run's clock, so neither can bound a ladder.
    // Only the evidence row's own creation time can.
    expect(UPGRADE_SRC).toMatch(/createdAt: true/);
    expect(UPGRADE_SRC).toMatch(/isOtsGlobalBudgetExhausted\(/);
  });

  it("the queue's attempt ceiling is NOT the ladder's ceiling", () => {
    // Recorded because it is the non-obvious fact behind the whole design: the
    // happy-path PENDING return does not throw, so it never consumes a BullMQ
    // attempt. A reader who assumes `attempts` bounds the ladder will conclude
    // the budget check is redundant and delete it.
    expect(UPGRADE_SRC).toMatch(/OTS_GLOBAL_BUDGET_EXHAUSTED/);
  });
});
