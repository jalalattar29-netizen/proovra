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

const QUEUE_SRC = readSource("../src/queue.ts");
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
    // AND it MUST pass excludeJobId so the queue's dedup logic
    // distinguishes the currently-running job from external dupes.
    expect(block).toMatch(/excludeJobId:\s*job\.id/);
    // AND it MUST use the stable follow-up id so the queue can
    // self-discriminate via the fix below.
    expect(block).toMatch(/jobId:\s*buildFollowUpJobId\(evidenceId\)/);
  });

  it("the FULLY_ANCHORED branch is the ONLY terminal-success branch (no spurious follow-up)", () => {
    const idx = UPGRADE_SRC.indexOf('if (classification.kind === "FULLY_ANCHORED")');
    expect(idx).toBeGreaterThan(-1);
    const block = UPGRADE_SRC.slice(idx, idx + 3000);
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
// THE FIX — enqueueOtsUpgradeJob respects excludeJobId for self-reference
// ============================================================================

describe("Phase IA-OTS-forward-retry — enqueueOtsUpgradeJob self-reschedule fix", () => {
  it("the direct-jobId branch checks isSelfReference using excludeJobId", () => {
    // The pre-fix code did `if (existing) { if (isRunnableQueueState) return; ... }`
    // — short-circuiting before ever looking at excludeJobId. The fix
    // introduces an `isSelfReference` predicate that fires FIRST.
    expect(QUEUE_SRC).toMatch(
      /const isSelfReference\s*=[\s\S]{0,200}options\?\.excludeJobId\s*!=\s*null[\s\S]{0,200}String\(existing\.id\)\s*===\s*String\(options\.excludeJobId\)/,
    );
  });

  it("self-reference path discriminates the jobId with a timestamp suffix", () => {
    // When the existing job IS the currently-running one, we cannot
    // enqueue under the same id (BullMQ rejects). The fix appends a
    // discriminator so the new follow-up has a distinct id.
    expect(QUEUE_SRC).toMatch(
      /if \(isSelfReference\)\s*\{[\s\S]{0,1200}jobId\s*=\s*`\$\{jobId\}-\$\{Date\.now\(\)\}`/,
    );
  });

  it("non-self-reference path still returns job_<state> when existing is runnable", () => {
    expect(QUEUE_SRC).toMatch(
      /else\s*\{[\s\S]{0,200}isRunnableQueueState\(state\)[\s\S]{0,200}return\s*\{\s*enqueued:\s*false,\s*reason:\s*`job_\$\{state\}`/,
    );
  });

  it("non-self-reference path removes completed/failed existing jobs before re-enqueue", () => {
    expect(QUEUE_SRC).toMatch(
      /else\s*\{[\s\S]{0,500}existing\.remove\(\)/,
    );
  });

  it("findRunnableOtsUpgradeJobForEvidence is STILL called for cross-job dedup", () => {
    // The downstream scan that catches parallel enqueues from other
    // sources (admin retry, repair script) MUST still run.
    expect(QUEUE_SRC).toMatch(
      /findRunnableOtsUpgradeJobForEvidence\(\s*evidenceId,\s*options\?\.excludeJobId\s*\)/,
    );
  });

  it("findRunnableOtsUpgradeJobForEvidence honors excludeJobId so it does NOT block self-reschedule", () => {
    // The scan helper compares each runnable job's id against
    // excludeJobId. Pin that contract.
    expect(QUEUE_SRC).toMatch(
      /findRunnableOtsUpgradeJobForEvidence\([\s\S]{0,400}if \(String\(job\.id\)\s*===\s*String\(excludeJobId\s*\?\?\s*""\)\)\s*return false/,
    );
  });

  it("the new job options preserve the existing retry policy (attempts: 20, removeOnComplete: 100)", () => {
    // The enqueue options must remain identical so the per-evidence
    // retry budget and queue-history cap are unchanged.
    expect(QUEUE_SRC).toMatch(/attempts:\s*20/);
    expect(QUEUE_SRC).toMatch(/removeOnComplete:\s*100/);
    expect(QUEUE_SRC).toMatch(/backoff:\s*\{\s*type:\s*"exponential"/);
  });
});

// ============================================================================
// The pre-fix bug shape — pin its ABSENCE so a future revert is caught
// ============================================================================

describe("Phase IA-OTS-forward-retry — pre-fix bug shape is GONE", () => {
  it("the unconditional 'return job_<state> if isRunnable' path no longer fires before excludeJobId is consulted", () => {
    // Pre-fix shape (REGRESSION GUARD):
    //
    //   if (existing) {
    //     const state = await existing.getState();
    //     if (isRunnableQueueState(state)) {
    //       return { enqueued: false, reason: `job_${state}` };
    //     }
    //     ...
    //   }
    //
    // That ordering let the function return BEFORE consulting
    // excludeJobId. The fix moved the isRunnable check INSIDE an
    // `else` branch that's only reached when isSelfReference is false.
    //
    // Pin: in the enqueueOtsUpgradeJob function, the FIRST occurrence
    // of `isRunnableQueueState(state)` (where state is the existing
    // job's state) MUST be inside the `else` branch — i.e., it MUST
    // be preceded by an `} else {` opener within the same function.
    const fnIdx = QUEUE_SRC.indexOf("export async function enqueueOtsUpgradeJob");
    expect(fnIdx).toBeGreaterThan(-1);
    const fnSlice = QUEUE_SRC.slice(fnIdx, fnIdx + 4000);
    const isRunnableMatchIdx = fnSlice.indexOf("isRunnableQueueState(state)");
    expect(isRunnableMatchIdx).toBeGreaterThan(-1);
    // Walk backward from the match looking for the nearest `else` or
    // `if`. The nearest preceding opener must be `else`.
    const upstream = fnSlice.slice(0, isRunnableMatchIdx);
    const lastElse = upstream.lastIndexOf("} else {");
    const lastIf = upstream.lastIndexOf("if (existing) {");
    expect(lastElse).toBeGreaterThan(-1);
    expect(lastElse).toBeGreaterThan(lastIf);
  });
});
