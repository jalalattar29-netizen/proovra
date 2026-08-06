/**
 * Phase Final-Worker-Visibility — contract test.
 *
 * Pins two closures:
 *
 * 1. **OTS upgrade loop control.** The processor now uses a stable
 *    jobId per evidenceId (so BullMQ's `attempts` ceiling is enforced
 *    across re-enqueues) and a 30-day global attempt budget anchored
 *    on `evidence.createdAt`. When the budget is exhausted the row
 *    is marked FAILED with reason `OTS_GLOBAL_BUDGET_EXHAUSTED` and a
 *    matching custody event is appended; no further re-enqueues.
 *
 * 2. **Queue heartbeat coverage.** `services/worker/src/index.ts`'s
 *    queue-health sampler now reports EVERY live queue declared in
 *    `services/worker/src/queue.ts`, not just `report` /
 *    `ots-upgrade` / `evidence-purge`.
 *
 * Both pins are file-content assertions so they survive without a
 * running worker.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import {
  JOB_NAMES,
  buildCanonicalJobId,
  getWorkEntryOrThrow,
} from "@proovra/shared";

function readWorker(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../worker/${rel}`, import.meta.url)),
    "utf8",
  );
}

// ============================================================================
// OTS upgrade loop control
// ============================================================================

describe("Phase Final-Worker-Visibility — OTS upgrade attempt budget", () => {
  const otsProc = readWorker("src/ots-upgrade.processor.ts");

  /**
   * PHASE 12 — POINT 5 went one step further than this test asked for.
   *
   * The original closure replaced a timestamp-bearing job id with a STABLE
   * one, so BullMQ's `attempts` ceiling survived re-enqueues. But it made that
   * stable id a SECOND id — `ots-upgrade-followup-<evidenceId>` alongside
   * `ots-upgrade-<evidenceId>` — which meant a follow-up and an initial upgrade
   * for the same evidence had separate attempt budgets and could both be
   * runnable at once.
   *
   * There is now exactly ONE id for an evidence record's OTS upgrade, derived
   * by `buildCanonicalJobId` from the registry prefix. The property this test
   * protects (no clock in the id, so the ceiling holds) is strictly stronger.
   */
  it("there is ONE stable job id for an evidence record's OTS upgrade", () => {
    const entry = getWorkEntryOrThrow(JOB_NAMES.UPGRADE_OTS);
    expect(entry.jobIdPrefix).toBe("ots-upgrade");
    const prefixed = { jobIdPrefix: entry.jobIdPrefix! };
    expect(buildCanonicalJobId(prefixed, "ev-1")).toBe("ots-upgrade-ev-1");
    // Deterministic: two calls, one id. No clock, no counter.
    expect(buildCanonicalJobId(prefixed, "ev-1")).toBe(
      buildCanonicalJobId(prefixed, "ev-1"),
    );
    // The second id is gone: no separate follow-up namespace survives.
    expect(otsProc).not.toMatch(/export function buildFollowUpJobId/);
    expect(otsProc).not.toMatch(/["']ots-upgrade-followup-["']/);
  });

  it("the global attempt budget helpers are wired (env-overridable, default 30 days)", () => {
    expect(otsProc).toMatch(/getOtsGlobalBudgetMs/);
    expect(otsProc).toMatch(/isOtsGlobalBudgetExhausted/);
    expect(otsProc).toMatch(/OTS_GLOBAL_BUDGET_DAYS_DEFAULT\s*=\s*30/);
    expect(otsProc).toMatch(/process\.env\.OTS_GLOBAL_BUDGET_DAYS/);
  });

  it("the processor checks the budget before re-enqueueing on PENDING", () => {
    expect(otsProc).toMatch(/isOtsGlobalBudgetExhausted\(/);
    expect(otsProc).toMatch(/OTS_GLOBAL_BUDGET_EXHAUSTED/);
    expect(otsProc).toMatch(/global_budget_exhausted/);
    expect(otsProc).toMatch(/ots\.upgrade\.budget_exhausted/);
  });

  it("the follow-up is still SCHEDULED, and still under a stable id", () => {
    // The original bug: baking `upgradedAt.getTime()` into the id defeated the
    // attempts ceiling. Still absent.
    expect(otsProc).not.toMatch(/upgradedAt\.getTime\(\)/);

    // PHASE 12 — POINT 5 preserved the harder half of this contract. With one
    // id, the follow-up call runs INSIDE the job that already holds that id, so
    // a plain enqueue would find its own active job and collapse onto it —
    // scheduling nothing, and leaving the evidence OTS-PENDING forever with an
    // empty queue. That is the exact production incident this suite exists for.
    // `selfJobId` tells the shared enqueue authority that the live job is the
    // caller, and the behavioural proof (schedules under a distinct id, does
    // NOT remove the running job, and a PARALLEL producer still collapses)
    // lives in the Point-5 closure gate.
    expect(otsProc).toMatch(/selfJobId:\s*job\.id/);
    expect(otsProc).toMatch(/enqueueOtsUpgradeJob\(evidenceId,\s*\{/);
  });

  it("the evidence select includes createdAt (the budget window anchor)", () => {
    expect(otsProc).toMatch(/createdAt:\s*true/);
  });
});

// ============================================================================
// Queue heartbeat coverage
// ============================================================================

describe("Phase Final-Worker-Visibility — heartbeat sampler covers every live queue", () => {
  const idx = readWorker("src/index.ts");

  // PHASE 12 POINT 5 — this was a HAND-MAINTAINED list of seventeen queue-name
  // identifiers, and it went stale the moment `mi-ocr` and `mi-transcript`
  // were removed. A hand list is also the weaker assertion: it proves the
  // sampler covers the queues SOMEBODY REMEMBERED, which is not the property
  // this suite exists to hold.
  //
  // The list is now DISCOVERED from the worker's own queue declarations, so a
  // queue added to `queue.ts` without being added to the heartbeat fails here
  // without anyone having to notice.
  const REQUIRED_QUEUES = (() => {
    const queueSrc = readWorker("src/queue.ts");
    const declared = [
      ...queueSrc.matchAll(/export const (\w+) = new Queue\(\s*\n?\s*(\w+)/g),
    ].map((m) => m[2]!);
    expect(
      declared.length,
      "no `export const X = new Queue(name` declarations found in queue.ts",
    ).toBeGreaterThan(0);
    return [...new Set(declared)];
  })();

  for (const q of REQUIRED_QUEUES) {
    it(`sampleQueueHealthOnce() samples ${q}`, () => {
      // Each queue name must appear inside `snapshotQueueHealth([...])`.
      // We look for the queue name token AS A KEY in the snapshot
      // list (not just anywhere in the file — many of these are
      // also passed to the Worker constructor below).
      const samplerBlock = idx.match(
        /snapshotQueueHealth\(\[([\s\S]*?)\]\)/,
      );
      expect(samplerBlock, "snapshotQueueHealth([...]) not found").not.toBeNull();
      expect(samplerBlock![1]!).toMatch(new RegExp(`\\b${q}\\b`));
    });
  }

  it("does not regress to the old 3-queue heartbeat", () => {
    // Negative assertion: the sampler array MUST NOT be limited to
    // just report / ots / purge.
    const samplerBlock = idx.match(/snapshotQueueHealth\(\[([\s\S]*?)\]\)/);
    expect(samplerBlock).not.toBeNull();
    const body = samplerBlock![1]!;
    // The sampler must cover EVERY declared queue — not "at least 14", which
    // was a floor chosen when the list was hand-written and which a removal
    // could satisfy while silently dropping a live queue.
    const nameKeyCount = (body.match(/\bname:/g) ?? []).length;
    expect(
      nameKeyCount,
      `heartbeat sampler covers ${nameKeyCount} queues; ${REQUIRED_QUEUES.length} are declared`,
    ).toBe(REQUIRED_QUEUES.length);
  });
});
